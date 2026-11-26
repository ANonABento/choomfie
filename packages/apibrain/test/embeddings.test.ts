import { describe, expect, test } from "bun:test";
import { classifierPipeline, keywordClassifier, type Classification, type Classifier } from "../classifier.ts";
import { cosine, embeddingClassifier, embedText, scoreBuckets, type Embed } from "../embeddings.ts";
import { evaluate, formatReport } from "../eval.ts";

/** Bag of words over a tiny vocabulary: enough to make "similar" mean something. */
const VOCAB = ["draw", "picture", "song", "bug", "code", "error", "hello", "hi", "weather", "news", "today"];
const fakeEmbed =
  (calls: string[][] = []): Embed =>
  async (texts) => {
    calls.push(texts);
    return texts.map((t) => [...VOCAB.map((w): number => (t.toLowerCase().includes(w) ? 1 : 0)), 0.01]);
  };

const BUCKETS = [
  { id: "media", label: "Media", description: "make media", examples: ["draw a picture of a cat", "make a song", "draw me a dog picture"] },
  { id: "code", label: "Code", description: "code", examples: ["fix this bug in my code", "code error", "why this error in my code"] },
  { id: "chat", label: "Chat", description: "chat", examples: ["hello there", "hi how are you", "hello"] },
  { id: "research", label: "Research", description: "news", examples: ["weather today", "news today", "today's news"] },
];
const input = (text: string, recent: { role: "user" | "assistant"; content: string }[] = []) => ({ text, hasImages: false, tokens: 10, recent });

describe("embeddings classifier", () => {
  test("cosine and per-bucket scores", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    const ranked = scoreBuckets([1, 0], [{ bucket: "a", vec: [1, 0] }, { bucket: "b", vec: [0, 1] }, { bucket: "a", vec: [0.9, 0.1] }], 2);
    expect(ranked[0].bucket).toBe("a");
  });

  test("picks the closest bucket; a clear message is sure, an unclear one isn't", async () => {
    const calls: string[][] = [];
    const c = embeddingClassifier({ buckets: BUCKETS, embed: fakeEmbed(calls) });
    const clear = await c.classify(input("there's an error in my code, a bug"));
    expect(clear).toMatchObject({ bucket: "code", by: "embeddings" });
    expect(clear.confidence).toBeGreaterThan(0.8);
    const vague = await c.classify(input("draw the news"));
    expect(vague.confidence).toBeLessThan(clear.confidence);
    // The examples are embedded once.
    expect(calls.filter((x) => x.length > 1)).toHaveLength(1);
  });

  test("a short follow-up is read with the turn before it", async () => {
    expect(embedText(input("same again", [{ role: "user", content: "draw a picture" }]))).toBe("draw a picture\nsame again");
    expect(embedText(input("a message long enough to stand on its own", [{ role: "user", content: "x" }]))).toBe("a message long enough to stand on its own");
    const c = embeddingClassifier({ buckets: BUCKETS, embed: fakeEmbed() });
    expect((await c.classify(input("again please", [{ role: "user", content: "draw a picture" }]))).bucket).toBe("media");
  });

  test("model down: skipped quietly for a while, then tried again", async () => {
    let up = false;
    let calls = 0;
    const embed: Embed = async (texts) => {
      calls++;
      if (!up) throw new Error("connection refused");
      return fakeEmbed()(texts);
    };
    const c = embeddingClassifier({ buckets: BUCKETS, embed, retryAfterMs: 30 });
    await expect(c.classify(input("hello"))).rejects.toMatchObject({ name: "StageUnavailable" });
    await expect(c.classify(input("hello"))).rejects.toMatchObject({ name: "StageUnavailable" });
    expect(calls).toBe(1);
    up = true;
    await Bun.sleep(40);
    expect((await c.classify(input("hello hi"))).bucket).toBe("chat");
  });
});

describe("pipeline stages", () => {
  const fixed = (c: Partial<Classification>, log?: string[]): Classifier => ({
    async classify() {
      log?.push(c.by ?? "?");
      return { bucket: "chat", confidence: 1, by: "zero-shot", reason: "t", ...c };
    },
  });
  const IDS = new Set(["chat", "code", "media"]);

  test("a sure first stage answers alone; an unsure one hands over", async () => {
    const log: string[] = [];
    const sure = classifierPipeline({ stages: [{ classifier: fixed({ bucket: "code", confidence: 0.9, by: "embeddings" }, log), sureAt: 0.8 }, { classifier: fixed({ bucket: "media" }, log) }], fallback: keywordClassifier(IDS) });
    expect(await sure.classify(input("x"))).toMatchObject({ bucket: "code", by: "embeddings" });
    expect(log).toEqual(["embeddings"]);
    const unsure = classifierPipeline({ stages: [{ classifier: fixed({ bucket: "code", confidence: 0.5, by: "embeddings" }), sureAt: 0.8 }, { classifier: fixed({ bucket: "media" }) }], fallback: keywordClassifier(IDS) });
    expect(await unsure.classify(input("x"))).toMatchObject({ bucket: "media", by: "zero-shot" });
  });

  test("the next stage failing: the unsure answer beats keywords", async () => {
    const broken: Classifier = { classify: async () => Promise.reject(new Error("429")) };
    const p = classifierPipeline({ stages: [{ classifier: fixed({ bucket: "media", confidence: 0.5, by: "embeddings" }), sureAt: 0.8 }, { classifier: broken }], fallback: keywordClassifier(IDS) });
    expect(await p.classify(input("fix this bug in my code"))).toMatchObject({ bucket: "media", by: "embeddings" });
    const none = classifierPipeline({ stages: [{ classifier: broken }], fallback: keywordClassifier(IDS) });
    expect(await none.classify(input("fix this bug in my code"))).toMatchObject({ bucket: "code", by: "keywords" });
  });
});

describe("eval", () => {
  test("scores accuracy, alt answers, calibration and misses", async () => {
    const c = embeddingClassifier({ buckets: BUCKETS, embed: fakeEmbed() });
    const r = await evaluate("emb", c, [
      { text: "a bug in the code", bucket: "code" },
      { text: "draw a picture", bucket: "chat", alt: "media" },
      { text: "hello hi", bucket: "research" },
    ]);
    expect(r.exact).toBe(1);
    expect(r.ok).toBe(2);
    expect(r.calibration[0].n).toBeGreaterThan(0);
    const text = formatReport(r).join("\n");
    expect(text).toContain("emb: 2/3 ok");
    expect(text).toContain("✗ want research, got chat");
    expect(text).not.toContain("a bug in the code");
  });
});
