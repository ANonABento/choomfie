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
import { normalizeTimeZone, toSQLiteDatetime } from "./time.ts";

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
  cron: string | null;
  timezone: string | null;
  nagInterval: number | null;
  category: string | null;
  ack: number;
  lastNagAt: string | null;
}

export interface Birthday {
  id: number;
  userId: string | null;
  name: string;
  birthday: string;
  year: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  lastRemindedOn: string | null;
}

export interface MemoryStats {
  coreCount: number;
  archivalCount: number;
  reminderCount: number;
  oldestMemory: string | null;
  newestMemory: string | null;
}

interface CountRow {
  count: number;
}

interface InsertIdRow {
  id: number;
}

interface TimestampRow {
  t: string | null;
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
        created_at TEXT DEFAULT (datetime('now')),
        cron TEXT,
        timezone TEXT,
        nag_interval INTEGER,
        category TEXT,
        ack INTEGER DEFAULT 0,
        last_nag_at TEXT
      );

      CREATE TABLE IF NOT EXISTS birthdays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        name TEXT NOT NULL UNIQUE,
        birthday TEXT NOT NULL,
        year INTEGER,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_reminded_on TEXT
      );
    `);

    // Migration: add new columns to existing tables
    this.migrate();
  }

  private migrate() {
    // Safely add columns if they don't exist (idempotent)
    const cols = [
      "cron TEXT",
      "timezone TEXT",
      "nag_interval INTEGER",
      "category TEXT",
      "ack INTEGER DEFAULT 0",
      "last_nag_at TEXT",
    ];
    for (const col of cols) {
      try {
        this.db.exec(`ALTER TABLE reminders ADD COLUMN ${col}`);
      } catch {
        // Column already exists, ignore
      }
    }

    const birthdayCols = [
      "updated_at TEXT",
      "last_reminded_on TEXT",
    ];
    for (const col of birthdayCols) {
      try {
        this.db.exec(`ALTER TABLE birthdays ADD COLUMN ${col}`);
      } catch {
        // Column already exists, ignore
      }
    }
    try {
      this.db.exec("UPDATE birthdays SET updated_at = COALESCE(updated_at, created_at, datetime('now'))");
    } catch {}
  }

  // --- Core memory ---

  getCoreMemory(): CoreMemory[] {
    return this.db
      .query("SELECT key, value, updated_at as updatedAt FROM core_memory")
      .all() as CoreMemory[];
  }

  /** Max core memories before auto-archiving oldest */
  static readonly MAX_CORE_MEMORIES = 20;

  setCoreMemory(key: string, value: string) {
    this.db
      .query(
        `INSERT INTO core_memory (key, value, updated_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`
      )
      .run(key, value);

    // Auto-compact: archive oldest core memories when over limit
    this.compactCoreMemory();
  }

  /** Archive oldest core memories when count exceeds MAX_CORE_MEMORIES */
  compactCoreMemory(): number {
    const count = (
      this.db.query("SELECT COUNT(*) as n FROM core_memory").get() as {
        n: number;
      }
    ).n;

    if (count <= MemoryStore.MAX_CORE_MEMORIES) return 0;

    const overflow = count - MemoryStore.MAX_CORE_MEMORIES;
    const oldest = this.db
      .query(
        "SELECT key, value FROM core_memory ORDER BY updated_at ASC LIMIT ?"
      )
      .all(overflow) as { key: string; value: string }[];

    for (const m of oldest) {
      this.addArchival(
        `[auto-archived] ${m.key}: ${m.value}`,
        "auto-archived,core-memory"
      );
      this.db.query("DELETE FROM core_memory WHERE key = ?").run(m.key);
    }

    return oldest.length;
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

  private static readonly REMINDER_COLS = `id, user_id as userId, chat_id as chatId, message, due_at as dueAt,
    created_at as createdAt, cron, timezone, nag_interval as nagInterval, category, ack, last_nag_at as lastNagAt`;

  addReminder(
    userId: string,
    chatId: string,
    message: string,
    dueAt: string,
    opts?: {
      cron?: string;
      timezone?: string | null;
      nagInterval?: number;
      category?: string;
    }
  ): number {
    const normalized = toSQLiteDatetime(dueAt);
    const timezone = normalizeTimeZone(opts?.timezone);
    this.db
      .query(
        "INSERT INTO reminders (user_id, chat_id, message, due_at, cron, timezone, nag_interval, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        userId,
        chatId,
        message,
        normalized,
        opts?.cron ?? null,
        timezone,
        opts?.nagInterval ?? null,
        opts?.category ?? null
      );
    // Return the new reminder ID
    return (
      this.db.query("SELECT last_insert_rowid() as id").get() as InsertIdRow
    ).id;
  }

  getDueReminders(): Reminder[] {
    return this.db
      .query(
        `SELECT ${MemoryStore.REMINDER_COLS}
         FROM reminders
         WHERE fired = 0 AND due_at <= datetime('now')
         ORDER BY due_at ASC`
      )
      .all() as Reminder[];
  }

  /** Get reminders in nag mode that are fired but unacknowledged and due for another nag */
  getNagReminders(): Reminder[] {
    return this.db
      .query(
        `SELECT ${MemoryStore.REMINDER_COLS}
         FROM reminders
         WHERE fired = 1 AND ack = 0 AND nag_interval IS NOT NULL
         AND (last_nag_at IS NULL OR datetime(last_nag_at, '+' || nag_interval || ' minutes') <= datetime('now'))
         ORDER BY due_at ASC`
      )
      .all() as Reminder[];
  }

  markReminderFired(id: number) {
    this.db.query("UPDATE reminders SET fired = 1, last_nag_at = datetime('now') WHERE id = ?").run(id);
  }

  updateNagTime(id: number) {
    this.db.query("UPDATE reminders SET last_nag_at = datetime('now') WHERE id = ?").run(id);
  }

  ackReminder(id: number): boolean {
    const result = this.db.query("UPDATE reminders SET ack = 1 WHERE id = ? AND fired = 1").run(id);
    return result.changes > 0;
  }

  snoozeReminder(
    id: number,
    newDueAt: string,
    opts?: { timezone?: string | null }
  ): boolean {
    const normalized = toSQLiteDatetime(newDueAt);
    const timezoneProvided = opts != null && "timezone" in opts;
    const timezone = timezoneProvided ? normalizeTimeZone(opts.timezone) : null;
    const result = timezoneProvided
      ? this.db
          .query(
            "UPDATE reminders SET fired = 0, ack = 0, due_at = ?, timezone = ?, last_nag_at = NULL WHERE id = ?"
          )
          .run(normalized, timezone, id)
      : this.db
          .query("UPDATE reminders SET fired = 0, ack = 0, due_at = ?, last_nag_at = NULL WHERE id = ?")
          .run(normalized, id);
    return result.changes > 0;
  }

  /** Get a single reminder by ID */
  getReminder(id: number): Reminder | null {
    return (
      this.db
        .query(`SELECT ${MemoryStore.REMINDER_COLS} FROM reminders WHERE id = ?`)
        .get(id) as Reminder | null
    );
  }

  getActiveReminders(userId?: string): Reminder[] {
    const filter = userId ? "AND user_id = ?" : "";
    const args = userId ? [userId] : [];
    return this.db
      .query(
        `SELECT ${MemoryStore.REMINDER_COLS}
         FROM reminders WHERE fired = 0 ${filter} ORDER BY due_at ASC`
      )
      .all(...args) as Reminder[];
  }

  /** Get fired but unacknowledged nag reminders */
  getUnackedReminders(userId?: string): Reminder[] {
    const where = userId ? "AND user_id = ?" : "";
    const args = userId ? [userId] : [];
    return this.db
      .query(
        `SELECT ${MemoryStore.REMINDER_COLS}
         FROM reminders WHERE fired = 1 AND ack = 0 AND nag_interval IS NOT NULL ${where}
         ORDER BY due_at ASC`
      )
      .all(...args) as Reminder[];
  }

  /** Get reminder history (fired reminders) */
  getReminderHistory(limit: number = 10): Reminder[] {
    return this.db
      .query(
        `SELECT ${MemoryStore.REMINDER_COLS}
         FROM reminders WHERE fired = 1 ORDER BY due_at DESC LIMIT ?`
      )
      .all(limit) as Reminder[];
  }

  cancelReminder(id: number): boolean {
    const result = this.db
      .query("DELETE FROM reminders WHERE id = ? AND (fired = 0 OR (fired = 1 AND ack = 0))")
      .run(id);
    return result.changes > 0;
  }

  /** Purge old fired+acked reminders. Returns number deleted. */
  purgeOldReminders(olderThanDays: number = 7): number {
    const result = this.db
      .query(
        `DELETE FROM reminders
         WHERE fired = 1 AND ack = 1
         AND due_at <= datetime('now', '-' || ? || ' days')`
      )
      .run(olderThanDays);
    return result.changes;
  }

  // --- Birthdays ---

  private static readonly BIRTHDAY_COLS = `id, user_id as userId, name, birthday, year, notes,
    created_at as createdAt, updated_at as updatedAt, last_reminded_on as lastRemindedOn`;

  addBirthday(
    name: string,
    birthday: string,
    opts?: {
      userId?: string | null;
      year?: number | null;
      notes?: string | null;
    }
  ): number {
    const existing = this.getBirthdayByName(name);
    if (existing) {
      this.db
        .query(
          `UPDATE birthdays
           SET user_id = ?, name = ?, birthday = ?, year = ?, notes = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          opts?.userId ?? null,
          name,
          birthday,
          opts?.year ?? null,
          opts?.notes ?? null,
          existing.id
        );
      return existing.id;
    }

    this.db
      .query(
        "INSERT INTO birthdays (user_id, name, birthday, year, notes) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        opts?.userId ?? null,
        name,
        birthday,
        opts?.year ?? null,
        opts?.notes ?? null
      );

    return (
      this.db.query("SELECT last_insert_rowid() as id").get() as InsertIdRow
    ).id;
  }

  getBirthdayByName(name: string): Birthday | null {
    return (
      this.db
        .query(
          `SELECT ${MemoryStore.BIRTHDAY_COLS}
           FROM birthdays
           WHERE lower(name) = lower(?)
           LIMIT 1`
        )
        .get(name) as Birthday | null
    );
  }

  listBirthdays(): Birthday[] {
    return this.db
      .query(`SELECT ${MemoryStore.BIRTHDAY_COLS} FROM birthdays ORDER BY name COLLATE NOCASE ASC`)
      .all() as Birthday[];
  }

  removeBirthday(name: string): boolean {
    const result = this.db
      .query("DELETE FROM birthdays WHERE lower(name) = lower(?)")
      .run(name);
    return result.changes > 0;
  }

  getTodaysBirthdays(birthday: string): Birthday[] {
    return this.db
      .query(
        `SELECT ${MemoryStore.BIRTHDAY_COLS}
         FROM birthdays
         WHERE birthday = ?
         ORDER BY name COLLATE NOCASE ASC`
      )
      .all(birthday) as Birthday[];
  }

  markBirthdayReminded(id: number, reminderDate: string) {
    this.db
      .query("UPDATE birthdays SET last_reminded_on = ?, updated_at = datetime('now') WHERE id = ?")
      .run(reminderDate, id);
  }

  // --- Stats ---

  getStats(): MemoryStats {
    const coreCount = (
      this.db.query("SELECT COUNT(*) as count FROM core_memory").get() as CountRow
    ).count;
    const archivalCount = (
      this.db
        .query("SELECT COUNT(*) as count FROM archival_memory")
        .get() as CountRow
    ).count;
    const reminderCount = (
      this.db
        .query("SELECT COUNT(*) as count FROM reminders WHERE fired = 0")
        .get() as CountRow
    ).count;
    const oldest = this.db
      .query(
        "SELECT MIN(created_at) as t FROM archival_memory"
      )
      .get() as TimestampRow;
    const newest = this.db
      .query(
        "SELECT MAX(created_at) as t FROM archival_memory"
      )
      .get() as TimestampRow;

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
    // Checkpoint WAL before closing — ensures all writes are flushed to the main DB file
    // and prevents WAL contention when a new worker opens the same database on restart
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    this.db.close();
  }
}
