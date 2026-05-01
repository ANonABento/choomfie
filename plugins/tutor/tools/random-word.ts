/**
 * Random word tool — picks a random N5 vocab word with spoiler-hidden meaning.
 */

import type { ToolDef } from "@choomfie/shared";
import { text } from "@choomfie/shared";
import { n5Vocab } from "../modules/japanese/vocab.ts";

export const randomWordTools: ToolDef[] = [
  {
    definition: {
      name: "random_word",
      description: "Get a random Japanese N5 vocabulary word. Great for daily practice or warm-up.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_args, _ctx) => {
      if (n5Vocab.length === 0) return text("No vocabulary data available.");

      const word = n5Vocab[Math.floor(Math.random() * n5Vocab.length)];
      return text(
        [
          `📚 **Random Word**`,
          ``,
          `**${word.front}** (${word.reading})`,
          `Meaning: ||${word.back}||`,
          ``,
          `_React ✅ if you knew it!_`,
        ].join("\n")
      );
    },
  },
];
