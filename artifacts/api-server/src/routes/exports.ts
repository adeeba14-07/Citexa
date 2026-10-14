import { and, asc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  conceptProgressTable,
  conceptsTable,
  coursesTable,
  sourcesTable,
  topicsTable,
  unitConceptsTable,
  unitsTable,
} from "@workspace/db/schema";
import {
  studygraphOwnerId,
  studygraphPathParam,
  validStudygraphId,
} from "../lib/studygraph/ownership";

const router: IRouter = Router();

function downloadName(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "studygraph-course"
  );
}

function locatorLabel(locator: {
  type: string;
  page?: number;
  slide?: number;
  start_sec?: number;
  end_sec?: number;
}): string {
  if (locator.type === "page" && locator.page) return `Page ${locator.page}`;
  if (locator.type === "slide" && locator.slide) return `Slide ${locator.slide}`;
  if (locator.type === "video") {
    const start = Math.max(0, Math.floor(locator.start_sec ?? 0));
    const end = Math.max(start, Math.floor(locator.end_sec ?? start));
    const stamp = (seconds: number) =>
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    return `${stamp(start)}–${stamp(end)}`;
  }
  return "Source location unavailable";
}

function escapeCsv(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}

router.get("/courses/:courseId/export/report", async (req: Request, res: Response) => {
  const ownerId = studygraphOwnerId(res);
  const courseId = studygraphPathParam(req, "courseId");
  if (!validStudygraphId(courseId)) {
    res.status(400).type("text").send("This course link is not valid.");
    return;
  }
  const [course] = await db.select().from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.ownerId, ownerId))).limit(1);
  if (!course) {
    res.status(404).type("text").send("This course could not be found.");
    return;
  }
  const rows = await db.select({
    unitId: unitsTable.id,
    text: unitsTable.text,
    figureCaption: unitsTable.figureCaption,
    locator: unitsTable.locator,
    sourceTitle: sourcesTable.title,
    topicName: topicsTable.name,
    conceptName: conceptsTable.name,
    mastery: conceptProgressTable.mastery,
  }).from(unitsTable)
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .leftJoin(unitConceptsTable, eq(unitConceptsTable.unitId, unitsTable.id))
    .leftJoin(conceptsTable, eq(unitConceptsTable.conceptId, conceptsTable.id))
    .leftJoin(topicsTable, eq(conceptsTable.topicId, topicsTable.id))
    .leftJoin(conceptProgressTable, and(eq(conceptProgressTable.conceptId, conceptsTable.id), eq(conceptProgressTable.ownerId, ownerId)))
    .where(and(eq(sourcesTable.courseId, courseId), eq(sourcesTable.ownerId, ownerId), eq(sourcesTable.status, "ready")))
    .orderBy(asc(sourcesTable.title), asc(unitsTable.createdAt));

  const byUnit = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!byUnit.has(row.unitId)) byUnit.set(row.unitId, row);
  const content = [...byUnit.values()].map((row) => {
    const notes = [row.text, row.figureCaption ? `Image or diagram: ${row.figureCaption}` : ""].filter(Boolean).join("\n\n");
    return `<article class="note"><div class="meta">${escapeHtml(row.sourceTitle)} · ${escapeHtml(locatorLabel(row.locator))}</div>${row.topicName ? `<p><b>Topic:</b> ${escapeHtml(row.topicName)}${row.conceptName ? ` · <b>Key idea:</b> ${escapeHtml(row.conceptName)}` : ""}</p>` : row.conceptName ? `<p><b>Key idea:</b> ${escapeHtml(row.conceptName)}</p>` : ""}<div class="text">${escapeHtml(notes || "No extracted note text available.")}</div>${row.mastery ? `<p class="meta">Your progress: ${escapeHtml(row.mastery)}</p>` : ""}</article>`;
  }).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(course.name)} · Study report</title><style>
    body{font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;color:#25473c;background:#f5f3eb;margin:0}.page{max-width:900px;margin:32px auto;padding:28px;background:#fffef9;border:1px solid #dedbd0;border-radius:20px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;border-bottom:1px solid #dedbd0;padding-bottom:18px}.print{border:0;border-radius:24px;background:#25473c;color:white;padding:12px 18px;font-weight:700;cursor:pointer}.intro{color:#627468}.note{padding:18px 0;border-bottom:1px solid #e9e5da;break-inside:avoid}.meta{color:#8b7550;font-size:13px}.text{white-space:pre-wrap;overflow-wrap:anywhere}.note p{font-size:14px}.empty{padding:20px;background:#f5f3eb;border-radius:12px}@media print{body{background:white}.page{margin:0 auto;border:0;border-radius:0;padding:0;max-width:none}.print,.intro{display:none}.note{break-inside:avoid}}
    </style></head><body><main class="page"><header class="top"><div><div class="meta">CITEXA · COURSE STUDY NOTES</div><h1>${escapeHtml(course.name)}</h1><p class="intro">A readable copy of the processed notes and their locations in your course materials.</p></div><button class="print" onclick="window.print()">Print / Save as PDF</button></header><p><b>${byUnit.size}</b> study notes from your ready course materials.</p>${content || `<p class="empty">No ready notes are available yet. When your course files finish processing, open this report again.</p>`}<p class="meta">Created ${escapeHtml(new Date().toLocaleDateString())}. Source locations are included so you can find the original page or slide.</p></main></body></html>`;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type("html").send(html);
});

router.get("/courses/:courseId/export/csv", async (req: Request, res: Response) => {
  const ownerId = studygraphOwnerId(res);
  const courseId = studygraphPathParam(req, "courseId");
  if (!validStudygraphId(courseId)) {
    res.status(400).json({ error: "Invalid course id." });
    return;
  }
  const [course] = await db
    .select()
    .from(coursesTable)
    .where(and(eq(coursesTable.id, courseId), eq(coursesTable.ownerId, ownerId)))
    .limit(1);
  if (!course) {
    res.status(404).json({ error: "Course not found." });
    return;
  }

  const rows = await db
    .select({
      text: unitsTable.text,
      figureCaption: unitsTable.figureCaption,
      locator: unitsTable.locator,
      sourceTitle: sourcesTable.title,
      sourceType: sourcesTable.sourceType,
      topicName: topicsTable.name,
      conceptName: conceptsTable.name,
      confidence: conceptProgressTable.confidence,
      mastery: conceptProgressTable.mastery,
    })
    .from(unitsTable)
    .innerJoin(sourcesTable, eq(unitsTable.sourceId, sourcesTable.id))
    .leftJoin(unitConceptsTable, eq(unitConceptsTable.unitId, unitsTable.id))
    .leftJoin(conceptsTable, eq(unitConceptsTable.conceptId, conceptsTable.id))
    .leftJoin(topicsTable, eq(conceptsTable.topicId, topicsTable.id))
    .leftJoin(
      conceptProgressTable,
      and(
        eq(conceptProgressTable.conceptId, conceptsTable.id),
        eq(conceptProgressTable.ownerId, ownerId),
      ),
    )
    .where(
      and(
        eq(sourcesTable.courseId, courseId),
        eq(sourcesTable.ownerId, ownerId),
        eq(sourcesTable.status, "ready"),
      ),
    )
    .orderBy(asc(sourcesTable.title), asc(unitsTable.createdAt));

  const header = [
    "course",
    "source",
    "source_type",
    "locator",
    "topic",
    "concept",
    "mastery",
    "confidence",
    "unit_text",
    "figure_caption",
  ];
  const records = rows.map((row) => [
    course.name,
    row.sourceTitle,
    row.sourceType,
    locatorLabel(row.locator),
    row.topicName,
    row.conceptName,
    row.mastery ?? "new",
    row.confidence ?? 0,
    row.text,
    row.figureCaption,
  ]);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `attachment; filename="${downloadName(course.name)}.csv"`);
  res.type("text/csv").send(
    [header, ...records].map((record) => record.map(escapeCsv).join(",")).join("\r\n"),
  );
});

export default router;
