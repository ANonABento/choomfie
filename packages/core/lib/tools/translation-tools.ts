/**
 * Translation tools — Anthropic-backed text translation.
 */

import type { ToolDef } from "../types.ts";
import { err, text } from "../types.ts";
import { parseTranslateArgs, translateText } from "../translation.ts";

export const translationTools: ToolDef[] = [
  {
    definition: {
      name: "translate",
      description:
        "Translate text to a target language. Detects the source language automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_lang: {
            type: "string",
            description: 'Target language, e.g. "English", "Spanish", "Japanese", or "pt-BR"',
          },
          text: {
            type: "string",
            description: "Text to translate",
          },
        },
        required: ["target_lang", "text"],
      },
    },
    handler: async (args) => {
      const parsed = parseTranslateArgs(args);
      if (typeof parsed === "string") return err(parsed);

      try {
        return text(await translateText(parsed));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(`Translation failed: ${message}`);
      }
    },
  },
];
