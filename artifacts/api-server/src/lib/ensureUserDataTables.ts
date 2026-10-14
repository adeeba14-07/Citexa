import { pool } from "@workspace/db";

/**
 * These two tables were added after the original StudyGraph schema. Create them
 * additively at startup so existing databases gain settings and saved-plan
 * persistence without a destructive migration or an extra manual command.
 * The rest of the application schema remains managed by `pnpm run setup`.
 */
let readiness: Promise<void> | undefined;

export function ensureUserDataTables(): Promise<void> {
  if (!readiness) {
    readiness = prepareUserDataTables().catch((error) => {
      readiness = undefined;
      throw error;
    });
  }
  return readiness;
}

async function prepareUserDataTables(): Promise<void> {
  const result = await pool.query<{ courses: string | null }>(
    "select to_regclass('public.studygraph_courses') as courses",
  );
  if (!result.rows[0]?.courses) {
    throw new Error("Base StudyGraph tables are missing. Configure DATABASE_URL and run pnpm run setup.");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS studygraph_user_settings (
      owner_id text PRIMARY KEY,
      daily_goal_minutes integer NOT NULL DEFAULT 30,
      reminder_time text,
      reminders_enabled boolean NOT NULL DEFAULT false,
      language text NOT NULL DEFAULT 'en',
      bigger_text boolean NOT NULL DEFAULT false,
      dyslexia_font boolean NOT NULL DEFAULT false,
      high_contrast boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS studygraph_saved_plans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id text NOT NULL,
      course_id uuid NOT NULL REFERENCES studygraph_courses(id) ON DELETE CASCADE,
      exam_date text NOT NULL,
      minutes_per_day integer NOT NULL,
      schedule jsonb NOT NULL,
      completed jsonb NOT NULL DEFAULT '[]'::jsonb,
      saved_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS studygraph_saved_plans_owner_course_idx
    ON studygraph_saved_plans (owner_id, course_id, saved_at)
  `);
}
