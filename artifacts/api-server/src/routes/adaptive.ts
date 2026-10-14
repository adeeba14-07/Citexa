import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  bktEventsTable,
  bktMasteryTable,
  conceptEdgesTable,
  conceptsTable,
  misconceptionLogTable,
  quizAttemptsTable,
  quizQuestionsTable,
  quizzesTable,
  savedStudyPlansTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
  type QuestionType,
  type StudyCitation,
} from "@workspace/db/schema";
import { errorMessage, mapLimit, modelConfig, openai, withRetry } from "../lib/ingestion/ai";
import {
  findOwnedCourse,
  studygraphOwnerId,
  studygraphPathParam,
  validStudygraphId,
} from "../lib/studygraph/ownership";
import { citationFor } from "../lib/studygraph/retrieval";
import { pageCountFor } from "./sourceview";
import { masteryLabel, priorityScore } from "../lib/adaptive/bkt";
import { ensureUserDataTables } from "../lib/ensureUserDataTables";
import {
  applyQuizEvidence,
  buildReport,
  gradeQuestion,
  logMisconceptions,
  recordEvidence,
} from "../lib/adaptive/grading";
import {
  buildQuiz,
  DUPLICATE_THRESHOLD,
  type Difficulty,
  type QuizMode,
  type QuizStrategy,
} from "../lib/adaptive/quiz";
import {
  learnerKey,
  loadConceptPool,
  loadMasteryMap,
  parseJsonLoose,
  QuizError,
  shuffle,
  stateOf,
} from "../lib/adaptive/shared";

const router: IRouter = Router();

function fail(res: Response, error: unknown) {
  if (error instanceof QuizError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: errorMessage(error) });
}

async function loadContext(req: Request, res: Response) {
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
  return { ownerId, courseId, course, learnerId: learnerKey(ownerId, req.header("x-learner-id")) };
}

function storageUrl(objectPath: string | null | undefined): string | null {
  return objectPath && objectPath.startsWith("/objects/") ? `/api/storage${objectPath}` : null;
}

/* ------------------------------------------------------------------ quizzes */

async function quizView(quizId: string, learnerId: string) {
  const [quiz] = await db.select().from(quizzesTable).where(eq(quizzesTable.id, quizId)).limit(1);
  if (!quiz) return null;
  const questions = await db
    .select()
    .from(quizQuestionsTable)
    .where(eq(quizQuestionsTable.quizId, quizId))
    .orderBy(asc(quizQuestionsTable.position));
  const topicIds = [...new Set(questions.map((q) => q.topicId).filter((id): id is string => !!id))];
  const conceptIds = [...new Set(questions.flatMap((q) => q.conceptIds))];
  const topics = topicIds.length
    ? await db.select({ id: topicsTable.id, name: topicsTable.name }).from(topicsTable).where(inArray(topicsTable.id, topicIds))
    : [];
  const concepts = conceptIds.length
    ? await db.select({ id: conceptsTable.id, name: conceptsTable.name }).from(conceptsTable).where(inArray(conceptsTable.id, conceptIds))
    : [];
  const topicName = new Map<string, string>(topics.map((t) => [t.id, t.name] as [string, string]));
  const conceptName = new Map<string, string>(concepts.map((c) => [c.id, c.name] as [string, string]));
  const [attempt] = await db
    .select({ id: quizAttemptsTable.id })
    .from(quizAttemptsTable)
    .where(and(eq(quizAttemptsTable.quizId, quizId), eq(quizAttemptsTable.learnerId, learnerId)))
    .limit(1);
  return {
    id: quiz.id,
    courseId: quiz.courseId,
    learnerId: quiz.learnerId,
    title: quiz.title,
    mode: quiz.mode,
    strategy: quiz.strategy,
    difficulty: quiz.difficulty,
    stats: quiz.stats,
    createdAt: quiz.createdAt,
    attempted: !!attempt,
    questions: questions.map((q) => ({
      id: q.id,
      position: q.position,
      type: q.type,
      prompt: q.prompt,
      options: q.options,
      difficulty: q.difficulty,
      topic: q.topicId ? { id: q.topicId, name: topicName.get(q.topicId) ?? "Topic" } : null,
      concepts: q.conceptIds.map((id) => ({ id, name: conceptName.get(id) ?? "Concept" })),
      sources: q.citations.map((c) => ({ unitId: c.unitId, sourceTitle: c.sourceTitle, sourceType: c.sourceType, locator: c.locator })),
      verification: q.verification,
    })),
  };
}

const QUESTION_TYPES: QuestionType[] = ["mcq", "short", "numeric"];

router.post("/x/courses/:courseId/quiz", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const mode: QuizMode = ["practice", "diagnostic", "mock", "chat"].includes(String(body.mode))
      ? (String(body.mode) as QuizMode)
      : "practice";
    const strategy: QuizStrategy = body.strategy === "random" ? "random" : "adaptive";
    const defaultCount = mode === "diagnostic" ? 8 : mode === "mock" ? 12 : mode === "chat" ? 1 : 6;
    const count = Math.min(15, Math.max(1, Math.round(Number(body.count) || defaultCount)));
    const difficulty: Difficulty = ["easy", "medium", "hard", "mixed"].includes(String(body.difficulty))
      ? (String(body.difficulty) as Difficulty)
      : "mixed";
    let types = (Array.isArray(body.types) ? body.types : [])
      .map(String)
      .filter((t): t is QuestionType => QUESTION_TYPES.includes(t as QuestionType));
    if (types.length === 0) types = mode === "diagnostic" || mode === "chat" ? ["mcq"] : ["mcq", "short", "numeric"];
    const topicId = typeof body.topicId === "string" && body.topicId ? body.topicId : undefined;
    if (topicId && !validStudygraphId(topicId)) {
      res.status(400).json({ error: "Invalid topic id." });
      return;
    }
    const unitIds = Array.isArray(body.unitIds)
      ? body.unitIds.map(String).filter(validStudygraphId).slice(0, 8)
      : undefined;

    const { quizId } = await buildQuiz({
      courseId: ctx.courseId,
      ownerId: ctx.ownerId,
      learnerId: ctx.learnerId,
      count,
      difficulty,
      types,
      mode,
      strategy,
      topicId,
      unitIds,
    });
    res.status(201).json({ quiz: await quizView(quizId, ctx.learnerId) });
  } catch (error) {
    fail(res, error);
  }
});

async function loadOwnedQuiz(req: Request, res: Response) {
  const ownerId = studygraphOwnerId(res);
  const quizId = studygraphPathParam(req, "quizId");
  if (!validStudygraphId(quizId)) {
    res.status(400).json({ error: "Invalid quiz id." });
    return null;
  }
  const [quiz] = await db.select().from(quizzesTable).where(eq(quizzesTable.id, quizId)).limit(1);
  const course = quiz ? await findOwnedCourse(quiz.courseId, ownerId) : undefined;
  const learnerId = learnerKey(ownerId, req.header("x-learner-id"));
  if (!quiz || !course || quiz.learnerId !== learnerId) {
    res.status(404).json({ error: "Quiz not found." });
    return null;
  }
  return { quiz, ownerId, learnerId };
}

router.get("/x/quizzes/:quizId", async (req: Request, res: Response) => {
  try {
    const ctx = await loadOwnedQuiz(req, res);
    if (!ctx) return;
    res.json({ quiz: await quizView(ctx.quiz.id, ctx.learnerId) });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/x/quizzes/:quizId/submit", async (req: Request, res: Response) => {
  try {
    const ctx = await loadOwnedQuiz(req, res);
    if (!ctx) return;
    const [existing] = await db
      .select({ id: quizAttemptsTable.id })
      .from(quizAttemptsTable)
      .where(and(eq(quizAttemptsTable.quizId, ctx.quiz.id), eq(quizAttemptsTable.learnerId, ctx.learnerId)))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "This quiz was already submitted. Start a new one." });
      return;
    }
    const answers = Array.isArray(req.body?.answers) ? (req.body.answers as Array<Record<string, unknown>>) : [];
    const byQuestion = new Map<string, string | number | null>();
    for (const entry of answers) {
      const value = entry.answer;
      byQuestion.set(
        String(entry.questionId),
        typeof value === "string" || typeof value === "number" ? value : null,
      );
    }
    const questions = await db
      .select()
      .from(quizQuestionsTable)
      .where(eq(quizQuestionsTable.quizId, ctx.quiz.id))
      .orderBy(asc(quizQuestionsTable.position));

    const graded = await mapLimit(questions, 3, (question) => gradeQuestion(question, byQuestion.get(question.id)));
    const changes = await applyQuizEvidence({
      learnerId: ctx.learnerId,
      courseId: ctx.quiz.courseId,
      mode: ctx.quiz.mode,
      graded,
    });
    await logMisconceptions({ learnerId: ctx.learnerId, courseId: ctx.quiz.courseId, graded });
    const report = await buildReport({ graded, changes });
    const score = graded.reduce((sum, g) => sum + g.score, 0);
    const [attempt] = await db
      .insert(quizAttemptsTable)
      .values({
        quizId: ctx.quiz.id,
        courseId: ctx.quiz.courseId,
        learnerId: ctx.learnerId,
        results: graded.map((g) => ({
          questionId: g.questionId, type: g.type, score: g.score, isCorrect: g.isCorrect,
          yourAnswer: g.yourAnswer, correctAnswer: g.correctAnswer, feedback: g.feedback,
          errorType: g.errorType, misconception: g.misconception,
        })),
        score,
        total: graded.length,
      })
      .returning({ id: quizAttemptsTable.id });

    res.json({
      attemptId: attempt.id,
      score,
      total: graded.length,
      percentage: report.percentage,
      results: graded,
      report,
      mastery: changes,
    });
  } catch (error) {
    fail(res, error);
  }
});

/* ------------------------------------------------------------------ mastery */

router.get("/x/courses/:courseId/mastery", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const now = new Date();
    const topics = await db.select().from(topicsTable).where(eq(topicsTable.courseId, ctx.courseId));
    const concepts = await db.select().from(conceptsTable).where(eq(conceptsTable.courseId, ctx.courseId));
    const mastery = await loadMasteryMap(ctx.learnerId, concepts.map((c) => c.id));
    const topicName = new Map<string, string>(topics.map((t) => [t.id, t.name] as [string, string]));

    const conceptRows = concepts.map((concept) => {
      const row = mastery.get(concept.id);
      const state = stateOf(row, now);
      return {
        id: concept.id,
        name: concept.name,
        topicId: concept.topicId,
        topic: topicName.get(concept.topicId) ?? "Topic",
        pKnown: state.pKnown,
        attempts: state.attempts,
        retention: state.retention,
        status: masteryLabel(state.pKnown, state.attempts),
        nextReviewAt: row?.nextReviewAt ?? null,
        due: !!row?.nextReviewAt && row.nextReviewAt <= now,
        priority: priorityScore(state),
      };
    });
    const tested = conceptRows.filter((c) => c.attempts > 0);
    const topicRows = topics.map((topic) => {
      const mine = conceptRows.filter((c) => c.topicId === topic.id);
      const testedMine = mine.filter((c) => c.attempts > 0);
      return {
        id: topic.id,
        name: topic.name,
        total: mine.length,
        tested: testedMine.length,
        mastery: testedMine.length ? testedMine.reduce((s, c) => s + c.pKnown, 0) / testedMine.length : null,
      };
    });

    const events = await db
      .select()
      .from(bktEventsTable)
      .where(and(eq(bktEventsTable.learnerId, ctx.learnerId), eq(bktEventsTable.courseId, ctx.courseId)))
      .orderBy(asc(bktEventsTable.createdAt));
    const firstMastery = new Map<string, Date>();
    for (const event of events) {
      if (event.weight > 0 && event.before < 0.8 && event.after >= 0.8 && !firstMastery.has(event.conceptId)) {
        firstMastery.set(event.conceptId, event.createdAt);
      }
    }
    const studyMilestones: Array<{ id: string; kind: "concept" | "topic"; name: string; topic: string; at: Date; minutes: number }> = [...firstMastery.entries()].flatMap(([conceptId, at]) => {
      const concept = conceptRows.find((item) => item.id === conceptId);
      return concept ? [{ id: `concept:${conceptId}`, kind: "concept" as const, name: concept.name, topic: concept.topic, at, minutes: 5 }] : [];
    });
    for (const topic of topics) {
      const topicConcepts = conceptRows.filter((concept) => concept.topicId === topic.id);
      if (!topicConcepts.length || topicConcepts.some((concept) => !firstMastery.has(concept.id))) continue;
      const at = topicConcepts.map((concept) => firstMastery.get(concept.id)!).sort((a, b) => +a - +b).at(-1)!;
      studyMilestones.push({ id: `topic:${topic.id}`, kind: "topic" as const, name: topic.name, topic: topic.name, at, minutes: 10 });
    }
    const running = new Map<string, number>();
    const history = events
      .filter((e) => e.weight > 0)
      .map((event, index) => {
        running.set(event.conceptId, event.after);
        const values = [...running.values()];
        return {
          i: index + 1,
          at: event.createdAt,
          source: event.source,
          average: values.reduce((a, b) => a + b, 0) / values.length,
        };
      })
      .slice(-150);

    const misconceptionRows = await db
      .select()
      .from(misconceptionLogTable)
      .where(and(eq(misconceptionLogTable.learnerId, ctx.learnerId), eq(misconceptionLogTable.courseId, ctx.courseId)));
    const conceptName = new Map<string, string>(concepts.map((c) => [c.id, c.name] as [string, string]));
    const misMap = new Map<string, { label: string; concept: string; count: number; citations: StudyCitation[] }>();
    for (const row of misconceptionRows) {
      const existing = misMap.get(row.label);
      if (existing) existing.count += 1;
      else misMap.set(row.label, { label: row.label, concept: row.conceptId ? (conceptName.get(row.conceptId) ?? "Concept") : "Concept", count: 1, citations: row.citations });
    }

    const quizzes = await db
      .select({ stats: quizzesTable.stats, mode: quizzesTable.mode, id: quizzesTable.id })
      .from(quizzesTable)
      .where(and(eq(quizzesTable.learnerId, ctx.learnerId), eq(quizzesTable.courseId, ctx.courseId)));
    const totals = quizzes.reduce(
      (acc, q) => ({
        generated: acc.generated + q.stats.generated,
        rejectedVerification: acc.rejectedVerification + q.stats.rejectedVerification,
        rejectedDuplicate: acc.rejectedDuplicate + q.stats.rejectedDuplicate,
        repeatsServed: acc.repeatsServed + q.stats.repeatsServed,
        kept: acc.kept + q.stats.kept,
      }),
      { generated: 0, rejectedVerification: 0, rejectedDuplicate: 0, repeatsServed: 0, kept: 0 },
    );
    const attempts = await db
      .select()
      .from(quizAttemptsTable)
      .where(and(eq(quizAttemptsTable.learnerId, ctx.learnerId), eq(quizAttemptsTable.courseId, ctx.courseId)))
      .orderBy(desc(quizAttemptsTable.createdAt))
      .limit(10);
    const modeById = new Map<string, string>(quizzes.map((q) => [q.id, q.mode] as [string, string]));

    res.json({
      courseId: ctx.courseId,
      needsDiagnostic: attempts.length === 0 && tested.length === 0,
      summary: {
        totalConcepts: conceptRows.length,
        testedConcepts: tested.length,
        averageMastery: tested.length ? tested.reduce((s, c) => s + c.pKnown, 0) / tested.length : null,
        weakConcepts: tested.filter((c) => c.status === "weak").length,
        dueConcepts: conceptRows.filter((c) => c.due).length,
      },
      concepts: conceptRows,
      topics: topicRows,
      weakConcepts: [...conceptRows].sort((a, b) => b.priority - a.priority).slice(0, 6),
      history,
      studyMilestones,
      misconceptions: [...misMap.values()].sort((a, b) => b.count - a.count).slice(0, 8),
      questionStats: {
        ...totals,
        repetitionRate: totals.kept ? totals.repeatsServed / totals.kept : 0,
        duplicateThreshold: DUPLICATE_THRESHOLD,
      },
      recentAttempts: attempts.map((a) => ({
        id: a.id, quizId: a.quizId, score: a.score, total: a.total, createdAt: a.createdAt, mode: modeById.get(a.quizId) ?? "practice",
      })),
    });
  } catch (error) {
    fail(res, error);
  }
});

router.get("/x/courses/:courseId/graph", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const topics = await db.select().from(topicsTable).where(eq(topicsTable.courseId, ctx.courseId));
    const concepts = await db.select().from(conceptsTable).where(eq(conceptsTable.courseId, ctx.courseId));
    const edges = await db
      .select({ from: conceptEdgesTable.prerequisiteConceptId, to: conceptEdgesTable.dependentConceptId })
      .from(conceptEdgesTable)
      .where(eq(conceptEdgesTable.courseId, ctx.courseId));
    const mastery = await loadMasteryMap(ctx.learnerId, concepts.map((c) => c.id));
    res.json({
      topics: topics.map((t) => ({ id: t.id, name: t.name, parentId: t.parentId })),
      concepts: concepts.map((c) => {
        const state = stateOf(mastery.get(c.id));
        return {
          id: c.id, name: c.name, description: c.description, topicId: c.topicId,
          pKnown: state.pKnown, attempts: state.attempts, status: masteryLabel(state.pKnown, state.attempts),
        };
      }),
      edges,
    });
  } catch (error) {
    fail(res, error);
  }
});

/* -------------------------------------------------------------- source units */

router.get("/x/units/:unitId", async (req: Request, res: Response) => {
  try {
    const ownerId = studygraphOwnerId(res);
    const unitId = studygraphPathParam(req, "unitId");
    if (!validStudygraphId(unitId)) {
      res.status(400).json({ error: "Invalid unit id." });
      return;
    }
    const [row] = await db
      .select({
        id: unitsTable.id,
        text: unitsTable.text,
        figureCaption: unitsTable.figureCaption,
        locator: unitsTable.locator,
        sourceId: sourcesTable.id,
        title: sourcesTable.title,
        sourceType: sourcesTable.sourceType,
        storagePath: sourcesTable.storagePath,
        sourceUrl: sourcesTable.sourceUrl,
        mimeType: sourcesTable.mimeType,
        ownerId: sourcesTable.ownerId,
      })
      .from(unitsTable)
      .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
      .where(eq(unitsTable.id, unitId))
      .limit(1);
    if (!row || row.ownerId !== ownerId) {
      res.status(404).json({ error: "Source unit not found." });
      return;
    }
    const locator = row.locator;
    res.json({
      id: row.id,
      text: row.text,
      figureCaption: row.figureCaption,
      locator,
      source: {
        id: row.sourceId,
        title: row.title,
        type: row.sourceType,
        fileUrl: storageUrl(row.storagePath),
        mimeType: row.mimeType,
        youtubeUrl: row.sourceUrl ?? null,
      },
      imageUrl: storageUrl(locator.imagePath),
      pageCount: row.sourceType === "video" ? null : await pageCountFor(row.sourceId),
    });
  } catch (error) {
    fail(res, error);
  }
});

/* -------------------------------------------------- chat evidence (4a, chat) */

router.post("/x/courses/:courseId/chat-signal", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const unitIds = Array.isArray(req.body?.unitIds)
      ? (req.body.unitIds as unknown[]).map(String).filter(validStudygraphId).slice(0, 6)
      : [];
    if (unitIds.length === 0) {
      res.json({ updates: [] });
      return;
    }
    const links = await db
      .select({ conceptId: unitConceptsTable.conceptId })
      .from(unitConceptsTable)
      .innerJoin(conceptsTable, eq(unitConceptsTable.conceptId, conceptsTable.id))
      .where(and(inArray(unitConceptsTable.unitId, unitIds), eq(conceptsTable.courseId, ctx.courseId)));
    const conceptIds = [...new Set(links.map((l) => l.conceptId))].slice(0, 3);
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const updates: Array<{ conceptId: string; before: number; after: number; reason: string }> = [];
    for (const conceptId of conceptIds) {
      const prior = await db
        .select({ id: bktEventsTable.id })
        .from(bktEventsTable)
        .where(
          and(
            eq(bktEventsTable.learnerId, ctx.learnerId),
            eq(bktEventsTable.conceptId, conceptId),
            eq(bktEventsTable.source, "chat-ask"),
            gte(bktEventsTable.createdAt, since),
          ),
        )
        .limit(1);
      if (prior.length > 0) {
        // Asking about the same concept again within the hour signals confusion.
        const result = await recordEvidence({
          learnerId: ctx.learnerId, courseId: ctx.courseId, conceptId,
          correctness: 0, kind: "short", source: "chat", weight: 0.25,
        });
        updates.push({ conceptId, ...result, reason: "repeated question on this concept" });
      } else {
        const mastery = await loadMasteryMap(ctx.learnerId, [conceptId]);
        const p = stateOf(mastery.get(conceptId)).pKnown;
        await db.insert(bktEventsTable).values({
          learnerId: ctx.learnerId, courseId: ctx.courseId, conceptId,
          source: "chat-ask", correctness: null, weight: 0, before: p, after: p,
        });
      }
    }
    res.json({ updates });
  } catch (error) {
    fail(res, error);
  }
});

/* ---------------------------------------------- revision: flashcards + plan */
router.get("/x/courses/:courseId/plans", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    await ensureUserDataTables();
    const plans = await db.select().from(savedStudyPlansTable)
      .where(and(eq(savedStudyPlansTable.courseId, ctx.courseId), eq(savedStudyPlansTable.ownerId, ctx.ownerId)))
      .orderBy(desc(savedStudyPlansTable.savedAt));
    res.json(plans);
  } catch (error) {
    fail(res, error);
  }
});

router.post("/x/courses/:courseId/plans", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  const body = req.body ?? {};
  const validDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
  const schedule = body.schedule;
  const validTask = (task: any) => task && typeof task === "object" && ["study", "review", "mock"].includes(task.kind) &&
    typeof task.concept === "string" && task.concept.length <= 300 && Number.isInteger(task.minutes) && task.minutes >= 1 && task.minutes <= 480;
  if (!validDate(body.examDate) || !Number.isInteger(body.minutesPerDay) || body.minutesPerDay < 15 || body.minutesPerDay > 480 ||
      !Array.isArray(schedule) || schedule.length > 60 || schedule.some((day: any) => !day || !validDate(day.date) || !Array.isArray(day.tasks) || day.tasks.length > 60 || day.tasks.some((task: unknown) => !validTask(task)))) {
    res.status(400).json({ error: "The study plan is invalid. Rebuild it and try again." });
    return;
  }
  try {
    await ensureUserDataTables();
    const completed = Array.isArray(body.completed) ? body.completed.filter((item: unknown): item is string => typeof item === "string" && item.length <= 100).slice(0, 5000) : [];
    const [plan] = await db.insert(savedStudyPlansTable).values({
      ownerId: ctx.ownerId,
      courseId: ctx.courseId,
      examDate: body.examDate,
      minutesPerDay: body.minutesPerDay,
      schedule,
      completed,
    }).returning();
    res.status(201).json(plan);
  } catch (error) {
    fail(res, error);
  }
});

router.patch("/x/courses/:courseId/plans/:planId", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  const planId = studygraphPathParam(req, "planId");
  if (!validStudygraphId(planId) || !Array.isArray(req.body?.completed) || req.body.completed.length > 5000 ||
      req.body.completed.some((item: unknown) => typeof item !== "string" || item.length > 100)) {
    res.status(400).json({ error: "The saved task list is invalid." });
    return;
  }
  try {
    await ensureUserDataTables();
    const [plan] = await db.update(savedStudyPlansTable).set({ completed: [...new Set(req.body.completed as string[])] })
      .where(and(eq(savedStudyPlansTable.id, planId), eq(savedStudyPlansTable.courseId, ctx.courseId), eq(savedStudyPlansTable.ownerId, ctx.ownerId)))
      .returning();
    if (!plan) {
      res.status(404).json({ error: "Saved study plan not found." });
      return;
    }
    res.json(plan);
  } catch (error) {
    fail(res, error);
  }
});

router.post("/x/courses/:courseId/flashcards", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const count = Math.min(12, Math.max(2, Math.round(Number(req.body?.count) || 8)));
    const pool = await loadConceptPool({ courseId: ctx.courseId, ownerId: ctx.ownerId });
    if (pool.length === 0) {
      res.status(409).json({ error: "Process a source first." });
      return;
    }
    const mastery = await loadMasteryMap(ctx.learnerId, pool.map((c) => c.id));
    const ranked = [...pool]
      .sort((a, b) => priorityScore(stateOf(mastery.get(b.id))) - priorityScore(stateOf(mastery.get(a.id))))
      .slice(0, Math.ceil(count / 1.5));
    const unitIds = [...new Set(ranked.flatMap((c) => shuffle(c.unitIds).slice(0, 2)))].slice(0, 12);
    const unitRows = await db
      .select({
        id: unitsTable.id, sourceId: unitsTable.sourceId, text: unitsTable.text,
        figureCaption: unitsTable.figureCaption, locator: unitsTable.locator,
        sourceTitle: sourcesTable.title, sourceType: sourcesTable.sourceType,
      })
      .from(unitsTable)
      .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
      .where(inArray(unitsTable.id, unitIds));
    const units = new Map(unitRows.map((u) => [u.id, u]));
    let rawCards: Array<Record<string, unknown>> = [];
    try {
      const response = await withRetry(() =>
        openai().chat.completions.create({
          model: modelConfig.assessment,
          max_completion_tokens: 3000,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `Create exactly ${count} study flashcards ONLY from the supplied units. Return JSON {"cards":[{"front": a question or term, "back": a concise answer in 1-3 sentences, "unitIds": [exact UNIT_ID values]}]}.\n\nUNITS:\n${unitRows
                .map((u) => `UNIT_ID: ${u.id}\n${u.text.slice(0, 1200)}`)
                .join("\n\n---\n\n")}`,
            },
            { role: "user", content: "Write the flashcards." },
          ],
        }),
      );
      const parsed = parseJsonLoose(response.choices[0]?.message?.content ?? "");
      rawCards = Array.isArray(parsed?.cards) ? (parsed.cards as Array<Record<string, unknown>>) : [];
    } catch (error) {
      req.log.warn({ err: error, courseId: ctx.courseId }, "Using source-note flashcards while the question-writing service is unavailable");
    }
    const cards = rawCards
      .map((card) => {
        const ids = Array.isArray(card.unitIds) ? card.unitIds.map(String).filter((id) => units.has(id)) : [];
        return {
          front: String(card.front ?? "").trim(),
          back: String(card.back ?? "").trim(),
          citations: ids.slice(0, 2).map((id) => citationFor({ ...units.get(id)!, similarity: 1 })),
        };
      })
      .filter((card) => card.front && card.back && card.citations.length > 0)
      .slice(0, count);
    if (cards.length < count) {
      const existingUnitIds = new Set(cards.flatMap((card) => card.citations.map((citation) => citation.unitId)));
      const fallbackCards = ranked.flatMap((concept) => {
        const unit = concept.unitIds.map((id) => units.get(id)).find((item) => item && !existingUnitIds.has(item.id) && (item.text.trim() || item.figureCaption?.trim()));
        if (!unit) return [];
        const excerpt = (unit.figureCaption?.trim() || unit.text.trim()).replace(/\s+/g, " ").slice(0, 700);
        if (!excerpt) return [];
        return [{
          front: `What do your notes say about ${concept.name}?`,
          back: excerpt,
          citations: [citationFor({ ...unit, similarity: 1 })],
        }];
      });
      cards.push(...fallbackCards.slice(0, count - cards.length));
    }
    res.json({ cards });
  } catch (error) {
    fail(res, error);
  }
});

router.get("/x/courses/:courseId/plan", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const exam = new Date(String(req.query.examDate ?? ""));
    if (Number.isNaN(exam.getTime())) {
      res.status(400).json({ error: "Provide examDate as YYYY-MM-DD." });
      return;
    }
    const minutesPerDay = Math.min(480, Math.max(15, Math.round(Number(req.query.minutesPerDay) || 45)));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.min(60, Math.max(1, Math.ceil((exam.getTime() - today.getTime()) / 86_400_000)));
    const pool = await loadConceptPool({ courseId: ctx.courseId, ownerId: ctx.ownerId });
    const mastery = await loadMasteryMap(ctx.learnerId, pool.map((c) => c.id));
    const ranked = [...pool].sort(
      (a, b) => priorityScore(stateOf(mastery.get(b.id))) - priorityScore(stateOf(mastery.get(a.id))),
    );
    const slotMinutes = 10;
    const capacity = Math.max(1, Math.floor(minutesPerDay / slotMinutes));
    const schedule: Array<{ date: string; tasks: Array<{ kind: "study" | "review" | "mock"; concept: string; minutes: number }> }> =
      Array.from({ length: days }, (_, i) => ({
        date: new Date(today.getTime() + i * 86_400_000).toISOString().slice(0, 10),
        tasks: [],
      }));
    const place = (day: number, task: { kind: "study" | "review" | "mock"; concept: string; minutes: number }) => {
      for (let d = day; d < days; d += 1) {
        if (schedule[d].tasks.length < capacity) {
          schedule[d].tasks.push(task);
          return d;
        }
      }
      return -1;
    };
    const lastStudyDay = Math.max(0, days - 2);
    ranked.forEach((concept, index) => {
      const day = Math.min(lastStudyDay, Math.floor(index / capacity));
      const placed = place(day, { kind: "study", concept: concept.name, minutes: slotMinutes });
      if (placed < 0) return;
      // Spaced reviews follow a forgetting curve: +1, +3, +7 days after study.
      for (const gap of [1, 3, 7]) {
        if (placed + gap < days - 1) place(placed + gap, { kind: "review", concept: concept.name, minutes: 5 });
      }
    });
    if (days >= 2) {
      schedule[days - 1].tasks.unshift({ kind: "mock", concept: "Full mock exam, then review weak topics", minutes: Math.min(minutesPerDay, 60) });
    }
    res.json({ examDate: exam.toISOString().slice(0, 10), days, minutesPerDay, schedule: schedule.filter((d) => d.tasks.length > 0) });
  } catch (error) {
    fail(res, error);
  }
});

/* ------------------------------------------- outside knowledge (flagged, 2b) */

router.post("/x/courses/:courseId/outside-knowledge", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const question = String(req.body?.question ?? "").trim().slice(0, 600);
    if (question.length < 3) {
      res.status(400).json({ error: "Ask a question first." });
      return;
    }
    const response = await withRetry(() =>
      openai().chat.completions.create({
        model: modelConfig.tutor,
        max_completion_tokens: 450,
        messages: [
          {
            role: "system",
            content:
              "You are giving a brief general-knowledge explanation (under 120 words) that is NOT based on the student's course material. Be accurate and say so plainly if you are unsure. Do not claim it comes from their lectures or textbooks.",
          },
          { role: "user", content: question },
        ],
      }),
    );
    res.json({
      answer: response.choices[0]?.message?.content?.trim() ?? "",
      disclaimer: "This is general knowledge, not backed by your course material.",
    });
  } catch (error) {
    fail(res, error);
  }
});

/* ------------------------------------------ concept detail for the map (6a) */

router.get("/x/courses/:courseId/concepts/:conceptId", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const conceptId = studygraphPathParam(req, "conceptId");
    if (!validStudygraphId(conceptId)) {
      res.status(400).json({ error: "Invalid concept id." });
      return;
    }
    const [concept] = await db
      .select()
      .from(conceptsTable)
      .where(and(eq(conceptsTable.id, conceptId), eq(conceptsTable.courseId, ctx.courseId)))
      .limit(1);
    if (!concept) {
      res.status(404).json({ error: "Concept not found." });
      return;
    }
    const rows = await db
      .select({
        id: unitsTable.id, sourceId: unitsTable.sourceId, text: unitsTable.text,
        figureCaption: unitsTable.figureCaption, locator: unitsTable.locator,
        sourceTitle: sourcesTable.title, sourceType: sourcesTable.sourceType,
      })
      .from(unitConceptsTable)
      .innerJoin(unitsTable, eq(unitConceptsTable.unitId, unitsTable.id))
      .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
      .where(and(eq(unitConceptsTable.conceptId, conceptId), eq(sourcesTable.ownerId, ctx.ownerId)))
      .limit(6);
    res.json({
      id: concept.id,
      name: concept.name,
      description: concept.description,
      topicId: concept.topicId,
      citations: rows.map((row) => citationFor({ ...row, similarity: 1 })),
    });
  } catch (error) {
    fail(res, error);
  }
});

/* ------------------------------------------------ evaluation support (5a-5c) */

/** Machine-readable unit list used by /eval to build a labeled test set. */
router.get("/x/courses/:courseId/units", async (req: Request, res: Response) => {
  const ctx = await loadContext(req, res);
  if (!ctx) return;
  try {
    const rows = await db
      .select({
        id: unitsTable.id, text: unitsTable.text, figureCaption: unitsTable.figureCaption,
        locator: unitsTable.locator, sourceTitle: sourcesTable.title, sourceType: sourcesTable.sourceType,
      })
      .from(unitsTable)
      .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
      .where(and(eq(sourcesTable.courseId, ctx.courseId), eq(sourcesTable.ownerId, ctx.ownerId), eq(sourcesTable.status, "ready")))
      .limit(3000);
    res.json({ units: rows });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Answer keys for simulated students and the key audit. Disabled unless
 * ALLOW_SIM_KEYS=true, so a normal learner can never read answers.
 */
router.get("/x/quizzes/:quizId/sim-key", async (req: Request, res: Response) => {
  if (process.env.ALLOW_SIM_KEYS !== "true") {
    res.status(404).json({ error: "Not found." });
    return;
  }
  try {
    const ctx = await loadOwnedQuiz(req, res);
    if (!ctx) return;
    const questions = await db
      .select()
      .from(quizQuestionsTable)
      .where(eq(quizQuestionsTable.quizId, ctx.quiz.id))
      .orderBy(asc(quizQuestionsTable.position));
    res.json({
      questions: questions.map((q) => ({
        id: q.id, type: q.type, prompt: q.prompt, options: q.options, answerKey: q.answerKey,
        explanation: q.explanation, conceptIds: q.conceptIds, verification: q.verification,
        citations: q.citations,
      })),
    });
  } catch (error) {
    fail(res, error);
  }
});

export default router;
