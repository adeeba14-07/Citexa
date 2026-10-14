import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  conceptsTable,
  coursesTable,
  topicsTable,
  type StudyCitation,
} from "./studygraph";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) =>
    value.slice(1, -1).split(",").filter(Boolean).map(Number),
});

export type QuestionType = "mcq" | "short" | "numeric";

export type AnswerKey =
  | { type: "mcq"; correctOption: number }
  | { type: "short"; modelAnswer: string; keyPoints: string[] }
  | {
      type: "numeric";
      value: number;
      unit: string;
      tolerancePct: number;
      expression?: string;
    };

export type QuestionVerification = {
  status: "verified" | "unverified";
  method: string;
  detail?: string;
};

export type QuizStats = {
  requested: number;
  generated: number;
  rejectedVerification: number;
  rejectedDuplicate: number;
  repeatsServed: number;
  kept: number;
};

/** Adaptive quizzes (MCQ, short answer, numerical) with verified keys. */
export const quizzesTable = pgTable(
  "studygraph_quizzes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    learnerId: text("learner_id").notNull(),
    mode: text("mode").notNull(),
    strategy: text("strategy").notNull().default("adaptive"),
    title: text("title").notNull(),
    difficulty: text("difficulty").notNull(),
    stats: jsonb("stats").$type<QuizStats>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_quizzes_learner_idx").on(table.learnerId, table.courseId),
  ],
);

export const quizQuestionsTable = pgTable(
  "studygraph_quiz_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzesTable.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    learnerId: text("learner_id").notNull(),
    position: integer("position").notNull(),
    type: text("type").$type<QuestionType>().notNull(),
    prompt: text("prompt").notNull(),
    options: jsonb("options").$type<string[] | null>(),
    answerKey: jsonb("answer_key").$type<AnswerKey>().notNull(),
    explanation: text("explanation").notNull(),
    difficulty: text("difficulty").notNull(),
    topicId: uuid("topic_id").references(() => topicsTable.id, {
      onDelete: "set null",
    }),
    conceptIds: jsonb("concept_ids").$type<string[]>().notNull(),
    unitIds: jsonb("unit_ids").$type<string[]>().notNull(),
    citations: jsonb("citations").$type<StudyCitation[]>().notNull(),
    misconceptions: jsonb("misconceptions").$type<(string | null)[] | null>(),
    verification: jsonb("verification").$type<QuestionVerification>().notNull(),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_quiz_questions_quiz_idx").on(table.quizId),
    index("studygraph_quiz_questions_learner_idx").on(
      table.learnerId,
      table.courseId,
    ),
  ],
);

export type QuestionResult = {
  questionId: string;
  type: QuestionType;
  score: number;
  isCorrect: boolean;
  yourAnswer: string;
  correctAnswer: string;
  feedback: string;
  errorType: string | null;
  misconception: string | null;
};

export const quizAttemptsTable = pgTable(
  "studygraph_quiz_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    quizId: uuid("quiz_id")
      .notNull()
      .references(() => quizzesTable.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    learnerId: text("learner_id").notNull(),
    results: jsonb("results").$type<QuestionResult[]>().notNull(),
    score: real("score").notNull(),
    total: integer("total").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_quiz_attempts_learner_idx").on(
      table.learnerId,
      table.courseId,
      table.createdAt,
    ),
  ],
);

/** Per-learner, per-concept Bayesian Knowledge Tracing state + forgetting curve. */
export const bktMasteryTable = pgTable(
  "studygraph_bkt_mastery",
  {
    learnerId: text("learner_id").notNull(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    pKnown: real("p_known").notNull().default(0.3),
    attempts: integer("attempts").notNull().default(0),
    correct: real("correct").notNull().default(0),
    stability: real("stability").notNull().default(1),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.learnerId, table.conceptId] })],
);

/** Every mastery update, with its evidence source (quiz | diagnostic | chat). */
export const bktEventsTable = pgTable(
  "studygraph_bkt_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: text("learner_id").notNull(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => conceptsTable.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    correctness: real("correctness"),
    weight: real("weight").notNull(),
    before: real("before").notNull(),
    after: real("after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_bkt_events_learner_idx").on(
      table.learnerId,
      table.courseId,
      table.createdAt,
    ),
  ],
);

export const misconceptionLogTable = pgTable(
  "studygraph_misconception_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerId: text("learner_id").notNull(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => coursesTable.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id").references(() => conceptsTable.id, {
      onDelete: "set null",
    }),
    questionId: uuid("question_id"),
    label: text("label").notNull(),
    citations: jsonb("citations").$type<StudyCitation[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studygraph_misconception_learner_idx").on(
      table.learnerId,
      table.courseId,
    ),
  ],
);
