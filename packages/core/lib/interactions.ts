/**
 * Interaction router — dispatches buttons, slash commands, and modal submissions.
 *
 * Re-exports shared registries so existing core imports don't break.
 * Handler logic lives in lib/handlers/ and lib/commands.ts.
 * All register themselves via side-effect imports at the bottom.
 */

import {
  MessageFlags,
  type Interaction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { AppContext } from "./types.ts";
import { errorMessage, type PluginContext } from "@choomfie/shared";
import { dispatchPluginInteraction } from "./plugin-lifecycle.ts";

// Re-export shared registries so existing core imports keep working
export {
  getCommandDefs,
  buttonHandlers,
  modalHandlers,
  commands,
} from "@choomfie/shared";

import {
  buttonHandlers,
  modalHandlers,
  commands,
  registerButtonHandler as registerSharedButtonHandler,
  registerModalHandler as registerSharedModalHandler,
  registerCommand as registerSharedCommand,
} from "@choomfie/shared";

export type ButtonHandler = (
  interaction: ButtonInteraction,
  parts: string[],
  ctx: AppContext
) => Promise<void>;

export type ModalHandler = (
  interaction: ModalSubmitInteraction,
  parts: string[],
  ctx: AppContext
) => Promise<void>;

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
) => Promise<void>;

function asAppContext(ctx: PluginContext): AppContext {
  return ctx as AppContext;
}

export function registerButtonHandler(prefix: string, handler: ButtonHandler) {
  registerSharedButtonHandler(prefix, (interaction, parts, ctx) =>
    handler(interaction, parts, asAppContext(ctx))
  );
}

export function registerModalHandler(prefix: string, handler: ModalHandler) {
  registerSharedModalHandler(prefix, (interaction, parts, ctx) =>
    handler(interaction, parts, asAppContext(ctx))
  );
}

export function registerCommand(
  name: string,
  def: {
    data: RESTPostAPIChatInputApplicationCommandsJSONBody;
    handler: CommandHandler;
  }
) {
  registerSharedCommand(name, {
    data: def.data,
    handler: (interaction, ctx) => def.handler(interaction, asAppContext(ctx)),
  });
}

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
// Dynamic imports avoid circular initialization issues.
// Handlers register themselves by calling registerButtonHandler/registerModalHandler/registerCommand.
await import("./handlers/reminder-buttons.ts");
await import("./handlers/permission-buttons.ts");
await import("./handlers/modals.ts");
await import("./commands.ts");
