/**
 * config.json `free` — how the free brain routes. Everything is optional;
 * anything missing or invalid falls back to the defaults in buckets.ts
 * (with a warning on stderr), so a typo never takes the brain down.
 *
 * Keys are never here: they live in the data dir's `.env`.
 */

import type { Limits, MemberOverrides } from "@choomfie/apibrain";
import { BUCKETS, DEFAULT_PRIORITY, type Bucket } from "./buckets.ts";

export type Strategy = "smart" | "priority";

export interface ProviderSettings extends MemberOverrides {
  /** false: never use it. For a keyless (local) provider, true is what turns it on. */
  enabled?: boolean;
}

export interface FreeConfig {
  /** smart: classify, then the bucket's targets. priority: always `priority`, in order. */
  strategy: Strategy;
  priority: string[];
  /** Buckets; one config pinned has `targets`, `@bucket` references expanded. */
  buckets: Bucket[];
  classifier: {
    /** zero-shot: a fast model classifies. keywords: regex rules only (no calls). */
    type: "zero-shot" | "keywords";
    /** Pinned classifier models; otherwise the smallest quick ones listed (need "tiny"). */
    targets?: string[];
    /**
     * How sure (0–1) the classifier must be, mid-chat, before a reply offers
     * to hand the chat to a web brain ("Hand this to Waymond").
     */
    suggestAt: number;
    /** Prompts over this many tokens are `long`. */
    longTokens: number;
    /**
     * Local embeddings stage, before the zero-shot call (Ollama). `false`
     * turns it off. Below `sureAt` the zero-shot model decides.
     */
    embeddings: false | { model: string; url?: string; sureAt: number };
  };
  /** Pinned summary models; otherwise need "fast". */
  summaryTargets?: string[];
  providers: Record<string, ProviderSettings>;
  /** Add "-# via Groq · model" under each answer. */
  footer: boolean;
  /** Cap on any API model's input budget (each provider has its own default). */
  contextTokens?: number;
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim() !== "");
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : undefined;

/** Expand `@bucket` references (one level deep is plenty; cycles are cut). */
export function expandTargets(targets: string[], byId: Map<string, string[]>, seen = new Set<string>()): string[] {
  return targets.flatMap((t) => {
    if (!t.startsWith("@")) return [t];
    const ref = t.slice(1);
    if (seen.has(ref) || !byId.has(ref)) return [];
    return expandTargets(byId.get(ref)!, byId, new Set([...seen, ref]));
  });
}

function parseLimits(v: unknown): Limits | undefined {
  if (!isRecord(v)) return undefined;
  const out: Limits = {};
  for (const k of ["rpm", "rpd", "tpm", "tpd"] as const) {
    const n = num(v[k], 0, 1e12);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function parseEmbeddings(v: unknown): FreeConfig["classifier"]["embeddings"] {
  if (v === false) return false;
  const e = isRecord(v) ? v : {};
  return {
    model: typeof e.model === "string" && e.model ? e.model : "nomic-embed-text",
    ...(typeof e.url === "string" && /^https?:\/\//.test(e.url) ? { url: e.url } : {}),
    sureAt: num(e.sureAt, 0, 1) ?? 0.8,
  };
}

export function parseFreeConfig(raw: unknown, warn: (msg: string) => void = (m) => console.error(`[free] config: ${m}`)): FreeConfig {
  const c = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) warn("`free` should be an object — using defaults");

  const strategy: Strategy = c.strategy === "priority" ? "priority" : "smart";
  if (c.strategy !== undefined && c.strategy !== "smart" && c.strategy !== "priority") warn(`unknown strategy ${JSON.stringify(c.strategy)} — using smart`);

  const priority = isStringList(c.priority) ? c.priority : DEFAULT_PRIORITY;
  if (c.priority !== undefined && !isStringList(c.priority)) warn("`priority` should be a list of targets");

  const overrides = isRecord(c.buckets) ? c.buckets : {};
  for (const [id, v] of Object.entries(overrides)) {
    if (!BUCKETS.some((b) => b.id === id)) warn(`unknown bucket "${id}" — buckets are ${BUCKETS.map((b) => b.id).join(", ")}`);
    else if (!isStringList(v)) warn(`bucket "${id}" should be a list of targets`);
  }
  const pins = new Map(BUCKETS.flatMap((b) => (isStringList(overrides[b.id]) ? [[b.id, overrides[b.id] as string[]] as const] : [])));
  const buckets = BUCKETS.map((b) => (pins.has(b.id) ? { ...b, targets: expandTargets(pins.get(b.id)!, pins) } : { ...b }));

  const cl = isRecord(c.classifier) ? c.classifier : {};
  const classifier: FreeConfig["classifier"] = {
    type: cl.type === "keywords" ? "keywords" : "zero-shot",
    ...(isStringList(cl.targets) ? { targets: cl.targets } : typeof cl.target === "string" ? { targets: [cl.target] } : {}),
    suggestAt: num(cl.suggestAt, 0, 1) ?? 0.75,
    longTokens: num(cl.longTokens, 500, 1e7) ?? 6_000,
    embeddings: parseEmbeddings(cl.embeddings),
  };

  const providers: Record<string, ProviderSettings> = {};
  for (const [id, v] of Object.entries(isRecord(c.providers) ? c.providers : {})) {
    if (!isRecord(v)) {
      warn(`providers.${id} should be an object`);
      continue;
    }
    providers[id] = {
      ...(typeof v.enabled === "boolean" ? { enabled: v.enabled } : {}),
      ...(isStringList(v.models) ? { models: v.models } : {}),
      ...(typeof v.baseURL === "string" && /^https?:\/\//.test(v.baseURL) ? { baseURL: v.baseURL } : {}),
      ...(parseLimits(v.limits) ? { limits: parseLimits(v.limits) } : {}),
      ...(num(v.contextTokens, 500, 2e6) ? { contextTokens: num(v.contextTokens, 500, 2e6) } : {}),
    };
  }

  return {
    strategy,
    priority,
    buckets,
    classifier,
    ...(isStringList(c.summaryTargets) ? { summaryTargets: c.summaryTargets } : {}),
    providers,
    footer: c.footer === true,
    ...(num(c.contextTokens, 500, 2e6) ? { contextTokens: num(c.contextTokens, 500, 2e6) } : {}),
  };
}
