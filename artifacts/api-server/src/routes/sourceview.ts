import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sourcesTable, unitsTable } from "@workspace/db/schema";
import { errorMessage } from "../lib/ingestion/ai";
import { renderPdfPageOnce, renderPdfPageWithHighlightOnce, renderPptxSlideOnce } from "../lib/ingestion/render";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
import {
  studygraphOwnerId,
  studygraphPathParam,
  validStudygraphId,
} from "../lib/studygraph/ownership";

const router: IRouter = Router();
const storage = new ObjectStorageService();

const pageOf = sql`coalesce((${unitsTable.locator}->>'page')::int, (${unitsTable.locator}->>'slide')::int)`;

/** Highest page/slide number that has a study unit (null for videos). */
export async function pageCountFor(sourceId: string): Promise<number | null> {
  const [row] = await db
    .select({ pages: sql<number | null>`max(${pageOf})` })
    .from(unitsTable)
    .where(eq(unitsTable.sourceId, sourceId));
  const pages = Number(row?.pages ?? 0);
  return pages > 0 ? pages : null;
}

async function ownedSource(req: Request, res: Response) {
  const ownerId = studygraphOwnerId(res);
  const sourceId = studygraphPathParam(req, "sourceId");
  if (!validStudygraphId(sourceId)) {
    res.status(400).json({ error: "Invalid source id." });
    return null;
  }
  const [source] = await db
    .select()
    .from(sourcesTable)
    .where(and(eq(sourcesTable.id, sourceId), eq(sourcesTable.ownerId, ownerId)))
    .limit(1);
  if (!source) {
    res.status(404).json({ error: "Source not found." });
    return null;
  }
  return { ownerId, source };
}

async function storedFileAvailable(objectPath: string | null | undefined): Promise<boolean> {
  if (!objectPath) return false;
  try {
    await storage.getObjectEntityFile(objectPath);
    return true;
  } catch {
    return false;
  }
}

/** Everything the source viewer needs to open a whole source (used by the library and the tutor). */
router.get("/x/sources/:sourceId/view", async (req: Request, res: Response) => {
  try {
    const found = await ownedSource(req, res);
    if (!found) return;
    const { source } = found;
    const chapterRows = source.sourceType === "video"
      ? await db
          .select({ id: unitsTable.id, text: unitsTable.text, locator: unitsTable.locator })
          .from(unitsTable)
          .where(eq(unitsTable.sourceId, source.id))
          .orderBy(sql`(${unitsTable.locator}->>'start_sec')::numeric asc`)
          .limit(200)
      : [];
    res.json({
      id: source.id,
      title: source.title,
      type: source.sourceType,
      status: source.status,
      originalFilename: source.originalFilename ?? null,
      mimeType: source.mimeType ?? null,
      youtubeUrl: source.sourceUrl ?? null,
      fileUrl:
        source.storagePath && source.storagePath.startsWith("/objects/")
          ? `/api/storage${source.storagePath}`
          : null,
      fileAvailable: await storedFileAvailable(source.storagePath),
      pageCount: source.sourceType === "video" ? null : await pageCountFor(source.id),
      chapters: chapterRows.flatMap((unit) => unit.locator.type === "video" ? [{
        unitId: unit.id,
        startSec: unit.locator.start_sec,
        title: unit.text.replace(/\s+/g, " ").trim().slice(0, 100) || "Video segment",
      }] : []),
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

function sendStored(res: Response, absPath: string, contentType: string | undefined) {
  res.sendFile(absPath, {
    dotfiles: "allow",
    headers: {
      "Content-Type": contentType || "image/png",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/**
 * One page of a PDF (or slide of a deck) as an image. Prefers the preview saved at upload time; when
 * that is missing it renders the page again from the stored original PDF and keeps the result.
 */
router.get("/x/sources/:sourceId/page/:page/image", async (req: Request, res: Response) => {
  try {
    const found = await ownedSource(req, res);
    if (!found) return;
    const { source, ownerId } = found;
    const page = Number(studygraphPathParam(req, "page"));
    if (!Number.isInteger(page) || page < 1 || page > 5000) {
      res.status(400).json({ error: "Invalid page number." });
      return;
    }
    if (source.sourceType === "video") {
      res.status(404).json({ error: "Videos do not have pages." });
      return;
    }
    // A citation chip may request a highlighted PDF image for its exact study unit.
    // Never accept a unit from another source/course, and leave ordinary page navigation unchanged.
    const requestedUnitId = typeof req.query.unitId === "string" ? req.query.unitId : "";
    if (requestedUnitId && source.sourceType === "pdf" && validStudygraphId(requestedUnitId) && source.storagePath) {
      const [citedUnit] = await db
        .select({ text: unitsTable.text, locator: unitsTable.locator })
        .from(unitsTable)
        .where(and(eq(unitsTable.id, requestedUnitId), eq(unitsTable.sourceId, source.id)))
        .limit(1);
      if (citedUnit && citedUnit.locator.type === "page" && Number(citedUnit.locator.page) === page) {
        try {
          const original = await storage.getObjectEntityFile(source.storagePath);
          const bytes = await renderPdfPageWithHighlightOnce(
            `${source.id}:${page}:${requestedUnitId}`,
            original.absPath,
            page,
            citedUnit.text,
          );
          res.type("image/png").set("Cache-Control", "private, max-age=3600").send(bytes);
          return;
        } catch (highlightError) {
          req.log?.warn({ err: highlightError, sourceId: source.id, unitId: requestedUnitId }, "Falling back to an unhighlighted PDF preview");
        }
      }
    }

    // 1. The preview stored when the source was processed.
    const [unit] = await db
      .select({ locator: unitsTable.locator })
      .from(unitsTable)
      .where(
        and(
          eq(unitsTable.sourceId, source.id),
          sql`${pageOf} = ${page}`,
          sql`${unitsTable.locator}->>'imagePath' is not null`,
        ),
      )
      .limit(1);
    const storedPath = unit?.locator.imagePath;
    if (storedPath) {
      try {
        const file = await storage.getObjectEntityFile(storedPath);
        const [metadata] = await file.getMetadata();
        sendStored(res, file.absPath, metadata.contentType);
        return;
      } catch (error) {
        if (!(error instanceof ObjectNotFoundError)) throw error;
      }
    }

    // 2. A page rendered earlier from the original.
    const padded = String(page).padStart(4, "0");
    const renderedPath = `/objects/studygraph/${source.id}/render-${padded}.png`;
    try {
      const cached = await storage.getObjectEntityFile(renderedPath);
      sendStored(res, cached.absPath, "image/png");
      return;
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error;
    }

    // A PPTX preview can go missing even when the original deck is still available.
    // Re-run the same extractor/LibreOffice renderer on demand and cache the rebuilt slide.
    if (source.sourceType === "pptx" && source.storagePath) {
      try {
        const original = await storage.getObjectEntityFile(source.storagePath);
        const bytes = await renderPptxSlideOnce(`${source.id}:${page}`, original.absPath, page);
        await storage.saveDerivedObject({
          sourceId: source.id,
          fileName: `render-${padded}.png`,
          contentType: "image/png",
          bytes,
          ownerId,
        }).catch(() => undefined);
        res.type("image/png").set("Cache-Control", "private, max-age=3600").send(bytes);
        return;
      } catch (renderError) {
        if (renderError instanceof ObjectNotFoundError) {
          res.status(404).json({ error: "The original PowerPoint file is no longer stored on this server." });
          return;
        }
        req.log?.error({ err: renderError, sourceId: source.id, page }, "Could not rebuild a PowerPoint slide preview");
        res.status(503).json({ error: `PowerPoint preview could not be rebuilt. ${errorMessage(renderError).slice(0, 300)}` });
        return;
      }
    }

    // 3. Render it now from the original PDF.
    if (source.sourceType !== "pdf" || !source.storagePath) {
      res.status(404).json({ error: "No preview is stored for this slide. Upload the deck again to restore it." });
      return;
    }
    let original;
    try {
      original = await storage.getObjectEntityFile(source.storagePath);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "The original file is no longer stored on this server. Upload it again to restore the preview." });
        return;
      }
      throw error;
    }
    const bytes = await renderPdfPageOnce(`${source.id}:${page}`, original.absPath, page);
    await storage
      .saveDerivedObject({
        sourceId: source.id,
        fileName: `render-${padded}.png`,
        contentType: "image/png",
        bytes,
        ownerId,
      })
      .catch(() => undefined);
    res.type("image/png").set("Cache-Control", "private, max-age=3600").send(bytes);
  } catch (error) {
    req.log?.error({ err: error }, "Could not render the page preview");
    res.status(500).json({ error: errorMessage(error) });
  }
});

export default router;
