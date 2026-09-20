/**
 * Interaction registries — shared between core and plugins.
 *
 * Contains ONLY the registries and register functions.
 * Dispatch logic (handleInteraction, safeHandle) stays in @choomfie/core.
 */

import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { PluginContext } from "./plugin-context.ts";

/**
 * Discord's hard cap on autocomplete suggestions. Sending more is rejected
 * outright, so every suggester must slice to this.
 */
export const AUTOCOMPLETE_LIMIT = 25;

// --- Handler types ---

export type ButtonHandler = (
  interaction: ButtonInteraction,
  parts: string[],
  ctx: PluginContext
) => Promise<void>;

export type ModalHandler = (
  interaction: ModalSubmitInteraction,
  parts: string[],
  ctx: PluginContext
) => Promise<void>;

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  ctx: PluginContext
) => Promise<void>;

/**
 * Suggests values for the option the user is currently typing in.
 *
 * Discord gives the handler 3 seconds and accepts exactly one response, so a
 * suggester must be synchronous work over in-memory data — never a network
 * call. It must also respond even when it has nothing to suggest (with an empty
 * list), or the user sees a stuck "loading options" spinner.
 */
export type AutocompleteHandler = (
  interaction: AutocompleteInteraction,
  ctx: PluginContext
) => Promise<void>;

export interface CommandDef {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  handler: CommandHandler;
  autocomplete?: AutocompleteHandler;
}

// --- Registries ---

export const buttonHandlers = new Map<string, ButtonHandler>();
export const modalHandlers = new Map<string, ModalHandler>();
export const commands = new Map<string, CommandDef>();

// --- Register functions ---

export function registerButtonHandler(prefix: string, handler: ButtonHandler) {
  buttonHandlers.set(prefix, handler);
}

export function registerModalHandler(prefix: string, handler: ModalHandler) {
  modalHandlers.set(prefix, handler);
}

export function registerCommand(name: string, def: CommandDef) {
  commands.set(name, def);
}

/** Get all command definitions for deploy script */
export function getCommandDefs(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [...commands.values()].map((c) => c.data);
}
