/**
 * Tutor tools — tutor_prompt, quiz, dictionary_lookup, set_level.
 * Delegates to the active module.
 */

import type { ToolDef } from "@choomfie/shared";
import { text, err, errorMessage } from "@choomfie/shared";
import { getActiveModule, getModuleLevel, setLevel } from "../core/session.ts";
import { getModule } from "../modules/index.ts";
import { getLessonDB } from "../core/lesson-db-instance.ts";
import { formatForPrompt } from "../core/learner-profile.ts";
import { getActiveSession } from "../lesson-interactions.ts";

function normalizeLevel(input: string, levels: string[]): string | null {
  const normalizedInput = input.trim().toUpperCase().replace(/\s+/g, "");
  return levels.find(
    (level) => level.toUpperCase().replace(/\s+/g, "") === normalizedInput
  ) ?? null;
}

function resolveModuleLevel(userId: string, moduleName: string, mod: ReturnType<typeof getModule>): string {
  const currentLevel = getModuleLevel(userId, moduleName);
  return normalizeLevel(currentLevel, mod.levels) ?? mod.defaultLevel;
}

export const tutorTools: ToolDef[] = [
  {
    definition: {
      name: "tutor_prompt",
      description:
        "Get the tutor system prompt for the user's active module and level. Use this to understand how to tutor the student.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, _ctx) => {
      const userId = args.user_id as string;
      const moduleName = getActiveModule(userId);
      const mod = getModule(moduleName);
      if (!mod.buildTutorPrompt) {
        return err(`Module "${mod.displayName}" does not have a tutor prompt`);
      }
      const level = resolveModuleLevel(userId, moduleName, mod);
      const activeSession = getActiveSession(userId);
      const promptCtx = activeSession?.module === moduleName && activeSession.lesson.furiganaLevel
        ? { furiganaLevel: activeSession.lesson.furiganaLevel }
        : undefined;
      let prompt = mod.buildTutorPrompt(level, promptCtx);

      // Append learner profile if available
      const db = getLessonDB();
      if (db) {
        const profile = db.getProfile(userId, moduleName);
        if (profile) {
          prompt += "\n\n" + formatForPrompt(profile);
        }
      }

      return text(prompt);
    },
  },
  {
    definition: {
      name: "dictionary_lookup",
      description:
        "Look up a word/term in the active module's reference. For languages: dictionary lookup. For other modules: reference/docs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Word or term to look up",
          },
          user_id: {
            type: "string",
            description: "Discord user ID (to determine active module)",
          },
          module: {
            type: "string",
            description: "Module to look up in (default: user's active module)",
          },
        },
        required: ["query"],
      },
    },
    handler: async (args, _ctx) => {
      const moduleName =
        (args.module as string) ||
        (args.user_id ? getActiveModule(args.user_id as string) : "japanese");
      const mod = getModule(moduleName);

      if (!mod.lookup) {
        return err(`Module "${mod.displayName}" does not support lookup`);
      }

      try {
        const entries = await mod.lookup(args.query as string);
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
      } catch (e: unknown) {
        return err(`Lookup error: ${errorMessage(e)}`);
      }
    },
  },
  {
    definition: {
      name: "quiz",
      description:
        "Generate a quiz question for the student based on their active module and level.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
          type: {
            type: "string",
            description: "Quiz type (module-specific, e.g. reading/vocab/grammar for Japanese)",
          },
        },
        required: ["user_id"],
      },
    },
    handler: async (args, _ctx) => {
      const userId = args.user_id as string;
      const moduleName = getActiveModule(userId);
      const mod = getModule(moduleName);

      if (!mod.generateQuiz) {
        return err(`Module "${mod.displayName}" does not support quizzes`);
      }

      const quizTypes = mod.quizTypes ?? ["general"];
      const quizType =
        (args.type as string) ||
        quizTypes[Math.floor(Math.random() * quizTypes.length)];

      const q = mod.generateQuiz(resolveModuleLevel(userId, moduleName, mod), quizType);

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
      name: "set_level",
      description:
        "Set the student's proficiency level for their active module.",
      inputSchema: {
        type: "object" as const,
        properties: {
          user_id: { type: "string", description: "Discord user ID" },
          level: {
            type: "string",
            description: "Proficiency level (module-specific, e.g. N5/N4/N3/N2/N1 for Japanese)",
          },
        },
        required: ["user_id", "level"],
      },
    },
    handler: async (args, _ctx) => {
      const userId = args.user_id as string;
      const moduleName = getActiveModule(userId);
      const mod = getModule(moduleName);
      const requestedLevel = typeof args.level === "string" ? args.level : "";
      const level = normalizeLevel(requestedLevel, mod.levels);

      if (!level) {
        return err(
          `Invalid level "${requestedLevel.trim().toUpperCase()}" for ${mod.displayName}. Available: ${mod.levels.join(", ")}`
        );
      }

      setLevel(userId, level);
      return text(
        `Set ${mod.displayName} level to **${level}**. Tutor will adjust difficulty accordingly.`
      );
    },
  },
];
