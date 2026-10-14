/**
 * Learner model: Bayesian Knowledge Tracing (BKT) + an exponential forgetting
 * curve for spaced review. Pure functions, no I/O, so they are easy to test.
 */

export type QuestionKind = "mcq" | "short" | "numeric";

/** Prior probability a never-tested concept is known (before any evidence). */
export const PRIOR_KNOWN = 0.3;
const SLIP = 0.1;
const LEARN = 0.15;

/** Chance of a correct answer without knowing the concept, by question type. */
export function guessProbability(kind: QuestionKind): number {
  if (kind === "mcq") return 0.25;
  if (kind === "short") return 0.1;
  return 0.05;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * One BKT step. `correctness` in [0,1] supports partial credit (the posterior
 * is a mixture of the "correct" and "incorrect" posteriors). `weight` in (0,1]
 * scales how strongly this evidence moves the estimate, so weaker evidence
 * (a chat message) moves it less than a graded quiz answer.
 */
export function bktUpdate(
  pKnown: number,
  correctness: number,
  options: { guess: number; weight?: number },
): number {
  const p = clamp(pKnown, 0.001, 0.999);
  const guess = options.guess;
  const weight = clamp(options.weight ?? 1, 0, 1);
  const c = clamp(correctness, 0, 1);

  const posteriorIfCorrect = (p * (1 - SLIP)) / (p * (1 - SLIP) + (1 - p) * guess);
  const posteriorIfWrong = (p * SLIP) / (p * SLIP + (1 - p) * (1 - guess));
  const posterior = c * posteriorIfCorrect + (1 - c) * posteriorIfWrong;
  const afterLearning = posterior + (1 - posterior) * LEARN;
  return clamp(p + weight * (afterLearning - p), 0.01, 0.99);
}

/** Memory stability in days; grows after success, shrinks after a miss. */
export function updateStability(stability: number, correctness: number): number {
  const next = correctness >= 0.7 ? stability * 2.0 : correctness <= 0.3 ? stability * 0.6 : stability;
  return clamp(next, 0.5, 120);
}

const MS_PER_DAY = 86_400_000;

/** Retrievability R(t) = exp(-t / stability). */
export function retention(
  stability: number,
  lastReviewedAt: Date | null,
  now: Date = new Date(),
): number {
  if (!lastReviewedAt) return 1;
  const days = Math.max(0, (now.getTime() - lastReviewedAt.getTime()) / MS_PER_DAY);
  return Math.exp(-days / Math.max(0.1, stability));
}

/** Next review is when predicted retention falls to 80%. */
export function nextReviewDate(stability: number, from: Date = new Date()): Date {
  const days = -Math.max(0.1, stability) * Math.log(0.8);
  return new Date(from.getTime() + days * MS_PER_DAY);
}

export type ConceptState = {
  pKnown: number;
  attempts: number;
  retention: number;
};

/**
 * Priority for the next quiz: low mastery, decayed memory, and (for
 * never-tested concepts) an exploration bonus so a new learner is covered
 * broadly before the quiz narrows onto weak spots.
 */
export function priorityScore(state: ConceptState): number {
  const weakness = 1 - state.pKnown;
  const forgetting = state.attempts > 0 ? 0.5 * (1 - state.retention) : 0;
  const exploration = state.attempts === 0 ? 0.25 : 0;
  return weakness + forgetting + exploration;
}

export function masteryLabel(pKnown: number, attempts: number): "untested" | "weak" | "learning" | "strong" {
  if (attempts === 0) return "untested";
  if (pKnown >= 0.8) return "strong";
  if (pKnown >= 0.55) return "learning";
  return "weak";
}
