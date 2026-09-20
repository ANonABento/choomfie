/**
 * Interaction registration — the AppContext-typed wrappers around the shared
 * registries in @choomfie/shared.
 *
 * This lives in its own module, separate from interactions.ts, on purpose.
 * Handler modules need `registerX()` at import time; the router needs the
 * handler modules. Putting both in one file made that a cycle, and because
 * interactions.ts loaded its handlers with top-level `await import()`, the
 * cycle deadlocked: importing lib/reminders.ts in isolation would hang forever
 * (reminders → reminder-buttons → interactions → await import(reminder-buttons),
 * which is still evaluating further up the stack).
 *
 * Handlers import from here; interactions.ts imports from here. Nothing imports
 * back into interactions.ts, so there is no cycle to deadlock on.
 */

import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import {
  registerButtonHandler as registerSharedButtonHandler,
  registerModalHandler as registerSharedModalHandler,
  registerCommand as registerSharedCommand,
  type PluginContext,
} from "@choomfie/shared";
import type { AppContext } from "./types.ts";

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
