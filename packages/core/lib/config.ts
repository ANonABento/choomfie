/**
 * Config manager — personas, settings, presets.
 *
 * Stored in config.json alongside the database.
 * Personas define how the bot behaves (personality, name, tone).
 * Settings control bot behavior (rate limits, triggers, etc.).
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { SocialsPlatformConfig, AutomodAction, AutomodConfig } from "@choomfie/shared";

export type { AutomodAction, AutomodConfig };

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

export interface WelcomeConfig {
  channelId?: string | null;
  template: string;
}

export interface Config {
  activePersona: string;
  personas: Record<string, Persona>;
  rateLimitMs: number;
  convoTimeoutMs: number;
  autoSummarize: boolean;
  plugins: string[];
  voice: VoiceConfig;
  automod: AutomodConfig;
  welcome: WelcomeConfig;
  socials?: SocialsConfig;
  [key: string]: unknown;
}

export const DEFAULT_WELCOME_TEMPLATE = "Welcome {user} to {server}!";

export function normalizeWelcomeTemplate(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_WELCOME_TEMPLATE;
}

function normalizeWelcomeConfig(value: unknown): WelcomeConfig {
  const saved =
    value && typeof value === "object"
      ? (value as Partial<Record<keyof WelcomeConfig, unknown>>)
      : {};
  const channelId =
    typeof saved.channelId === "string" && saved.channelId.trim()
      ? saved.channelId.trim()
      : null;

  return {
    channelId,
    template: normalizeWelcomeTemplate(saved.template),
  };
}

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
  automod: {
    maxMessagesPerMinute: 20,
    bannedWords: [],
    action: "warn",
  },
  welcome: {
    channelId: null,
    template: DEFAULT_WELCOME_TEMPLATE,
  },
};

function normalizeMaxMessagesPerMinute(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_CONFIG.automod.maxMessagesPerMinute;

  const normalized = Math.floor(value);
  if (normalized < 1) return 1;
  if (normalized > 120) return 120;
  return normalized;
}

function normalizeBannedWords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .map((item) => item.toLowerCase())
    .filter((item, idx, arr) => arr.indexOf(item) === idx);
}

function normalizeAutomodAction(raw: unknown): AutomodAction {
  if (raw === "timeout" || raw === "kick" || raw === "warn") return raw;
  return DEFAULT_CONFIG.automod.action;
}

function mergeConfig(saved: Partial<Config>): Config {
  const savedPersonas =
    saved.personas && typeof saved.personas === "object"
      ? saved.personas
      : {};
  const savedVoice =
    saved.voice && typeof saved.voice === "object" ? saved.voice : {};
  const savedAutomod =
    saved.automod && typeof saved.automod === "object" ? saved.automod : {};
  const savedWelcome = normalizeWelcomeConfig(saved.welcome);
  const savedSocials =
    saved.socials && typeof saved.socials === "object" ? saved.socials : undefined;
  const normalizedAutomod = savedAutomod as Partial<AutomodConfig>;

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
    automod: {
      ...DEFAULT_CONFIG.automod,
      ...savedAutomod,
      maxMessagesPerMinute: normalizeMaxMessagesPerMinute(
        normalizedAutomod.maxMessagesPerMinute
      ),
      bannedWords: normalizeBannedWords(normalizedAutomod.bannedWords),
      action: normalizeAutomodAction(normalizedAutomod.action),
    },
    welcome: {
      ...DEFAULT_CONFIG.welcome,
      ...savedWelcome,
    },
    ...(savedSocials ? { socials: savedSocials } : {}),
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
    writeFileSync(
      this.configPath,
      JSON.stringify(this.config, null, 2)
    );
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

  // --- Automod ---

  getAutomodConfig(): AutomodConfig {
    return {
      ...this.config.automod,
      bannedWords: [...this.config.automod.bannedWords],
    };
  }

  setAutomodConfig(raw: Partial<AutomodConfig>) {
    const existing = this.config.automod || { ...DEFAULT_CONFIG.automod };
    this.config.automod = {
      maxMessagesPerMinute: normalizeMaxMessagesPerMinute(
        raw.maxMessagesPerMinute ?? existing.maxMessagesPerMinute
      ),
      bannedWords: normalizeBannedWords(raw.bannedWords ?? existing.bannedWords),
      action: normalizeAutomodAction(raw.action ?? existing.action),
    };
    this.save();
  }

  // --- Welcome messages ---

  getWelcomeConfig(): WelcomeConfig {
    return normalizeWelcomeConfig(this.config.welcome);
  }

  setWelcomeConfig(welcome: Partial<WelcomeConfig>) {
    this.config.welcome = normalizeWelcomeConfig({
      ...this.config.welcome,
      ...welcome,
    });
    this.save();
  }

  // --- Full config ---

  getConfig(): Config {
    return { ...this.config };
  }
}
