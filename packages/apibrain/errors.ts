/**
 * How an API call failed, in the terms the router acts on. Every failure a
 * provider can produce is mapped to one of these kinds (`client.ts`), so
 * health, key rotation and failover never parse provider error bodies.
 */

export type ProviderErrorKind =
  /** Too many requests right now (RPM/TPM): cool that key, try the next. */
  | "rate_limit"
  /** A daily or credit allowance is spent: cool that key for much longer. */
  | "quota"
  /** The key is wrong or revoked. */
  | "auth"
  /** The account behind the key needs a card or a balance before it answers anything (SambaNova's 402). */
  | "no_credit"
  /** The model was renamed, retired, or never existed. */
  | "model_gone"
  /** Listed, but this key's plan gets none of it (Gemini's "limit: 0" on Pro models). */
  | "not_free"
  /** The prompt doesn't fit this model: a bigger one may take it. */
  | "too_large"
  /** 5xx or an unreadable answer. */
  | "server"
  | "timeout"
  | "network"
  /** Our request was refused for some other reason (a paid model, a bad parameter). */
  | "bad_request";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** When the provider said to come back (retry-after, a reset header). */
    readonly retryAfterMs?: number,
    readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Every target failed or was cooling down. `retryInMs` is the soonest one comes back, if known. */
export class AllUnavailableError extends Error {
  constructor(
    readonly attempts: string[],
    readonly retryInMs?: number
  ) {
    super(attempts.length ? `no target answered (${attempts.join("; ")})` : "no target available");
    this.name = "AllUnavailableError";
  }
}
