/**
 * Chinese-specific tutor tools.
 */

import type { ToolDef } from "@choomfie/shared";
import { text, err } from "@choomfie/shared";
import { convertHanzi, getHanziInfo } from "./hanzi.ts";
import { isValidNumberedPinyin, normalizePinyin } from "./pinyin.ts";

const PINYIN_STYLES = ["marks", "numbers"] as const;
const HANZI_TARGETS = ["simplified", "traditional"] as const;

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" ? value : null;
}

function enumArg<T extends readonly string[]>(
  args: Record<string, unknown>,
  name: string,
  values: T
): T[number] | null {
  const value = stringArg(args, name);
  return value && (values as readonly string[]).includes(value) ? (value as T[number]) : null;
}

export const chineseTools: ToolDef[] = [
  {
    definition: {
      name: "convert_pinyin",
      description:
        "Convert Mandarin pinyin between tone marks and tone numbers, e.g. nǐ hǎo ↔ ni3 hao3.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Pinyin text to convert" },
          to: {
            type: "string",
            enum: ["marks", "numbers"],
            description: "Target pinyin style",
          },
        },
        required: ["text", "to"],
      },
    },
    handler: async (args, _ctx) => {
      const input = stringArg(args, "text");
      const to = enumArg(args, "to", PINYIN_STYLES);

      if (!input) {
        return err("Expected `text` to be a non-empty string.");
      }

      if (!to) {
        return err(`Unknown target: ${String(args.to)}`);
      }

      if (to === "marks" && !isValidNumberedPinyin(input)) {
        return err("Expected numbered pinyin such as `ni3 hao3`.");
      }

      return text(`${input} → **${normalizePinyin(input, to)}**`);
    },
  },
  {
    definition: {
      name: "stroke_info",
      description: "Show basic stroke count and radical information for a Chinese character.",
      inputSchema: {
        type: "object" as const,
        properties: {
          character: { type: "string", description: "Chinese character to inspect" },
        },
        required: ["character"],
      },
    },
    handler: async (args, _ctx) => {
      const character = stringArg(args, "character");
      if (!character) {
        return err("Expected `character` to be a non-empty string.");
      }

      const info = getHanziInfo(character);
      if (!info) {
        return text("No built-in stroke data for that character yet.");
      }

      return text(
        `**${info.character}** — ${info.strokes} strokes, radical **${info.radical}**, ${info.meaning}`
      );
    },
  },
  {
    definition: {
      name: "convert_hanzi",
      description:
        "Convert a small set of common Chinese characters between simplified and traditional forms.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Chinese text to convert" },
          to: {
            type: "string",
            enum: ["simplified", "traditional"],
            description: "Target character form",
          },
        },
        required: ["text", "to"],
      },
    },
    handler: async (args, _ctx) => {
      const input = stringArg(args, "text");
      const to = enumArg(args, "to", HANZI_TARGETS);

      if (!input) {
        return err("Expected `text` to be a non-empty string.");
      }

      if (!to) {
        return err(`Unknown target: ${String(args.to)}`);
      }

      return text(`${input} → **${convertHanzi(input, to)}**`);
    },
  },
];
