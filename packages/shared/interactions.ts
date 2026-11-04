/**
 * Interaction registries — shared between core and plugins.
 *
 * Contains ONLY the registries and register functions.
 * Dispatch logic (handleInteraction, safeHandle) stays in @choomfie/core.
 */

import {
  ApplicationIntegrationType,
  InteractionContextType,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type RESTPostAPIContextMenuApplicationCommandsJSONBody,
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

/** A right-click → Apps command on a message. */
export type MessageMenuHandler = (
  interaction: MessageContextMenuCommandInteraction,
  ctx: PluginContext
) => Promise<void>;

export interface MessageMenuDef {
  data: RESTPostAPIContextMenuApplicationCommandsJSONBody;
  handler: MessageMenuHandler;
}

export type AnyCommandBody =
  | RESTPostAPIChatInputApplicationCommandsJSONBody
  | RESTPostAPIContextMenuApplicationCommandsJSONBody;

// --- Registries ---

export const buttonHandlers = new Map<string, ButtonHandler>();
export const modalHandlers = new Map<string, ModalHandler>();
export const commands = new Map<string, CommandDef>();
export const messageMenus = new Map<string, MessageMenuDef>();

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

export function registerMessageMenu(name: string, def: MessageMenuDef) {
  messageMenus.set(name, def);
}

/**
 * Where a command can be installed and used when it doesn't say.
 *
 * Spelled out rather than left to Discord: an unset `integration_types` falls
 * back to the app's configured install types, so ticking "User Install" in the
 * Developer Portal would otherwise turn every owner command into something
 * usable from any chat the owner is in. Only commands that opt in
 * (`/choomfie`, `/brain`, `/stop`, "Ask Choomfie") work outside the bot's servers.
 */
export const GUILD_INSTALL_ONLY = {
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
};

/** For the few commands that should work anywhere the owner is — group DMs included. */
export const ANYWHERE = {
  integration_types: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
};

/** Get all command definitions for deploy script */
export function getCommandDefs(): AnyCommandBody[] {
  // `??`, not a spread: the builders' toJSON() emits these keys as `undefined`,
  // which a spread would copy straight over the default.
  return [...commands.values(), ...messageMenus.values()].map((c) => ({
    ...c.data,
    integration_types: c.data.integration_types ?? GUILD_INSTALL_ONLY.integration_types,
    contexts: c.data.contexts ?? GUILD_INSTALL_ONLY.contexts,
  }));
}
