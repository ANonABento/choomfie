/**
 * A command that throws gets "Something went wrong." — but that reply can fail
 * too (Discord already dropped the interaction: "Unknown interaction"). That
 * second failure used to escape the event handler and exit the worker
 * (seen 2026-11-08 on /choomfie).
 */
import { expect, test } from "bun:test";
import type { AppContext } from "../../lib/types.ts";
import { handleInteraction } from "../../lib/interactions.ts";
import { registerCommand } from "../../lib/register.ts";

test("a failing error reply is logged, not thrown", async () => {
  registerCommand("error-reply-boom", {
    data: { name: "error-reply-boom", description: "test" } as never,
    handler: async () => {
      throw new Error("handler failed");
    },
  });
  const interaction = {
    commandName: "error-reply-boom",
    deferred: false,
    replied: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isModalSubmit: () => false,
    isMessageContextMenuCommand: () => false,
    isContextMenuCommand: () => false,
    reply: async () => {
      throw new Error("Unknown interaction");
    },
  };
  await expect(handleInteraction(interaction as never, { plugins: [] } as unknown as AppContext)).resolves.toBeUndefined();
});
