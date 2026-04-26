/**
 * Core types — extends shared types with full AppContext.
 *
 * Re-exports shared types so existing core imports don't break.
 * Core's Plugin is the same as shared's — AppContext extends PluginContext
 * so plugin methods accepting AppContext satisfy PluginContext constraints.
 */

import type { Client } from "discord.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PluginContext, ToolResult } from "@choomfie/shared";
import type { MemoryStore } from "./memory.ts";
import type { ConfigManager } from "./config.ts";
import type { ReminderScheduler } from "./reminders.ts";
import type { BirthdayScheduler } from "./birthdays.ts";
import type { McpProxy } from "./mcp-proxy.ts";

// Re-export shared types so existing core code keeps working
export type { Plugin, ToolResult } from "@choomfie/shared";
export { text, err } from "@choomfie/shared";

export interface ToolDef {
  definition: {
    name: string;
    description: string;
    inputSchema: object;
  };
  handler: (
    args: Record<string, unknown>,
    ctx: AppContext
  ) => Promise<ToolResult>;
}

export interface AppContext extends PluginContext {
  discord: Client;
  /** MCP Server (supervisor) or McpProxy (worker). */
  mcp: Server | McpProxy;
  memory: MemoryStore;
  config: ConfigManager;
  plugins: import("@choomfie/shared").Plugin[];
  allowedUsers: Set<string>;
  ownerUserId: string | null;
  pendingPairings: Map<
    string,
    { userId: string; username: string; expiresAt: number }
  >;
  messageStats: {
    received: number;
    sent: number;
    byUser: Map<string, number>;
  };
  startedAt: number | null;
  activeChannels: Map<string, number>;
  lastMessageTime: Map<string, number>;
  DATA_DIR: string;
  accessPath: string;
  /** Timer-based reminder scheduler */
  reminderScheduler: ReminderScheduler;
  /** Daily birthday reminder scheduler */
  birthdayScheduler: BirthdayScheduler;
}
