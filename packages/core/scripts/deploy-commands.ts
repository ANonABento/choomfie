#!/usr/bin/env bun
/**
 * Deploy slash commands to Discord.
 *
 * Usage:
 *   bun scripts/deploy-commands.ts              # Guild deploy (instant, for dev)
 *   bun scripts/deploy-commands.ts --global      # Global deploy (up to 1hr propagation)
 *
 * Reads DISCORD_TOKEN and APPLICATION_ID from the data directory.
 */

import { REST, Routes } from "discord.js";
import { getCommandDefs } from "../lib/interactions.ts";
import { deployGuildCommands } from "../lib/command-deploy.ts";
import { readFile } from "node:fs/promises";
import "@choomfie/tutor";

const DATA_DIR =
  process.env.CHOOMFIE_DATA_DIR ||
  `${process.env.HOME}/.claude/plugins/data/choomfie-inline`;

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

const isGlobal = process.argv.includes("--global");
const guildId = process.argv.find((a) => a.startsWith("--guild="))?.split("=")[1];

const rest = new REST().setToken(token);

// Get application ID from token (bot tokens encode this)
const appInfo = (await rest.get(Routes.currentApplication())) as {
  id: string;
};
const applicationId = appInfo.id;

const commands = getCommandDefs();

console.log(`Deploying ${commands.length} commands...`);

if (isGlobal) {
  await rest.put(Routes.applicationCommands(applicationId), {
    body: commands,
  });
  console.log(`Deployed ${commands.length} commands globally (may take up to 1hr to propagate).`);
} else if (guildId) {
  await rest.put(
    Routes.applicationGuildCommands(applicationId, guildId),
    { body: commands }
  );
  console.log(`Deployed ${commands.length} commands to guild ${guildId} (instant).`);
} else {
  // If no guild specified, deploy to all guilds the bot is in
  const { Client, GatewayIntentBits } = await import("discord.js");
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  await new Promise<void>((resolve) => {
    client.once("ready", async (c) => {
      const guilds = c.guilds.cache;
      for (const [id, guild] of guilds) {
        await deployGuildCommands(rest, applicationId, [id], commands);
        console.log(`  Deployed to: ${guild.name} (${id})`);
      }
      console.log(`\nDeployed ${commands.length} commands to ${guilds.size} guild(s) (instant).`);
      client.destroy();
      resolve();
    });
    client.login(token);
  });
}
