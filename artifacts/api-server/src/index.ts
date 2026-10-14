import app from "./app";
import { logger } from "./lib/logger";
import { resumeIngestionJobs } from "./lib/ingestion/worker";
import { ensureEmbeddings, ensureModels } from "./lib/ingestion/ai";
import { mirrorExistingFilesToDb } from "./lib/localFile";
import { ensureUserDataTables } from "./lib/ensureUserDataTables";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void ensureUserDataTables().then(() => {
    logger.info("Account settings and saved-plan tables are ready");
  }).catch((error) => {
    logger.error({ error }, "Could not prepare account settings and saved-plan tables; check DATABASE_URL and run pnpm run setup if base tables are missing");
  });
  void ensureEmbeddings();
  void mirrorExistingFilesToDb();
  void ensureModels().then(() => resumeIngestionJobs()).catch((err) => {
    logger.error({ err }, "Could not resume StudyGraph ingestion jobs");
  });
});
