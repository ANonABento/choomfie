/**
 * OpenAI-compatible HTTP client: one chat completion, or the model list.
 *
 * Every provider on the free path speaks this protocol (OpenRouter, Groq,
 * Gemini's compat endpoint, NVIDIA, SambaNova, Cloudflare, Ollama). Failures
 * come back as a `ProviderError` of a known kind, and rate-limit headers as a
 * `RateSnapshot`, whatever dialect the provider uses.
 */

import { ProviderError, type ProviderErrorKind } from "./errors.ts";
import type { ModelInfo } from "./provider.ts";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ChatRequest {
  baseURL: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Give up after this long. Default 120s (big free models can be slow). */
  timeoutMs?: number;
}

/** What the provider said about its limits on this response. All optional: providers differ. */
export interface RateSnapshot {
  remainingRequests?: number;
  remainingTokens?: number;
  /** Milliseconds until the request / token allowance resets. */
  resetRequestsMs?: number;
  resetTokensMs?: number;
  retryAfterMs?: number;
}

export interface ChatResponse {
  text: string;
  /** The model that answered, as the provider names it. */
  model: string;
  usage?: { prompt: number; completion: number };
  rate: RateSnapshot;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** "1h2m3.5s", "250ms", "7.66s", "30" (seconds), or an epoch (s or ms) → milliseconds from now. */
export function parseDuration(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) return Math.max(0, n - now); // epoch ms
    if (n > 1e9) return Math.max(0, n * 1000 - now); // epoch s
    return n * 1000;
  }
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  if (matched) return total;
  const date = Date.parse(v); // HTTP-date retry-after
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const num = (v: string | null) => (v != null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Groq/OpenAI (`x-ratelimit-*-requests`), OpenRouter (`x-ratelimit-remaining`/`-reset`) and `retry-after`. */
export function parseRateHeaders(h: Headers, now = Date.now()): RateSnapshot {
  const snap: RateSnapshot = {
    remainingRequests: num(h.get("x-ratelimit-remaining-requests")) ?? num(h.get("x-ratelimit-remaining")),
    remainingTokens: num(h.get("x-ratelimit-remaining-tokens")),
    resetRequestsMs: parseDuration(h.get("x-ratelimit-reset-requests") ?? h.get("x-ratelimit-reset"), now),
    resetTokensMs: parseDuration(h.get("x-ratelimit-reset-tokens"), now),
    retryAfterMs: parseDuration(h.get("retry-after-ms") ? `${h.get("retry-after-ms")}ms` : h.get("retry-after"), now),
  };
  for (const k of Object.keys(snap) as (keyof RateSnapshot)[]) if (snap[k] === undefined) delete snap[k];
  return snap;
}

/** Map a failed response to a kind the router acts on. `body` is the response text (clipped). */
export function classifyFailure(status: number, body: string, rate: RateSnapshot = {}): ProviderError {
  const text = body.toLowerCase();
  const said = body.replace(/\s+/g, " ").slice(0, 200);
  const make = (kind: ProviderErrorKind, retryAfterMs?: number) =>
    new ProviderError(kind, `${status}${said ? `: ${said}` : ""}`, retryAfterMs, status);
  const daily = /per[ -]day|daily|\brpd\b|\btpd\b|quota|credits|insufficient|billing/.test(text);
  const tooLarge = /context[_ ]length|too (large|long)|maximum context|reduce the length|request too large|max_tokens/.test(text);
  const goneModel =
    /model[_ ]not[_ ]found|decommissioned|deprecated|does not exist|no endpoints found|unknown model|not a valid model|is not supported|invalid model/.test(text);

  // A quota of zero: the model is listed, but not on this (free) plan.
  if ((status === 429 || status === 403) && /\blimit:?\s*0\b|not available (on|for) (the )?free|free tier.{0,40}not (supported|available)/.test(text)) return make("not_free");
  // The whole account needs a card first: no model on this key will answer.
  if (/payment[_ ]method[_ ]required|add a payment method|payment method is required/.test(text)) return make("no_credit");
  // This model costs money on this account (Z.ai "insufficient balance" on a non-free model): the free ones still answer.
  if (/insufficient balance|no resource package|please recharge|paid[_ ]model|sign in to use this model/.test(text)) return make("not_free");
  if (status === 401 || status === 403) return make("auth");
  if (status === 402) return make("quota", rate.retryAfterMs);
  if (status === 413 || (tooLarge && status !== 429)) return make("too_large");
  if (status === 429) {
    // Groq answers a TPM overrun with 429 "Request too large … tokens per minute": a smaller prompt or another model.
    if (tooLarge && /per minute|tpm/.test(text)) return make("rate_limit", rate.retryAfterMs ?? rate.resetTokensMs);
    return daily ? make("quota", rate.retryAfterMs ?? rate.resetRequestsMs) : make("rate_limit", rate.retryAfterMs ?? rate.resetRequestsMs);
  }
  if (status === 404 || ((status === 400 || status === 422) && goneModel)) return make("model_gone");
  if (status >= 500) return make("server", rate.retryAfterMs);
  return make("bad_request");
}

/** Reasoning models put their thinking inline on some providers: the reply is what's after it. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function linkedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function send(fetchImpl: FetchLike, url: string, init: RequestInit, signal: AbortSignal, external?: AbortSignal): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (e) {
    if (external?.aborted) throw e; // /stop: not the provider's fault
    const name = (e as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new ProviderError("timeout", "timed out");
    throw new ProviderError("network", e instanceof Error ? e.message : String(e));
  }
}

function authHeaders(apiKey: string | undefined, extra?: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...extra };
}

export async function chatCompletion(req: ChatRequest, fetchImpl: FetchLike = fetch): Promise<ChatResponse> {
  const signal = linkedSignal(req.signal, req.timeoutMs ?? 120_000);
  const res = await send(
    fetchImpl,
    `${req.baseURL}/chat/completions`,
    {
      method: "POST",
      headers: authHeaders(req.apiKey, req.headers),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: false,
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      }),
    },
    signal,
    req.signal
  );
  const rate = parseRateHeaders(res.headers);
  const body = await res.text().catch(() => "");
  if (!res.ok) throw classifyFailure(res.status, body, rate);
  let data: {
    model?: string;
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string; code?: number | string };
  };
  try {
    data = JSON.parse(body);
  } catch {
    throw new ProviderError("server", `unreadable answer: ${body.slice(0, 120)}`);
  }
  // Some providers (OpenRouter) report an upstream failure inside a 200.
  if (data.error) throw classifyFailure(Number(data.error.code) || 502, data.error.message ?? JSON.stringify(data.error), rate);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ProviderError("server", "answer had no text");
  return {
    text: stripThinking(content),
    model: data.model ?? req.model,
    ...(data.usage ? { usage: { prompt: data.usage.prompt_tokens ?? 0, completion: data.usage.completion_tokens ?? 0 } } : {}),
    rate,
  };
}

export async function listModels(
  baseURL: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 15_000,
  url = `${baseURL}/models`
): Promise<ModelInfo[]> {
  const res = await send(fetchImpl, url, { headers: authHeaders(apiKey, headers) }, linkedSignal(undefined, timeoutMs));
  const body = await res.text().catch(() => "");
  if (!res.ok) throw classifyFailure(res.status, body);
  const data = JSON.parse(body) as { data?: unknown[]; models?: unknown[] };
  return ((data.data ?? data.models ?? []) as ListedModel[]).flatMap((m) => {
    const info = parseListed(m);
    return info ? [info] : [];
  });
}

/** One row of a `/models` listing. Providers agree on `id` and little else. */
interface ListedModel {
  id?: string;
  name?: string;
  pricing?: { prompt?: string | number; completion?: string | number; input?: string | number; output?: string | number };
  context_length?: number;
  context_window?: number | { tokens?: number };
  max_context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  input_modalities?: string[];
  output_modalities?: string[];
  modalities?: { input?: string[]; output?: string[] };
  /** Mistral. */
  capabilities?: { completion_chat?: boolean; vision?: boolean };
  /** Cohere's native list: which endpoints take the model. */
  endpoints?: string[];
  supports_vision?: boolean;
  model_type?: string;
  type?: string;
  tier?: string;
}

/** Normalize the shapes seen so far (OpenAI, OpenRouter/Kilo, Mistral, Cohere, LLM7, Gonka/Runcrate). Exported for tests. */
export function parseListed(m: ListedModel): ModelInfo | null {
  const id = (m.id ?? m.name)?.replace(/^models\//, "");
  if (!id) return null;
  const num = (v: string | number | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  const prompt = num(m.pricing?.prompt ?? m.pricing?.input);
  const completion = num(m.pricing?.completion ?? m.pricing?.output);
  const ctxWindow = typeof m.context_window === "object" ? m.context_window?.tokens : m.context_window;
  const contextLength = m.context_length || ctxWindow || m.max_context_length || undefined;
  const inputs = m.architecture?.input_modalities ?? m.input_modalities ?? m.modalities?.input;
  const outputs = m.architecture?.output_modalities ?? m.output_modalities ?? m.modalities?.output;
  const arrow = m.architecture?.modality?.split("->");
  const vision = m.capabilities?.vision ?? m.supports_vision ?? (inputs ? inputs.includes("image") : arrow ? arrow[0].includes("image") : undefined);
  const kind = m.model_type ?? m.type;
  const chat =
    m.capabilities?.completion_chat ??
    (m.endpoints ? m.endpoints.some((e) => /(^|\/)chat\b/.test(e)) : undefined) ??
    (kind && kind !== "model" ? /chat|text|llm|language/.test(kind) && !/embed|image|audio|speech|rerank/.test(kind) : undefined) ??
    (outputs ? outputs.includes("text") : arrow ? arrow[1]?.includes("text") : undefined);
  return {
    id,
    ...(m.pricing && (prompt !== undefined || completion !== undefined) ? { pricing: { prompt, completion } } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(chat !== undefined ? { chat } : {}),
    ...(m.tier ? { tier: m.tier } : {}),
  };
}
