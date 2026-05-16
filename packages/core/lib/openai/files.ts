import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OpenAIFileObject {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
}

interface FileRow {
  id: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  content_hash: string;
}

export class OpenAIFileStore {
  private readonly db: Database;
  private readonly filesDir: string;

  constructor(private readonly dataDir: string) {
    this.filesDir = join(dataDir, "openai-files");
    mkdirSync(this.filesDir, { recursive: true });
    this.db = new Database(join(dataDir, "choomfie.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS openai_files (
        id TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        filename TEXT NOT NULL,
        purpose TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
    `);
  }

  async createFromFile(file: File, purpose: string, maxBytes: number): Promise<OpenAIFileObject> {
    const bytes = file.size;
    if (bytes > maxBytes) {
      throw new Error(`File exceeds maximum size of ${maxBytes} bytes`);
    }

    const id = `file_${randomBytes(12).toString("base64url")}`;
    const content = Buffer.from(await file.arrayBuffer());
    const contentHash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const createdAt = Math.floor(Date.now() / 1000);
    writeFileSync(this.pathFor(id), content, { mode: 0o600 });
    this.db
      .query(`
        INSERT INTO openai_files (id, bytes, created_at, filename, purpose, content_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, bytes, createdAt, file.name || "upload", purpose, contentHash);

    return {
      id,
      object: "file",
      bytes,
      created_at: createdAt,
      filename: file.name || "upload",
      purpose,
    };
  }

  get(id: string): OpenAIFileObject | null {
    const row = this.getRow(id);
    return row ? toFileObject(row) : null;
  }

  content(id: string): Uint8Array | null {
    if (!this.getRow(id)) return null;
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    return new Uint8Array(readFileSync(path));
  }

  delete(id: string): boolean {
    const row = this.getRow(id);
    if (!row) return false;
    this.db.query("DELETE FROM openai_files WHERE id = ?").run(id);
    rmSync(this.pathFor(id), { force: true });
    return true;
  }

  close() {
    this.db.close();
  }

  private getRow(id: string): FileRow | null {
    if (!isValidFileId(id)) return null;
    return this.db
      .query("SELECT id, bytes, created_at, filename, purpose, content_hash FROM openai_files WHERE id = ?")
      .get(id) as FileRow | null;
  }

  private pathFor(id: string): string {
    if (!isValidFileId(id)) {
      throw new Error("Invalid file id");
    }
    return join(this.filesDir, id);
  }
}

function isValidFileId(id: string): boolean {
  return /^file_[A-Za-z0-9_-]+$/.test(id);
}

function toFileObject(row: FileRow): OpenAIFileObject {
  return {
    id: row.id,
    object: "file",
    bytes: row.bytes,
    created_at: row.created_at,
    filename: row.filename,
    purpose: row.purpose,
  };
}
