import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

/**
 * Local-disk object storage (replaces the Replit/GCS sidecar so the app runs
 * on any machine). Objects live under STORAGE_DIR; metadata (content type and
 * ACL policy) is kept in a "<object>.meta.json" file next to each object.
 */
export const STORAGE_ROOT = path.resolve(
  process.env.STORAGE_DIR ?? path.join(process.cwd(), ".local-storage"),
);

/**
 * Files are also mirrored into the database (table citexa_files) so they survive server restarts
 * and are available wherever the app runs against the same database (for example a deployed copy
 * on Render with no persistent disk). Files above the size cap, such as long videos, stay on disk only.
 * Turn off with CITEXA_DB_FILES=off. Raise or lower the cap with CITEXA_DB_FILES_MAX_MB (default 30).
 */
const DB_FILES_ON = (process.env.CITEXA_DB_FILES ?? "on").toLowerCase() !== "off";
const DB_FILE_MAX_BYTES = (Number(process.env.CITEXA_DB_FILES_MAX_MB) || 30) * 1024 * 1024;
let filesTableReady: Promise<void> | undefined;
function ensureFilesTable(): Promise<void> {
  filesTableReady ??= db
    .execute(
      sql`create table if not exists citexa_files (
        name text primary key,
        content_type text,
        meta text,
        size integer not null default 0,
        data bytea not null,
        created_at timestamptz not null default now()
      )`,
    )
    .then(() => undefined)
    .catch((error) => {
      filesTableReady = undefined;
      throw error;
    });
  return filesTableReady;
}
const warn = (message: string, error: unknown) =>
  console.warn(`[files] ${message}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);

export function localPath(name: string): string {
  const cleaned = name.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(STORAGE_ROOT, cleaned);
  if (abs !== STORAGE_ROOT && !abs.startsWith(STORAGE_ROOT + path.sep)) {
    throw new Error("Invalid object path.");
  }
  return abs;
}

type StoredMeta = {
  contentType?: string;
  metadata?: Record<string, string>;
};

export class LocalFile {
  constructor(readonly name: string) {}

  get absPath(): string {
    return localPath(this.name);
  }

  private get metaPath(): string {
    return `${this.absPath}.meta.json`;
  }

  private async readMeta(): Promise<StoredMeta> {
    try {
      return JSON.parse(await fs.readFile(this.metaPath, "utf8")) as StoredMeta;
    } catch {
      return {};
    }
  }

  async exists(): Promise<[boolean]> {
    try {
      const stat = await fs.stat(this.absPath);
      if (stat.isFile()) return [true];
    } catch {
      /* not on disk: try the database copy below */
    }
    return [await this.restoreFromDb()];
  }

  /** Copies this file (and its metadata) into the database. Never throws. */
  async mirrorToDb(): Promise<void> {
    if (!DB_FILES_ON) return;
    try {
      const stat = await fs.stat(this.absPath);
      if (!stat.isFile() || stat.size > DB_FILE_MAX_BYTES) return;
      const data = await fs.readFile(this.absPath);
      const meta = await this.readMeta();
      await ensureFilesTable();
      await db.execute(
        sql`insert into citexa_files (name, content_type, meta, size, data)
            values (${this.name}, ${meta.contentType ?? null}, ${JSON.stringify(meta)}, ${stat.size}, ${data})
            on conflict (name) do update
            set content_type = excluded.content_type, meta = excluded.meta, size = excluded.size, data = excluded.data`,
      );
    } catch (error) {
      warn(`Could not keep a database copy of ${this.name}`, error);
    }
  }

  private async syncMetaToDb(): Promise<void> {
    if (!DB_FILES_ON) return;
    try {
      const meta = await this.readMeta();
      await ensureFilesTable();
      await db.execute(
        sql`update citexa_files set meta = ${JSON.stringify(meta)}, content_type = ${meta.contentType ?? null} where name = ${this.name}`,
      );
    } catch (error) {
      warn(`Could not update stored details of ${this.name}`, error);
    }
  }

  private async restoreFromDb(): Promise<boolean> {
    if (!DB_FILES_ON) return false;
    try {
      await ensureFilesTable();
      const result = (await db.execute(
        sql`select content_type, meta, data from citexa_files where name = ${this.name} limit 1`,
      )) as unknown as { rows?: Array<{ content_type: string | null; meta: string | null; data: Buffer }> };
      const row = result.rows?.[0];
      if (!row) return false;
      await fs.mkdir(path.dirname(this.absPath), { recursive: true });
      await fs.writeFile(this.absPath, row.data);
      await fs.writeFile(
        this.metaPath,
        row.meta ?? JSON.stringify(row.content_type ? { contentType: row.content_type } : {}),
      );
      return true;
    } catch (error) {
      warn(`Could not restore ${this.name} from the database`, error);
      return false;
    }
  }

  async getMetadata(): Promise<
    [{ contentType?: string; size?: number; metadata?: Record<string, string> }]
  > {
    const stat = await fs.stat(this.absPath);
    const meta = await this.readMeta();
    return [{ contentType: meta.contentType, size: stat.size, metadata: meta.metadata }];
  }

  createReadStream() {
    return createReadStream(this.absPath);
  }

  async save(
    bytes: Buffer,
    options?: { metadata?: { contentType?: string } },
  ): Promise<void> {
    await fs.mkdir(path.dirname(this.absPath), { recursive: true });
    await fs.writeFile(this.absPath, bytes);
    const existing = await this.readMeta();
    await this.writeMeta({
      ...existing,
      contentType: options?.metadata?.contentType ?? existing.contentType,
    });
    await this.mirrorToDb();
  }

  async setContentType(contentType: string): Promise<void> {
    const existing = await this.readMeta();
    await this.writeMeta({ ...existing, contentType });
    await this.syncMetaToDb();
  }

  async setMetadata(update: { metadata: Record<string, string> }): Promise<void> {
    const existing = await this.readMeta();
    await this.writeMeta({
      ...existing,
      metadata: { ...(existing.metadata ?? {}), ...update.metadata },
    });
    await this.syncMetaToDb();
  }

  private async writeMeta(meta: StoredMeta): Promise<void> {
    await fs.mkdir(path.dirname(this.metaPath), { recursive: true });
    await fs.writeFile(this.metaPath, JSON.stringify(meta));
  }

  async delete(options?: { ignoreNotFound?: boolean }): Promise<void> {
    try {
      await fs.unlink(this.absPath);
    } catch (error) {
      if (!options?.ignoreNotFound) throw error;
    }
    await fs.unlink(this.metaPath).catch(() => undefined);
    if (DB_FILES_ON) {
      try {
        await ensureFilesTable();
        await db.execute(sql`delete from citexa_files where name = ${this.name}`);
      } catch (error) {
        warn(`Could not remove the database copy of ${this.name}`, error);
      }
    }
  }
}

export async function removeDirectory(name: string): Promise<void> {
  await fs.rm(localPath(name), { recursive: true, force: true });
  if (DB_FILES_ON) {
    try {
      await ensureFilesTable();
      await db.execute(sql`delete from citexa_files where name like ${`${name.replace(/[%_\\]/g, "")}/%`}`);
    } catch (error) {
      warn(`Could not remove database copies under ${name}`, error);
    }
  }
}

/**
 * One-time catch-up at startup: copies files that already exist on this computer (uploaded before the
 * database mirror existed) into the database, so a deployed copy can serve them too.
 */
export async function mirrorExistingFilesToDb(): Promise<void> {
  if (!DB_FILES_ON) return;
  try {
    await ensureFilesTable();
    const known = (await db.execute(sql`select name from citexa_files`)) as unknown as {
      rows?: Array<{ name: string }>;
    };
    const have = new Set((known.rows ?? []).map((row) => row.name));
    let copied = 0;
    const walk = async (relDir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = await fs.readdir(path.join(STORAGE_ROOT, relDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(rel);
        } else if (!entry.name.endsWith(".meta.json") && !have.has(rel)) {
          await new LocalFile(rel).mirrorToDb();
          copied += 1;
        }
      }
    };
    await walk("uploads");
    await walk("studygraph");
    if (copied) console.log(`[files] Copied ${copied} existing file(s) into the database for safekeeping.`);
  } catch (error) {
    warn("Could not copy existing files to the database", error);
  }
}
