import { index, integer, jsonb, pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import { coursesTable } from "./studygraph";

export type SavedPlanTask = {
  kind: "study" | "review" | "mock";
  concept: string;
  minutes: number;
};
export type SavedPlanDay = { date: string; tasks: SavedPlanTask[] };

export const userSettingsTable = pgTable("studygraph_user_settings", {
  ownerId: text("owner_id").primaryKey(),
  dailyGoalMinutes: integer("daily_goal_minutes").notNull().default(30),
  reminderTime: text("reminder_time"),
  remindersEnabled: boolean("reminders_enabled").notNull().default(false),
  language: text("language").notNull().default("en"),
  biggerText: boolean("bigger_text").notNull().default(false),
  dyslexiaFont: boolean("dyslexia_font").notNull().default(false),
  highContrast: boolean("high_contrast").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const savedStudyPlansTable = pgTable(
  "studygraph_saved_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id").notNull(),
    courseId: uuid("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
    examDate: text("exam_date").notNull(),
    minutesPerDay: integer("minutes_per_day").notNull(),
    schedule: jsonb("schedule").$type<SavedPlanDay[]>().notNull(),
    completed: jsonb("completed").$type<string[]>().notNull().default([]),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("studygraph_saved_plans_owner_course_idx").on(table.ownerId, table.courseId, table.savedAt),
  ],
);
