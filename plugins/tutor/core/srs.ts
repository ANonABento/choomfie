/**
 * SRS (Spaced Repetition System) — FSRS algorithm via ts-fsrs.
 *
 * Stores card state in SQLite. Supports multiple decks per user.
 * FSRS is 15-20% more efficient than SM-2 (used by Anki since 2024).
 */

import { FSRS, createEmptyCard, Rating, type Card } from "ts-fsrs";
import { Database } from "bun:sqlite";
import { nowUTC, toSQLiteDatetime } from "@choomfie/shared";

export interface SRSCard {
  id: number;
  userId: string;
  front: string;
  back: string;
  reading: string;
  deck: string;
  tags: string;
  cardState: string;
  nextReview: string;
  createdAt: string;
}

export interface ReviewResult {
  card: SRSCard;
  nextReview: Date;
  interval: number; // days
}

export interface SRSDeck {
  name: string;
  total: number;
  due: number;
  learned: number;
  createdAt: string;
}

interface SRSCardDBRow {
  id: number;
  user_id: string;
  front: string;
  back: string;
  reading: string;
  deck: string;
  tags: string;
  card_state: string;
  next_review: string;
  created_at: string;
}

interface CountDBRow {
  c: number;
}

interface DueCountDBRow {
  user_id: string;
  count: number;
}

interface SRSDeckDBRow {
  name: string;
  created_at: string;
  total: number;
  due: number;
  learned: number;
}

export class SRSManager {
  private db: Database;
  private fsrs: FSRS;
  private emptyCardState: string;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.fsrs = new FSRS({});
    this.emptyCardState = JSON.stringify(createEmptyCard());
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS srs_decks (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, name)
      );

      CREATE TABLE IF NOT EXISTS srs_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        reading TEXT DEFAULT '',
        deck TEXT DEFAULT 'default',
        tags TEXT DEFAULT '',
        card_state TEXT DEFAULT '{}',
        next_review TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_srs_user_deck
        ON srs_cards(user_id, deck);
      CREATE INDEX IF NOT EXISTS idx_srs_next_review
        ON srs_cards(user_id, next_review);
    `);

    this.db.exec(`
      INSERT OR IGNORE INTO srs_decks (user_id, name)
      SELECT DISTINCT user_id, deck FROM srs_cards;
    `);
  }

  createDeck(userId: string, deck: string): boolean {
    const result = this.db
      .query("INSERT OR IGNORE INTO srs_decks (user_id, name) VALUES (?, ?)")
      .run(userId, deck);
    return result.changes > 0;
  }

  deleteDeck(userId: string, deck: string): { existed: boolean; deletedCards: number } {
    const existed = this.hasDeck(userId, deck);
    if (!existed) return { existed: false, deletedCards: 0 };

    const tx = this.db.transaction(() => {
      const cards = this.db
        .query("DELETE FROM srs_cards WHERE user_id = ? AND deck = ?")
        .run(userId, deck);
      this.db
        .query("DELETE FROM srs_decks WHERE user_id = ? AND name = ?")
        .run(userId, deck);
      return Number(cards.changes);
    });

    return { existed: true, deletedCards: tx() };
  }

  listDecks(userId: string): SRSDeck[] {
    const now = nowUTC();
    const rows = this.db
      .query(
        `SELECT
           d.name,
           d.created_at,
           COUNT(c.id) as total,
           SUM(CASE WHEN c.next_review <= ? THEN 1 ELSE 0 END) as due,
           SUM(CASE WHEN c.card_state IS NOT NULL AND c.card_state != ? THEN 1 ELSE 0 END) as learned
         FROM srs_decks d
         LEFT JOIN srs_cards c ON c.user_id = d.user_id AND c.deck = d.name
         WHERE d.user_id = ?
         GROUP BY d.name, d.created_at
         ORDER BY d.name ASC`
      )
      .all(now, this.emptyCardState, userId) as SRSDeckDBRow[];

    return rows.map((row) => ({
      name: row.name,
      total: Number(row.total ?? 0),
      due: Number(row.due ?? 0),
      learned: Number(row.learned ?? 0),
      createdAt: row.created_at,
    }));
  }

  addCard(
    userId: string,
    front: string,
    back: string,
    reading: string = "",
    deck: string = "default",
    tags: string = ""
  ): number {
    this.createDeck(userId, deck);
    const result = this.db
      .query(
        `INSERT INTO srs_cards (user_id, front, back, reading, deck, tags, card_state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, front, back, reading, deck, tags, this.emptyCardState);
    return Number(result.lastInsertRowid);
  }

  importDeck(
    userId: string,
    deck: string,
    cards: Array<{ front: string; back: string; reading: string; tags?: string }>
  ): number {
    const stmt = this.db.prepare(
      `INSERT INTO srs_cards (user_id, front, back, reading, deck, tags, card_state)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    let count = 0;
    const tx = this.db.transaction(() => {
      this.createDeck(userId, deck);
      for (const card of cards) {
        stmt.run(
          userId,
          card.front,
          card.back,
          card.reading,
          deck,
          card.tags || "",
          this.emptyCardState
        );
        count++;
      }
    });
    tx();
    return count;
  }

  getDueCards(userId: string, deck?: string, limit: number = 10): SRSCard[] {
    const now = nowUTC();
    const query = deck
      ? `SELECT * FROM srs_cards WHERE user_id = ? AND deck = ? AND next_review <= ? ORDER BY next_review ASC LIMIT ?`
      : `SELECT * FROM srs_cards WHERE user_id = ? AND next_review <= ? ORDER BY next_review ASC LIMIT ?`;

    const params = deck ? [userId, deck, now, limit] : [userId, now, limit];
    const rows = this.db.query(query).all(...params) as SRSCardDBRow[];
    return rows.map(this.rowToCard);
  }

  reviewCard(
    userId: string,
    cardId: number,
    rating: "again" | "hard" | "good" | "easy"
  ): ReviewResult {
    const row = this.db
      .query("SELECT * FROM srs_cards WHERE id = ?")
      .get(cardId) as SRSCardDBRow | null;

    if (!row) throw new Error(`Card #${cardId} not found`);
    if (row.user_id !== userId) {
      throw new Error(`Card #${cardId} does not belong to user ${userId}`);
    }

    const card = this.rowToCard(row);
    const fsrsCard: Card = JSON.parse(card.cardState);
    const ratingMap = {
      again: Rating.Again,
      hard: Rating.Hard,
      good: Rating.Good,
      easy: Rating.Easy,
    };

    const result = this.fsrs.repeat(fsrsCard, new Date());
    const scheduled = result[ratingMap[rating]];
    const nextReview = scheduled.card.due;

    this.db
      .query(
        `UPDATE srs_cards SET card_state = ?, next_review = ? WHERE id = ?`
      )
      .run(
        JSON.stringify(scheduled.card),
        toSQLiteDatetime(nextReview.toISOString()),
        cardId
      );

    const interval = Math.round(
      (nextReview.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    );

    return { card, nextReview, interval };
  }

  getDeckStats(
    userId: string,
    deck?: string
  ): { total: number; due: number; learned: number } {
    const now = nowUTC();
    const where = deck ? "user_id = ? AND deck = ?" : "user_id = ?";
    const params = deck ? [userId, deck] : [userId];

    const total = (
      this.db.query(`SELECT COUNT(*) as c FROM srs_cards WHERE ${where}`).get(...params) as CountDBRow
    ).c;

    const due = (
      this.db
        .query(
          `SELECT COUNT(*) as c FROM srs_cards WHERE ${where} AND next_review <= ?`
        )
        .get(...params, now) as CountDBRow
    ).c;

    const learned = (
      this.db
        .query(
          `SELECT COUNT(*) as c FROM srs_cards WHERE ${where} AND card_state != ?`
        )
        .get(...params, this.emptyCardState) as CountDBRow
    ).c;

    return { total, due, learned };
  }

  /** Get due card counts for all users who have cards */
  getDueCountByUser(): Map<string, number> {
    const now = nowUTC();
    const rows = this.db.query(
      `SELECT user_id, COUNT(*) as count FROM srs_cards WHERE next_review <= ? GROUP BY user_id`
    ).all(now) as DueCountDBRow[];

    const result = new Map<string, number>();
    for (const row of rows) {
      result.set(row.user_id, row.count);
    }
    return result;
  }

  hasDeck(userId: string, deck: string): boolean {
    const count = (
      this.db
        .query(
          `SELECT COUNT(*) as c FROM srs_decks WHERE user_id = ? AND name = ?`
        )
        .get(userId, deck) as CountDBRow
    ).c;
    return count > 0;
  }

  private rowToCard(row: SRSCardDBRow): SRSCard {
    return {
      id: row.id,
      userId: row.user_id,
      front: row.front,
      back: row.back,
      reading: row.reading,
      deck: row.deck,
      tags: row.tags,
      cardState: row.card_state,
      nextReview: row.next_review,
      createdAt: row.created_at,
    };
  }

  close() {
    this.db.close();
  }
}
