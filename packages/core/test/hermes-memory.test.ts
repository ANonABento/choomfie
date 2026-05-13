import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "choomfie-hermes-memory-"));
  dirs.push(dir);
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
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      chat_id TEXT,
      message TEXT NOT NULL,
      due_at TEXT,
      cron TEXT,
      timezone TEXT,
      category TEXT,
      fired INTEGER DEFAULT 0,
      ack INTEGER DEFAULT 0
    );
    CREATE TABLE birthdays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      birthday TEXT NOT NULL,
      year INTEGER,
      notes TEXT
    );
    INSERT INTO core_memory (key, value) VALUES
      ('timezone', 'America/Toronto'),
      ('style_preference', 'casual');
    INSERT INTO archival_memory (content, tags) VALUES
      ('User likes concise Discord replies', 'preference,discord');
    INSERT INTO reminders (message, due_at, fired, ack) VALUES
      ('check Choomfie', '2026-05-14 09:00:00', 0, 0);
    INSERT INTO birthdays (name, birthday) VALUES ('Alex', '01-01');
  `);
  db.close();
  return { dir, dbPath };
}

test("hermes-memory exports categorized memory and renders a draft", async () => {
  const { dir, dbPath } = makeDb();
  const jsonPath = join(dir, "memory.json");
  const mdPath = join(dir, "memory.md");

  const exportRun = Bun.spawnSync([
    "bun",
    "packages/core/scripts/hermes-memory.ts",
    "export",
    dbPath,
    jsonPath,
  ]);
  expect(exportRun.exitCode).toBe(0);

  const exported = JSON.parse(readFileSync(jsonPath, "utf-8"));
  expect(exported.counts).toEqual({
    coreMemory: 2,
    archivalMemory: 1,
    activeReminders: 1,
    birthdays: 1,
  });
  expect(exported.categories.profileFacts.join("\n")).toContain("timezone");
  expect(exported.categories.preferences.join("\n")).toContain("concise Discord replies");

  const draftRun = Bun.spawnSync([
    "bun",
    "packages/core/scripts/hermes-memory.ts",
    "draft",
    jsonPath,
    mdPath,
  ]);
  expect(draftRun.exitCode).toBe(0);
  const draft = readFileSync(mdPath, "utf-8");
  expect(draft).toContain("## Profile Facts");
  expect(draft).toContain("Birthday: Alex 01-01");
  expect(draft).toContain("Reminder #1: check Choomfie");
});
