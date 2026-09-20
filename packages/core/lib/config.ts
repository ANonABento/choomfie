/**
 * Config manager — personas, settings, presets.
 *
 * Stored in config.json alongside the database.
 * Personas define how the bot behaves (personality, name, tone).
 * Settings control bot behavior (rate limits, triggers, etc.).
 */

import { readFileSync } from "node:fs";
import { writeJsonAtomicSync, type SocialsPlatformConfig } from "@choomfie/shared";
import {
  resolveOpenAIEndpointConfig,
  type OpenAIEndpointConfig,
} from "./openai/config.ts";

export interface Persona {
  name: string;
  personality: string;
}

export interface VoiceConfig {
  stt: string;
  tts: string;
  ttsSpeed?: number; // 0.5 to 2.0 (default 1.0)
}

export interface YouTubeConfig extends SocialsPlatformConfig {
    apiKey?: string;       // Optional — for YouTube Data API v3 reads (fallback to yt-dlp)
    clientId?: string;     // Optional — for OAuth (comments)
    clientSecret?: string; // Optional — for OAuth (comments)
}

export interface LinkedInConfig extends SocialsPlatformConfig {
    clientId: string;
    clientSecret: string;
}

export interface RedditConfig extends SocialsPlatformConfig {
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
}

export interface TwitterConfig extends SocialsPlatformConfig {
  username: string;
  password: string;
  email: string;
}

export interface SocialsConfig {
  youtube?: YouTubeConfig;
  linkedin?: LinkedInConfig;
  reddit?: RedditConfig;
  twitter?: TwitterConfig;
  [key: string]: SocialsPlatformConfig | undefined;
}

/** Settings for `--daemon` mode sessions. */
export interface DaemonConfig {
  /** Cycle the session once cumulative context reaches this many tokens. */
  tokenThreshold: number;
  /** Cycle the session once it has taken this many turns. */
  turnThreshold: number;
  /**
   * Model for daemon sessions — an alias ("opus", "sonnet", "haiku") or a full
   * model id. Unset means Claude Code's own default, which is what daemon
   * sessions used before this existed.
   *
   * Only applies to `--daemon`. Foreground and `--tmux` run under the `claude`
   * CLI, which takes its model from your Claude Code settings, not from here.
   */
  model?: string;
  /** Model to fall back to when the primary is overloaded. Unset = no fallback. */
  fallbackModel?: string;
}

export interface Config {
  activePersona: string;
  personas: Record<string, Persona>;
  rateLimitMs: number;
  convoTimeoutMs: number;
  autoSummarize: boolean;
  plugins: string[];
  voice: VoiceConfig;
  socials?: SocialsConfig;
  daemon: DaemonConfig;
  openaiEndpoint: OpenAIEndpointConfig;
  [key: string]: unknown;
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  tokenThreshold: 120_000,
  turnThreshold: 80,
};

const DEFAULT_CONFIG: Config = {
  activePersona: "choomfie",
  personas: {
    choomfie: {
      name: "Choomfie",
      personality:
        "Be casual, friendly, and fun. Talk like a cyberpunk buddy — use slang, be a ride-or-die friend.",
    },
  },
  rateLimitMs: 5000,
  convoTimeoutMs: 5 * 60 * 1000, // 5 min
  autoSummarize: true,
  plugins: [],
  voice: { stt: "auto", tts: "auto", ttsSpeed: 0.7 },
  daemon: { ...DEFAULT_DAEMON_CONFIG },
  openaiEndpoint: resolveOpenAIEndpointConfig(),
};

function mergeConfig(saved: Partial<Config>): Config {
  const savedPersonas =
    saved.personas && typeof saved.personas === "object"
      ? saved.personas
      : {};
  const savedVoice =
    saved.voice && typeof saved.voice === "object" ? saved.voice : {};
  const savedSocials =
    saved.socials && typeof saved.socials === "object" ? saved.socials : undefined;
  const savedDaemon =
    saved.daemon && typeof saved.daemon === "object" ? saved.daemon : {};
  const savedOpenAIEndpoint =
    saved.openaiEndpoint && typeof saved.openaiEndpoint === "object"
      ? saved.openaiEndpoint
      : undefined;

  return {
    ...DEFAULT_CONFIG,
    ...saved,
    personas: {
      ...DEFAULT_CONFIG.personas,
      ...savedPersonas,
    },
    voice: {
      ...DEFAULT_CONFIG.voice,
      ...savedVoice,
    },
    ...(savedSocials ? { socials: savedSocials } : {}),
    daemon: {
      ...DEFAULT_DAEMON_CONFIG,
      ...savedDaemon,
    },
    openaiEndpoint: resolveOpenAIEndpointConfig(savedOpenAIEndpoint),
  };
}

export class ConfigManager {
  private configPath: string;
  private config: Config;

  constructor(dataDir: string) {
    this.configPath = `${dataDir}/config.json`;
    this.config = this.load();
  }

  private load(): Config {
    try {
      const raw = readFileSync(this.configPath, "utf-8");
      const saved = JSON.parse(raw) as Partial<Config>;
      return mergeConfig(saved);
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private save() {
    // Atomic: save() runs on every mutation, and a crash mid-write would
    // otherwise truncate config.json and lose personas + settings.
    writeJsonAtomicSync(this.configPath, this.config);
  }

  // --- Persona ---

  getActivePersona(): Persona {
    return (
      this.config.personas[this.config.activePersona] ||
      this.config.personas.choomfie ||
      { name: "Choomfie", personality: "Be casual, friendly, and fun." }
    );
  }

  getActivePersonaKey(): string {
    return this.config.activePersona;
  }

  switchPersona(key: string): Persona | null {
    const persona = this.config.personas[key.toLowerCase()];
    if (!persona) return null;
    this.config.activePersona = key.toLowerCase();
    this.save();
    return persona;
  }

  savePersona(key: string, name: string, personality: string) {
    this.config.personas[key.toLowerCase()] = { name, personality };
    this.save();
  }

  deletePersona(key: string): boolean {
    const k = key.toLowerCase();
    if (k === this.config.activePersona) return false; // can't delete active
    if (!this.config.personas[k]) return false;
    delete this.config.personas[k];
    this.save();
    return true;
  }

  listPersonas(): Array<{ key: string; persona: Persona; active: boolean }> {
    return Object.entries(this.config.personas).map(([key, persona]) => ({
      key,
      persona,
      active: key === this.config.activePersona,
    }));
  }

  // --- Settings ---

  getRateLimitMs(): number {
    return this.config.rateLimitMs;
  }

  setRateLimitMs(ms: number) {
    this.config.rateLimitMs = ms;
    this.save();
  }

  getConvoTimeoutMs(): number {
    return this.config.convoTimeoutMs || 5 * 60 * 1000;
  }

  setConvoTimeoutMs(ms: number) {
    this.config.convoTimeoutMs = ms;
    this.save();
  }

  getAutoSummarize(): boolean {
    return this.config.autoSummarize;
  }

  setAutoSummarize(enabled: boolean) {
    this.config.autoSummarize = enabled;
    this.save();
  }

  // --- Voice ---

  getVoiceConfig(): VoiceConfig {
    return this.config.voice || { stt: "auto", tts: "auto" };
  }

  setVoiceConfig(voice: Partial<VoiceConfig>) {
    this.config.voice = { ...this.config.voice, ...voice };
    this.save();
  }

  // --- Plugins ---

  getEnabledPlugins(): string[] {
    return this.config.plugins || [];
  }

  setEnabledPlugins(names: string[]) {
    this.config.plugins = names;
    this.save();
  }

  // --- Socials ---

  getSocialsConfig(): SocialsConfig | undefined {
    return this.config.socials;
  }

  // --- Daemon ---

  getDaemonConfig(): DaemonConfig {
    return {
      ...DEFAULT_DAEMON_CONFIG,
      ...this.config.daemon,
    };
  }

  setDaemonConfig(daemon: Partial<DaemonConfig>) {
    this.config.daemon = {
      ...this.getDaemonConfig(),
      ...daemon,
    };
    this.save();
  }

  // --- OpenAI-compatible endpoint ---

  getOpenAIEndpointConfig(): OpenAIEndpointConfig {
    return resolveOpenAIEndpointConfig(this.config.openaiEndpoint);
  }

  // --- Full config ---

  getConfig(): Config {
    return { ...this.config };
  }
}
