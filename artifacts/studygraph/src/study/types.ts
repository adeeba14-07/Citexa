export type Locator =
  | { type: 'page'; page: number; imagePath?: string }
  | { type: 'slide'; slide: number; imagePath?: string }
  | { type: 'video'; start_sec: number; end_sec: number; imagePath?: string };

export type Citation = {
  unitId: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: 'pdf' | 'pptx' | 'video';
  locator: Locator;
  excerpt?: string;
};

export type QuestionType = 'mcq' | 'short' | 'numeric';

export type QuizQuestion = {
  id: string;
  position: number;
  type: QuestionType;
  prompt: string;
  options: string[] | null;
  difficulty: 'easy' | 'medium' | 'hard';
  topic: { id: string; name: string } | null;
  concepts: { id: string; name: string }[];
  sources: Omit<Citation, 'sourceId' | 'excerpt'>[];
  verification: { status: string; method: string; detail?: string };
};

export type Quiz = {
  id: string;
  title: string;
  mode: 'practice' | 'diagnostic' | 'mock' | 'chat';
  difficulty: string;
  attempted: boolean;
  stats: {
    requested: number; generated: number; rejectedVerification: number;
    rejectedDuplicate: number; repeatsServed: number; kept: number;
  };
  questions: QuizQuestion[];
};

export type GradedResult = {
  questionId: string;
  type: QuestionType;
  prompt: string;
  score: number;
  isCorrect: boolean;
  yourAnswer: string;
  correctAnswer: string;
  feedback: string;
  explanation: string;
  errorType: string | null;
  misconception: string | null;
  difficulty: string;
  citations: Citation[];
  conceptIds: string[];
};

export type Report = {
  percentage: number;
  byTopic: { topicId: string | null; topic: string; earned: number; total: number }[];
  weakTopics: { topic: string; accuracy: number; mastery: number | null }[];
  misconceptions: { label: string; concept: string; count: number; citations: Citation[] }[];
  nextSteps: string[];
};

export type SubmitResponse = {
  attemptId: string;
  score: number;
  total: number;
  percentage: number;
  results: GradedResult[];
  report: Report;
  mastery: { conceptId: string; name: string; before: number; after: number }[];
};

export type ConceptMastery = {
  id: string; name: string; topicId: string; topic: string; pKnown: number; attempts: number;
  retention: number; status: 'untested' | 'weak' | 'learning' | 'strong';
  nextReviewAt: string | null; due: boolean; priority: number;
};

export type MasteryResponse = {
  needsDiagnostic: boolean;
  summary: { totalConcepts: number; testedConcepts: number; averageMastery: number | null; weakConcepts: number; dueConcepts: number };
  concepts: ConceptMastery[];
  topics: { id: string; name: string; total: number; tested: number; mastery: number | null }[];
  weakConcepts: ConceptMastery[];
  history: { i: number; at: string; source: string; average: number }[];
  studyMilestones: { id: string; kind: 'concept' | 'topic'; name: string; topic: string; at: string; minutes: number }[];
  misconceptions: { label: string; concept: string; count: number; citations: Citation[] }[];
  questionStats: {
    generated: number; rejectedVerification: number; rejectedDuplicate: number;
    repeatsServed: number; kept: number; repetitionRate: number; duplicateThreshold: number;
  };
  recentAttempts: { id: string; quizId: string; score: number; total: number; createdAt: string; mode: string }[];
};

export type GraphResponse = {
  topics: { id: string; name: string; parentId: string | null }[];
  concepts: { id: string; name: string; description: string | null; topicId: string; pKnown: number; attempts: number; status: ConceptMastery['status'] }[];
  edges: { from: string; to: string }[];
};

export type UnitDetail = {
  id: string;
  text: string;
  figureCaption: string | null;
  locator: Locator;
  source: { id: string; title: string; type: 'pdf' | 'pptx' | 'video'; fileUrl: string | null; mimeType: string | null; youtubeUrl: string | null };
  imageUrl: string | null;
  pageCount?: number | null;
};

/** What the viewer needs to open a whole source (from the library or a citation). */
export type SourceView = {
  id: string;
  title: string;
  type: 'pdf' | 'pptx' | 'video';
  status: string;
  originalFilename: string | null;
  mimeType: string | null;
  youtubeUrl: string | null;
  fileUrl: string | null;
  fileAvailable: boolean;
  pageCount: number | null;
  chapters: { unitId: string; startSec: number; title: string }[];
};

export type Flashcard = { front: string; back: string; citations: Citation[] };
export type PlanDay = { date: string; tasks: { kind: 'study' | 'review' | 'mock'; concept: string; minutes: number }[] };
