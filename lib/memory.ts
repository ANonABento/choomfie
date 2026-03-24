/**
 * Memory store — Letta-inspired self-editing memory + reminders.
 *
 * Three systems:
 *   - Core memory: always in context (user profile, preferences, active goals)
 *   - Archival memory: searchable long-term storage (past conversations, learnings)
 *   - Reminders: scheduled messages with due times
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

export interface Reminder {
  id: number;
  userId: string;
  chatId: string;
  message: string;
  dueAt: string;
  createdAt: string;
}

export interface MemoryStats {
  coreCount: number;
  archivalCount: number;
  reminderCount: number;
  oldestMemory: string | null;
  newestMemory: string | null;
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

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message TEXT NOT NULL,
        due_at TEXT NOT NULL,
        fired INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  // --- Core memory ---

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

  // --- Archival memory ---

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

  // --- Reminders ---

  addReminder(userId: string, chatId: string, message: string, dueAt: string) {
    this.db
      .query(
        "INSERT INTO reminders (user_id, chat_id, message, due_at) VALUES (?, ?, ?, ?)"
      )
      .run(userId, chatId, message, dueAt);
  }

  getDueReminders(): Reminder[] {
    return this.db
      .query(
        `SELECT id, user_id as userId, chat_id as chatId, message, due_at as dueAt, created_at as createdAt
         FROM reminders
         WHERE fired = 0 AND due_at <= datetime('now')
         ORDER BY due_at ASC`
      )
      .all() as Reminder[];
  }

  markReminderFired(id: number) {
    this.db.query("UPDATE reminders SET fired = 1 WHERE id = ?").run(id);
  }

  getActiveReminders(userId?: string): Reminder[] {
    if (userId) {
      return this.db
        .query(
          `SELECT id, user_id as userId, chat_id as chatId, message, due_at as dueAt, created_at as createdAt
           FROM reminders WHERE fired = 0 AND user_id = ? ORDER BY due_at ASC`
        )
        .all(userId) as Reminder[];
    }
    return this.db
      .query(
        `SELECT id, user_id as userId, chat_id as chatId, message, due_at as dueAt, created_at as createdAt
         FROM reminders WHERE fired = 0 ORDER BY due_at ASC`
      )
      .all() as Reminder[];
  }

  cancelReminder(id: number): boolean {
    const result = this.db
      .query("DELETE FROM reminders WHERE id = ? AND fired = 0")
      .run(id);
    return result.changes > 0;
  }

  // --- Stats ---

  getStats(): MemoryStats {
    const coreCount = (
      this.db.query("SELECT COUNT(*) as count FROM core_memory").get() as any
    ).count;
    const archivalCount = (
      this.db
        .query("SELECT COUNT(*) as count FROM archival_memory")
        .get() as any
    ).count;
    const reminderCount = (
      this.db
        .query("SELECT COUNT(*) as count FROM reminders WHERE fired = 0")
        .get() as any
    ).count;
    const oldest = this.db
      .query(
        "SELECT MIN(created_at) as t FROM archival_memory"
      )
      .get() as any;
    const newest = this.db
      .query(
        "SELECT MAX(created_at) as t FROM archival_memory"
      )
      .get() as any;

    return {
      coreCount,
      archivalCount,
      reminderCount,
      oldestMemory: oldest?.t || null,
      newestMemory: newest?.t || null,
    };
  }

  // --- Context ---

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
