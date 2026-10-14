import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  sourcesTable,
  type StudyCitation,
  type SourceLocator,
  unitsTable,
} from "@workspace/db/schema";
import {
  cachedAI,
  embedForIndex,
  semanticActive,
  semanticMinSimilarity,
  vectorSearchSafe,
  modelConfig,
  sha256,
} from "../ingestion/ai";

export type GroundedUnit = {
  id: string;
  sourceId: string;
  text: string;
  figureCaption: string | null;
  locator: SourceLocator;
  sourceTitle: string;
  sourceType: "pdf" | "pptx" | "video";
  similarity: number;
};

const STOPWORDS = new Set(
  "a an the of in on at to for from by with about into over under is are was were be been being do does did can could should would will shall may might this that these those it its as and or but if then than so such what which who whom whose when where why how explain describe tell give me please define show main idea ideas first lecture lectures topic topics course material about i you we they he she them us my your our their there here also not no yes any some more most very just".split(
    " ",
  ),
);
const OVERVIEW_PATTERN =
  /\b(main idea|summar|overview|introduc|outline|what is this|what's this|about this|first lecture|lecture 1|key points|covers?)\b/i;

// Expand common subject acronyms before retrieval. In particular, two-letter
// forms like “ML” were previously discarded by the lexical minimum-length rule.
const STUDY_ACRONYMS: Record<string, string> = {
  ai: "artificial intelligence",
  ml: "machine learning",
  dl: "deep learning",
  nlp: "natural language processing",
  llm: "large language model",
  rag: "retrieval augmented generation",
  cnn: "convolutional neural network",
  rnn: "recurrent neural network",
  gan: "generative adversarial network",
  svm: "support vector machine",
  knn: "k nearest neighbors",
  api: "application programming interface",
  ocr: "optical character recognition",
  sql: "structured query language database",
};

function expandStudyAcronyms(question: string): string {
  const terms = (question.match(/\b[a-z]{2,8}\b/gi) ?? [])
    .map((token) => STUDY_ACRONYMS[token.toLowerCase()])
    .filter((term): term is string => Boolean(term));
  return terms.length ? `${question} ${[...new Set(terms)].join(" ")}` : question;
}

/** OR-joined, prefix-matched tsquery so one missing word never zeroes out the results. */
function buildTsQuery(question: string): string | null {
  const tokens: string[] = (question.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token: string) => token.length > 2 && !STOPWORDS.has(token))
    .slice(0, 24)
    .map((token) => (token.length >= 6 ? token.slice(0, token.length - 2) : token));
  const unique = [...new Set(tokens)];
  return unique.length ? unique.map((token) => `${token}:*`).join(" | ") : null;
}

export async function retrieveRelevantUnits(
  courseId: string,
  ownerId: string,
  question: string,
): Promise<GroundedUnit[]> {
  const normalizedQuestion = question
    .replace(/\n\n\(Please answer in [\s\S]*\)\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
  const expandedQuestion = expandStudyAcronyms(normalizedQuestion);
  const tsQuery = buildTsQuery(expandedQuestion);
  const wantsOverview = OVERVIEW_PATTERN.test(normalizedQuestion);
  const vectorOk = await vectorSearchSafe();
  const embedding = vectorOk
    ? await cachedAI<number[]>(
        `studygraph:query:${modelConfig.embedding}:${sha256(expandedQuestion.toLowerCase())}`,
        modelConfig.embedding,
        async () => (await embedForIndex([expandedQuestion], "query"))[0],
      )
    : null;

  const vectorLiteral = sql`${JSON.stringify(embedding ?? new Array(1536).fill(0))}::vector`;
  const distance = sql<number>`${unitsTable.embedding} <=> ${vectorLiteral}`;
  const baseFilters = [
    eq(sourcesTable.courseId, courseId),
    eq(sourcesTable.ownerId, ownerId),
    eq(sourcesTable.status, "ready"),
    sql`${unitsTable.embedding} IS NOT NULL`,
  ];

  const vectorMatches = await db
    .select({
      id: unitsTable.id,
      sourceId: unitsTable.sourceId,
      text: unitsTable.text,
      figureCaption: unitsTable.figureCaption,
      locator: unitsTable.locator,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
      distance,
    })
    .from(unitsTable)
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .where(and(...baseFilters))
    .orderBy(distance)
    .limit(embedding ? 14 : 0);

  const lexicalMatches = tsQuery
    ? await db
        .select({
          id: unitsTable.id,
          sourceId: unitsTable.sourceId,
          text: unitsTable.text,
          figureCaption: unitsTable.figureCaption,
          locator: unitsTable.locator,
          sourceTitle: sourcesTable.title,
          sourceType: sourcesTable.sourceType,
          rank: sql<number>`ts_rank(to_tsvector('simple', ${unitsTable.text}), to_tsquery('simple', ${tsQuery}))`,
        })
        .from(unitsTable)
        .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
        .where(
          and(
            eq(sourcesTable.courseId, courseId),
            eq(sourcesTable.ownerId, ownerId),
            eq(sourcesTable.status, "ready"),
            sql`to_tsvector('simple', ${unitsTable.text}) @@ to_tsquery('simple', ${tsQuery})`,
          ),
        )
        .orderBy(
          desc(
            sql`ts_rank(to_tsvector('simple', ${unitsTable.text}), to_tsquery('simple', ${tsQuery}))`,
          ),
        )
        .limit(12)
    : [];

  // Broad questions ("main idea", "summary") are answered from the opening material of each source.
  const overviewMatches = wantsOverview
    ? await db
        .select({
          id: unitsTable.id,
          sourceId: unitsTable.sourceId,
          text: unitsTable.text,
          figureCaption: unitsTable.figureCaption,
          locator: unitsTable.locator,
          sourceTitle: sourcesTable.title,
          sourceType: sourcesTable.sourceType,
        })
        .from(unitsTable)
        .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
        .where(
          and(
            eq(sourcesTable.courseId, courseId),
            eq(sourcesTable.ownerId, ownerId),
            eq(sourcesTable.status, "ready"),
          ),
        )
        .orderBy(
          sourcesTable.createdAt,
          sql`coalesce((${unitsTable.locator}->>'page')::int, (${unitsTable.locator}->>'slide')::int, 0)`,
          sql`coalesce((${unitsTable.locator}->>'start_sec')::float, 0)`,
        )
        .limit(6)
    : [];

  const candidates = new Map<
    string,
    GroundedUnit & { rankScore: number; lexicalHit: boolean }
  >();
  vectorMatches.forEach((row, index) => {
    const similarity = Math.max(0, Math.min(1, 1 - Number(row.distance)));
    if (similarity < (semanticActive() ? semanticMinSimilarity() : 0.04)) return;
    candidates.set(row.id, {
      ...row,
      similarity,
      rankScore: 1 / (60 + index) + similarity / 500,
      lexicalHit: false,
    });
  });
  lexicalMatches.forEach((row, index) => {
    const existing = candidates.get(row.id);
    const bonus = 1 / (60 + index);
    if (existing) {
      existing.rankScore += bonus;
      existing.lexicalHit = true;
    } else if (Number(row.rank) > 0) {
      candidates.set(row.id, {
        ...row,
        similarity: 0,
        rankScore: bonus,
        lexicalHit: true,
      });
    }
  });

  overviewMatches.forEach((row, index) => {
    if (!candidates.has(row.id)) {
      candidates.set(row.id, {
        ...row,
        similarity: 0,
        rankScore: 1 / (50 + index),
        lexicalHit: false,
      });
    }
  });

  return [...candidates.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, 10)
    .map(({ rankScore: _rankScore, lexicalHit: _lexicalHit, ...unit }) => unit);
}

export function citationFor(unit: GroundedUnit): StudyCitation {
  const excerpt = (unit.figureCaption || unit.text).trim();
  return {
    unitId: unit.id,
    sourceId: unit.sourceId,
    sourceTitle: unit.sourceTitle,
    sourceType: unit.sourceType,
    locator: unit.locator,
    excerpt:
      excerpt.length > 720 ? `${excerpt.slice(0, 717).trimEnd()}…` : excerpt,
  };
}

/** Loads specific units (for example the ones cited in the previous answer) so follow-up questions stay grounded. */
export async function loadUnitsByIds(
  courseId: string,
  ownerId: string,
  ids: string[],
): Promise<GroundedUnit[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: unitsTable.id,
      sourceId: unitsTable.sourceId,
      text: unitsTable.text,
      figureCaption: unitsTable.figureCaption,
      locator: unitsTable.locator,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
    })
    .from(unitsTable)
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .where(
      and(
        inArray(unitsTable.id, ids),
        eq(sourcesTable.courseId, courseId),
        eq(sourcesTable.ownerId, ownerId),
        eq(sourcesTable.status, "ready"),
      ),
    );
  const order = new Map(ids.map((id, index) => [id, index]));
  return rows
    .map((row) => ({ ...row, similarity: 1 }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
