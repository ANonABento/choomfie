/**
 * A classifier with no LLM call: each bucket has a handful of example
 * messages; a message goes to the bucket whose examples it sits closest to
 * (cosine similarity of embedding vectors). With a local embedding model
 * (Ollama `nomic-embed-text`) that is a few milliseconds, private, and spends
 * no free-tier quota.
 *
 * Confidence comes from the gap between the best bucket and the runner-up,
 * so "explain this regex" (clearly code) is sure and "can you look at this"
 * (anything) is not — the pipeline then asks the next stage.
 */

import type { BucketDef, Classification, Classifier, ClassifyInput } from "./classifier.ts";

/** Turns texts into vectors, one per text, in order. */
export type Embed = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;

/** Thrown while the embedding model is known to be down, so the pipeline moves on without logging every message. */
export class StageUnavailable extends Error {
  override name = "StageUnavailable";
}

export interface EmbeddingClassifierOptions {
  buckets: (BucketDef & { examples?: string[] })[];
  embed: Embed;
  /** Bucket score = mean similarity of its `k` closest examples. Default 3. */
  k?: number;
  /** Gap between the best two buckets that counts as fully sure. Default 0.08 (measured on the eval set). */
  sureGap?: number;
  /** After a failure, how long to skip this stage. Default 10 min. */
  retryAfterMs?: number;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Per-bucket scores, best first. */
export function scoreBuckets(vec: number[], anchors: { bucket: string; vec: number[] }[], k: number): { bucket: string; score: number }[] {
  const sims = new Map<string, number[]>();
  for (const a of anchors) {
    const list = sims.get(a.bucket) ?? [];
    list.push(cosine(vec, a.vec));
    sims.set(a.bucket, list);
  }
  return [...sims]
    .map(([bucket, s]) => {
      const top = s.sort((x, y) => y - x).slice(0, k);
      return { bucket, score: top.reduce((x, y) => x + y, 0) / top.length };
    })
    .sort((a, b) => b.score - a.score);
}

/** What gets embedded: the message, with the previous user turn when the message is too short to stand alone ("same for the other one"). */
export function embedText(input: ClassifyInput): string {
  const text = input.text.trim().slice(0, 1_500);
  const words = text.split(/\s+/).filter(Boolean).length;
  const prev = [...input.recent].reverse().find((t) => t.role === "user")?.content;
  return words < 6 && prev ? `${prev.slice(0, 300)}\n${text}` : text;
}

export function embeddingClassifier(opts: EmbeddingClassifierOptions): Classifier {
  const k = opts.k ?? 3;
  const sureGap = opts.sureGap ?? 0.08;
  const retryAfterMs = opts.retryAfterMs ?? 10 * 60_000;
  const examples = opts.buckets.flatMap((b) => (b.examples ?? []).map((text) => ({ bucket: b.id, text })));
  let anchors: Promise<{ bucket: string; vec: number[] }[]> | null = null;
  let downUntil = 0;

  return {
    async classify(input, signal): Promise<Classification> {
      if (!examples.length) throw new StageUnavailable("no example messages");
      if (Date.now() < downUntil) throw new StageUnavailable("embedding model unavailable");
      try {
        anchors ??= opts.embed(examples.map((e) => e.text)).then((vecs) => vecs.map((vec, i) => ({ bucket: examples[i].bucket, vec })));
        const examplesVecs = await anchors;
        const [vec] = await opts.embed([embedText(input)], signal);
        const ranked = scoreBuckets(vec, examplesVecs, k);
        const [best, second] = ranked;
        const gap = best.score - (second?.score ?? 0);
        // 0.4 with no gap at all, 1 at `sureGap` or more.
        const confidence = Math.min(1, 0.4 + 0.6 * (gap / sureGap));
        return { bucket: best.bucket, confidence: Math.round(confidence * 100) / 100, by: "embeddings", reason: `${best.bucket} ${best.score.toFixed(3)} vs ${second?.bucket ?? "-"} ${second?.score.toFixed(3) ?? "-"}` };
      } catch (e) {
        if (signal?.aborted) throw e;
        anchors = null;
        downUntil = Date.now() + retryAfterMs;
        console.error(`[apibrain] embeddings classifier off for ${Math.round(retryAfterMs / 60_000)} min: ${e instanceof Error ? e.message : e}`);
        throw new StageUnavailable("embedding model unavailable");
      }
    },
  };
}

/** Ollama's `/api/embed` (batch). nomic-embed-text wants a task prefix. */
export function ollamaEmbed(opts: { url?: string; model?: string; prefix?: string; timeoutMs?: number } = {}): Embed {
  const url = (opts.url ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = opts.model ?? "nomic-embed-text";
  const prefix = opts.prefix ?? (/nomic/.test(model) ? "classification: " : "");
  return async (texts, signal) => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
    const res = await fetch(`${url}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: texts.map((t) => prefix + t) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const body = (await res.json()) as { embeddings?: unknown };
    const out = Array.isArray(body.embeddings) ? (body.embeddings as number[][]) : [];
    if (out.length !== texts.length) throw new Error(`ollama returned ${out.length} vectors for ${texts.length} texts`);
    return out;
  };
}
