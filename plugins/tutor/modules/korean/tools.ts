/**
 * Korean-specific tutor tool — convert_hangul.
 */

import type { ToolDef } from "@choomfie/shared";
import { text, err } from "@choomfie/shared";
import { hangulToRomanization } from "./romanization.ts";

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const koreanTools: ToolDef[] = [
  {
    definition: {
      name: "convert_hangul",
      description:
        "Convert Korean Hangul text to Revised Romanization. Useful for beginners learning pronunciation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "Korean Hangul text to romanize (e.g. 안녕하세요)",
          },
        },
        required: ["text"],
      },
    },
    handler: async (args, _ctx) => {
      const input = stringArg(args, "text");
      if (!input) {
        return err("Expected `text` to be a non-empty string of Korean Hangul.");
      }

      const romanized = hangulToRomanization(input);
      return text(`${input} → **${romanized}**`);
    },
  },
];
