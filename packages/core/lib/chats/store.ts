/**
 * Chat store — chats and which one is live where. See `@choomfie/shared/chat.ts`
 * for the model.
 *
 * Shares Choomfie's SQLite database (MemoryStore hands it the handle) but owns
 * its own tables, so the chat schema lives next to the code that uses it.
 *
 * A chat is bound to at most one location at a time: resuming it somewhere
 * else moves it. Two locations driving one backend conversation would let two
 * sends race into the same Waymond chat or Claude session.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { nowUTC, titleFrom, UNTITLED_CHAT, type ChatRecord, type ChatsApi } from "@choomfie/shared";

interface ChatRow {
  id: string;
  brain: string;
  backend_ref: string | null;
  title: string;
  cwd: string | null;
  location_id: string;
  created_at: string;
  last_active_at: string;
}

const COLUMNS = "id, brain, backend_ref, title, cwd, location_id, created_at, last_active_at";

function toRecord(row: ChatRow): ChatRecord {
  return {
    id: row.id,
    brain: row.brain,
    backendRef: row.backend_ref,
    title: row.title,
    cwd: row.cwd,
    locationId: row.location_id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

export interface NewChat {
  locationId: string;
  brain: string;
  title?: string;
  cwd?: string | null;
  backendRef?: string | null;
  /** Use this id instead of a fresh one (the daemon names Claude chats itself). */
  id?: string;
}

export class ChatStore implements ChatsApi {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        brain TEXT NOT NULL,
        backend_ref TEXT,
        title TEXT NOT NULL,
        cwd TEXT,
        location_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_brain_active ON chats (brain, last_active_at);

      CREATE TABLE IF NOT EXISTS chat_bindings (
        location_id TEXT NOT NULL,
        brain TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, brain)
      );
    `);
  }

  get(chatId: string): ChatRecord | null {
    const row = this.db.query(`SELECT ${COLUMNS} FROM chats WHERE id = ?`).get(chatId) as ChatRow | null;
    return row ? toRecord(row) : null;
  }

  /** The chat bound at this location for this brain, if any. */
  bound(locationId: string, brain: string): ChatRecord | null {
    const row = this.db
      .query(
        `SELECT ${COLUMNS.split(", ").map((c) => `c.${c}`).join(", ")}
         FROM chat_bindings b JOIN chats c ON c.id = b.chat_id
         WHERE b.location_id = ? AND b.brain = ?`
      )
      .get(locationId, brain) as ChatRow | null;
    return row ? toRecord(row) : null;
  }

  /** Where a chat is live right now, if anywhere. */
  locationOf(chatId: string): string | null {
    const row = this.db.query("SELECT location_id FROM chat_bindings WHERE chat_id = ?").get(chatId) as
      | { location_id: string }
      | null;
    return row?.location_id ?? null;
  }

  create(chat: NewChat): ChatRecord {
    const now = nowUTC();
    const id = chat.id ?? randomUUID();
    this.db
      .query(`INSERT INTO chats (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, chat.brain, chat.backendRef ?? null, chat.title || UNTITLED_CHAT, chat.cwd ?? null, chat.locationId, now, now);
    return this.get(id)!;
  }

  /** Make `chatId` the live chat at this location, moving it from anywhere else. */
  bind(locationId: string, chatId: string): void {
    const chat = this.get(chatId);
    if (!chat) throw new Error(`no chat ${chatId}`);
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM chat_bindings WHERE chat_id = ?").run(chatId);
      this.db
        .query(
          `INSERT INTO chat_bindings (location_id, brain, chat_id, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (location_id, brain) DO UPDATE SET chat_id = excluded.chat_id, updated_at = excluded.updated_at`
        )
        .run(locationId, chat.brain, chatId, nowUTC());
    });
    tx();
  }

  current(locationId: string, brain: string, message?: string): ChatRecord {
    const title = message?.trim() ? titleFrom(message) : undefined;
    const chat = this.bound(locationId, brain);
    if (!chat) return this.start(locationId, brain, title);
    if (title && chat.title === UNTITLED_CHAT) this.rename(chat.id, title);
    this.touch(chat.id);
    return this.get(chat.id)!;
  }

  start(locationId: string, brain: string, title?: string): ChatRecord {
    const chat = this.create({ locationId, brain, title });
    this.bind(locationId, chat.id);
    return chat;
  }

  setBackendRef(chatId: string, ref: string | null): void {
    this.db.query("UPDATE chats SET backend_ref = ?, last_active_at = ? WHERE id = ?").run(ref, nowUTC(), chatId);
  }

  setCwd(chatId: string, cwd: string | null): void {
    this.db.query("UPDATE chats SET cwd = ? WHERE id = ?").run(cwd, chatId);
  }

  touch(chatId: string): void {
    this.db.query("UPDATE chats SET last_active_at = ? WHERE id = ?").run(nowUTC(), chatId);
  }

  rename(chatId: string, title: string): void {
    this.db.query("UPDATE chats SET title = ? WHERE id = ?").run(title, chatId);
  }

  /** Most recently active first. */
  list(opts: { brain?: string; limit?: number } = {}): ChatRecord[] {
    return this.select(opts);
  }

  /** Title search for autocomplete — a local indexed query, well inside Discord's 3s. */
  search(typed: string, opts: { brain?: string; limit?: number } = {}): ChatRecord[] {
    return this.select({ ...opts, titleLike: `%${typed.replace(/[%_\\]/g, (c) => `\\${c}`)}%` });
  }

  private select(opts: { brain?: string; titleLike?: string; limit?: number }): ChatRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.brain) {
      where.push("brain = ?");
      args.push(opts.brain);
    }
    if (opts.titleLike) {
      where.push("title LIKE ? ESCAPE '\\'");
      args.push(opts.titleLike);
    }
    const rows = this.db
      .query(
        `SELECT ${COLUMNS} FROM chats ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY last_active_at DESC, rowid DESC LIMIT ?`
      )
      .all(...args, opts.limit ?? 25);
    return (rows as ChatRow[]).map(toRecord);
  }
}
