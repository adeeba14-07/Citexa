import { and, asc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  conceptsTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
  type SourceLocator,
  type StudyCitation,
} from "@workspace/db/schema";
import { cachedAI, errorMessage, modelConfig, openai, sha256, withRetry } from "../lib/ingestion/ai";
import { findOwnedCourse, studygraphOwnerId, studygraphPathParam, validStudygraphId } from "../lib/studygraph/ownership";

const router: IRouter = Router();

type EvidenceRow = {
  topicId: string;
  topicName: string;
  conceptId: string;
  conceptName: string;
  conceptDescription: string | null;
  unitId: string;
  unitText: string;
  figureCaption: string | null;
  locator: SourceLocator;
  sourceId: string;
  sourceTitle: string;
  sourceType: "pdf" | "pptx" | "video";
};

function citation(row: EvidenceRow): StudyCitation {
  return {
    unitId: row.unitId,
    sourceId: row.sourceId,
    sourceTitle: row.sourceTitle,
    sourceType: row.sourceType,
    locator: row.locator,
    excerpt: row.unitText.slice(0, 260),
  };
}

async function loadEvidence(courseId: string, ownerId: string): Promise<EvidenceRow[]> {
  return db
    .select({
      topicId: topicsTable.id,
      topicName: topicsTable.name,
      conceptId: conceptsTable.id,
      conceptName: conceptsTable.name,
      conceptDescription: conceptsTable.description,
      unitId: unitsTable.id,
      unitText: unitsTable.text,
      figureCaption: unitsTable.figureCaption,
      locator: unitsTable.locator,
      sourceId: sourcesTable.id,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
    })
    .from(topicsTable)
    .innerJoin(conceptsTable, eq(conceptsTable.topicId, topicsTable.id))
    .innerJoin(unitConceptsTable, eq(unitConceptsTable.conceptId, conceptsTable.id))
    .innerJoin(unitsTable, eq(unitsTable.id, unitConceptsTable.unitId))
    .innerJoin(sourcesTable, eq(sourcesTable.id, unitsTable.sourceId))
    .where(
      and(
        eq(topicsTable.courseId, courseId),
        eq(sourcesTable.courseId, courseId),
        eq(sourcesTable.ownerId, ownerId),
        eq(sourcesTable.status, "ready"),
      ),
    )
    .orderBy(asc(topicsTable.name), asc(conceptsTable.name))
    .limit(5000) as Promise<EvidenceRow[]>;
}

async function courseContext(req: Request, res: Response) {
  const ownerId = studygraphOwnerId(res);
  const courseId = studygraphPathParam(req, "courseId");
  if (!validStudygraphId(courseId)) {
    res.status(400).json({ error: "Invalid course id." });
    return null;
  }
  const course = await findOwnedCourse(courseId, ownerId);
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return null;
  }
  return { ownerId, courseId };
}

function safeString(value: unknown, max = 1600): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isModelQuotaError(error: unknown): boolean {
  const status = error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
  return status === 429 || /rate.?limit|quota|too many requests|tokens per minute|overloaded|temporarily busy/i.test(errorMessage(error));
}

function sourceExcerpt(value: string, max = 360): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const sentence = normalized.match(/^.{1,360}?[.!?](?=\s|$)/)?.[0];
  return (sentence && sentence.length >= 45 ? sentence : normalized.slice(0, max).replace(/\s+\S*$/, "")).trim();
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

router.get("/x/courses/:courseId/glossary", async (req: Request, res: Response) => {
  const ctx = await courseContext(req, res);
  if (!ctx) return;
  try {
    const rows = await loadEvidence(ctx.courseId, ctx.ownerId);
    const concepts = new Map<string, { id: string; term: string; topic: string; description: string; rows: EvidenceRow[] }>();
    for (const row of rows) {
      let concept = concepts.get(row.conceptId);
      if (!concept) {
        concept = { id: row.conceptId, term: row.conceptName, topic: row.topicName, description: row.conceptDescription ?? "", rows: [] };
        concepts.set(row.conceptId, concept);
      }
      if (concept.rows.length < 4 && !concept.rows.some((item) => item.unitId === row.unitId)) concept.rows.push(row);
    }
    const items = [...concepts.values()].slice(0, 100);
    if (!items.length) {
      res.json({ terms: [], note: "No ready, topic-linked concepts are available yet. Wait for course sources to finish processing." });
      return;
    }
    const cacheInput = items.map((item) => ({ id: item.id, term: item.term, description: item.description, excerpts: item.rows.map((row) => row.unitText.slice(0, 900)) }));
    const cacheKey = `study-glossary-v1:${sha256(JSON.stringify(cacheInput))}`;
    let usedSourceFallback = false;
    let generated: { terms: Array<{ id: string; meaning: string }> };
    try {
      generated = await cachedAI<{ terms: Array<{ id: string; meaning: string }> }>(cacheKey, modelConfig.structure, async () => {
      const completion = await withRetry(() => openai().chat.completions.create({
        model: modelConfig.structure,
        response_format: { type: "json_object" },
        max_completion_tokens: 5000,
        messages: [
          { role: "system", content: "Create a concise glossary for a student. For each supplied concept ID, write a plain-language meaning using only its supplied description and excerpts. Do not add unsupported facts. Keep technical words if needed but explain them simply. Return JSON {\"terms\":[{\"id\":\"exact supplied concept id\",\"meaning\":\"...\"}]}." },
          { role: "user", content: JSON.stringify(cacheInput) },
        ],
      }));
      const parsed = parseJson(completion.choices[0]?.message.content ?? "");
      if (!parsed || !Array.isArray(parsed.terms)) throw new Error("The glossary model returned an invalid result.");
      return { terms: parsed.terms.flatMap((term) => {
        if (!term || typeof term !== "object") return [];
        const entry = term as Record<string, unknown>;
        return typeof entry.id === "string" && typeof entry.meaning === "string" ? [{ id: entry.id, meaning: entry.meaning.slice(0, 900) }] : [];
      }) };
      });
    } catch (error) {
      if (!isModelQuotaError(error)) throw error;
      usedSourceFallback = true;
      generated = { terms: items.map((item) => ({
        id: item.id,
        meaning: sourceExcerpt(item.description || item.rows[0]?.unitText || "No concise description is available in the extracted course material.", 900),
      })) };
    }
    const meaningById = new Map(generated.terms.map((term) => [term.id, term.meaning]));
    res.json({ terms: items.flatMap((item) => {
      const meaning = meaningById.get(item.id);
      return meaning ? [{ id: item.id, term: item.term, topic: item.topic, meaning, citations: item.rows.map(citation) }] : [];
    }), note: usedSourceFallback
      ? "The explanation service is busy. Showing descriptions and excerpts directly from your course material instead; open a citation to check the original."
      : "Meanings are simplified from ready course material; open a citation to inspect the supporting source." });
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) || "Could not build the glossary." });
  }
});

router.post("/x/courses/:courseId/cheat-sheet", async (req: Request, res: Response) => {
  const ctx = await courseContext(req, res);
  if (!ctx) return;
  try {
    const rows = await loadEvidence(ctx.courseId, ctx.ownerId);
    const grouped = new Map<string, { topic: string; rows: EvidenceRow[] }>();
    for (const row of rows) {
      let group = grouped.get(row.topicId);
      if (!group) {
        group = { topic: row.topicName, rows: [] };
        grouped.set(row.topicId, group);
      }
      if (group.rows.length < 8 && !group.rows.some((item) => item.unitId === row.unitId)) group.rows.push(row);
    }
    const topics = [...grouped.entries()].slice(0, 16);
    if (!topics.length) {
      res.status(409).json({ error: "No ready, topic-linked course material is available yet. Wait for processing to finish first." });
      return;
    }
    const material = topics.map(([id, group]) => ({ id, topic: group.topic, units: group.rows.map((row) => ({ id: row.unitId, concept: row.conceptName, text: row.unitText.slice(0, 650), figure: row.figureCaption })) }));
    const cacheKey = `study-cheatsheet-v1:${sha256(JSON.stringify(material))}`;
    type GeneratedTopic = { topicId: string; definitions: Array<{ text: string; unitIds: string[] }>; formulas: Array<{ text: string; unitIds: string[] }>; examples: Array<{ text: string; unitIds: string[] }> };
    let usedSourceFallback = false;
    let generated: { topics: GeneratedTopic[] };
    try {
      generated = await cachedAI<{ topics: GeneratedTopic[] }>(cacheKey, modelConfig.assessment, async () => {
      const completion = await withRetry(() => openai().chat.completions.create({
        model: modelConfig.assessment,
        response_format: { type: "json_object" },
        max_completion_tokens: 7000,
        messages: [
          { role: "system", content: "Create printable exam revision sheets, one per supplied topic. Use ONLY the supplied source units. Extract concise key definitions, formulas (copy exactly), and examples actually present or directly illustrated in the units. Do not invent a formula or example. For every item include exact supporting unit IDs from the supplied list. If a category has no supported material, return an empty array. Return JSON {\"topics\":[{\"topicId\":\"exact supplied topic id\",\"definitions\":[{\"text\":\"...\",\"unitIds\":[\"...\"]}],\"formulas\":[{\"text\":\"...\",\"unitIds\":[\"...\"]}],\"examples\":[{\"text\":\"...\",\"unitIds\":[\"...\"]}]}]}. Limit each array to 3 concise items that fit comfortably on one printed page. Keep each item under 300 characters. Include readable math using LaTeX when supported by the source." },
          { role: "user", content: JSON.stringify(material) },
        ],
      }));
      const parsed = parseJson(completion.choices[0]?.message.content ?? "");
      if (!parsed || !Array.isArray(parsed.topics)) throw new Error("The cheat-sheet model returned an invalid result.");
      return { topics: parsed.topics.flatMap((topic) => {
        if (!topic || typeof topic !== "object") return [];
        const entry = topic as Record<string, unknown>;
        const cleanItems = (value: unknown) => Array.isArray(value) ? value.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          return typeof record.text === "string" && Array.isArray(record.unitIds)
            ? [{ text: record.text.slice(0, 900), unitIds: record.unitIds.filter((id): id is string => typeof id === "string") }]
            : [];
        }).slice(0, 3) : [];
        return typeof entry.topicId === "string" ? [{ topicId: entry.topicId, definitions: cleanItems(entry.definitions), formulas: cleanItems(entry.formulas), examples: cleanItems(entry.examples) }] : [];
      }) };
      });
    } catch (error) {
      if (!isModelQuotaError(error)) throw error;
      usedSourceFallback = true;
      generated = { topics: topics.map(([topicId, group]) => ({
        topicId,
        definitions: group.rows.slice(0, 3)
          .map((row) => ({ text: sourceExcerpt(row.unitText), unitIds: [row.unitId] }))
          .filter((item) => !!item.text),
        formulas: [],
        examples: [],
      })) };
    }
    const byUnit = new Map<string, EvidenceRow>();
    for (const row of rows) byUnit.set(row.unitId, row);
    const topicName = new Map(topics.map(([id, group]) => [id, group.topic]));
    const allowedTopicIds = new Set(topicName.keys());
    const attachCitations = (items: Array<{ text: string; unitIds: string[] }>) => items.flatMap((item) => {
      const cited = [...new Set(item.unitIds)].map((id) => byUnit.get(id)).filter((row): row is EvidenceRow => !!row);
      return cited.length ? [{ text: safeString(item.text, 550), citations: cited.slice(0, 4).map(citation) }] : [];
    });
    const sheetTopics = generated.topics.filter((topic) => allowedTopicIds.has(topic.topicId)).map((topic) => ({
      id: topic.topicId,
      topic: topicName.get(topic.topicId) ?? "Topic",
      definitions: attachCitations(topic.definitions),
      formulas: attachCitations(topic.formulas),
      examples: attachCitations(topic.examples),
    })).filter((topic) => topic.definitions.length || topic.formulas.length || topic.examples.length);
    res.json({ topics: sheetTopics, fallback: usedSourceFallback, omittedTopicCount: Math.max(0, grouped.size - topics.length), note: usedSourceFallback
      ? "The explanation service is busy. These are direct excerpts from your course sources, not AI-written definitions; open the citations to review context."
      : "Every listed item has at least one ready-source citation. Print this page and choose Save as PDF to export." });
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) || "Could not create the exam cheat sheet." });
  }
});

router.post("/x/courses/:courseId/past-paper-predictor", async (req: Request, res: Response) => {
  const ctx = await courseContext(req, res);
  if (!ctx) return;
  const rawSourceIds: unknown[] = Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : [];
  if (!rawSourceIds.length || rawSourceIds.some((id) => typeof id !== "string" || !validStudygraphId(id))) {
    res.status(400).json({ error: "Select at least one valid past-paper source." });
    return;
  }
  const sourceIds = [...new Set(rawSourceIds as string[])];
  try {
    const allowedSources = await db.select({ id: sourcesTable.id, title: sourcesTable.title, sourceType: sourcesTable.sourceType })
      .from(sourcesTable)
      .where(and(eq(sourcesTable.courseId, ctx.courseId), eq(sourcesTable.ownerId, ctx.ownerId), eq(sourcesTable.status, "ready"), inArray(sourcesTable.sourceType, ["pdf", "pptx"]), inArray(sourcesTable.id, sourceIds)));
    if (allowedSources.length !== sourceIds.length) {
      res.status(400).json({ error: "One or more selected papers are not ready, are not a PDF or slide deck, or do not belong to this course." });
      return;
    }
    const rows = await db.select({
      topicId: topicsTable.id,
      topicName: topicsTable.name,
      conceptId: conceptsTable.id,
      conceptName: conceptsTable.name,
      unitId: unitsTable.id,
      unitText: unitsTable.text,
      locator: unitsTable.locator,
      sourceId: sourcesTable.id,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
    })
      .from(unitsTable)
      .innerJoin(sourcesTable, eq(sourcesTable.id, unitsTable.sourceId))
      .innerJoin(unitConceptsTable, eq(unitConceptsTable.unitId, unitsTable.id))
      .innerJoin(conceptsTable, eq(conceptsTable.id, unitConceptsTable.conceptId))
      .innerJoin(topicsTable, eq(topicsTable.id, conceptsTable.topicId))
      .where(and(eq(sourcesTable.courseId, ctx.courseId), eq(sourcesTable.ownerId, ctx.ownerId), eq(sourcesTable.status, "ready"), inArray(sourcesTable.id, sourceIds)))
      .orderBy(asc(topicsTable.name));
    const byTopic = new Map<string, { topic: string; concepts: Set<string>; units: Map<string, EvidenceRow>; papers: Set<string> }>();
    for (const row of rows as EvidenceRow[]) {
      let item = byTopic.get(row.topicId);
      if (!item) {
        item = { topic: row.topicName, concepts: new Set(), units: new Map(), papers: new Set() };
        byTopic.set(row.topicId, item);
      }
      item.concepts.add(row.conceptId);
      item.units.set(row.unitId, row);
      item.papers.add(row.sourceId);
    }
    const topicEvidence = [...byTopic.entries()].map(([id, item]) => {
      const mentionCount = item.units.size;
      const paperCount = item.papers.size;
      const conceptCount = item.concepts.size;
      return { id, topic: item.topic, paperCount, conceptCount, mentionCount, units: [...item.units.values()] };
    });
    const maxMentions = Math.max(1, ...topicEvidence.map((item) => item.mentionCount));
    const topics = topicEvidence.map((item) => {
      // Priority is a transparent relative ranking: repeated appearances across
      // papers matter most, with within-course frequency and concept breadth as
      // supporting signals. It never claims probability of a future exam item.
      const paperCoverage = item.paperCount / Math.max(1, allowedSources.length);
      const relativeFrequency = item.mentionCount / maxMentions;
      const conceptBreadth = Math.min(1, item.conceptCount / 4);
      const coverageScore = Math.round(55 * paperCoverage + 30 * relativeFrequency + 15 * conceptBreadth);
      const importance = item.paperCount >= Math.min(2, allowedSources.length) && coverageScore >= 55 || coverageScore >= 70
        ? "High priority"
        : coverageScore >= 40 ? "Worth reviewing" : "Some evidence";
      return {
        id: item.id,
        topic: item.topic,
        coverageScore,
        importance,
        signal: `${importance} · found in ${item.paperCount} of ${allowedSources.length} papers · ${item.mentionCount} source passages · ${item.conceptCount} linked concepts`,
        paperCount: item.paperCount,
        conceptCount: item.conceptCount,
        mentionCount: item.mentionCount,
        citations: item.units.slice(0, 6).map((row) => citation(row)),
      };
    }).sort((a, b) => b.coverageScore - a.coverageScore || b.paperCount - a.paperCount || b.mentionCount - a.mentionCount);
    res.json({ topics, selectedSources: allowedSources, totalSelectedPapers: allowedSources.length, disclaimer: "Priority is based on repeated appearances, passage frequency, and linked concept breadth in the selected papers. It highlights useful revision topics, not a guarantee of what will appear in a future exam. Check the citations against each paper." });
  } catch (error) {
    res.status(503).json({ error: errorMessage(error) || "Could not analyze the selected papers." });
  }
});

export default router;
