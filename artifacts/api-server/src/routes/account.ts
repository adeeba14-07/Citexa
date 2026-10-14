import { eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  assessmentAttemptsTable,
  assessmentsTable,
  bktEventsTable,
  bktMasteryTable,
  conceptsTable,
  conversationMessagesTable,
  conversationsTable,
  misconceptionLogTable,
  quizAttemptsTable,
  quizQuestionsTable,
  quizzesTable,
  savedStudyPlansTable,
  sourcesTable,
  topicsTable,
  unitsTable,
  userSettingsTable,
  coursesTable,
} from "@workspace/db/schema";
import { cancelIngestion } from "../lib/ingestion/worker";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { ensureUserDataTables } from "../lib/ensureUserDataTables";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const DEFAULT_SETTINGS = {
  dailyGoalMinutes: 30,
  reminderTime: null as string | null,
  remindersEnabled: false,
  language: "en",
  biggerText: false,
  dyslexiaFont: false,
  highContrast: false,
};
const LANGUAGES = new Set(["en", "hi", "en-IN", "ta", "te", "bn", "mr"]);

function ownerId(res: Response): string {
  return res.locals.userId as string;
}
function accountError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/relation ["'`]?.+["'`]? does not exist|table ["'`]?.+["'`]? does not exist/i.test(message)) {
    return "The database schema is out of date. Stop the app, verify DATABASE_URL, and run pnpm run setup once.";
  }
  if (/ECONNREFUSED|connection terminated|connection timeout|authentication failed|database.*not configured/i.test(message)) {
    return "Citexa cannot connect to the study database. Verify DATABASE_URL and check the API server logs.";
  }
  return fallback;
}
function publicSettings(row?: typeof userSettingsTable.$inferSelect) {
  return row ? {
    dailyGoalMinutes: row.dailyGoalMinutes,
    reminderTime: row.reminderTime,
    remindersEnabled: row.remindersEnabled,
    language: row.language,
    biggerText: row.biggerText,
    dyslexiaFont: row.dyslexiaFont,
    highContrast: row.highContrast,
  } : DEFAULT_SETTINGS;
}

router.get("/account/settings", async (_req: Request, res: Response) => {
  try {
    await ensureUserDataTables();
    const [row] = await db.select().from(userSettingsTable).where(eq(userSettingsTable.ownerId, ownerId(res))).limit(1);
    res.json(publicSettings(row));
  } catch (error) {
    logger.error({ error }, "Could not load account settings");
    res.status(500).json({ error: accountError(error, "Could not load your settings.") });
  }
});

router.put("/account/settings", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const dailyGoalMinutes = Number(body.dailyGoalMinutes);
  const reminderTime = body.reminderTime === null || body.reminderTime === "" ? null : body.reminderTime;
  const validTime = reminderTime === null || (typeof reminderTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime));
  if (!Number.isInteger(dailyGoalMinutes) || dailyGoalMinutes < 15 || dailyGoalMinutes > 480 || !validTime ||
      typeof body.remindersEnabled !== "boolean" || typeof body.language !== "string" || !LANGUAGES.has(body.language) ||
      typeof body.biggerText !== "boolean" || typeof body.dyslexiaFont !== "boolean" || typeof body.highContrast !== "boolean") {
    res.status(400).json({ error: "Settings are invalid. Choose a daily goal from 15 to 480 minutes and a supported language and reminder time." });
    return;
  }
  try {
    await ensureUserDataTables();
    const owner = ownerId(res);
    const values = {
      ownerId: owner,
      dailyGoalMinutes,
      reminderTime,
      remindersEnabled: body.remindersEnabled,
      language: body.language,
      biggerText: body.biggerText,
      dyslexiaFont: body.dyslexiaFont,
      highContrast: body.highContrast,
      updatedAt: new Date(),
    };
    const [row] = await db.insert(userSettingsTable).values(values)
      .onConflictDoUpdate({ target: userSettingsTable.ownerId, set: {
        dailyGoalMinutes: values.dailyGoalMinutes,
        reminderTime: values.reminderTime,
        remindersEnabled: values.remindersEnabled,
        language: values.language,
        biggerText: values.biggerText,
        dyslexiaFont: values.dyslexiaFont,
        highContrast: values.highContrast,
        updatedAt: values.updatedAt,
      } }).returning();
    res.json(publicSettings(row));
  } catch (error) {
    logger.error({ error }, "Could not save account settings");
    res.status(500).json({ error: accountError(error, "Could not save your settings.") });
  }
});

router.get("/account/export", async (_req: Request, res: Response) => {
  const owner = ownerId(res);
  try {
    await ensureUserDataTables();
    const [courses, settings, plans, sources, conversations, assessments] = await Promise.all([
      db.select().from(coursesTable).where(eq(coursesTable.ownerId, owner)),
      db.select().from(userSettingsTable).where(eq(userSettingsTable.ownerId, owner)),
      db.select().from(savedStudyPlansTable).where(eq(savedStudyPlansTable.ownerId, owner)),
      db.select().from(sourcesTable).where(eq(sourcesTable.ownerId, owner)),
      db.select().from(conversationsTable).where(eq(conversationsTable.ownerId, owner)),
      db.select().from(assessmentsTable).where(eq(assessmentsTable.ownerId, owner)),
    ]);
    const courseIds = courses.map((row) => row.id);
    const conversationIds = conversations.map((row) => row.id);
    const assessmentIds = assessments.map((row) => row.id);
    const sourceIds = sources.map((row) => row.id);
    const [topics, concepts, units, messages, assessmentAttempts, quizzes, quizQuestions, quizAttempts, events, misconceptions] = await Promise.all([
      courseIds.length ? db.select().from(topicsTable).where(inArray(topicsTable.courseId, courseIds)) : [],
      courseIds.length ? db.select().from(conceptsTable).where(inArray(conceptsTable.courseId, courseIds)) : [],
      sourceIds.length ? db.select().from(unitsTable).where(inArray(unitsTable.sourceId, sourceIds)) : [],
      conversationIds.length ? db.select().from(conversationMessagesTable).where(inArray(conversationMessagesTable.conversationId, conversationIds)) : [],
      assessmentIds.length ? db.select().from(assessmentAttemptsTable).where(inArray(assessmentAttemptsTable.assessmentId, assessmentIds)) : [],
      courseIds.length ? db.select().from(quizzesTable).where(inArray(quizzesTable.courseId, courseIds)) : [],
      courseIds.length ? db.select().from(quizQuestionsTable).where(inArray(quizQuestionsTable.courseId, courseIds)) : [],
      courseIds.length ? db.select().from(quizAttemptsTable).where(inArray(quizAttemptsTable.courseId, courseIds)) : [],
      courseIds.length ? db.select().from(bktEventsTable).where(inArray(bktEventsTable.courseId, courseIds)) : [],
      courseIds.length ? db.select().from(misconceptionLogTable).where(inArray(misconceptionLogTable.courseId, courseIds)) : [],
    ]);
    const conceptIds = concepts.map((row) => row.id);
    const mastery = conceptIds.length ? await db.select().from(bktMasteryTable).where(inArray(bktMasteryTable.conceptId, conceptIds)) : [];
    const data = {
      format: "citexa-account-export-v1",
      exportedAt: new Date().toISOString(),
      settings: publicSettings(settings[0]),
      courses,
      sources,
      studyUnits: units,
      topics,
      concepts,
      savedStudyPlans: plans,
      conversations,
      conversationMessages: messages,
      assessments,
      assessmentAttempts,
      quizzes,
      quizQuestions,
      quizAttempts,
      learnerMastery: mastery,
      learningEvents: events,
      misconceptions,
    };
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename=citexa-data-${stamp}.json`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.type("application/json").send(JSON.stringify(data, null, 2));
  } catch (error) {
    logger.error({ error }, "Could not export account data");
    res.status(500).json({ error: accountError(error, "Could not export your data.") });
  }
});

router.delete("/account/data", async (_req: Request, res: Response) => {
  const owner = ownerId(res);
  try {
    await ensureUserDataTables();
    const sources = await db.select({ id: sourcesTable.id, storagePath: sourcesTable.storagePath })
      .from(sourcesTable).where(eq(sourcesTable.ownerId, owner));
    await Promise.all(sources.map(async (source) => {
      cancelIngestion(source.id);
      await storage.deleteDerivedObjects(source.id).catch((error) => logger.warn({ sourceId: source.id, error }, "Could not remove derived source assets during account data deletion"));
      if (source.storagePath) await storage.deleteObjectEntity(source.storagePath).catch((error) => logger.warn({ sourceId: source.id, error }, "Could not remove uploaded source during account data deletion"));
    }));
    await db.transaction(async (tx) => {
      await tx.delete(coursesTable).where(eq(coursesTable.ownerId, owner));
      await tx.delete(userSettingsTable).where(eq(userSettingsTable.ownerId, owner));
    });
    res.json({ ok: true });
  } catch (error) {
    logger.error({ error }, "Could not delete account data");
    res.status(500).json({ error: accountError(error, "Could not delete all of your data. Nothing was confirmed as complete; try again.") });
  }
});

export default router;
