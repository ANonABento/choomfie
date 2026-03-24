/**
 * Memory store — Letta-inspired self-editing memory.
 *
 * Two tiers:
 *   - Core memory: always in context (user profile, preferences, active goals)
 *   - Archival memory: searchable long-term storage (past conversations, learnings)
 *
 * Uses Bun's built-in SQLite (bun:sqlite).
 */

import { Database } from "bun:sqlite";

export interface CoreMemory {
  key: string;
  value: string;
  updatedAt: string;
}

export interface ArchivalMemory {
  id: number;
  content: string;
  tags: string;
  createdAt: string;
}

export class MemoryStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS core_memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS archival_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  getCoreMemory(): CoreMemory[] {
    return this.db
      .query("SELECT key, value, updated_at as updatedAt FROM core_memory")
      .all() as CoreMemory[];
  }

  setCoreMemory(key: string, value: string) {
    this.db
      .query(
        `INSERT INTO core_memory (key, value, updated_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`
      )
      .run(key, value);
  }

  deleteCoreMemory(key: string) {
    this.db.query("DELETE FROM core_memory WHERE key = ?").run(key);
  }

  addArchival(content: string, tags: string = "") {
    this.db
      .query("INSERT INTO archival_memory (content, tags) VALUES (?, ?)")
      .run(content, tags);
  }

  searchArchival(query: string, limit: number = 10): ArchivalMemory[] {
    return this.db
      .query(
        `SELECT id, content, tags, created_at as createdAt
         FROM archival_memory
         WHERE content LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, limit) as ArchivalMemory[];
  }

  buildMemoryContext(): string {
    const core = this.getCoreMemory();
    if (core.length === 0) return "";

    const lines = core.map((m) => `- ${m.key}: ${m.value}`);
    return `## Current Memories\n${lines.join("\n")}`;
  }

  close() {
    this.db.close();
  }
}
