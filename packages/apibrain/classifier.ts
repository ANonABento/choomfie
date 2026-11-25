/**
 * Which kind of message is this? The answer picks a routing bucket (chat,
 * code, agentic, vision, …), and the bucket picks the targets.
 *
 *   1. Hard rules — no call: an image, an oversized prompt, a two-word hello.
 *   2. Zero-shot — a fast free model reads the bucket descriptions and the
 *      message and answers `{"bucket": …, "confidence": …}`.
 *   3. Keywords — when the zero-shot call fails or answers nonsense.
 *
 * Buckets are data (id + description), so adding one updates the zero-shot
 * prompt by itself. Any `Classifier` can take the place of a stage
 * (embeddings, a local model) without touching the callers.
 */

import type { ChatMessage } from "./client.ts";

export interface BucketDef {
  id: string;
  /** Short name, for `/mode`. */
  label: string;
  /** What belongs here — read by the zero-shot model, so write it for a model. */
  description: string;
}

export interface ClassifyInput {
  text: string;
  hasImages: boolean;
  /** Rough size of the prompt with its history. */
  tokens: number;
  /** The last couple of turns, for context ("now do the same for…"). */
  recent: { role: "user" | "assistant"; content: string }[];
}

export interface Classification {
  bucket: string;
  /** 0–1. Hard facts (an image, a huge prompt) say 1; guesses (keywords, a short message) 0.5 or less. */
  confidence: number;
  by: "rule" | "zero-shot" | "keywords";
  reason: string;
}

export interface Classifier {
  classify(input: ClassifyInput, signal?: AbortSignal): Promise<Classification>;
}

export interface HardRuleOptions {
  /** Prompts over this many tokens go to `long`. */
  longTokens: number;
}

/** Decisions that need no model. Null when none applies. */
export function hardRules(ids: Set<string>, opts: HardRuleOptions) {
  return (input: ClassifyInput): Classification | null => {
    const rule = (bucket: string, reason: string, confidence = 1): Classification | null =>
      ids.has(bucket) ? { bucket, confidence, by: "rule", reason } : null;
    if (input.hasImages) return rule("vision", "image attached");
    if (input.tokens > opts.longTokens) return rule("long", `about ${input.tokens} tokens`);
    const words = input.text.trim().split(/\s+/).filter(Boolean);
    if (words.length <= 3 && !/[`{}();=]|https?:\/\//.test(input.text)) return rule("chat", "short message", 0.5); // weak: "ok, go on" continues whatever came before
    return null;
  };
}

const KEYWORDS: [bucket: string, re: RegExp][] = [
  ["local", /\b(on (my|this|the) (mac|laptop|computer|machine|pc)|locally|in my terminal|my (downloads|desktop|documents|home) (folder|dir(ectory)?)|~\/[\w.-]+)/i],
  ["agentic", /\b(in (the|my) (repo|workspace|sandbox)|open a pr|commit|run (it|the|this)|execute|deploy|build (me|a|an|the)|scaffold|browse|click|cad|stl|3d model|create (a|the) (file|repo|project)|(make|draw|generate|create|paint|design) (me )?(an? |the |some )?(image|picture|pic|drawing|art|artwork|logo|sticker|wallpaper|icon)s?)\b/i],
  ["code", /```|\b(code|function|class|bug|error|stack ?trace|refactor|typescript|javascript|python|regex|sql|compile|exception|api)\b/i],
  ["research", /\b(latest|news|today|current(ly)?|this (week|month|year)|sources?|cite|look up|search|price of|who won)\b/i],
  ["quality", /\b(analy[sz]e|compare|explain (why|how|in detail)|essay|proof|reason|plan out|trade-?offs?|pros and cons|rewrite)\b/i],
];

/** Regex rules from the handoff's v1 classifier — the safety net when the zero-shot call can't be made. */
export function keywordClassifier(ids: Set<string>, fallback = "chat"): Classifier {
  const dflt = ids.has(fallback) ? fallback : [...ids][0];
  return {
    async classify(input) {
      for (const [bucket, re] of KEYWORDS) {
        if (ids.has(bucket) && re.test(input.text)) return { bucket, confidence: 0.5, by: "keywords", reason: `matched ${re.exec(input.text)?.[0]}` };
      }
      if (ids.has("quality") && input.text.length > 600) return { bucket: "quality", confidence: 0.5, by: "keywords", reason: "long message" };
      return { bucket: dflt, confidence: 0.4, by: "keywords", reason: "default" };
    },
  };
}

export function zeroShotPrompt(buckets: BucketDef[]): string {
  return [
    "You route chat messages to the right kind of AI model. Classify the LATEST user message into exactly one category:",
    ...buckets.map((b) => `- ${b.id}: ${b.description}`),
    'Answer with JSON only, no prose: {"bucket": "<id>", "confidence": <0..1>}',
  ].join("\n");
}

/** Pull `{bucket, confidence}` out of a model's answer, tolerating code fences and chatter. Null if it's not one of ours. */
export function parseClassification(answer: string, ids: Set<string>): { bucket: string; confidence: number } | null {
  const json = /\{[\s\S]*?\}/.exec(answer)?.[0];
  if (json) {
    try {
      const o = JSON.parse(json) as { bucket?: unknown; category?: unknown; confidence?: unknown };
      const bucket = String(o.bucket ?? o.category ?? "").toLowerCase().trim();
      if (ids.has(bucket)) {
        const c = Number(o.confidence);
        return { bucket, confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.6 };
      }
    } catch {
      /* fall through to a bare word */
    }
  }
  const word = answer.trim().toLowerCase().replace(/[^a-z-]/g, "");
  return ids.has(word) ? { bucket: word, confidence: 0.6 } : null;
}

export interface ZeroShotOptions {
  buckets: BucketDef[];
  /** One small completion (the router over fast free targets). */
  ask(messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

/** Throws when the model can't be reached or answers something unusable. */
export function zeroShotClassifier(opts: ZeroShotOptions): Classifier {
  const ids = new Set(opts.buckets.map((b) => b.id));
  const system = zeroShotPrompt(opts.buckets);
  return {
    async classify(input, signal) {
      const context = input.recent
        .slice(-2)
        .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 300)}`)
        .join("\n");
      const user = `${context ? `Earlier:\n${context}\n\n` : ""}LATEST user message:\n${input.text.slice(0, 1_500)}${input.hasImages ? "\n[has image attachments]" : ""}`;
      const answer = await opts.ask(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        signal
      );
      const parsed = parseClassification(answer, ids);
      if (!parsed) throw new Error(`unusable classification: ${answer.slice(0, 80)}`);
      return { ...parsed, by: "zero-shot", reason: "zero-shot" };
    },
  };
}

export interface PipelineOptions {
  hard?: (input: ClassifyInput) => Classification | null;
  primary?: Classifier;
  fallback: Classifier;
  /** How long the primary gets before the fallback answers. Default 2.5s. */
  timeoutMs?: number;
}

export function classifierPipeline(opts: PipelineOptions): Classifier {
  return {
    async classify(input, signal) {
      const hard = opts.hard?.(input);
      if (hard) return hard;
      if (opts.primary) {
        try {
          const timeout = AbortSignal.timeout(opts.timeoutMs ?? 2_500);
          return await opts.primary.classify(input, signal ? AbortSignal.any([signal, timeout]) : timeout);
        } catch (e) {
          if (signal?.aborted) throw e;
          console.error(`[apibrain] zero-shot classifier: ${e instanceof Error ? e.message : e} — using keywords`);
        }
      }
      return opts.fallback.classify(input, signal);
    },
  };
}
