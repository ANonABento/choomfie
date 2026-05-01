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
import { spawnSync } from "node:child_process";
import { normalizeTimeZone, toSQLiteDatetime } from "./time.ts";
import {
  isValidCustomCommandName,
  normalizeCustomCommandName,
} from "./custom-commands.ts";

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
  score?: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  embed(text: string): number[] | null;
}

export interface MemoryStoreOptions {
  embeddingProvider?: EmbeddingProvider | null;
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

export interface IncomingWebhook {
  token: string;
  channelId: string;
  guildId: string | null;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
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

interface ArchivalEmbeddingRow {
  embedding: string;
  dimension: number;
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly endpoint: string;
  private available = true;

  constructor() {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/api/embeddings`;
    this.model = process.env.OLLAMA_EMBEDDING_MODEL ?? "mxbai-embed-large";
  }

  embed(text: string): number[] | null {
    if (!this.available) return null;

    const result = spawnSync(
      "curl",
      [
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        process.env.CHOOMFIE_EMBEDDING_TIMEOUT_SECONDS ?? "2",
        this.endpoint,
        "-H",
        "Content-Type: application/json",
        "-d",
        JSON.stringify({ model: this.model, prompt: text }),
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 8,
      }
    );

    if (result.status !== 0 || !result.stdout) {
      this.available = false;
      return null;
    }

    try {
      const parsed = JSON.parse(result.stdout) as { embedding?: unknown };
      if (!Array.isArray(parsed.embedding)) return null;
      const embedding = parsed.embedding.filter((n): n is number => typeof n === "number");
      return embedding.length > 0 ? embedding : null;
    } catch {
      this.available = false;
      return null;
    }
  }
}

function createDefaultEmbeddingProvider(): EmbeddingProvider | null {
  if (process.env.CHOOMFIE_EMBEDDINGS === "off") return null;
  return new OllamaEmbeddingProvider();
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function parseEmbedding(value: string): number[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const embedding = parsed.filter((n): n is number => typeof n === "number");
    return embedding.length > 0 ? embedding : null;
  } catch {
    return null;
  }
}

export class MemoryStore {
  private db: Database;
  private embeddingProvider: EmbeddingProvider | null;

  constructor(dbPath: string, options: MemoryStoreOptions = {}) {
    this.db = new Database(dbPath, { create: true });
    this.embeddingProvider =
      "embeddingProvider" in options
        ? options.embeddingProvider ?? null
        : createDefaultEmbeddingProvider();
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
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

      CREATE TABLE IF NOT EXISTS archival_memory_embeddings (
        memory_id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY(memory_id) REFERENCES archival_memory(id) ON DELETE CASCADE
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

      CREATE TABLE IF NOT EXISTS incoming_webhooks (
        token TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        guild_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        revoked_at TEXT
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
      this.db.query("SELECT COUNT(*) as count FROM core_memory").get() as CountRow
    ).count;

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

  addArchival(content: string, tags: string = ""): number {
    this.db
      .query("INSERT INTO archival_memory (content, tags) VALUES (?, ?)")
      .run(content, tags);
    const id = (
      this.db.query("SELECT last_insert_rowid() as id").get() as InsertIdRow
    ).id;
    this.cacheArchivalEmbedding(id, content);
    return id;
  }

  deleteArchival(id: number): boolean {
    const result = this.db
      .query("DELETE FROM archival_memory WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  searchArchival(query: string, limit: number = 10): ArchivalMemory[] {
    const semanticResults = this.searchArchivalByEmbedding(query, limit);
    if (semanticResults) return semanticResults;

    return this.searchArchivalByString(query, limit);
  }

  private searchArchivalByString(query: string, limit: number): ArchivalMemory[] {
    return this.db
      .query(
        `SELECT id, content, tags, created_at as createdAt
         FROM archival_memory
         WHERE content LIKE ? OR tags LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(`%${query}%`, `%${query}%`, limit) as ArchivalMemory[];
  }

  private searchArchivalByEmbedding(query: string, limit: number): ArchivalMemory[] | null {
    const provider = this.embeddingProvider;
    if (!provider) return null;

    const queryEmbedding = provider.embed(query);
    if (!queryEmbedding) return null;

    const memories = this.db
      .query(
        `SELECT id, content, tags, created_at as createdAt
         FROM archival_memory
         ORDER BY created_at DESC`
      )
      .all() as ArchivalMemory[];

    const scored: ArchivalMemory[] = [];
    for (const memory of memories) {
      const embedding = this.getOrCreateArchivalEmbedding(memory.id, memory.content);
      if (!embedding) continue;
      scored.push({
        ...memory,
        score: cosineSimilarity(queryEmbedding, embedding),
      });
    }

    if (scored.length === 0) return null;

    return scored
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private getOrCreateArchivalEmbedding(id: number, content: string): number[] | null {
    const provider = this.embeddingProvider;
    if (!provider) return null;

    const cached = this.db
      .query(
        `SELECT embedding, dimension
         FROM archival_memory_embeddings
         WHERE memory_id = ? AND provider = ? AND model = ?`
      )
      .get(id, provider.name, provider.model) as ArchivalEmbeddingRow | null;

    if (cached) {
      const embedding = parseEmbedding(cached.embedding);
      if (embedding && embedding.length === cached.dimension) return embedding;
    }

    return this.cacheArchivalEmbedding(id, content);
  }

  private cacheArchivalEmbedding(id: number, content: string): number[] | null {
    const provider = this.embeddingProvider;
    if (!provider) return null;

    const embedding = provider.embed(content);
    if (!embedding) return null;

    this.db
      .query(
        `INSERT INTO archival_memory_embeddings
           (memory_id, provider, model, dimension, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(memory_id) DO UPDATE SET
           provider = excluded.provider,
           model = excluded.model,
           dimension = excluded.dimension,
           embedding = excluded.embedding,
           updated_at = datetime('now')`
      )
      .run(id, provider.name, provider.model, embedding.length, JSON.stringify(embedding));

    return embedding;
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

  // --- Incoming webhooks ---

  private static readonly WEBHOOK_COLS = `token, channel_id as channelId, guild_id as guildId,
    created_by as createdBy, created_at as createdAt, revoked_at as revokedAt`;

  addIncomingWebhook(token: string, channelId: string, createdBy: string, guildId?: string | null) {
    this.db
      .query(
        "INSERT INTO incoming_webhooks (token, channel_id, guild_id, created_by) VALUES (?, ?, ?, ?)"
      )
      .run(token, channelId, guildId ?? null, createdBy);
  }

  getIncomingWebhook(token: string): IncomingWebhook | null {
    return (
      this.db
        .query(
          `SELECT ${MemoryStore.WEBHOOK_COLS}
           FROM incoming_webhooks
           WHERE token = ? AND revoked_at IS NULL`
        )
        .get(token) as IncomingWebhook | null
    );
  }

  listIncomingWebhooks(includeRevoked = false): IncomingWebhook[] {
    const where = includeRevoked ? "" : "WHERE revoked_at IS NULL";
    return this.db
      .query(
        `SELECT ${MemoryStore.WEBHOOK_COLS}
         FROM incoming_webhooks
         ${where}
         ORDER BY created_at DESC`
      )
      .all() as IncomingWebhook[];
  }

  revokeIncomingWebhook(token: string): boolean {
    const result = this.db
      .query(
        "UPDATE incoming_webhooks SET revoked_at = datetime('now') WHERE token = ? AND revoked_at IS NULL"
      )
      .run(token);
    return result.changes > 0;
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

  close(): void {
    // Checkpoint WAL before closing — ensures all writes are flushed to the main DB file
    // and prevents WAL contention when a new worker opens the same database on restart
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    this.db.close();
  }
}
