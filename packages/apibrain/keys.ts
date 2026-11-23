/**
 * Several keys per provider, pooled. `GROQ_API_KEY`, `GROQ_API_KEY_2`, … in
 * the data dir's `.env` (already loaded into the environment at startup).
 * Each key is its own capacity unit: a 429 benches that key only, and the
 * least recently used key that's healthy and under quota goes next.
 *
 * Only keys the owner legitimately holds — this pools capacity, it doesn't create accounts.
 */

export interface ApiKey {
  /** Unit name for health and quota: `<provider>#<n>`. */
  unit: string;
  /** 1-based, for status lines ("key 2"). Never the key itself. */
  n: number;
  value: string;
}

/** Every key set for this provider: `<ENV>`, then `<ENV>_2`, `<ENV>_3`, … in number order. */
export function discoverKeys(provider: string, keyEnv: string, env: Record<string, string | undefined>): ApiKey[] {
  const numbered = Object.keys(env)
    .map((k) => ({ k, m: new RegExp(`^${keyEnv}_(\\d+)$`).exec(k) }))
    .filter((x): x is { k: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => x.k);
  const values = [keyEnv, ...numbered].map((k) => env[k]?.trim()).filter((v): v is string => !!v);
  return [...new Set(values)].map((value, i) => ({ unit: `${provider}#${i + 1}`, n: i + 1, value }));
}

export class KeyPool {
  private lastUsed = new Map<string, number>();

  constructor(readonly keys: ApiKey[]) {}

  get size(): number {
    return this.keys.length;
  }

  /** Usable keys, least recently used first. */
  order(usable: (key: ApiKey) => boolean): ApiKey[] {
    return this.keys.filter(usable).sort((a, b) => (this.lastUsed.get(a.unit) ?? 0) - (this.lastUsed.get(b.unit) ?? 0));
  }

  used(key: ApiKey, at = Date.now()): void {
    this.lastUsed.set(key.unit, at);
  }
}
