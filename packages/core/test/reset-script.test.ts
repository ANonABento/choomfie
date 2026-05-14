import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-reset-"));
  tempDirs.push(dir);
  return dir;
}

function seedDb(dir: string): string {
  const dbPath = join(dir, "choomfie.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE core_memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE archival_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE archival_memory_embeddings (
      memory_id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      embedding TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(memory_id) REFERENCES archival_memory(id) ON DELETE CASCADE
    );
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message TEXT NOT NULL,
      due_at TEXT NOT NULL,
      fired INTEGER DEFAULT 0
    );
    CREATE TABLE birthdays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      birthday TEXT NOT NULL
    );
    INSERT INTO core_memory (key, value) VALUES ('timezone', 'America/Toronto');
    INSERT INTO archival_memory (content, tags) VALUES ('saved fact', 'test');
    INSERT INTO archival_memory_embeddings (memory_id, provider, model, dimension, embedding)
      VALUES (1, 'test', 'test-model', 1, '[0.1]');
    INSERT INTO reminders (user_id, chat_id, message, due_at) VALUES
      ('user', 'channel', 'check deploy', '2026-05-14 09:00:00');
    INSERT INTO birthdays (name, birthday) VALUES ('Alex', '01-01');
  `);
  db.close();
  return dbPath;
}

function runReset(dir: string, scope: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bun", "packages/core/scripts/reset.ts", scope], {
    env: { ...process.env, CHOOMFIE_DATA_DIR: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function countRows(db: Database, table: string): number {
  const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

test("reset memory scope clears memory tables and preserves other state", () => {
  const dir = makeTempDir();
  const dbPath = seedDb(dir);

  const result = runReset(dir, "memory");
  expect(result.exitCode).toBe(0);

  const db = new Database(dbPath, { readonly: true });
  try {
    expect(countRows(db, "core_memory")).toBe(0);
    expect(countRows(db, "archival_memory")).toBe(0);
    expect(countRows(db, "archival_memory_embeddings")).toBe(0);
    expect(countRows(db, "reminders")).toBe(1);
    expect(countRows(db, "birthdays")).toBe(1);
  } finally {
    db.close();
  }
});

test("reset all removes database and sqlite sidecar files", () => {
  const dir = makeTempDir();
  const dbPath = seedDb(dir);
  writeFileSync(`${dbPath}-wal`, "");
  writeFileSync(`${dbPath}-shm`, "");

  const result = runReset(dir, "all");
  expect(result.exitCode).toBe(0);
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
});

test("reset skips pid files that point at non-Choomfie processes", () => {
  const dir = makeTempDir();
  seedDb(dir);
  writeFileSync(join(dir, "choomfie.pid"), String(process.pid));

  const result = runReset(dir, "core");
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("Skipping Claude Code supervisor pid");
});
