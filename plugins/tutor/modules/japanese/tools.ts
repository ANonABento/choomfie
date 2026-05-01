/**
 * Japanese-specific tools — only registered when Japanese module is loaded.
 */

import type { ToolDef } from "@choomfie/shared";
import { text, err } from "@choomfie/shared";
import * as kana from "./kana.ts";
import { getKanjiInfo } from "./kanji.ts";

export const japaneseTools: ToolDef[] = [
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
  {
    definition: {
      name: "kanji_stroke_info",
      description: "Show basic stroke count, radical, and reading information for a built-in JLPT N5 kanji.",
      inputSchema: {
        type: "object" as const,
        properties: {
          character: { type: "string", description: "Japanese kanji to inspect" },
        },
        required: ["character"],
      },
    },
    handler: async (args, _ctx) => {
      const character = typeof args.character === "string" ? args.character : null;
      if (!character) {
        return err("Expected `character` to be a non-empty string.");
      }

      const info = getKanjiInfo(character);
      if (!info) {
        return text("No built-in kanji stroke data for that character yet.");
      }

      const readings = [
        info.onyomi ? `on: ${info.onyomi}` : null,
        info.kunyomi ? `kun: ${info.kunyomi}` : null,
      ].filter(Boolean).join("; ");

      return text(
        `**${info.character}** — ${info.strokes} strokes, radical **${info.radical}**, ${info.meaning}${readings ? ` (${readings})` : ""}`
      );
    },
  },
];
