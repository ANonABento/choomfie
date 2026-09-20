/**
 * Slash command deployment.
 *
 * Commands are deployed **globally** — one command list, one source of truth,
 * available in every guild the bot joins and in DMs. Guild-scoped commands are
 * deliberately not used: Discord lets both scopes coexist and a guild command
 * *shadows* a global one with the same name, so a leftover guild copy silently
 * pins that guild to an old definition while every other surface moves on.
 *
 * That is exactly what Choomfie used to do, and why `clearGuildCommands` exists:
 * anyone upgrading has stale guild-scoped copies sitting in front of the new
 * global ones, and they have to be explicitly cleared.
 *
 * The cost of global is propagation delay — Discord documents up to an hour for
 * a newly added or renamed command (in practice usually much less). Edits to an
 * existing command's description or options generally appear immediately.
 */
import {
  Routes,
  type REST,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export type CommandBody = RESTPostAPIChatInputApplicationCommandsJSONBody;

/** Replace the application's global command list. */
export async function deployGlobalCommands(
  rest: REST,
  applicationId: string,
  commands: CommandBody[],
): Promise<void> {
  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
}

/**
 * Replace a guild's command list. Only used by `--guild=<id>` on the deploy
 * script, for iterating on a definition without waiting on global propagation.
 * Clear it again with `clearGuildCommands` before relying on global.
 */
export async function deployGuildCommands(
  rest: REST,
  applicationId: string,
  guildIds: Iterable<string>,
  commands: CommandBody[],
): Promise<number> {
  let deployed = 0;
  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: commands,
    });
    deployed++;
  }
  return deployed;
}

/**
 * Remove every guild-scoped command from the given guilds, so the global list
 * is what users actually see. Idempotent — a guild with no guild-scoped
 * commands is a no-op PUT.
 */
export async function clearGuildCommands(
  rest: REST,
  applicationId: string,
  guildIds: Iterable<string>,
): Promise<number> {
  let cleared = 0;
  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: [],
    });
    cleared++;
  }
  return cleared;
}
