import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  conceptEdgesTable,
  quizQuestionsTable,
  quizzesTable,
  sourcesTable,
  unitsTable,
  type AnswerKey,
  type QuestionType,
  type QuestionVerification,
  type QuizStats,
  type StudyCitation,
} from "@workspace/db/schema";
import { embedTexts, mapLimit, modelConfig, openai, withRetry } from "../ingestion/ai";
import { citationFor, type GroundedUnit } from "../studygraph/retrieval";
import { priorityScore } from "./bkt";
import { evaluateExpression, withinTolerance } from "./mathExpr";
import {
  cosine,
  loadConceptPool,
  loadMasteryMap,
  parseJsonLoose,
  QuizError,
  shuffle,
  stateOf,
  weightedSample,
  type PoolConcept,
} from "./shared";

export type QuizMode = "practice" | "diagnostic" | "mock" | "chat";
export type QuizStrategy = "adaptive" | "random";
export type Difficulty = "easy" | "medium" | "hard" | "mixed";

export type QuizRequest = {
  courseId: string;
  ownerId: string;
  learnerId: string;
  count: number;
  difficulty: Difficulty;
  types: QuestionType[];
  mode: QuizMode;
  strategy: QuizStrategy;
  topicId?: string;
  unitIds?: string[];
};

/** Cosine similarity at or above this counts as a repeated question. */
export const DUPLICATE_THRESHOLD = 0.88;

type Candidate = {
  type: QuestionType;
  prompt: string;
  difficulty: "easy" | "medium" | "hard";
  unitIds: string[];
  conceptIds: string[];
  explanation: string;
  options: string[] | null;
  misconceptions: (string | null)[] | null;
  key: AnswerKey;
  expression?: string;
};

type UnitRow = {
  id: string;
  sourceId: string;
  text: string;
  figureCaption: string | null;
  locator: GroundedUnit["locator"];
  sourceTitle: string;
  sourceType: GroundedUnit["sourceType"];
};

function sourceLinkedFallbackQuestions(
  chosen: PoolConcept[],
  pool: PoolConcept[],
  units: Map<string, UnitRow>,
  count: number,
): Candidate[] {
  const allNames = [...new Set(pool.map((concept) => concept.name.trim()).filter(Boolean))];
  return chosen.flatMap((concept) => {
    const unitId = concept.unitIds.find((id) => units.has(id));
    if (!unitId || !concept.name.trim()) return [];
    const unit = units.get(unitId);
    const excerpt = (unit?.figureCaption || unit?.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!excerpt) return [];
    const distractors = shuffle(allNames.filter((name) => name !== concept.name)).slice(0, 3);
    const options = shuffle([concept.name, ...distractors]);
    // Keep the question unambiguous even for very small courses.
    for (const extra of ["A different course topic", "Not linked to this source section", "Not shown in the course map"]) {
      if (options.length >= 4) break;
      if (!options.includes(extra) && extra !== concept.name) options.push(extra);
    }
    const correctOption = options.indexOf(concept.name);
    return [{
      type: "mcq" as const,
      prompt: `Which course concept is most closely connected to this note? “${excerpt}”`,
      difficulty: "easy" as const,
      unitIds: [unitId],
      conceptIds: [concept.id],
      explanation: `The course map connects this note to “${concept.name}.”`,
      options,
      misconceptions: options.map((option) => option === concept.name ? null : "This is not the concept linked to the selected source section."),
      key: { type: "mcq" as const, correctOption },
    }];
  }).slice(0, count);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

async function chooseConcepts(
  request: QuizRequest,
  pool: PoolConcept[],
): Promise<PoolConcept[]> {
  const k = Math.min(
    pool.length,
    request.mode === "diagnostic" || request.mode === "mock"
      ? request.count
      : Math.max(1, Math.ceil(request.count / 2)),
  );

  if (request.strategy === "random") return shuffle(pool).slice(0, k);

  const mastery = await loadMasteryMap(request.learnerId, pool.map((c) => c.id));

  if (request.mode === "diagnostic" || request.mode === "mock") {
    // Broad coverage: round-robin across topics, least-tested concepts first.
    const byTopic = new Map<string, PoolConcept[]>();
    for (const concept of shuffle(pool)) {
      const list = byTopic.get(concept.topicId) ?? [];
      list.push(concept);
      byTopic.set(concept.topicId, list);
    }
    for (const list of byTopic.values()) {
      list.sort(
        (a, b) =>
          (mastery.get(a.id)?.attempts ?? 0) - (mastery.get(b.id)?.attempts ?? 0),
      );
    }
    const lists = [...byTopic.values()];
    const chosen: PoolConcept[] = [];
    for (let round = 0; chosen.length < k; round += 1) {
      let added = false;
      for (const list of lists) {
        if (list[round] && chosen.length < k) {
          chosen.push(list[round]);
          added = true;
        }
      }
      if (!added) break;
    }
    return chosen;
  }

  // Adaptive practice: weight by priority, with a prerequisite boost.
  const edges = await db
    .select({
      prerequisite: conceptEdgesTable.prerequisiteConceptId,
      dependent: conceptEdgesTable.dependentConceptId,
    })
    .from(conceptEdgesTable)
    .where(eq(conceptEdgesTable.courseId, request.courseId));
  const boost = new Map<string, number>();
  for (const edge of edges) {
    const dependent = mastery.get(edge.dependent);
    const prerequisite = mastery.get(edge.prerequisite);
    const dependentWeak = !!dependent && dependent.attempts > 0 && dependent.pKnown < 0.5;
    const prerequisiteWeak = !prerequisite || prerequisite.pKnown < 0.5;
    if (dependentWeak && prerequisiteWeak) {
      boost.set(edge.prerequisite, (boost.get(edge.prerequisite) ?? 0) + 0.3);
    }
  }
  const weights = pool.map((concept) => {
    const score = priorityScore(stateOf(mastery.get(concept.id))) + (boost.get(concept.id) ?? 0);
    return score * score;
  });
  return weightedSample(pool, weights, k);
}

function unitContext(units: UnitRow[], maxChars = 1600): string {
  return units
    .map((unit) =>
      [
        `UNIT_ID: ${unit.id}`,
        `SOURCE: ${unit.sourceTitle}`,
        `CONTENT: ${(unit.figureCaption ? `[Figure] ${unit.figureCaption}\n` : "") + unit.text.slice(0, maxChars)}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

function normalizeCandidates(
  raw: unknown,
  allowedUnits: Set<string>,
  allowedConcepts: Set<string>,
  allowedTypes: Set<QuestionType>,
  fixedDifficulty: Difficulty,
): Candidate[] {
  if (!Array.isArray(raw)) return [];
  const result: Candidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const type = asString(q.type) as QuestionType;
    const prompt = asString(q.prompt);
    if (!allowedTypes.has(type) || prompt.length < 10) continue;
    const unitIds = asStringArray(q.unitIds).filter((id) => allowedUnits.has(id));
    if (unitIds.length === 0) continue;
    const conceptIds = asStringArray(q.conceptIds).filter((id) => allowedConcepts.has(id));
    const rawDifficulty = asString(q.difficulty);
    const difficulty: "easy" | "medium" | "hard" =
      fixedDifficulty !== "mixed"
        ? fixedDifficulty
        : rawDifficulty === "easy" || rawDifficulty === "hard"
          ? rawDifficulty
          : "medium";
    const explanation = asString(q.explanation) || "See the cited source.";

    if (type === "mcq") {
      const options = asStringArray(q.options);
      const correct = Number(q.correctOption);
      if (
        options.length !== 4 ||
        new Set(options.map((o) => o.toLowerCase())).size !== 4 ||
        !Number.isInteger(correct) ||
        correct < 0 ||
        correct > 3
      ) {
        continue;
      }
      const rawMis = Array.isArray(q.misconceptions) ? q.misconceptions : [];
      const misconceptions = options.map((_, index) =>
        index === correct ? null : asString(rawMis[index]) || null,
      );
      result.push({
        type, prompt, difficulty, unitIds, conceptIds, explanation, options, misconceptions,
        key: { type: "mcq", correctOption: correct },
      });
    } else if (type === "short") {
      const modelAnswer = asString(q.modelAnswer);
      const keyPoints = asStringArray(q.keyPoints).slice(0, 5);
      if (!modelAnswer || keyPoints.length < 1) continue;
      result.push({
        type, prompt, difficulty, unitIds, conceptIds, explanation, options: null, misconceptions: null,
        key: { type: "short", modelAnswer, keyPoints },
      });
    } else if (type === "numeric") {
      const expression = asString(q.expression);
      if (!expression) continue;
      let value: number;
      try {
        value = evaluateExpression(expression);
      } catch {
        continue;
      }
      const tolerancePct = Math.min(10, Math.max(0.1, Number(q.tolerancePct) || 1));
      result.push({
        type, prompt, difficulty, unitIds, conceptIds, explanation, options: null, misconceptions: null,
        expression,
        key: { type: "numeric", value, unit: asString(q.unit), tolerancePct, expression },
      });
    }
  }
  return result;
}

async function validatorJson(system: string, user: string) {
  const response = await withRetry(() =>
    openai().chat.completions.create({
      model: modelConfig.validator,
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  );
  return parseJsonLoose(response.choices[0]?.message?.content ?? "");
}

/**
 * Cross-model verification: a DIFFERENT model must independently reach the
 * same answer using only the cited units. Numerical answers are additionally
 * checked by evaluating both models' expressions with code.
 */
async function verifyCandidate(
  candidate: Candidate,
  units: Map<string, UnitRow>,
): Promise<QuestionVerification & { ok: boolean }> {
  const cited = candidate.unitIds
    .map((id) => units.get(id))
    .filter((unit): unit is UnitRow => !!unit)
    .slice(0, 4);
  const context = unitContext(cited, 1500);
  try {
    if (candidate.type === "mcq" && candidate.options && candidate.key.type === "mcq") {
      const out = await validatorJson(
        'Answer the multiple-choice question using ONLY the supplied units. Return JSON {"choice": integer 0-3, or -1 if the units do not support any option, "reason": string}.',
        `UNITS:\n${context}\n\nQUESTION: ${candidate.prompt}\n${candidate.options.map((o, i) => `${i}. ${o}`).join("\n")}`,
      );
      const choice = Number(out?.choice);
      const ok = choice === candidate.key.correctOption;
      return {
        ok,
        status: ok ? "verified" : "unverified",
        method: `independent-solve:${modelConfig.validator}`,
        detail: ok ? undefined : `Validator chose ${choice}, key was ${candidate.key.correctOption}.`,
      };
    }
    if (candidate.type === "numeric" && candidate.key.type === "numeric") {
      const out = await validatorJson(
        'Solve the problem using ONLY the supplied units. Return JSON {"expression": a pure arithmetic expression using only numbers and + - * / ^ ( ) sqrt ln log10 exp pi that evaluates to the final answer, "unit": string}.',
        `UNITS:\n${context}\n\nPROBLEM: ${candidate.prompt}`,
      );
      const theirs = evaluateExpression(asString(out?.expression));
      const ok = withinTolerance(theirs, candidate.key.value, Math.max(1, candidate.key.tolerancePct));
      return {
        ok,
        status: ok ? "verified" : "unverified",
        method: `independent-solve+code:${modelConfig.validator}`,
        detail: ok ? undefined : `Validator computed ${theirs}, key was ${candidate.key.value}.`,
      };
    }
    if (candidate.type === "short" && candidate.key.type === "short") {
      const out = await validatorJson(
        'Decide whether the proposed answer correctly answers the question AND is fully supported by the supplied units. Return JSON {"supported": boolean, "issue": string}.',
        `UNITS:\n${context}\n\nQUESTION: ${candidate.prompt}\nPROPOSED ANSWER: ${candidate.key.modelAnswer}`,
      );
      const ok = out?.supported === true;
      return {
        ok,
        status: ok ? "verified" : "unverified",
        method: `support-check:${modelConfig.validator}`,
        detail: ok ? undefined : asString(out?.issue) || "Not supported by the cited units.",
      };
    }
  } catch (error) {
    return {
      ok: false,
      status: "unverified",
      method: "error",
      detail: error instanceof Error ? error.message.slice(0, 160) : "Verification failed.",
    };
  }
  return { ok: false, status: "unverified", method: "none" };
}

async function embedMany(texts: string[]): Promise<number[][]> {
  return embedTexts(texts);
}

async function maxSimilarityToPrevious(
  learnerId: string,
  courseId: string,
  embedding: number[],
): Promise<number> {
  const vectorLiteral = sql`${JSON.stringify(embedding)}::vector`;
  const rows = await db
    .select({ similarity: sql<number>`1 - (${quizQuestionsTable.embedding} <=> ${vectorLiteral})` })
    .from(quizQuestionsTable)
    .where(
      and(
        eq(quizQuestionsTable.learnerId, learnerId),
        eq(quizQuestionsTable.courseId, courseId),
      ),
    )
    .orderBy(sql`${quizQuestionsTable.embedding} <=> ${vectorLiteral}`)
    .limit(1);
  return rows.length ? Number(rows[0].similarity) : 0;
}

export async function buildQuiz(request: QuizRequest): Promise<{ quizId: string; stats: QuizStats }> {
  const pool = await loadConceptPool({
    courseId: request.courseId,
    ownerId: request.ownerId,
    topicId: request.topicId,
    restrictUnitIds: request.unitIds,
  });
  if (pool.length === 0) {
    throw new QuizError(
      "No tagged concepts are available yet. Process at least one source first (or pick a different topic).",
      409,
    );
  }

  const chosen = await chooseConcepts(request, pool);
  const unitCap = request.unitIds ? 6 : 14;
  const unitIdSet = new Set<string>();
  for (const concept of chosen) {
    for (const id of shuffle(concept.unitIds).slice(0, 3)) {
      if (unitIdSet.size < unitCap) unitIdSet.add(id);
    }
  }
  const unitRows: UnitRow[] = await db
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
    .where(inArray(unitsTable.id, [...unitIdSet]));
  const units = new Map(unitRows.map((unit) => [unit.id, unit]));
  const allowedConcepts = new Set(chosen.map((c) => c.id));

  // Avoid recently asked questions (soft instruction; hard check comes later).
  const recent =
    request.strategy === "adaptive"
      ? await db
          .select({ prompt: quizQuestionsTable.prompt })
          .from(quizQuestionsTable)
          .where(
            and(
              eq(quizQuestionsTable.learnerId, request.learnerId),
              eq(quizQuestionsTable.courseId, request.courseId),
            ),
          )
          .orderBy(desc(quizQuestionsTable.createdAt))
          .limit(20)
      : [];

  const requested = request.count;
  // Generate a small validation cushion instead of 50% extra questions; every
  // candidate is independently verified, so over-generation multiplies latency.
  const toGenerate = Math.min(16, requested + Math.max(1, Math.ceil(requested * 0.15)));
  const typeList = request.types.join(", ");
  const conceptContext = chosen.map((c) => `CONCEPT_ID: ${c.id} | ${c.name}`).join("\n");

  let candidates: Candidate[] = [];
  let localFallback = false;
  try {
    const response = await withRetry(() =>
      openai().chat.completions.create({
        model: modelConfig.assessment,
        max_completion_tokens: 7000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You write exam questions strictly from the supplied course units. Use only facts present in the units, never outside knowledge.",
              `Return JSON: {"title": string, "questions": [ ... ]}. Create exactly ${toGenerate} questions using these types: ${typeList}. Spread questions across the supplied concepts.`,
              'Every question has: "type" ("mcq"|"short"|"numeric"), "prompt", "difficulty" ("easy"|"medium"|"hard"), "unitIds" (exact UNIT_ID values that support the answer), "conceptIds" (exact CONCEPT_ID values tested), "explanation" (1-3 sentences grounded in the units).',
              'mcq: add "options" (exactly 4 distinct strings), "correctOption" (0-3), and "misconceptions": an array of 4 where each WRONG option is a short label (max 10 words) naming the specific misconception that option represents, and the correct option is null.',
              'short: add "modelAnswer" (1-3 sentences) and "keyPoints" (2-4 short strings a correct answer must contain).',
              'numeric: add "expression" (pure arithmetic using only numbers and + - * / ^ ( ) sqrt ln log10 exp pi that evaluates to the final answer), "unit" (string), "tolerancePct" (number, usually 1). Only write numeric questions when the units contain a quantitative relationship or worked numbers, and the prompt must state every number needed. Otherwise use another allowed type.',
              request.difficulty === "mixed" ? "Mix difficulties." : `All questions must be ${request.difficulty} difficulty.`,
              recent.length ? `Do NOT repeat or paraphrase these earlier questions:\n${recent.map((r) => `- ${r.prompt}`).join("\n")}` : "",
              `CONCEPTS:\n${conceptContext}`,
              `COURSE UNITS:\n${unitContext(unitRows)}`,
            ].filter(Boolean).join("\n\n"),
          },
          { role: "user", content: `Write the ${toGenerate} questions now.` },
        ],
      }),
    );
    const parsed = parseJsonLoose(response.choices[0]?.message?.content ?? "");
    candidates = normalizeCandidates(
      parsed?.questions,
      new Set(unitRows.map((u) => u.id)),
      allowedConcepts,
      new Set(request.types),
      request.difficulty,
    );
  } catch {
    // A course-map quiz remains available even when the external model is busy.
    localFallback = true;
  }
  if (candidates.length === 0) {
    localFallback = true;
    candidates = sourceLinkedFallbackQuestions(chosen, pool, units, requested);
  }
  if (candidates.length === 0) {
    throw new QuizError("The model did not return usable questions. Please try again.", 502);
  }
  const quizTitle = localFallback ? "Course concepts quiz" : `${request.mode[0].toUpperCase()}${request.mode.slice(1)} quiz`;

  // 1) Cross-model verification (in parallel, bounded).
  // STUDYGRAPH_SKIP_VERIFY=true disables the check; used only by /eval to
  // measure answer-key accuracy before vs. after cross-model validation.
  const skipVerify = process.env.STUDYGRAPH_SKIP_VERIFY === "true";
  const verifications = localFallback
    ? candidates.map(() => ({ ok: true, status: "verified" as const, method: "course-map-link" }))
    : skipVerify
    ? candidates.map(() => ({ ok: true, status: "unverified" as const, method: "skipped" }))
    : await mapLimit(candidates, 4, (candidate) => verifyCandidate(candidate, units));
  let verified = candidates
    .map((candidate, index) => ({ candidate, verification: verifications[index] }))
    .filter((entry) => entry.verification.ok);
  const rejectedVerification = candidates.length - verified.length;

  if (verified.length === 0 && !localFallback) {
    localFallback = true;
    candidates = sourceLinkedFallbackQuestions(chosen, pool, units, requested);
    verified = candidates.map((candidate) => ({ candidate, verification: { ok: true, status: "verified" as const, method: "course-map-link" } }));
  }

  // 2) Novelty: reject near-duplicates of earlier questions and of each other.
  const embeddings = verified.length ? await embedMany(verified.map((v) => v.candidate.prompt)) : [];
  const kept: Array<{ candidate: Candidate; verification: QuestionVerification; embedding: number[] }> = [];
  let rejectedDuplicate = 0;
  let repeatsServed = 0;
  for (let i = 0; i < verified.length && kept.length < requested; i += 1) {
    const embedding = embeddings[i];
    const previous = await maxSimilarityToPrevious(request.learnerId, request.courseId, embedding);
    const withinBatch = kept.some((entry) => cosine(entry.embedding, embedding) >= DUPLICATE_THRESHOLD);
    const isRepeat = previous >= DUPLICATE_THRESHOLD || withinBatch;
    if (isRepeat && request.strategy === "adaptive" && !localFallback) {
      rejectedDuplicate += 1;
      continue;
    }
    if (isRepeat) repeatsServed += 1; // baseline: served anyway, but measured
    const { ok: _ok, ...verification } = verified[i].verification;
    kept.push({ candidate: verified[i].candidate, verification, embedding });
  }
  if (kept.length === 0) {
    throw new QuizError(
      "Every generated question failed verification or was a repeat. Try again or widen the scope.",
      502,
    );
  }

  const stats: QuizStats = {
    requested,
    generated: candidates.length,
    rejectedVerification,
    rejectedDuplicate,
    repeatsServed,
    kept: kept.length,
  };

  const [quiz] = await db
    .insert(quizzesTable)
    .values({
      courseId: request.courseId,
      learnerId: request.learnerId,
      mode: request.mode,
      strategy: request.strategy,
      title: quizTitle,
      difficulty: request.difficulty,
      stats,
    })
    .returning({ id: quizzesTable.id });

  const conceptTopic = new Map(pool.map((c) => [c.id, c.topicId]));
  await db.insert(quizQuestionsTable).values(
    kept.map((entry, index) => {
      const { candidate } = entry;
      const conceptIds = candidate.conceptIds.length ? candidate.conceptIds : chosen.slice(0, 1).map((c) => c.id);
      const citations: StudyCitation[] = candidate.unitIds
        .map((id) => units.get(id))
        .filter((unit): unit is UnitRow => !!unit)
        .map((unit) => citationFor({ ...unit, similarity: 1 }));
      return {
        quizId: quiz.id,
        courseId: request.courseId,
        learnerId: request.learnerId,
        position: index,
        type: candidate.type,
        prompt: candidate.prompt,
        options: candidate.options,
        answerKey: candidate.key,
        explanation: candidate.explanation,
        difficulty: candidate.difficulty,
        topicId: conceptTopic.get(conceptIds[0]) ?? null,
        conceptIds,
        unitIds: candidate.unitIds,
        citations,
        misconceptions: candidate.misconceptions,
        verification: entry.verification,
        embedding: entry.embedding,
      };
    }),
  );
  return { quizId: quiz.id, stats };
}
