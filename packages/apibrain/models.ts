/**
 * Which model for which need — worked out from each provider's live model
 * list, never from a list in code. Providers rename and retire models every
 * few weeks; anything that names a model goes stale. So:
 *
 *   - candidates are the chat models a provider lists right now (no embedders,
 *     speech, image or guard models), newest version of each family only;
 *   - their traits come from the listing (context, vision, price) and the id
 *     itself (`120b`, `a55b`, `flash-lite`, `pro`);
 *   - a need (fast, strong, vision, long, tiny) turns traits into an order,
 *     nudged by what we've seen: measured latency, and scarce daily quotas
 *     kept for when they matter.
 *
 * Config can still pin models (`free.providers.<id>.models`) and the doctor
 * shows what was picked. Measured quality (benchmarks, 👍/👎) slots in as one
 * more term of `score` later.
 */

import type { ModelInfo } from "./provider.ts";

export type Need = "fast" | "strong" | "vision" | "long" | "tiny";
export const NEEDS: Need[] = ["fast", "strong", "vision", "long", "tiny"];

export interface ModelTraits {
  id: string;
  /** Total parameters in billions, from the id or estimated from its tier word. */
  params: number;
  /** True when `params` came from the id, not a guess. */
  sized: boolean;
  tier?: "small" | "mid" | "big";
  vision: boolean;
  contextLength?: number;
  preview: boolean;
  /** The id with its version number blanked: `gemini-#-flash`. */
  family: string;
  version: number;
  /** A moving alias (`-latest`) rather than a release. */
  alias: boolean;
}

/** Words in an id that mean "not a chat model". */
const NOT_CHAT = new Set([
  "embed", "embedding", "embeddings", "whisper", "tts", "speech", "transcribe", "transcription", "audio", "guard", "safeguard",
  "moderation", "rerank", "reranker", "retriever", "orpheus", "image", "imagen", "veo", "lyria", "music", "aqa", "robotics",
  "computer", "live", "banana", "research", "ocr", "clip", "playai", "diffusion", "flux", "sdxl", "video", "bge", "kokoro",
  "chatterbox", "kling", "voxtral", "riva", "nvr", "asr", "vad", "translate", "summarise", "summarize",
]);
/** Inside a run-together token too (`qwen3guard`, `bgem3`). */
const NOT_CHAT_PARTS = ["guard", "embed", "whisper", "tts", "diffusion", "rerank"];
const SMALL = new Set(["lite", "mini", "nano", "instant", "tiny", "small", "micro", "haiku"]);
const MID = new Set(["flash", "medium", "turbo", "air"]);
const BIG = new Set(["pro", "ultra", "large", "max", "opus", "plus", "maverick"]);
const GUESS: Record<NonNullable<ModelTraits["tier"]>, number> = { small: 12, mid: 80, big: 300 };
const UNKNOWN_PARAMS = 40;

const tokens = (id: string) => id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Can it hold a conversation? Judged from the listing when it says, otherwise from the id. */
export function isChatModel(id: string, info?: ModelInfo): boolean {
  if (info?.chat === false) return false;
  return !tokens(id).some((t) => NOT_CHAT.has(t) || NOT_CHAT_PARTS.some((p) => t.includes(p)));
}

/** Billions of parameters named in an id: `120b`, `8x7b`, `e4b`, `500m`. Active (`a55b`) is skipped. */
function namedParams(id: string): number | undefined {
  const s = id.toLowerCase();
  const moe = /(?<![a-z0-9.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(s);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  let best: number | undefined;
  for (const m of s.matchAll(/(?<![a-z0-9.])(a|e)?(\d+(?:\.\d+)?)([bm])(?![a-z0-9])/g)) {
    if (m[1] === "a") continue; // active parameters of a mixture-of-experts
    const n = Number(m[2]) / (m[3] === "m" ? 1000 : 1);
    best = Math.max(best ?? 0, n);
  }
  return best;
}

export function modelTraits(id: string, info?: ModelInfo, vision = false): ModelTraits {
  const lower = id.toLowerCase();
  const words = tokens(id);
  const tier = words.some((w) => SMALL.has(w)) ? "small" : words.some((w) => BIG.has(w)) ? "big" : words.some((w) => MID.has(w)) ? "mid" : undefined;
  const named = namedParams(id);
  const alias = /(^|[-/])latest($|[-:])/.test(lower) || lower === "openrouter/free";
  const preview = /preview|exp(erimental)?\b|-exp-|beta/.test(lower);
  // The version: the first number that isn't a size, a date or a build suffix.
  const bare = lower
    .replace(/:free$/, "")
    .replace(/-(preview|exp|experimental)(-[a-z0-9-]*)?$/, "")
    .replace(/-\d{2,4}(-\d{2}){1,2}$/, "")
    .replace(/-\d{3,4}$/, "")
    .replace(/(^|[-/])latest$/, "");
  const sizeRe = /(?<![a-z0-9.])(\d+x)?[ae]?\d+(\.\d+)?[bm](?![a-z0-9])/g;
  const versionMatch = /(\d+(?:\.\d+)?)/.exec(bare.replace(sizeRe, (m) => "§".repeat(m.length)));
  const version = versionMatch ? Number(versionMatch[1]) : 0;
  const family = versionMatch ? `${bare.slice(0, versionMatch.index)}#${bare.slice(versionMatch.index + versionMatch[1].length)}` : bare;
  return {
    id,
    params: named ?? (tier ? GUESS[tier] : UNKNOWN_PARAMS),
    sized: named !== undefined,
    ...(tier ? { tier } : {}),
    vision,
    ...(info?.contextLength ? { contextLength: info.contextLength } : {}),
    preview,
    family,
    version,
    alias,
  };
}

/**
 * One model per family: the newest version, a release over a preview, a
 * release over a moving alias. `gemini-2.5-flash` goes once `gemini-3.8-flash`
 * is listed; `gpt-oss-20b` and `gpt-oss-120b` are different families.
 */
export function newestOnly(models: ModelTraits[]): ModelTraits[] {
  const best = new Map<string, ModelTraits>();
  const rank = (m: ModelTraits) => [m.version, m.preview ? 0 : 1, m.alias ? 0 : 1];
  const better = (a: ModelTraits, b: ModelTraits) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
    return a.id.length < b.id.length;
  };
  for (const m of models) {
    const cur = best.get(m.family);
    if (!cur || better(m, cur)) best.set(m.family, m);
  }
  // An alias goes when a release of its line is listed (`gemini-flash-latest` beside `gemini-3.8-flash`).
  const line = (f: string) => f.replace(/#-|-#|#/, "");
  const released = new Set([...best.values()].filter((m) => !m.alias).map((m) => line(m.family)));
  return [...best.values()].filter((m) => !m.alias || !released.has(line(m.family)));
}

export interface ScoreContext {
  /** The provider's daily allowance is small (OpenRouter's 50): keep it for what needs it. */
  scarce: boolean;
  /** Measured average answer time, when known. */
  latencyMs?: number;
  /** The input budget the provider gets (for `long`). */
  contextTokens: number;
}

const log2 = Math.log2;

/** Higher is better; -Infinity = not for this need. */
export function score(m: ModelTraits, need: Need, c: ScoreContext): number {
  const strength = log2(Math.max(1, m.params)) - (m.preview ? 0.3 : 0);
  const speed = c.latencyMs === undefined ? 0 : -Math.min(3, c.latencyMs / 4_000);
  switch (need) {
    case "strong":
      return strength + speed * 0.3 - (c.scarce ? 0.2 : 0);
    case "fast":
      // Good enough to chat (around 70B), quick, and not on a scarce quota.
      return Math.min(strength, log2(80)) - (m.params > 200 ? 1 : 0) + speed - (c.scarce ? 2 : 0);
    case "tiny":
      // The classifier and summaries: small, quick, plentiful. Not so small it can't follow a format.
      return -Math.abs(log2(Math.max(1, m.params)) - log2(20)) + speed * 2 - (c.scarce ? 4 : 0) - (m.params < 3 ? 2 : 0);
    case "vision":
      return m.vision ? strength + speed * 0.3 - (c.scarce ? 0.5 : 0) : -Infinity;
    case "long":
      return log2(c.contextTokens) * 2 + strength * 0.5 - (c.scarce ? 0.5 : 0);
  }
}

/** "~120B · sees images · 131k context" — for `/model` and the doctor. */
export function describeModel(m: ModelTraits): string {
  const size = m.sized ? `${m.params >= 10 ? Math.round(m.params) : m.params}B` : m.tier ? `${m.tier} tier` : "";
  const ctx = m.contextLength ? `${m.contextLength >= 1_000_000 ? `${Math.round(m.contextLength / 1_000_000)}M` : `${Math.round(m.contextLength / 1000)}k`} context` : "";
  return [size, m.vision ? "sees images" : "", ctx, m.preview ? "preview" : ""].filter(Boolean).join(" · ");
}
