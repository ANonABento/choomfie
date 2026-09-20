/**
 * Adjustable settings registry.
 *
 * Every setting a user should be able to change at runtime is declared here
 * once, with its parser, validator, and what it takes for the change to land.
 * `/config` renders and mutates this list; nothing else needs to know the shape
 * of config.json.
 *
 * Why this exists: `ConfigManager` has had `setRateLimitMs`, `setConvoTimeoutMs`
 * and `setDaemonConfig` for a long time and **nothing ever called them**. The
 * only way to change a rate limit was to hand-edit config.json and restart,
 * even though CLAUDE.md claimed otherwise. A setter with no caller is not a
 * setting.
 *
 * Deliberately not listed here:
 * - `activePersona` / `personas` — `/persona`, `/newpersona`
 * - `plugins` — `/plugins`
 * - `voice` — `/voice`, which auto-detects providers
 * - `autoSummarize` — currently read by nothing; exposing a switch that does
 *   nothing is worse than not having one.
 */

import { AUTOCOMPLETE_LIMIT } from "@choomfie/shared";
import type { ConfigManager } from "./config.ts";

/** When a change takes effect. */
export type SettingScope =
  | "immediately"
  | "next worker restart"
  | "next daemon start"
  /** Read when the `claude` CLI or the daemon session is launched. */
  | "next start";

export type SettingValue = string;

/**
 * The repo compiles with `strict: false`, which disables the narrowing that
 * would let `if (!result.ok)` reveal `error`. Declaring the absent half of each
 * member as `?: undefined` keeps the union honest for readers and lets both
 * properties be read without a cast.
 */
export type ParseResult =
  | { ok: true; value: SettingValue; error?: undefined }
  | { ok: false; error: string; value?: undefined };

export type Setting = {
  /** Stable key — the value used in the `/config` choice list. */
  key: string;
  description: string;
  /** Hint shown to the user for what a valid value looks like. */
  example: string;
  /**
   * Values offered by `/config`'s autocomplete. Suggestions only — `write`
   * still accepts anything valid, so a model id newer than this file is not
   * locked out. Kept static and in-memory: Discord allows 3 seconds and one
   * response for an autocomplete, so there is no room for a lookup.
   */
  suggestions: string[];
  scope: SettingScope;
  /** Current value, formatted for display. */
  read(config: ConfigManager): string;
  /** Validate and apply. Returns the formatted new value. */
  write(config: ConfigManager, raw: string): ParseResult;
};

/** Values that mean "go back to the built-in default". */
const RESET_WORDS = new Set(["default", "reset", "clear", "none", "unset"]);

function isReset(raw: string): boolean {
  return RESET_WORDS.has(raw.trim().toLowerCase());
}

/**
 * Parse a duration as either a bare millisecond count or a suffixed value
 * (`5s`, `2m`, `1h`). Typing `5000` for five seconds is easy to get wrong by an
 * order of magnitude; `5s` is not.
 */
function parseDurationMs(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(text);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  switch (match[2]) {
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return amount;
  }
}

function formatMs(ms: number): string {
  if (ms === 0) return "0ms (off)";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function parseCount(raw: string): number | null {
  const text = raw.trim().replace(/[_,]/g, "");
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function durationSetting(options: {
  key: string;
  description: string;
  example: string;
  suggestions: string[];
  min: number;
  max: number;
  read: (config: ConfigManager) => number;
  write: (config: ConfigManager, ms: number) => void;
}): Setting {
  return {
    key: options.key,
    description: options.description,
    example: options.example,
    suggestions: options.suggestions,
    scope: "immediately",
    read: (config) => formatMs(options.read(config)),
    write: (config, raw) => {
      const ms = parseDurationMs(raw);
      if (ms === null) {
        return { ok: false, error: `Not a duration. Try \`${options.example}\`.` };
      }
      if (ms < options.min || ms > options.max) {
        return {
          ok: false,
          error: `Must be between ${formatMs(options.min)} and ${formatMs(options.max)}.`,
        };
      }
      options.write(config, Math.round(ms));
      return { ok: true, value: formatMs(Math.round(ms)) };
    },
  };
}

function countSetting(options: {
  key: string;
  description: string;
  example: string;
  suggestions: string[];
  min: number;
  max: number;
  fallback: number;
  read: (config: ConfigManager) => number;
  write: (config: ConfigManager, value: number) => void;
}): Setting {
  return {
    key: options.key,
    description: options.description,
    example: options.example,
    suggestions: options.suggestions,
    scope: "next daemon start",
    read: (config) => options.read(config).toLocaleString(),
    write: (config, raw) => {
      if (isReset(raw)) {
        options.write(config, options.fallback);
        return { ok: true, value: options.fallback.toLocaleString() };
      }
      const value = parseCount(raw);
      if (value === null) {
        return { ok: false, error: `Not a whole number. Try \`${options.example}\`.` };
      }
      if (value < options.min || value > options.max) {
        return {
          ok: false,
          error: `Must be between ${options.min.toLocaleString()} and ${options.max.toLocaleString()}.`,
        };
      }
      options.write(config, value);
      return { ok: true, value: value.toLocaleString() };
    },
  };
}

/**
 * Aliases the Agent SDK resolves to the current model in each tier. Offered as
 * suggestions rather than enforced choices: aliases outlive specific model ids,
 * but a full id must stay typeable so a new model is usable the day it ships,
 * without an edit here.
 */
export const MODEL_SUGGESTIONS = ["default", "opus", "sonnet", "haiku"];

/** The setting `/model` is a shortcut for. Must name a Setting in SETTINGS. */
export const MODEL_SETTING_KEY = "model";

function modelSetting(options: {
  key: string;
  description: string;
  read: (config: ConfigManager) => string | undefined;
  write: (config: ConfigManager, model: string | undefined) => void;
}): Setting {
  return {
    key: options.key,
    description: options.description,
    example: "opus, sonnet, haiku, a full model id, or `default`",
    suggestions: MODEL_SUGGESTIONS,
    scope: "next start",
    read: (config) => options.read(config) ?? "Claude Code default",
    write: (config, raw) => {
      if (isReset(raw)) {
        options.write(config, undefined);
        return { ok: true, value: "Claude Code default" };
      }
      const model = raw.trim();
      // Not validated against a list: model ids change faster than this file
      // does, and the SDK reports an unknown one clearly at session start.
      // Length and whitespace are the only things worth rejecting.
      if (!model || /\s/.test(model) || model.length > 100) {
        return {
          ok: false,
          error: "Model must be a single token, e.g. `opus` or `claude-opus-5`.",
        };
      }
      options.write(config, model);
      return { ok: true, value: model };
    },
  };
}

export const SETTINGS: Setting[] = [
  durationSetting({
    key: "rateLimitMs",
    description: "Per-user cooldown between messages Choomfie will answer",
    example: "5s",
    suggestions: ["0", "3s", "5s", "10s", "30s"],
    min: 0,
    max: 5 * 60_000,
    read: (config) => config.getRateLimitMs(),
    write: (config, ms) => config.setRateLimitMs(ms),
  }),
  durationSetting({
    key: "convoTimeoutMs",
    description: "How long a channel stays 'in conversation' after a reply",
    example: "5m",
    suggestions: ["1m", "5m", "15m", "30m", "1h"],
    min: 10_000,
    max: 6 * 3_600_000,
    read: (config) => config.getConvoTimeoutMs(),
    write: (config, ms) => config.setConvoTimeoutMs(ms),
  }),
  modelSetting({
    key: "model",
    description: "Model Choomfie runs on, in every mode",
    read: (config) => config.getModel(),
    write: (config, model) => config.setModel(model),
  }),
  modelSetting({
    key: "fallbackModel",
    description: "Model to fall back to when the primary is overloaded (daemon only)",
    read: (config) => config.getFallbackModel(),
    write: (config, model) => config.setFallbackModel(model),
  }),
  countSetting({
    key: "daemon.tokenThreshold",
    description: "Cycle the daemon session past this much context",
    example: "120000",
    suggestions: ["default", "60000", "120000", "200000", "400000"],
    min: 10_000,
    max: 900_000,
    fallback: 120_000,
    read: (config) => config.getDaemonConfig().tokenThreshold,
    write: (config, value) => config.setDaemonConfig({ tokenThreshold: value }),
  }),
  countSetting({
    key: "daemon.turnThreshold",
    description: "Cycle the daemon session past this many turns",
    example: "80",
    suggestions: ["default", "40", "80", "150", "300"],
    min: 5,
    max: 1000,
    fallback: 80,
    read: (config) => config.getDaemonConfig().turnThreshold,
    write: (config, value) => config.setDaemonConfig({ turnThreshold: value }),
  }),
];

export function findSetting(key: string): Setting | undefined {
  const wanted = key.trim().toLowerCase();
  return SETTINGS.find((setting) => setting.key.toLowerCase() === wanted);
}

/**
 * Suggestions for `setting`, narrowed to what the user has typed so far.
 *
 * Substring rather than prefix matching, so typing "model" finds
 * `daemon.fallbackModel` too. Whatever the user has typed is offered back as
 * the first entry when it isn't already in the list — without it, a valid value
 * that simply isn't in `suggestions` (a brand-new model id) looks rejected,
 * because Discord's picker gives no way to submit free text once a suggestion
 * list is showing.
 */
export function suggestValues(setting: Setting, typed: string): string[] {
  const query = typed.trim().toLowerCase();
  const matches = setting.suggestions.filter((value) =>
    value.toLowerCase().includes(query),
  );
  const typedIsNovel =
    query.length > 0 &&
    !matches.some((value) => value.toLowerCase() === query);

  return (typedIsNovel ? [typed.trim(), ...matches] : matches).slice(
    0,
    AUTOCOMPLETE_LIMIT,
  );
}
