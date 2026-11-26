/**
 * Conversation history for API brains, which keep none of their own.
 *
 * Keyed by Choomfie chat id, not by location: `/clear` starts a new chat
 * (empty history) and `/resume` binds an old one back (its history returns),
 * with no work here. Every turn is kept with who answered it, so a router
 * can switch providers mid-chat and the next one still sees the conversation.
 *
 * Its own SQLite file (`<data>/apibrain/transcripts.db`): the schema lives
 * next to the code that uses it. Datetimes are SQLite format (`nowUTC`).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { nowUTC } from "@choomfie/shared";

export interface Turn {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Who answered (provider or brain id). Null for user turns. */
  member: string | null;
  model: string | null;
}

export interface Summary {
  text: string;
  /** Turns up to and including this id are covered by the summary. */
  uptoId: number;
}

export class Transcript {
  private db: Database;

  /** `path` ":memory:" for tests. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        member TEXT,
        model TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_chat ON turns (chat_id, id);
      CREATE TABLE IF NOT EXISTS summaries (
        chat_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        upto_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  add(chatId: string, role: Turn["role"], content: string, member?: string | null, model?: string | null): number {
    const r = this.db
      .query("INSERT INTO turns (chat_id, role, content, member, model, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chatId, role, content, member ?? null, model ?? null, nowUTC());
    return Number(r.lastInsertRowid);
  }

  /** Turns not yet covered by the summary, oldest first. */
  live(chatId: string): Turn[] {
    const upto = this.summary(chatId)?.uptoId ?? 0;
    return this.db
      .query("SELECT id, role, content, member, model FROM turns WHERE chat_id = ? AND id > ? ORDER BY id")
      .all(chatId, upto) as Turn[];
  }

  /** Every turn, summarized or not, oldest first. */
  all(chatId: string): Turn[] {
    return this.db.query("SELECT id, role, content, member, model FROM turns WHERE chat_id = ? ORDER BY id").all(chatId) as Turn[];
  }

  summary(chatId: string): Summary | null {
    const row = this.db.query("SELECT summary, upto_id FROM summaries WHERE chat_id = ?").get(chatId) as
      | { summary: string; upto_id: number }
      | null;
    return row ? { text: row.summary, uptoId: row.upto_id } : null;
  }

  setSummary(chatId: string, text: string, uptoId: number): void {
    this.db
      .query(
        `INSERT INTO summaries (chat_id, summary, upto_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET summary = excluded.summary, upto_id = excluded.upto_id, updated_at = excluded.updated_at`
      )
      .run(chatId, text, uptoId, nowUTC());
  }

  /** Forget this turn and every later one in the chat (an answer being redone). */
  dropFrom(chatId: string, id: number): void {
    this.db.query("DELETE FROM turns WHERE chat_id = ? AND id >= ?").run(chatId, id);
  }

  /** The id of the last turn this member answered in the chat (0 if never). */
  lastAnsweredBy(chatId: string, member: string): number {
    const row = this.db.query("SELECT MAX(id) AS id FROM turns WHERE chat_id = ? AND member = ?").get(chatId, member) as { id: number | null };
    return row.id ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
