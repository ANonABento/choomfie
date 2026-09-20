/**
 * Interaction router — dispatches buttons, slash commands, and modal submissions.
 *
 * Re-exports shared registries so existing core imports don't break.
 * Handler logic lives in lib/handlers/ and lib/commands.ts; the registration
 * wrappers they use live in lib/register.ts.
 *
 * Importing this module has NO side effects. Call registerAllHandlers() once at
 * boot to load the built-in handlers — see the note on that function.
 */

import {
  MessageFlags,
  type Interaction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import type { AppContext } from "./types.ts";
import { errorMessage } from "@choomfie/shared";
import { dispatchPluginInteraction } from "./plugin-lifecycle.ts";

// Re-export shared registries so existing core imports keep working
export {
  getCommandDefs,
  buttonHandlers,
  modalHandlers,
  commands,
} from "@choomfie/shared";

// Re-exported for back-compat — the definitions live in ./register.ts, which
// handler modules import directly so they never depend on this file.
export {
  registerButtonHandler,
  registerModalHandler,
  registerCommand,
  type ButtonHandler,
  type ModalHandler,
  type CommandHandler,
} from "./register.ts";

import { buttonHandlers, modalHandlers, commands } from "@choomfie/shared";

// --- Error-safe interaction wrapper ---

type SafeHandleInteraction =
  | ChatInputCommandInteraction
  | ButtonInteraction
  | ModalSubmitInteraction;

async function safeHandle(
  interaction: SafeHandleInteraction,
  label: string,
  fn: () => Promise<void>
) {
  try {
    await fn();
  } catch (e) {
    console.error(`${label}: ${errorMessage(e)}`);
    if (interaction.deferred && interaction.editReply) {
      await interaction.editReply({ content: "Something went wrong." });
    } else if (!interaction.replied) {
      await interaction.reply({
        content: "Something went wrong.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

// --- Main router ---

export async function handleInteraction(
  interaction: Interaction,
  ctx: AppContext
) {
  // Let plugins handle first
  await dispatchPluginInteraction(ctx.plugins, interaction, ctx);

  // Autocomplete is checked before the command branch: an autocomplete
  // interaction is not a chat-input command, and it cannot go through
  // safeHandle — it has no reply()/editReply(), only respond(), and Discord
  // accepts exactly one response within 3 seconds.
  if (interaction.isAutocomplete()) {
    const cmd = commands.get(interaction.commandName);
    if (!cmd?.autocomplete) return;
    try {
      await cmd.autocomplete(interaction, ctx);
    } catch (e) {
      console.error(`Autocomplete(${interaction.commandName}): ${errorMessage(e)}`);
      // Leave the user with an empty list rather than a spinner that never
      // resolves. Throws if something already responded, which is fine.
      try {
        await interaction.respond([]);
      } catch {
        // Already responded, or the 3s window closed.
      }
    }
    return;
  }

  if (interaction.isChatInputCommand()) {
    const cmd = commands.get(interaction.commandName);
    if (cmd) {
      await safeHandle(interaction, `Command(${interaction.commandName})`, () =>
        cmd.handler(interaction, ctx)
      );
    }
    return;
  }

  if (interaction.isButton()) {
    const parts = interaction.customId.split(":");
    const handler = buttonHandlers.get(parts[0]);
    if (handler) {
      await safeHandle(interaction, `Button(${parts[0]})`, () =>
        handler(interaction, parts, ctx)
      );
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    const parts = interaction.customId.split(":");
    const handler = modalHandlers.get(parts[0]);
    if (handler) {
      await safeHandle(interaction, `Modal(${parts[0]})`, () =>
        handler(interaction, parts, ctx)
      );
    }
  }
}

// --- Load handlers ---

let handlersLoaded: Promise<void> | null = null;

/**
 * Load the built-in button/modal/command handlers, which self-register on
 * import. Idempotent — repeated calls await the first one.
 *
 * These imports used to sit at module scope as top-level `await import()`,
 * which made importing this file (or anything that reached it) a deadlock risk.
 * Keeping them inside a function means module import is side-effect free and
 * the registration point is an explicit, greppable call at boot.
 */
export function registerAllHandlers(): Promise<void> {
  handlersLoaded ??= (async () => {
    await import("./handlers/reminder-buttons.ts");
    await import("./handlers/permission-buttons.ts");
    await import("./handlers/modals.ts");
    await import("./commands.ts");
  })();
  return handlersLoaded;
}
