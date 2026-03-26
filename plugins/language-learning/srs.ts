/**
 * SRS (Spaced Repetition System) — FSRS algorithm via ts-fsrs.
 *
 * Stores card state in SQLite. Supports multiple decks per user.
 * FSRS is 15-20% more efficient than SM-2 (used by Anki since 2024).
 */

import { FSRS, createEmptyCard, Rating, type Card } from "ts-fsrs";
import { Database } from "bun:sqlite";
import { nowUTC, toSQLiteDatetime } from "../../lib/time.ts";

export interface SRSCard {
  id: number;
  userId: string;
  front: string; // e.g. "食べる"
  back: string; // e.g. "to eat (taberu)"
  reading: string; // e.g. "たべる"
  deck: string; // e.g. "jlpt-n5"
  tags: string; // e.g. "verb,ichidan,n5"
  // FSRS state (serialized JSON)
  cardState: string;
  nextReview: string;
  createdAt: string;
}

export interface ReviewResult {
  card: SRSCard;
  nextReview: Date;
  interval: number; // days
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
  }

  /** Add a card to a user's deck */
  addCard(
    userId: string,
    front: string,
    back: string,
    reading: string = "",
    deck: string = "default",
    tags: string = ""
  ): number {
    const result = this.db
      .query(
        `INSERT INTO srs_cards (user_id, front, back, reading, deck, tags, card_state)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        front,
        back,
        reading,
        deck,
        tags,
        this.emptyCardState
      );
    return Number(result.lastInsertRowid);
  }

  /** Import a batch of cards (for loading JLPT decks) */
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

  /** Get cards due for review */
  getDueCards(userId: string, deck?: string, limit: number = 10): SRSCard[] {
    const now = nowUTC();
    const query = deck
      ? `SELECT * FROM srs_cards WHERE user_id = ? AND deck = ? AND next_review <= ? ORDER BY next_review ASC LIMIT ?`
      : `SELECT * FROM srs_cards WHERE user_id = ? AND next_review <= ? ORDER BY next_review ASC LIMIT ?`;

    const params = deck
      ? [userId, deck, now, limit]
      : [userId, now, limit];

    const rows = this.db.query(query).all(...params) as any[];
    return rows.map(this.rowToCard);
  }

  /** Review a card with a rating */
  reviewCard(
    userId: string,
    cardId: number,
    rating: "again" | "hard" | "good" | "easy"
  ): ReviewResult {
    const row = this.db
      .query("SELECT * FROM srs_cards WHERE id = ?")
      .get(cardId) as any;

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

  /** Get deck stats for a user */
  getDeckStats(
    userId: string,
    deck?: string
  ): { total: number; due: number; learned: number } {
    const now = nowUTC();
    const where = deck
      ? "user_id = ? AND deck = ?"
      : "user_id = ?";
    const params = deck ? [userId, deck] : [userId];

    const total = (
      this.db.query(`SELECT COUNT(*) as c FROM srs_cards WHERE ${where}`).get(...params) as any
    ).c;

    const due = (
      this.db
        .query(
          `SELECT COUNT(*) as c FROM srs_cards WHERE ${where} AND next_review <= ?`
        )
        .get(...params, now) as any
    ).c;

    // "Learned" = reviewed at least once (card_state != empty)
    const learned = (
      this.db
        .query(
          `SELECT COUNT(*) as c FROM srs_cards WHERE ${where} AND card_state != ?`
        )
        .get(...params, this.emptyCardState) as any
    ).c;

    return { total, due, learned };
  }

  /** Check if a user has a deck loaded */
  hasDeck(userId: string, deck: string): boolean {
    const count = (
      this.db
        .query(
          "SELECT COUNT(*) as c FROM srs_cards WHERE user_id = ? AND deck = ?"
        )
        .get(userId, deck) as any
    ).c;
    return count > 0;
  }

  private rowToCard(row: any): SRSCard {
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
