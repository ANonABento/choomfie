/**
 * Spanish-specific tutor tools.
 */

import type { ToolDef } from "@choomfie/shared";
import { err, text } from "@choomfie/shared";
import { spanishToIpa } from "./pronunciation.ts";

function stringArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  return typeof value === "string" ? value : null;
}

export const spanishTools: ToolDef[] = [
  {
    definition: {
      name: "spanish_pronunciation",
      description:
        "Show a simple Latin American Spanish IPA-style pronunciation for a word or short phrase.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Spanish word or short phrase" },
        },
        required: ["text"],
      },
    },
    handler: async (args) => {
      const rawInput = stringArg(args, "text");
      const input = rawInput?.trim();
      if (!input) {
        return err("Expected `text` to be a non-empty string.");
      }

      return text(`${input} → /${spanishToIpa(input)}/`);
    },
  },
];
