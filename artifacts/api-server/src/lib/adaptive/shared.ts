import { and, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  bktMasteryTable,
  conceptsTable,
  sourcesTable,
  unitConceptsTable,
  unitsTable,
} from "@workspace/db/schema";
import { PRIOR_KNOWN, retention, type ConceptState } from "./bkt";

export class QuizError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "QuizError";
  }
}

/** Parses a JSON object out of a model response, tolerating code fences. */
export function parseJsonLoose(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const stripped = raw.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function shuffle<T>(values: T[]): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function weightedSample<T>(items: T[], weights: number[], k: number): T[] {
  const pool = items.map((item, index) => ({ item, weight: Math.max(weights[index], 1e-6) }));
  const chosen: T[] = [];
  while (chosen.length < k && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let pick = Math.random() * total;
    let index = 0;
    for (; index < pool.length - 1; index += 1) {
      pick -= pool[index].weight;
      if (pick <= 0) break;
    }
    chosen.push(pool[index].item);
    pool.splice(index, 1);
  }
  return chosen;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * The learner identity. Courses belong to one owner, but the learner whose
 * mastery is tracked can be overridden with an x-learner-id header. The
 * evaluation simulator uses this to run many virtual students over the same
 * course without re-ingesting it. Always namespaced by the owner.
 */
export function learnerKey(ownerId: string, header: unknown): string {
  const value = Array.isArray(header) ? header[0] : header;
  const clean = typeof value === "string" ? value.trim().slice(0, 64) : "";
  return clean && /^[A-Za-z0-9_.-]+$/.test(clean) ? `${ownerId}::${clean}` : ownerId;
}

export type PoolConcept = {
  id: string;
  name: string;
  topicId: string;
  unitIds: string[];
};

/** Concepts of a course that have at least one unit from a ready source. */
export async function loadConceptPool(options: {
  courseId: string;
  ownerId: string;
  topicId?: string;
  restrictUnitIds?: string[];
}): Promise<PoolConcept[]> {
  const filters = [
    eq(conceptsTable.courseId, options.courseId),
    eq(sourcesTable.ownerId, options.ownerId),
    eq(sourcesTable.status, "ready"),
    ...(options.topicId ? [eq(conceptsTable.topicId, options.topicId)] : []),
    ...(options.restrictUnitIds?.length
      ? [inArray(unitsTable.id, options.restrictUnitIds)]
      : []),
  ];
  const rows = await db
    .select({
      conceptId: unitConceptsTable.conceptId,
      unitId: unitConceptsTable.unitId,
      name: conceptsTable.name,
      topicId: conceptsTable.topicId,
    })
    .from(unitConceptsTable)
    .innerJoin(conceptsTable, eq(unitConceptsTable.conceptId, conceptsTable.id))
    .innerJoin(unitsTable, eq(unitConceptsTable.unitId, unitsTable.id))
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .where(and(...filters));

  const byConcept = new Map<string, PoolConcept>();
  for (const row of rows) {
    const existing = byConcept.get(row.conceptId);
    if (existing) {
      if (!existing.unitIds.includes(row.unitId)) existing.unitIds.push(row.unitId);
    } else {
      byConcept.set(row.conceptId, {
        id: row.conceptId,
        name: row.name,
        topicId: row.topicId,
        unitIds: [row.unitId],
      });
    }
  }
  return [...byConcept.values()];
}

export type MasteryRow = typeof bktMasteryTable.$inferSelect;

export async function loadMasteryMap(
  learnerId: string,
  conceptIds: string[],
): Promise<Map<string, MasteryRow>> {
  if (conceptIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(bktMasteryTable)
    .where(
      and(
        eq(bktMasteryTable.learnerId, learnerId),
        inArray(bktMasteryTable.conceptId, conceptIds),
      ),
    );
  return new Map(rows.map((row) => [row.conceptId, row]));
}

export function stateOf(row: MasteryRow | undefined, now: Date = new Date()): ConceptState {
  if (!row) return { pKnown: PRIOR_KNOWN, attempts: 0, retention: 1 };
  return {
    pKnown: row.pKnown,
    attempts: row.attempts,
    retention: retention(row.stability, row.lastReviewedAt, now),
  };
}
