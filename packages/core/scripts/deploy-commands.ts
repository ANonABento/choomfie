#!/usr/bin/env bun
/**
 * Deploy slash commands to Discord.
 *
 * Commands are global — one list, every guild, plus DMs. See lib/command-deploy.ts
 * for why guild-scoped deployment is not the default.
 *
 * Usage:
 *   bun packages/core/scripts/deploy-commands.ts                # Global (default)
 *   bun packages/core/scripts/deploy-commands.ts --guild=<id>   # Dev only: instant, one guild
 *   bun packages/core/scripts/deploy-commands.ts --clear-guilds # Drop guild-scoped leftovers
 *
 * Reads DISCORD_TOKEN and APPLICATION_ID from the data directory.
 */

import { REST, Routes } from "discord.js";
import { getCommandDefs, registerAllHandlers } from "../lib/interactions.ts";
import {
  clearGuildCommands,
  deployGlobalCommands,
  deployGuildCommands,
} from "../lib/command-deploy.ts";
import { readFile } from "node:fs/promises";
import { resolveDataDir } from "@choomfie/shared";
import "@choomfie/tutor";

await registerAllHandlers();

const DATA_DIR = resolveDataDir();

// Load token from .env file or environment
let token = process.env.DISCORD_TOKEN || "";
if (!token) {
  try {
    const envFile = await readFile(`${DATA_DIR}/.env`, "utf-8");
    for (const line of envFile.split("\n")) {
      const match = line.match(/^DISCORD_TOKEN=(.+)$/);
      if (match) {
        token = match[1].trim();
        break;
      }
    }
  } catch {}
}
if (!token) {
  console.error("No DISCORD_TOKEN found. Run /choomfie:configure first.");
  process.exit(1);
}

const guildId = process.argv.find((a) => a.startsWith("--guild="))?.split("=")[1];
const clearGuilds = process.argv.includes("--clear-guilds");

const rest = new REST().setToken(token);

// Get application ID from token (bot tokens encode this)
const appInfo = (await rest.get(Routes.currentApplication())) as { id: string };
const applicationId = appInfo.id;

const commands = getCommandDefs();

/** Every guild the bot is in — needs a gateway connection to enumerate. */
async function connectedGuildIds(): Promise<Map<string, string>> {
  const { Client, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const guilds = await new Promise<Map<string, string>>((resolve) => {
      client.once("ready", (c) => {
        resolve(new Map([...c.guilds.cache].map(([id, g]) => [id, g.name])));
      });
      client.login(token);
    });
    return guilds;
  } finally {
    client.destroy();
  }
}

if (guildId) {
  // Dev escape hatch: instant, but shadows the global list in that guild until
  // cleared. Say so rather than letting it become a confusing silent override.
  await deployGuildCommands(rest, applicationId, [guildId], commands);
  console.log(`Deployed ${commands.length} commands to guild ${guildId} (instant).`);
  console.log("These shadow the global commands in that guild.");
  console.log("Run with --clear-guilds when you're done to fall back to global.");
} else if (clearGuilds) {
  const guilds = await connectedGuildIds();
  await clearGuildCommands(rest, applicationId, guilds.keys());
  for (const name of guilds.values()) console.log(`  Cleared: ${name}`);
  console.log(`\nCleared guild-scoped commands in ${guilds.size} guild(s). Global list is now authoritative.`);
} else {
  await deployGlobalCommands(rest, applicationId, commands);
  console.log(`Deployed ${commands.length} commands globally.`);

  // A leftover guild-scoped copy would shadow what we just deployed.
  const guilds = await connectedGuildIds();
  if (guilds.size > 0) {
    await clearGuildCommands(rest, applicationId, guilds.keys());
    console.log(`Cleared guild-scoped copies in ${guilds.size} guild(s).`);
  }
  console.log("New or renamed commands can take up to an hour to appear; edits are usually immediate.");
}
