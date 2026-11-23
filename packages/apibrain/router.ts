/**
 * Failover across targets. A target is `member[:model]`: an API provider id
 * (optionally pinned to one model) or any registered brain id. The router
 * only orders, skips what's cooling down, and moves on when a call fails;
 * each member keeps its own keys, models and health.
 */

import { AllUnavailableError, ProviderError } from "./errors.ts";

export interface Target {
  member: string;
  model?: string;
}

/** "groq:openai/gpt-oss-20b" → { member: "groq", model: "openai/gpt-oss-20b" }. Model ids may contain ":" (OpenRouter's `:free`). */
export function parseTarget(spec: string): Target {
  const s = spec.trim();
  const at = s.indexOf(":");
  return at === -1 ? { member: s.toLowerCase() } : { member: s.slice(0, at).toLowerCase(), model: s.slice(at + 1) };
}

export function targetKey(t: Target): string {
  return t.model ? `${t.member}:${t.model}` : t.member;
}

/** In order, without repeats. */
export function dedupeTargets(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const k = targetKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface RouteOptions<T> {
  /** 0 when the target can take a call now; ms until it can; Infinity when it can't at all (not loaded, no key). */
  waitMs(target: Target): number;
  attempt(target: Target): Promise<T>;
  signal?: AbortSignal;
}

export interface Routed<T> {
  value: T;
  target: Target;
  latencyMs: number;
  /** What was skipped or failed before this one answered. */
  passed: string[];
}

export async function route<T>(targets: Target[], opts: RouteOptions<T>): Promise<Routed<T>> {
  const passed: string[] = [];
  let soonest = Infinity;
  for (const target of dedupeTargets(targets)) {
    const key = targetKey(target);
    const wait = opts.waitMs(target);
    if (wait > 0) {
      soonest = Math.min(soonest, wait);
      passed.push(`${key}: ${Number.isFinite(wait) ? "cooling down" : "unavailable"}`);
      continue;
    }
    const started = Date.now();
    try {
      const value = await opts.attempt(target);
      return { value, target, latencyMs: Date.now() - started, passed };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      if (e instanceof ProviderError && e.retryAfterMs) soonest = Math.min(soonest, e.retryAfterMs);
      passed.push(`${key}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
  throw new AllUnavailableError(passed, Number.isFinite(soonest) ? soonest : undefined);
}
