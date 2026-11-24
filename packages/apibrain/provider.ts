/**
 * The contract an API provider implements — pure data. One small file per
 * provider (plugins/free/providers/), so a new free tier is a few lines and
 * a model change is a config edit, never a code change.
 */

/** Rough free-tier allowance per key. The provider's own rate-limit headers win when it sends them. */
export interface Limits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

/** One entry from a provider's `/models`. */
export interface ModelInfo {
  id: string;
  /** Per-token prices as the provider reports them (OpenRouter): both 0 = free. */
  pricing?: { prompt?: number; completion?: number };
  contextLength?: number;
  /** Takes images, per the provider's own listing. */
  vision?: boolean;
  /** Answers in text, per the listing's output types (false: an image or audio model). */
  chat?: boolean;
  /** The provider's own tier label for the model (LLM7: "turbo" is the keyless free tier). */
  tier?: string;
}

export interface ApiProviderSpec {
  /** Brain id (`/brain <id>`), config key, health and quota unit. Lowercase, no spaces. */
  id: string;
  label: string;
  /**
   * OpenAI-compatible base URL (without `/chat/completions`). `{name}`
   * placeholders are filled from `vars` (Cloudflare's account id).
   */
  baseURL: string;
  /** Placeholder → env var, e.g. `{ accountId: "CLOUDFLARE_ACCOUNT_ID" }`. */
  vars?: Record<string, string>;
  /**
   * Env var holding the key. `<KEY>_2`, `<KEY>_3`… are pooled with it: each
   * key is its own capacity unit with its own cooldown and quota.
   */
  keyEnv?: string;
  /** Needs no key: an anonymous free tier, or a local server. */
  noKey?: boolean;
  /** Only used when config enables it (`free.providers.<id>.enabled: true`): a local server that may not be running. */
  optIn?: boolean;
  /** Where the model list lives when it isn't `<baseURL>/models` (Cohere lists on its native API). */
  modelsURL?: string;
  /** One line for `apibrain keys`: what the free tier gives, and its catch (prompt logging, phone check…). */
  note?: string;
  /** Env var that overrides `baseURL` (a local server on another port). */
  baseURLEnv?: string;
  /**
   * Only for a provider that can't list its models (`listsModels: false`):
   * what to try. Everyone else's models come from their live `/models`, so
   * no model id goes stale in code. config.json `free.providers.<id>.models`
   * pins a list for any provider.
   */
  fallbackModels?: string[];
  /**
   * Free models the provider serves but leaves out of its `/models` (Z.ai's
   * older GLM flash models). Tried alongside the listed ones; one that stops
   * answering is probed out like any other.
   */
  unlistedModels?: string[];
  /** IANA zone its daily limits reset in (Gemini: Pacific midnight). Default UTC. */
  resetTimeZone?: string;
  /**
   * May this model be called on the free path? Default: every model (the key
   * is a free-tier key). OpenRouter overrides it: only `:free` or zero-priced.
   */
  isFree?(model: string, info?: ModelInfo): boolean;
  /** Takes images. Default: none do. */
  vision?(model: string): boolean;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Input budget to keep prompts under (free tiers often cap tokens per minute far below the context window). */
  contextTokens?: number;
  limits?: Limits;
  /**
   * What the limits count against: the whole key (OpenRouter's free models
   * share one allowance) or each model on a key (Groq). Default "key".
   */
  limitScope?: "key" | "model";
  /** Has an OpenAI-style `GET /models`. Default true. */
  listsModels?: boolean;
  /** Wire protocol. Only "openai" today; the seam for a provider that isn't OpenAI-compatible. */
  protocol?: "openai";
  /** Where to get a key (shown when none is set). */
  signup?: string;
}

export function defineProvider(spec: ApiProviderSpec): ApiProviderSpec {
  if (!/^[a-z0-9-]+$/.test(spec.id)) throw new Error(`provider id "${spec.id}": lowercase letters, digits and dashes only`);
  if (spec.optIn && !spec.noKey) throw new Error(`provider ${spec.id}: optIn is for keyless providers (a keyed one is on when its key is set)`);
  if (!spec.noKey && !spec.keyEnv) throw new Error(`provider ${spec.id}: needs keyEnv (or noKey)`);
  return { protocol: "openai", listsModels: true, ...spec };
}

/** The base URL with its placeholders filled, or null when one is missing from the env. */
export function resolveBaseURL(spec: ApiProviderSpec, env: Record<string, string | undefined>): string | null {
  let url = (spec.baseURLEnv && env[spec.baseURLEnv]) || spec.baseURL;
  for (const [name, envVar] of Object.entries(spec.vars ?? {})) {
    const value = env[envVar];
    if (!value) return null;
    url = url.replaceAll(`{${name}}`, encodeURIComponent(value));
  }
  return url.replace(/\/+$/, "");
}

export function modelIsFree(spec: ApiProviderSpec, model: string, info?: ModelInfo): boolean {
  return spec.isFree ? spec.isFree(model, info) : true;
}

export function modelHasVision(spec: ApiProviderSpec, model: string, info?: ModelInfo): boolean {
  if (info?.vision !== undefined) return info.vision;
  return spec.vision ? spec.vision(model) : false;
}
