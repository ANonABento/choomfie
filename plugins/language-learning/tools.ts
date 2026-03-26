/**
 * Language learning tools — tutor, dictionary, quiz, SRS, kana, level setting.
 */

import type { ToolDef } from "../../lib/types.ts";
import { text, err } from "../../lib/types.ts";
import { getLanguageModule, listLanguages } from "./languages/index.ts";
import { getSession, setLevel, setLanguage } from "./session.ts";
import { getSRS } from "./srs-instance.ts";
import * as kana from "./kana.ts";

export const languageLearningTools: ToolDef[] = [
  {
    definition: {
      name: "tutor_prompt",
      description:
        "Get the tutor system prompt for the current language and level. Use this to understand how to tutor the student.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID",
          },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, ctx) => {
      const session = getSession(args.user_id as string);
      const langModule = getLanguageModule(session.language);
      const prompt = langModule.buildTutorPrompt(session.level);
      return text(prompt);
    },
  },
  {
    definition: {
      name: "dictionary_lookup",
      description:
        "Look up a word in the dictionary for the current language. Returns readings, meanings, and level.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description:
              "Word to look up (in target language, romaji, or English)",
          },
          user_id: {
            type: "string",
            description:
              "Discord user ID (optional, used to default to the user's current study language)",
          },
          language: {
            type: "string",
            description:
              "Language to look up in (default: user's current language)",
          },
        },
        required: ["query"],
      },
    },
    handler: async (args, ctx) => {
      const langName =
        (args.language as string) ||
        ((args.user_id as string | undefined)
          ? getSession(args.user_id as string).language
          : undefined) ||
        "japanese";
      const langModule = getLanguageModule(langName);

      try {
        const entries = await langModule.lookup(args.query as string);
        if (entries.length === 0) {
          return text(`No results found for "${args.query}"`);
        }

        const formatted = entries
          .map((e) => {
            const level = e.level ? ` [${e.level}]` : "";
            const pos = e.partOfSpeech.length > 0
              ? ` (${e.partOfSpeech.join(", ")})`
              : "";
            return `**${e.word}** (${e.reading})${level}${pos}\n  ${e.meanings.join("; ")}`;
          })
          .join("\n\n");

        return text(formatted);
      } catch (e: any) {
        return err(`Dictionary error: ${e.message}`);
      }
    },
  },
  {
    definition: {
      name: "quiz",
      description:
        "Generate a quiz question for the student. Types: reading (kana), vocab, grammar.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID",
          },
          type: {
            type: "string",
            enum: ["reading", "vocab", "grammar"],
            description: "Quiz type (default: random)",
          },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, ctx) => {
      const session = getSession(args.user_id as string);
      const langModule = getLanguageModule(session.language);
      const quizType =
        (args.type as string) ||
        ["reading", "vocab", "grammar"][Math.floor(Math.random() * 3)];

      const q = langModule.generateQuiz(
        session.level,
        quizType as "reading" | "vocab" | "grammar"
      );

      const optionLines = q.options
        .map((o, i) => `${["A", "B", "C", "D"][i]}. ${o}`)
        .join("\n");

      const answer = ["A", "B", "C", "D"][q.correctIndex];

      return text(
        [
          `**Quiz (${quizType})**`,
          "",
          q.question,
          "",
          optionLines,
          "",
          `||Answer: ${answer}. ${q.explanation}||`,
        ].join("\n")
      );
    },
  },
  {
    definition: {
      name: "set_language_level",
      description:
        "Set the student's proficiency level for their current language.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID",
          },
          level: {
            type: "string",
            description:
              "Proficiency level (e.g. N5, N4, N3, N2, N1 for Japanese)",
          },
        },
        required: ["user_id", "level"],
      },
    },
    handler: async (args, ctx) => {
      const session = getSession(args.user_id as string);
      const langModule = getLanguageModule(session.language);
      const level = (args.level as string).toUpperCase();

      if (!langModule.levels.includes(level)) {
        return err(
          `Invalid level "${level}" for ${langModule.displayName}. Available: ${langModule.levels.join(", ")}`
        );
      }

      setLevel(args.user_id as string, level);
      return text(
        `Set ${langModule.displayName} level to **${level}**. Tutor will adjust difficulty accordingly.`
      );
    },
  },
  {
    definition: {
      name: "set_study_language",
      description:
        "Switch which language the student is studying.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: {
            type: "string",
            description: "Discord user ID",
          },
          language: {
            type: "string",
            description: "Language to study (e.g. japanese, chinese)",
          },
        },
        required: ["user_id", "language"],
      },
    },
    handler: async (args, ctx) => {
      const langName = (args.language as string).toLowerCase();
      try {
        const langModule = getLanguageModule(langName);
        setLanguage(args.user_id as string, langName);
        return text(
          `Switched to **${langModule.displayName}**. Level: ${getSession(args.user_id as string).level}`
        );
      } catch (e: any) {
        return err(e.message);
      }
    },
  },
  {
    definition: {
      name: "list_languages",
      description: "List all available languages for study.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    handler: async (_args, _ctx) => {
      const langs = listLanguages();
      const formatted = langs
        .map(
          (l) =>
            `**${l.displayName}** (\`${l.name}\`) — Levels: ${l.levels.join(", ")}`
        )
        .join("\n");
      return text(formatted);
    },
  },

  // --- SRS tools ---
  {
    definition: {
      name: "srs_review",
      description:
        "Get cards due for SRS review. Shows the front of each card for the user to recall.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
          deck: { type: "string", description: "Deck name (default: jlpt-n5)" },
          limit: { type: "number", description: "Max cards (default: 5)" },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, _ctx) => {
      const srs = getSRS();
      if (!srs) return err("SRS not initialized");

      const deck = (args.deck as string) || "jlpt-n5";
      const userId = args.user_id as string;

      // Auto-import N5 deck if user doesn't have it
      if (!srs.hasDeck(userId, deck) && deck === "jlpt-n5") {
        try {
          const vocabData = await import(
            "./languages/japanese/data/n5-vocab.json"
          );
          const cards = Array.isArray(vocabData.default)
            ? vocabData.default
            : vocabData;
          srs.importDeck(userId, "jlpt-n5", cards);
        } catch (e: any) {
          return err(`Failed to import N5 deck: ${e.message}`);
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
            `**${i + 1}.** ${c.front} (${c.reading})\n  ||${c.back}||`
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
        const result = srs.reviewCard(
          args.user_id as string,
          args.card_id as number,
          args.rating as "again" | "hard" | "good" | "easy"
        );
        const nextStr =
          result.interval < 1
            ? `${Math.round(result.interval * 24)} hours`
            : `${result.interval} days`;
        return text(
          `Rated **${result.card.front}** as **${args.rating}**. Next review in ${nextStr}.`
        );
      } catch (e: any) {
        return err(`SRS error: ${e.message}`);
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

  // --- Kana tools ---
  {
    definition: {
      name: "convert_kana",
      description:
        "Convert between romaji, hiragana, and katakana. Useful for beginners learning to type Japanese.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Text to convert" },
          to: {
            type: "string",
            enum: ["hiragana", "katakana", "romaji"],
            description: "Target format",
          },
        },
        required: ["text", "to"],
      },
    },
    handler: async (args, _ctx) => {
      const input = args.text as string;
      const to = args.to as string;

      let result: string;
      switch (to) {
        case "hiragana":
          result = kana.toHiragana(input);
          break;
        case "katakana":
          result = kana.toKatakana(input);
          break;
        case "romaji":
          result = kana.toRomaji(input);
          break;
        default:
          return err(`Unknown target: ${to}`);
      }

      return text(`${input} → **${result}**`);
    },
  },
];
