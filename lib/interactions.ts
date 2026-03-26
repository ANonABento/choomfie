/**
 * Interaction router — dispatches buttons, slash commands, and modal submissions.
 *
 * Handler logic lives in lib/handlers/ and lib/commands.ts.
 * All register themselves via side-effect imports at the bottom.
 */

import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { AppContext } from "./types.ts";

// --- Handler registries ---

type ButtonHandler = (
  interaction: ButtonInteraction,
  parts: string[],
  ctx: AppContext
) => Promise<void>;

type ModalHandler = (
  interaction: ModalSubmitInteraction,
  parts: string[],
  ctx: AppContext
) => Promise<void>;

type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  ctx: AppContext
) => Promise<void>;

interface CommandDef {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  handler: CommandHandler;
}

const buttonHandlers = new Map<string, ButtonHandler>();
const modalHandlers = new Map<string, ModalHandler>();
const commands = new Map<string, CommandDef>();

export function registerButtonHandler(prefix: string, handler: ButtonHandler) {
  buttonHandlers.set(prefix, handler);
}

export function registerModalHandler(prefix: string, handler: ModalHandler) {
  modalHandlers.set(prefix, handler);
}

export function registerCommand(
  name: string,
  def: { data: RESTPostAPIChatInputApplicationCommandsJSONBody; handler: CommandHandler }
) {
  commands.set(name, def);
}

/** Get all command definitions for deploy script */
export function getCommandDefs(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [...commands.values()].map((c) => c.data);
}

// --- Error-safe interaction wrapper ---

async function safeHandle(
  interaction: { replied: boolean; deferred: boolean; reply: Function; editReply?: Function },
  label: string,
  fn: () => Promise<void>
) {
  try {
    await fn();
  } catch (e) {
    console.error(`${label}: ${e}`);
    const reply = { content: "Something went wrong.", flags: MessageFlags.Ephemeral };
    if (interaction.deferred && interaction.editReply) {
      await interaction.editReply(reply);
    } else if (!interaction.replied) {
      await interaction.reply(reply);
    }
  }
}

// --- Main router ---

export async function handleInteraction(
  interaction: Interaction,
  ctx: AppContext
) {
  // Let plugins handle first
  for (const plugin of ctx.plugins) {
    if (plugin.onInteraction) {
      try {
        await plugin.onInteraction(interaction, ctx);
      } catch (e) {
        console.error(`Plugin ${plugin.name} onInteraction error: ${e}`);
      }
    }
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
// Dynamic imports avoid circular initialization issues.
// Handlers register themselves by calling registerButtonHandler/registerModalHandler/registerCommand.
await import("./handlers/reminder-buttons.ts");
await import("./handlers/modals.ts");
await import("./commands.ts");
