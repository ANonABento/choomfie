/**
 * config.json `free` — how the free brain routes. Everything is optional;
 * anything missing or invalid falls back to the defaults in buckets.ts
 * (with a warning on stderr), so a typo never takes the brain down.
 *
 * Keys are never here: they live in the data dir's `.env`.
 */

import type { Limits, MemberOverrides } from "@choomfie/apibrain";
import { BUCKETS, DEFAULT_CLASSIFIER_TARGETS, DEFAULT_PRIORITY, DEFAULT_SUMMARY_TARGETS, type Bucket } from "./buckets.ts";

export type Strategy = "smart" | "priority";

export interface ProviderSettings extends MemberOverrides {
  /** false: never use it. For a keyless (local) provider, true is what turns it on. */
  enabled?: boolean;
}

export interface FreeConfig {
  /** smart: classify, then the bucket's targets. priority: always `priority`, in order. */
  strategy: Strategy;
  priority: string[];
  /** Buckets with their targets, `@bucket` references expanded. */
  buckets: Bucket[];
  classifier: {
    /** zero-shot: a fast model classifies. keywords: regex rules only (no calls). */
    type: "zero-shot" | "keywords";
    targets: string[];
    /**
     * How sure (0–1) the classifier must be, mid-chat, before a reply offers
     * to hand the chat to a web brain ("Hand this to Waymond").
     */
    suggestAt: number;
    /** Prompts over this many tokens are `long`. */
    longTokens: number;
  };
  summaryTargets: string[];
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
  const raw_ = new Map(BUCKETS.map((b) => [b.id, isStringList(overrides[b.id]) ? (overrides[b.id] as string[]) : b.targets]));
  const buckets = BUCKETS.map((b) => ({ ...b, targets: expandTargets(raw_.get(b.id)!, raw_) }));

  const cl = isRecord(c.classifier) ? c.classifier : {};
  const classifier: FreeConfig["classifier"] = {
    type: cl.type === "keywords" ? "keywords" : "zero-shot",
    targets: isStringList(cl.targets) ? cl.targets : typeof cl.target === "string" ? [cl.target, ...DEFAULT_CLASSIFIER_TARGETS] : DEFAULT_CLASSIFIER_TARGETS,
    suggestAt: num(cl.suggestAt, 0, 1) ?? 0.75,
    longTokens: num(cl.longTokens, 500, 1e7) ?? 6_000,
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
    summaryTargets: isStringList(c.summaryTargets) ? c.summaryTargets : DEFAULT_SUMMARY_TARGETS,
    providers,
    footer: c.footer === true,
    ...(num(c.contextTokens, 500, 2e6) ? { contextTokens: num(c.contextTokens, 500, 2e6) } : {}),
  };
}
