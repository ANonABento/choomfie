import {
  Routes,
  type REST,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { AppContext } from "./types.ts";

export async function deployGuildCommands(
  rest: REST,
  applicationId: string,
  guildIds: Iterable<string>,
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
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

export async function deployCurrentGuildCommands(
  ctx: AppContext,
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[],
): Promise<number> {
  const token = ctx.discord.token;
  const applicationId = ctx.discord.application?.id;
  if (!token || !applicationId) {
    throw new Error("Discord client is not ready for command deployment");
  }

  const { REST } = await import("discord.js");
  const rest = new REST().setToken(token);
  return deployGuildCommands(rest, applicationId, ctx.discord.guilds.cache.keys(), commands);
}
