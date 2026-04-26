/**
 * SRS tools — review, rate, stats. Module-agnostic.
 */

import type { ToolDef } from "@choomfie/shared";
import { text, err, errorMessage } from "@choomfie/shared";
import { getSRS } from "../core/srs-instance.ts";
import { getActiveModule } from "../core/session.ts";
import { getLessonDB } from "../core/lesson-db-instance.ts";
import { updateFromSrsReview } from "../core/learner-profile.ts";

const DEFAULT_DECK = "jlpt-n5";

function defaultDeckForModule(moduleName: string): string {
  return moduleName === "japanese" ? DEFAULT_DECK : `lesson-${moduleName}`;
}

export const srsTools: ToolDef[] = [
  {
    definition: {
      name: "srs_review",
      description:
        "Get cards due for SRS review. Shows the front of each card for the user to recall.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
          deck: { type: "string", description: "Deck name (default: auto-detected from active module)" },
          limit: { type: "number", description: "Max cards (default: 5)" },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, _ctx) => {
      const srs = getSRS();
      if (!srs) return err("SRS not initialized");

      const userId = args.user_id as string;
      const moduleName = getActiveModule(userId);
      const deck = (args.deck as string) || defaultDeckForModule(moduleName);

      // Auto-import N5 deck for Japanese users
      if (!srs.hasDeck(userId, deck) && deck === DEFAULT_DECK) {
        try {
          const vocabData = await import(
            "../modules/japanese/data/n5-vocab.json"
          );
          const cards = Array.isArray(vocabData.default)
            ? vocabData.default
            : vocabData;
          srs.importDeck(userId, DEFAULT_DECK, cards);
        } catch (e: unknown) {
          return err(`Failed to import N5 deck: ${errorMessage(e)}`);
        }
      }

      const due = srs.getDueCards(userId, deck, (args.limit as number) || 5);
      if (due.length === 0) {
        const stats = srs.getDeckStats(userId, deck);
        return text(
          `No cards due for review! 🎉\nDeck: ${deck} — ${stats.learned}/${stats.total} learned`
        );
      }

      const formatted = due
        .map(
          (c, i) =>
            `**${i + 1}.** Card #${c.id}: ${c.front} (${c.reading})\n  ||${c.back}||`
        )
        .join("\n\n");

      return text(
        `**${due.length} cards due** (${deck}):\n\n${formatted}\n\nRate each card: use \`srs_rate\` with the card ID and rating (again/hard/good/easy)`
      );
    },
  },
  {
    definition: {
      name: "srs_rate",
      description:
        "Rate an SRS card after reviewing it. Schedules the next review based on FSRS algorithm.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
          card_id: { type: "number", description: "Card ID from srs_review" },
          rating: {
            type: "string",
            enum: ["again", "hard", "good", "easy"],
            description: "How well you recalled the card",
          },
        },
        required: ["user_id", "card_id", "rating"],
      },
    },
    handler: async (args, _ctx) => {
      const srs = getSRS();
      if (!srs) return err("SRS not initialized");

      try {
        const userId = args.user_id as string;
        const result = srs.reviewCard(
          userId,
          args.card_id as number,
          args.rating as "again" | "hard" | "good" | "easy"
        );

        // Update learner profile with current SRS stats
        const db = getLessonDB();
        if (db) {
          const deck = result.card.deck;
          const stats = srs.getDeckStats(userId, deck);
          const moduleName = getActiveModule(userId);
          updateFromSrsReview(db, userId, moduleName, stats);
        }

        const nextStr =
          result.interval < 1
            ? `${Math.round(result.interval * 24)} hours`
            : `${result.interval} days`;
        return text(
          `Rated **${result.card.front}** as **${args.rating}**. Next review in ${nextStr}.`
        );
      } catch (e: unknown) {
        return err(`SRS error: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "srs_stats",
      description: "Show SRS deck statistics for a user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
          deck: { type: "string", description: "Deck name (optional)" },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, _ctx) => {
      const srs = getSRS();
      if (!srs) return err("SRS not initialized");

      const stats = srs.getDeckStats(
        args.user_id as string,
        args.deck as string | undefined
      );
      return text(
        [
          `**SRS Stats** ${args.deck ? `(${args.deck})` : "(all decks)"}`,
          `Total cards: ${stats.total}`,
          `Learned: ${stats.learned}`,
          `Due now: ${stats.due}`,
        ].join("\n")
      );
    },
  },
  {
    definition: {
      name: "srs_reminders",
      description: "Show or update SRS study reminder preferences for a user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
          enabled: {
            type: "boolean",
            description: "Set to true to enable reminders, false to opt out. Omit to check status.",
          },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, _ctx) => {
      const db = getLessonDB();
      if (!db) return err("Lesson DB not initialized");

      const userId = args.user_id as string;
      const moduleName = getActiveModule(userId);
      if (typeof args.enabled === "boolean") {
        db.setSrsRemindersEnabled(userId, moduleName, args.enabled);
      }

      const settings = db.getSrsReminderSettings(userId, moduleName);
      const state = settings.enabled ? "enabled" : "disabled";
      const lastSent = settings.lastRemindedAt
        ? new Date(settings.lastRemindedAt).toISOString()
        : "never";

      return text(
        [
          `SRS reminders are **${state}** for ${moduleName}.`,
          `Last reminder sent: ${lastSent}`,
        ].join("\n")
      );
    },
  },
];
