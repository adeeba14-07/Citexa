import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import { ensureUserDataTables } from "../lib/ensureUserDataTables";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  try {
    await ensureUserDataTables();
    const result = await db.execute(sql`select
      to_regclass('studygraph_conversations') is not null as conversations,
      to_regclass('studygraph_conversation_messages') is not null as messages,
      to_regclass('studygraph_user_settings') is not null as settings,
      to_regclass('studygraph_saved_plans') is not null as plans`);
    const tables = result.rows[0] as Record<string, boolean> | undefined;
    const missing = Object.entries({
      conversations: tables?.conversations,
      conversationMessages: tables?.messages,
      accountSettings: tables?.settings,
      savedStudyPlans: tables?.plans,
    }).filter(([, exists]) => exists !== true).map(([name]) => name);
    if (missing.length) {
      res.status(503).json({ status: "degraded", error: `Database schema is missing: ${missing.join(", ")}. Stop the app, verify DATABASE_URL, then run pnpm run setup.` });
      return;
    }
    res.json(HealthCheckResponse.parse({ status: "ok" }));
  } catch (error) {
    logger.error({ error }, "Database health check failed");
    res.status(503).json({ status: "degraded", error: "Database connection failed. Check DATABASE_URL and the API server logs." });
  }
});

export default router;
