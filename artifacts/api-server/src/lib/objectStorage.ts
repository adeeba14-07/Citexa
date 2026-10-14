import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
  type ObjectAclPolicy,
} from "./objectAcl";
import { LocalFile, removeDirectory } from "./localFile";

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

const UPLOAD_ROUTE = "/api/storage/local-upload/";
const UPLOAD_ID = /^[0-9a-f-]{36}$/i;

function secret(): string {
  return process.env.STORAGE_SECRET ?? "studygraph-local-dev-secret";
}

function sign(id: string, exp: number): string {
  return createHmac("sha256", secret()).update(`${id}.${exp}`).digest("hex");
}

/** Validates a signed local upload URL's query parameters. */
export function verifyUploadSignature(id: string, exp: string, sig: string): boolean {
  if (!UPLOAD_ID.test(id)) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Date.now()) return false;
  const expected = Buffer.from(sign(id, expNum));
  const given = Buffer.from(sig ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class ObjectStorageService {
  getPublicObjectSearchPaths(): string[] {
    return [];
  }

  getPrivateObjectDir(): string {
    return "/local";
  }

  async searchPublicObject(_filePath: string): Promise<LocalFile | null> {
    return null;
  }

  async downloadObject(file: LocalFile, cacheTtlSec = 3600): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const aclPolicy = await getObjectAclPolicy(file);
    const isPublic = aclPolicy?.visibility === "public";
    const webStream = Readable.toWeb(file.createReadStream()) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) headers["Content-Length"] = String(metadata.size);
    return new Response(webStream, { headers });
  }

  /** Returns a short-lived, signed, same-origin URL that accepts a PUT. */
  async getObjectEntityUploadURL(): Promise<string> {
    const id = randomUUID();
    const exp = Date.now() + 60 * 60 * 1000;
    return `${UPLOAD_ROUTE}${id}?exp=${exp}&sig=${sign(id, exp)}`;
  }

  async getObjectEntityFile(objectPath: string): Promise<LocalFile> {
    if (!objectPath.startsWith("/objects/")) throw new ObjectNotFoundError();
    const entityId = objectPath.slice("/objects/".length);
    if (!entityId) throw new ObjectNotFoundError();
    let file: LocalFile;
    try {
      file = new LocalFile(entityId);
      void file.absPath;
    } catch {
      throw new ObjectNotFoundError();
    }
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    const index = rawPath.indexOf(UPLOAD_ROUTE);
    if (index === -1) return rawPath;
    const rest = rawPath.slice(index + UPLOAD_ROUTE.length).split("?")[0];
    return `/objects/uploads/${rest}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    aclPolicy: ObjectAclPolicy,
  ): Promise<string> {
    const normalizedPath = this.normalizeObjectEntityPath(rawPath);
    if (!normalizedPath.startsWith("/")) return normalizedPath;
    const objectFile = await this.getObjectEntityFile(normalizedPath);
    await setObjectAclPolicy(objectFile, aclPolicy);
    return normalizedPath;
  }

  async saveDerivedObject({
    sourceId,
    fileName,
    contentType,
    bytes,
    ownerId,
  }: {
    sourceId: string;
    fileName: string;
    contentType: string;
    bytes: Buffer;
    ownerId: string;
  }): Promise<string> {
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const entityPath = `studygraph/${sourceId}/${safeName}`;
    const file = new LocalFile(entityPath);
    await file.save(bytes, { metadata: { contentType } });
    await setObjectAclPolicy(file, { owner: ownerId, visibility: "private" });
    return `/objects/${entityPath}`;
  }

  async deleteObjectEntity(objectPath: string): Promise<void> {
    const file = await this.getObjectEntityFile(objectPath);
    await file.delete({ ignoreNotFound: true });
  }

  async deleteDerivedObjects(sourceId: string): Promise<void> {
    if (!UPLOAD_ID.test(sourceId)) return;
    await removeDirectory(`studygraph/${sourceId}`);
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: LocalFile;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }
}
