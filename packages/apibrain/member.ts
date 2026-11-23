/**
 * One API provider, ready to answer: its keys, models, health and quota
 * behind a single `complete()`. Picks a model and a key that are healthy and
 * under quota, and on failure moves to the next key or model by what kind of
 * failure it was. Throws when nothing on this provider can answer, so the
 * router moves on to the next provider.
 */

import { chatCompletion, listModels, type ChatMessage, type FetchLike } from "./client.ts";
import { Catalog } from "./catalog.ts";
import { ProviderError } from "./errors.ts";
import { COOLDOWN_MS, Health, shortDuration } from "./health.ts";
import { discoverKeys, KeyPool, type ApiKey } from "./keys.ts";
import { modelHasVision, modelIsFree, resolveBaseURL, type ApiProviderSpec, type Limits } from "./provider.ts";
import { Quota } from "./quota.ts";

/** Per-provider settings from config.json (`free.providers.<id>`). */
export interface MemberOverrides {
  /** Replaces the spec's base URL (a local server elsewhere, a proxy). */
  baseURL?: string;
  models?: string[];
  limits?: Limits;
  contextTokens?: number;
}

export interface ApiMemberDeps {
  env: Record<string, string | undefined>;
  health: Health;
  quota: Quota;
  fetch?: FetchLike;
  overrides?: MemberOverrides;
}

export interface CompleteOptions {
  /** This model only; otherwise the provider's models in order. */
  model?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Rough prompt size, for the tokens-per-minute check. */
  tokens?: number;
}

export interface Completion {
  text: string;
  model: string;
  usage?: { prompt: number; completion: number };
}

const DEFAULT_CONTEXT_TOKENS = 8_000;
const CATALOG_MAX_AGE_MS = 24 * 3_600_000;

const asProviderError = (e: unknown): ProviderError =>
  e instanceof ProviderError ? e : new ProviderError("server", e instanceof Error ? e.message : String(e));

export class ApiMember {
  readonly kind = "api" as const;
  readonly keys: KeyPool;
  readonly baseURL: string | null;
  readonly catalog = new Catalog();
  private readonly fetchImpl: FetchLike;

  constructor(
    readonly spec: ApiProviderSpec,
    private deps: ApiMemberDeps
  ) {
    this.baseURL = deps.overrides?.baseURL?.replace(/\/+$/, "") || resolveBaseURL(spec, deps.env);
    const keys: ApiKey[] = spec.noKey ? [{ unit: `${spec.id}#1`, n: 1, value: "" }] : discoverKeys(spec.id, spec.keyEnv!, deps.env);
    this.keys = new KeyPool(keys);
    this.fetchImpl = deps.fetch ?? fetch;
  }

  get id(): string {
    return this.spec.id;
  }

  get label(): string {
    return this.spec.label;
  }

  /** Has what it needs to make a call (a key, and its URL's variables). */
  get configured(): boolean {
    return !!this.baseURL && this.keys.size > 0;
  }

  get limits(): Limits {
    return { ...this.spec.limits, ...this.deps.overrides?.limits };
  }

  get contextTokens(): number {
    return this.deps.overrides?.contextTokens ?? this.spec.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  }

  /** Models to try, best first: the configured ones that exist and are free. */
  models(): string[] {
    return this.catalog.pick(this.deps.overrides?.models ?? this.spec.defaultModels, this.spec);
  }

  vision(model?: string): boolean {
    const m = model ?? this.models()[0] ?? "";
    return modelHasVision(this.spec, m, this.catalog.info(m));
  }

  modelUnit(model: string): string {
    return `${this.id}:${model}`;
  }

  /** What a key's limits count against for this model. */
  scopeUnit(key: ApiKey, model: string): string {
    return this.spec.limitScope === "model" ? `${key.unit}:${model}` : key.unit;
  }

  /** 0 when some model and key can take a call now; otherwise how long until one can. */
  waitMs(model?: string, tokens = 0): number {
    if (!this.configured) return Infinity;
    const { health, quota } = this.deps;
    let best = Infinity;
    for (const m of model ? [model] : this.models()) {
      for (const key of this.keys.keys) {
        const scope = this.scopeUnit(key, m);
        const wait = Math.max(health.waitMs(this.modelUnit(m)), health.waitMs(key.unit), health.waitMs(scope), quota.waitMs(scope, this.limits, tokens));
        if (wait === 0) return 0;
        best = Math.min(best, wait);
      }
    }
    return best;
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<Completion> {
    if (!this.configured) throw new ProviderError("auth", `${this.label} has no key set`);
    const { health, quota } = this.deps;
    const models = opts.model ? [opts.model] : this.models();
    if (!models.length) throw new ProviderError("model_gone", `${this.label} has no free models to use`);
    let last: ProviderError | undefined;

    for (const model of models) {
      if (!modelIsFree(this.spec, model, this.catalog.info(model))) {
        last = new ProviderError("bad_request", `${model} isn't free — refused on the free path`);
        continue;
      }
      if (!health.available(this.modelUnit(model))) continue;
      const usable = (k: ApiKey) => {
        const scope = this.scopeUnit(k, model);
        return health.available(k.unit) && health.available(scope) && quota.hasCapacity(scope, this.limits, opts.tokens ?? 0);
      };
      keys: for (const key of this.keys.order(usable)) {
        const scope = this.scopeUnit(key, model);
        this.keys.used(key);
        try {
          const r = await chatCompletion(
            {
              baseURL: this.baseURL!,
              apiKey: key.value || undefined,
              model,
              messages,
              headers: this.spec.headers,
              maxTokens: opts.maxTokens,
              temperature: opts.temperature,
              signal: opts.signal,
              timeoutMs: opts.timeoutMs,
            },
            this.fetchImpl
          );
          health.ok(key.unit);
          health.ok(this.modelUnit(model));
          quota.record(scope, (r.usage?.prompt ?? opts.tokens ?? 0) + (r.usage?.completion ?? 0), r.rate);
          return { text: r.text, model: r.model || model, ...(r.usage ? { usage: r.usage } : {}) };
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          const pe = asProviderError(e);
          last = pe;
          switch (pe.kind) {
            case "rate_limit":
            case "quota":
              health.cool(scope, pe.retryAfterMs ?? COOLDOWN_MS[pe.kind]!, pe.kind);
              continue keys;
            case "auth":
              health.cool(key.unit, COOLDOWN_MS.auth!, "key rejected");
              continue keys;
            case "model_gone":
              health.cool(this.modelUnit(model), COOLDOWN_MS.model_gone!, "model gone");
              break keys;
            case "server":
            case "timeout":
            case "network":
              health.fail(this.modelUnit(model), pe.kind);
              break keys;
            default: // too_large, bad_request: this model can't take it; another might
              break keys;
          }
        }
      }
    }
    if (last) throw last;
    const wait = this.waitMs(undefined, opts.tokens);
    throw new ProviderError("rate_limit", `${this.label}: every key is cooling down or at its limit`, Number.isFinite(wait) ? wait : undefined);
  }

  /** Fetch the model list if it's missing or a day old. Failures leave the old list (or trust the config). */
  async refreshCatalog(force = false): Promise<void> {
    if (!this.configured || this.spec.listsModels === false) return;
    if (!force && this.catalog.known && !this.catalog.stale(CATALOG_MAX_AGE_MS)) return;
    const key = this.keys.keys[0];
    try {
      this.catalog.set(await listModels(this.baseURL!, key.value || undefined, this.spec.headers, this.fetchImpl));
      const models = this.models();
      if (!models.length) console.error(`[apibrain] ${this.label}: none of its models are listed or free right now`);
    } catch (e) {
      console.error(`[apibrain] ${this.label}: couldn't list models: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** One line for `/brain`: keys, state, today's use. */
  statusLine(): string {
    if (!this.configured) return `• **${this.label}** — no key${this.spec.signup ? ` (${this.spec.signup})` : ""}`;
    const wait = this.waitMs();
    const state = wait === 0 ? "ready" : Number.isFinite(wait) ? `cooling ${shortDuration(wait)}` : "unavailable";
    const used = this.keys.keys.reduce((n, k) => n + this.deps.quota.usage(k.unit).requestsToday, 0);
    const rpd = this.limits.rpd;
    const today = this.spec.limitScope === "model" ? "" : ` · ${used}${rpd ? `/${rpd * this.keys.size}` : ""} today`;
    const keys = this.spec.noKey ? "" : ` · ${this.keys.size} key${this.keys.size === 1 ? "" : "s"}`;
    return `• **${this.label}** — ${state}${keys}${today} · ${this.models()[0] ?? "no models"}`;
  }
}
