import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { Router, type IRouter, type Request, type Response } from "express";

import { getUserId } from "../lib/auth";
import { LocalFile } from "../lib/localFile";
import { ObjectPermission } from "../lib/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
  verifyUploadSignature,
} from "../lib/objectStorage";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

/** POST /storage/uploads/request-url: returns a signed same-origin upload URL. */
router.post("/storage/uploads/request-url", async (req: Request, res: Response) => {
  if (!getUserId(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }
  try {
    const relativeUploadURL = await objectStorageService.getObjectEntityUploadURL();
    const uploadURL = new URL(relativeUploadURL, `${req.protocol}://${req.get("host")}`).toString();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    res.json(RequestUploadUrlResponse.parse({ uploadURL, objectPath }));
  } catch (error) {
    req.log.error({ err: error, route: "storage/uploads/request-url" }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * PUT /storage/local-upload/:id
 * Receives the raw file body, streamed straight to disk (works for large
 * videos). Protected by the HMAC-signed, expiring URL from request-url.
 */
router.put("/storage/local-upload/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const exp = String(req.query.exp ?? "");
  const sig = String(req.query.sig ?? "");
  if (!verifyUploadSignature(id, exp, sig)) {
    res.status(403).json({ error: "Upload link is invalid or has expired." });
    return;
  }
  try {
    const file = new LocalFile(`uploads/${id}`);
    await fs.mkdir(path.dirname(file.absPath), { recursive: true });
    await pipeline(req, createWriteStream(file.absPath));
    await file.setContentType(
      req.header("content-type") ?? "application/octet-stream",
    );
    await file.mirrorToDb();
    res.status(200).json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, "Local upload failed");
    res.status(500).json({ error: "Upload failed." });
  }
});

/** No public objects exist in the local setup. */
router.get("/storage/public-objects/*filePath", (_req: Request, res: Response) => {
  res.status(404).json({ error: "File not found" });
});

/**
 * GET /storage/objects/*
 * Serves a stored object to its owner. Uses sendFile so HTTP Range requests
 * work, which the video player needs to seek to a citation timestamp.
 */
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;
    const objectFile = await objectStorageService.getObjectEntityFile(
      `/objects/${wildcardPath}`,
    );
    const canAccess = await objectStorageService.canAccessObjectEntity({
      userId,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });
    if (!canAccess) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const [metadata] = await objectFile.getMetadata();
    res.sendFile(objectFile.absPath, {
      dotfiles: "allow",
      headers: {
        "Content-Type": metadata.contentType || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      // Browsers opening "original file" links get a readable page instead of raw JSON.
      if ((req.headers.accept ?? "").includes("text/html")) {
        res
          .status(404)
          .type("html")
          .send(
            `<!doctype html><meta charset="utf-8"><title>File not available</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#25473c;line-height:1.6"><h2>The original file is not available on this server</h2><p>Citexa still has the text it extracted from this source, so answers and citations keep working. The uploaded file itself is no longer stored here (this happens when the server is restarted without a persistent disk, or when the source was uploaded on another computer).</p><p>To open the original, upload the source again.</p></body>`,
          );
        return;
      }
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
