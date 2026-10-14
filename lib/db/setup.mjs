// Enables the pgvector extension (required by the schema) before `drizzle-kit push`.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add it to your .env file.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query("CREATE EXTENSION IF NOT EXISTS vector");
  console.log("pgvector extension is enabled.");
} catch (error) {
  console.error("Could not enable pgvector:", error.message);
  console.error("Use a Postgres with pgvector (Neon/Supabase, or the pgvector/pgvector Docker image).");
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}
