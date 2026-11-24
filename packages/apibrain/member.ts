/**
 * One API provider, ready to answer: its keys, models, health and quota
 * behind a single `complete()`. Picks a model and a key that are healthy and
 * under quota, and on failure moves to the next key or model by what kind of
 * failure it was. Throws when nothing on this provider can answer, so the
 * router moves on to the next provider.
 */

import type { Availability } from "./availability.ts";
import { nowIso, redact, type CallEntry, type CallLog } from "./calllog.ts";
import { chatCompletion, listModels, type ChatMessage, type FetchLike } from "./client.ts";
import { Catalog } from "./catalog.ts";
import { ProviderError } from "./errors.ts";
import { COOLDOWN_MS, Health, shortDuration } from "./health.ts";
import { discoverKeys, KeyPool, type ApiKey } from "./keys.ts";
import { describeModel, score, type ModelTraits, type Need } from "./models.ts";
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
  /** Where every request and reply is written (`apibrain log`). */
  log?: CallLog;
  /** What each listed model did when tried; without it, every listed model is taken on trust. */
  availability?: Availability;
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
  /** For the call log. */
  purpose?: CallEntry["purpose"];
  chatId?: string;
}

export interface Completion {
  text: string;
  model: string;
  usage?: { prompt: number; completion: number };
}

const DEFAULT_CONTEXT_TOKENS = 8_000;
const CATALOG_MAX_AGE_MS = 6 * 3_600_000;
/** A daily allowance under this (all keys together) is kept for what needs it. */
const SCARCE_RPD = 200;
/** Score cost of a model that hasn't answered yet (about one size class). */
const UNTESTED_PENALTY = 1.5;
const PROBE: ChatMessage[] = [{ role: "user", content: "Reply with the word: ok" }];

const asProviderError = (e: unknown): ProviderError =>
  e instanceof ProviderError ? e : new ProviderError("server", e instanceof Error ? e.message : String(e));

export class ApiMember {
  readonly kind = "api" as const;
  readonly keys: KeyPool;
  readonly baseURL: string | null;
  readonly catalog = new Catalog();
  private readonly fetchImpl: FetchLike;
  /** Average answer time per model, as measured. */
  private latency = new Map<string, number>();
  private refreshing: Promise<void> | null = null;

  constructor(
    readonly spec: ApiProviderSpec,
    private deps: ApiMemberDeps
  ) {
    this.baseURL = deps.overrides?.baseURL?.replace(/\/+$/, "") || resolveBaseURL(spec, deps.env);
    const keys: ApiKey[] = spec.noKey ? [{ unit: `${spec.id}#1`, n: 1, value: "" }] : discoverKeys(spec.id, spec.keyEnv!, deps.env);
    this.keys = new KeyPool(keys);
    this.fetchImpl = deps.fetch ?? fetch;
    if (spec.resetTimeZone) deps.quota.zone(spec.id, spec.resetTimeZone);
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

  /** Models to try, best first: config's pins in their order, otherwise the strongest listed. */
  models(): string[] {
    return this.ranked("strong").map((m) => m.id);
  }

  /** This provider's usable models, best first for a need. Pinned models keep config's order. */
  ranked(need: Need): ModelTraits[] {
    const pinned = this.deps.overrides?.models;
    const all = this.catalog.candidates(this.spec, pinned).filter((m) => !this.deps.availability?.refused(this.modelUnit(m.id)));
    if (pinned?.length) return all.filter((m) => this.score(m, need) > -Infinity);
    return all
      .map((m) => [m, this.score(m, need)] as const)
      .filter(([, s]) => s > -Infinity)
      .sort((a, b) => b[1] - a[1])
      .map(([m]) => m);
  }

  score(m: ModelTraits, need: Need): number {
    const base = score(m, need, { scarce: this.scarce, latencyMs: this.latency.get(m.id), contextTokens: this.contextTokens });
    // A model seen answering beats one only known by its name.
    const seen = this.deps.availability?.get(this.modelUnit(m.id))?.ok;
    return base - (this.deps.availability && !seen ? UNTESTED_PENALTY : 0);
  }

  traits(model: string): ModelTraits | undefined {
    return this.catalog.candidates(this.spec, this.deps.overrides?.models).find((m) => m.id === model);
  }

  describe(model: string): string {
    const t = this.traits(model);
    const ms = this.latency.get(model);
    return [t ? describeModel(t) : "", ms ? `~${(ms / 1000).toFixed(1)}s` : ""].filter(Boolean).join(" · ");
  }

  /** Its daily allowance is small: used for what needs it, not small talk. */
  get scarce(): boolean {
    const rpd = this.limits.rpd;
    return rpd !== undefined && rpd * Math.max(1, this.keys.size) < SCARCE_RPD;
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
        const started = Date.now();
        const entry = (fields: Partial<CallEntry>): CallEntry => ({
          type: "call",
          at: nowIso(),
          purpose: opts.purpose ?? "other",
          ...(opts.chatId ? { chat: opts.chatId } : {}),
          provider: this.id,
          key: key.n,
          model,
          ms: Date.now() - started,
          ok: false,
          messages: redact(messages),
          ...fields,
        });
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
          this.deps.log?.write(entry({ ok: true, reply: r.text, ...(r.usage ? { usage: r.usage } : {}) }));
          this.deps.availability?.mark(this.modelUnit(model), true);
          const took = Date.now() - started;
          const avg = this.latency.get(model);
          this.latency.set(model, avg === undefined ? took : avg * 0.7 + took * 0.3);
          health.ok(key.unit);
          health.ok(this.modelUnit(model));
          quota.record(scope, (r.usage?.prompt ?? opts.tokens ?? 0) + (r.usage?.completion ?? 0), r.rate);
          return { text: r.text, model: r.model || model, ...(r.usage ? { usage: r.usage } : {}) };
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          const pe = asProviderError(e);
          this.deps.log?.write(entry({ error: `${pe.kind}: ${pe.message.slice(0, 300)}` }));
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
            case "not_free":
              health.cool(this.modelUnit(model), COOLDOWN_MS[pe.kind]!, pe.kind === "not_free" ? "not on the free plan" : "model gone");
              this.deps.availability?.mark(this.modelUnit(model), false, pe.kind === "not_free" ? "not on the free plan" : "gone");
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

  /**
   * Try each listed model nobody has tried yet with one tiny request, spaced
   * to the provider's per-minute limit, so ranking knows which really answer.
   * Returns what was learned, for the doctor.
   */
  async probe(opts: { signal?: AbortSignal; onResult?: (model: string, ok: boolean, why: string) => void } = {}): Promise<void> {
    const av = this.deps.availability;
    if (!av || !this.configured) return;
    // Per-model limits: models don't share a budget, so only a polite second between them.
    const gap = this.limits.rpm && this.spec.limitScope !== "model" ? Math.ceil(60_000 / this.limits.rpm) : 1_000;
    const todo = this.catalog.candidates(this.spec, this.deps.overrides?.models).filter((m) => av.untested(this.modelUnit(m.id)));
    for (const [i, m] of todo.entries()) {
      if (opts.signal?.aborted) return;
      if (i) await new Promise((r) => setTimeout(r, gap));
      try {
        await this.complete(PROBE, { model: m.id, maxTokens: 200, temperature: 0, timeoutMs: 30_000, purpose: "probe", signal: opts.signal });
        opts.onResult?.(m.id, true, "answers");
      } catch (e) {
        const kind = e instanceof ProviderError ? e.kind : String(e);
        // Refusing a plain "say ok" means it isn't a chat model we can use (an agent, a special endpoint).
        if (kind === "bad_request") av.mark(this.modelUnit(m.id), false, "refused a plain chat request");
        opts.onResult?.(m.id, false, kind);
        // The key itself is out (bad, or its shared allowance spent): the rest would fail the same way.
        if (kind === "auth" || (this.spec.limitScope !== "model" && (kind === "rate_limit" || kind === "quota"))) return;
      }
    }
  }

  /** Resolves once a model list has been tried (at most one fetch in flight). */
  ready(): Promise<void> {
    if (this.catalog.known || !this.configured || this.spec.listsModels === false) return Promise.resolve();
    return (this.refreshing ??= this.refreshCatalog().finally(() => (this.refreshing = null)));
  }

  /** Fetch the model list if it's missing or a few hours old. Failures leave the old list. */
  async refreshCatalog(force = false): Promise<void> {
    if (!this.configured || this.spec.listsModels === false) return;
    if (!force && this.catalog.known && !this.catalog.stale(CATALOG_MAX_AGE_MS)) return;
    const key = this.keys.keys[0];
    try {
      this.catalog.set(await listModels(this.baseURL!, key.value || undefined, this.spec.headers, this.fetchImpl, 15_000, this.spec.modelsURL));
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
    const { requests, tokens } = this.deps.quota.providerToday(this.id);
    const rpd = this.limits.rpd;
    // Per-model limits (Groq, Gemini) are per model: the cap shown is one model's.
    const cap = rpd ? `/${rpd * this.keys.size}${this.spec.limitScope === "model" ? " per model" : ""}` : "";
    const today = ` · ${requests}${cap} requests today${tokens ? `, ${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens` : ""}`;
    const keys = this.spec.noKey ? "" : ` · ${this.keys.size} key${this.keys.size === 1 ? "" : "s"}`;
    return `• **${this.label}** — ${state}${keys}${today} · ${this.models()[0] ?? "no models"}`;
  }
}

/** At most this many models from one provider in a ranked list (they share its quota and its outages). */
const PER_PROVIDER = 3;

/**
 * The best targets for a need across providers, best first: each provider's
 * own ranking, merged by score. Unconfigured providers and ones with no list
 * yet add nothing.
 */
export function rankAcross(members: Iterable<ApiMember>, need: Need, limit = 8): { member: string; model: string }[] {
  const all: { member: string; model: string; score: number }[] = [];
  for (const m of members) {
    if (!m.configured) continue;
    for (const t of m.ranked(need).slice(0, PER_PROVIDER)) all.push({ member: m.id, model: t.id, score: m.score(t, need) });
  }
  return all
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ member, model }) => ({ member, model }));
}
