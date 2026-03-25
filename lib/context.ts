/**
 * Context factory — loads env/config and creates the AppContext object.
 */

import { MemoryStore } from "./memory.ts";
import { ConfigManager } from "./config.ts";
import type { AppContext } from "./types.ts";

export async function createContext(): Promise<{
  ctx: AppContext;
  discordToken: string;
}> {
  const CHANNELS_DIR =
    process.env.CLAUDE_CHANNELS_DIR ||
    `${process.env.HOME}/.claude/channels/choomfie`;
  const DATA_DIR = process.env.CLAUDE_PLUGIN_DATA || CHANNELS_DIR;

  // Load Discord token from channel config
  const envPath = `${DATA_DIR}/.env`;
  let discordToken = process.env.DISCORD_TOKEN || "";

  try {
    const envFile = await Bun.file(envPath).text();
    for (const line of envFile.split("\n")) {
      const match = line.match(/^DISCORD_TOKEN=(.+)$/);
      if (match) discordToken = match[1].trim();
    }
  } catch {
    // .env doesn't exist yet — user needs to run /choomfie:configure
  }

  // Load access list
  const accessPath = `${DATA_DIR}/access.json`;
  let allowedUsers: Set<string> = new Set();
  let ownerUserId: string | null = null;

  try {
    const accessData = JSON.parse(await Bun.file(accessPath).text());
    allowedUsers = new Set(accessData.allowed || []);
    ownerUserId = accessData.owner || null;
  } catch {
    // No access file yet — will be created by /choomfie:access
  }

  const memory = new MemoryStore(`${DATA_DIR}/choomfie.db`);
  const config = new ConfigManager(DATA_DIR);

  const ctx: AppContext = {
    // discord, mcp, plugins are set after creation
    discord: null as any,
    mcp: null as any,
    memory,
    config,
    plugins: [],
    allowedUsers,
    ownerUserId,
    pendingPairings: new Map(),
    messageStats: { received: 0, sent: 0, byUser: new Map() },
    startedAt: null,
    activeChannels: new Map(),
    lastMessageTime: new Map(),
    DATA_DIR,
    CHANNELS_DIR,
    accessPath,
  };

  return { ctx, discordToken };
}
