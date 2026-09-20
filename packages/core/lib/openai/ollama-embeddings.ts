/**
 * Shared core for the two Ollama embedding call sites.
 *
 * Both speak the same wire protocol — POST /api/embeddings with
 * `{ model, prompt }`, back `{ embedding: number[] }` — but they cannot share a
 * provider class: `lib/memory.ts` needs a synchronous, nullable, single-text
 * call (it sits on a sync path down from `MemoryStore.searchArchival()`), while
 * `lib/openai/embeddings.ts` needs an async batch call that throws. So the
 * endpoint/model resolution and the response parsing live here, and each side
 * keeps its own thin transport adapter.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "mxbai-embed-large";

export type OllamaEmbeddingConfig = {
  /** Base URL with any trailing slash stripped. */
  baseUrl: string;
  /** Default embedding model. */
  model: string;
  /** Fully-qualified embeddings endpoint. */
  endpoint: string;
};

export function resolveOllamaEmbeddingConfig(
  env: Record<string, string | undefined> = process.env,
): OllamaEmbeddingConfig {
  const baseUrl = (env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return {
    baseUrl,
    model: env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_MODEL,
    endpoint: `${baseUrl}/api/embeddings`,
  };
}

/** Request body for POST /api/embeddings. */
export function buildOllamaEmbeddingRequest(model: string, text: string): string {
  return JSON.stringify({ model, prompt: text });
}

/**
 * Pull the embedding vector out of an Ollama response body, dropping any
 * non-numeric entries. Returns null only when the body carries no `embedding`
 * array at all — an empty vector comes back as `[]` so callers can decide
 * whether that counts as a failure.
 */
export function parseOllamaEmbeddingResponse(body: unknown): number[] | null {
  if (!body || typeof body !== "object") return null;
  const embedding = (body as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding)) return null;
  return embedding.filter((value): value is number => typeof value === "number");
}
