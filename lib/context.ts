/**
 * Context factory — loads env/config and creates the AppContext object.
 */

import { MemoryStore } from "./memory.ts";
import { ConfigManager } from "./config.ts";
import { ReminderScheduler } from "./reminders.ts";
import type { AppContext } from "./types.ts";

/** Write current access state to disk. */
export async function saveAccess(ctx: AppContext) {
  await Bun.write(
    ctx.accessPath,
    JSON.stringify(
      {
        policy: "allowlist",
        owner: ctx.ownerUserId,
        allowed: [...ctx.allowedUsers],
      },
      null,
      2
    )
  );
}

export async function createContext(): Promise<{
  ctx: AppContext;
  discordToken: string;
}> {
  const DATA_DIR =
    process.env.CLAUDE_PLUGIN_DATA ||
    `${process.env.HOME}/.claude/plugins/data/choomfie-inline`;

  // Ensure data directory exists
  const { mkdir } = await import("node:fs/promises");
  await mkdir(DATA_DIR, { recursive: true });

  // Load env vars from .env file
  const envPath = `${DATA_DIR}/.env`;
  let discordToken = process.env.DISCORD_TOKEN || "";

  try {
    const envFile = await Bun.file(envPath).text();
    for (const line of envFile.split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match) {
        const [, key, value] = match;
        const trimmed = value.trim();
        // Set on process.env so plugins can read them
        if (!process.env[key]) process.env[key] = trimmed;
        if (key === "DISCORD_TOKEN") discordToken = trimmed;
      }
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
    accessPath,
    reminderScheduler: new ReminderScheduler(),
  };

  return { ctx, discordToken };
}
