/**
 * PluginContext — minimal context interface plugins code against.
 *
 * When running inside Choomfie, plugins receive the full AppContext (which extends PluginContext).
 * When running standalone, they receive a minimal implementation of this interface.
 */

import type { Client } from "discord.js";

export interface SocialsPlatformConfig {
  [key: string]: string | number | boolean | undefined;
}

export interface SocialsConfig {
  youtube?: SocialsPlatformConfig;
  reddit?: SocialsPlatformConfig;
  linkedin?: SocialsPlatformConfig;
  twitter?: SocialsPlatformConfig;
  [key: string]: SocialsPlatformConfig | undefined;
}

export interface ChoomfieConfig {
  localFirst?: boolean;
  provider?: string;
  localModel?: string;
  ollamaUrl?: string;
  embeddings?: string;
  socials?: SocialsConfig;
  [key: string]: unknown;
}

export interface NotificationMessage {
  method: string;
  params: Record<string, unknown>;
}

export interface McpTransport {
  notification?(msg: NotificationMessage): void;
  requestRestart?(reason: string, chat_id?: string): void;
  setNotificationHandler?(
    schema: unknown,
    handler: (msg: { params: Record<string, unknown> }) => Promise<void>,
  ): void;
}

/** Minimal config interface plugins can depend on (no ConfigManager class import). */
export interface PluginConfig {
  getConfig(): ChoomfieConfig;
  getEnabledPlugins(): string[];
  getVoiceConfig(): { stt: string; tts: string; ttsSpeed?: number };
  getSocialsConfig(): SocialsConfig | undefined;
}

export interface PluginContext {
  /** Data directory for persistent storage */
  DATA_DIR: string;
  /** Config manager (typed interface, not the class) */
  config: PluginConfig;
  /** MCP server or proxy for sending notifications */
  mcp?: McpTransport;
  /** Discord client (only if running inside Choomfie) */
  discord?: Client;
  /** Owner user ID (for permission checks) */
  ownerUserId?: string | null;
}
