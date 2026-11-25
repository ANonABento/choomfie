import { describe, expect, test } from "bun:test";
import { classifierPipeline, hardRules, keywordClassifier, parseClassification, zeroShotClassifier, zeroShotPrompt, type BucketDef } from "../classifier.ts";
import { AllUnavailableError, ProviderError } from "../errors.ts";
import { dedupeTargets, parseTarget, route, targetKey } from "../router.ts";

describe("targets", () => {
  test("parse member and model; model ids keep their colons", () => {
    expect(parseTarget("openrouter:qwen/qwen3-coder:free")).toEqual({ member: "openrouter", model: "qwen/qwen3-coder:free" });
    expect(parseTarget(" Waymond ")).toEqual({ member: "waymond" });
    expect(dedupeTargets(["groq", "groq:a", "groq"].map(parseTarget)).map(targetKey)).toEqual(["groq", "groq:a"]);
  });
});

describe("route", () => {
  test("skips cooling targets, fails over, reports what it passed", async () => {
    const r = await route(["a", "b", "c"].map(parseTarget), {
      waitMs: (t) => (t.member === "a" ? 5_000 : 0),
      attempt: async (t) => {
        if (t.member === "b") throw new ProviderError("rate_limit", "429", 9_000);
        return `answer from ${t.member}`;
      },
    });
    expect(r.value).toBe("answer from c");
    expect(r.passed).toEqual(["a: cooling down", "b: 429"]);
  });

  test("all unavailable: the soonest return time", async () => {
    const e = await route(["a", "b"].map(parseTarget), {
      waitMs: (t) => (t.member === "a" ? 60_000 : Infinity),
      attempt: async () => "x",
    }).catch((x) => x);
    expect(e).toBeInstanceOf(AllUnavailableError);
    expect(e.retryInMs).toBe(60_000);
  });

  test("an abort stops the route instead of failing over", async () => {
    const abort = new AbortController();
    let calls = 0;
    const e = await route(["a", "b"].map(parseTarget), {
      waitMs: () => 0,
      signal: abort.signal,
      attempt: async () => {
        calls++;
        abort.abort();
        throw new Error("aborted");
      },
    }).catch((x) => x);
    expect(e.message).toBe("aborted");
    expect(calls).toBe(1);
  });
});

const BUCKETS: BucketDef[] = ["chat", "quality", "code", "media", "agentic", "research", "vision", "long"].map((id) => ({ id, label: id, description: `${id} things` }));
const IDS = new Set(BUCKETS.map((b) => b.id));
const input = (text: string, over = {}) => ({ text, hasImages: false, tokens: 10, recent: [], ...over });

describe("classifier", () => {
  test("hard rules", () => {
    const hard = hardRules(IDS, { longTokens: 1000 });
    expect(hard(input("what's in this?", { hasImages: true }))?.bucket).toBe("vision");
    expect(hard(input("x".repeat(10), { tokens: 5000 }))?.bucket).toBe("long");
    expect(hard(input("hey there"))?.bucket).toBe("chat");
    expect(hard(input("fix `foo()`"))).toBeNull();
    expect(hard(input("please explain how compilers work"))).toBeNull();
  });

  test("keywords", async () => {
    const k = keywordClassifier(IDS);
    expect((await k.classify(input("why does this function throw an error"))).bucket).toBe("code");
    expect((await k.classify(input("build me a landing page in my repo"))).bucket).toBe("agentic");
    expect((await k.classify(input("draw me a cute cat picture"))).bucket).toBe("media");
    expect((await k.classify(input("make a lofi song for studying"))).bucket).toBe("media");
    expect((await k.classify(input("what makes a good logo"))).bucket).not.toBe("media");
    expect((await k.classify(input("what's the latest news on the election"))).bucket).toBe("research");
    expect((await k.classify(input("tell me a joke about cats please"))).bucket).toBe("chat");
  });

  test("parseClassification tolerates fences and bare words; rejects unknown buckets", () => {
    expect(parseClassification('```json\n{"bucket": "Code", "confidence": 0.9}\n```', IDS)).toEqual({ bucket: "code", confidence: 0.9 });
    expect(parseClassification("research", IDS)).toEqual({ bucket: "research", confidence: 0.6 });
    expect(parseClassification('{"bucket":"poetry"}', IDS)).toBeNull();
    expect(parseClassification('{"category":"chat","confidence":7}', IDS)).toEqual({ bucket: "chat", confidence: 1 });
  });

  test("zero-shot prompt lists every bucket; pipeline falls back to keywords", async () => {
    expect(zeroShotPrompt(BUCKETS)).toContain("- agentic: agentic things");
    const zs = zeroShotClassifier({ buckets: BUCKETS, ask: async () => '{"bucket":"quality","confidence":0.8}' });
    const pipe = classifierPipeline({ hard: hardRules(IDS, { longTokens: 1e6 }), primary: zs, fallback: keywordClassifier(IDS) });
    expect(await pipe.classify(input("compare these two approaches for me"))).toMatchObject({ bucket: "quality", by: "zero-shot" });

    const broken = zeroShotClassifier({ buckets: BUCKETS, ask: async () => "I think it's poetry" });
    const pipe2 = classifierPipeline({ primary: broken, fallback: keywordClassifier(IDS) });
    expect(await pipe2.classify(input("debug this stack trace please"))).toMatchObject({ bucket: "code", by: "keywords" });

    const slow = zeroShotClassifier({ buckets: BUCKETS, ask: (_m, signal) => new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new Error("timeout")))) });
    const pipe3 = classifierPipeline({ primary: slow, fallback: keywordClassifier(IDS), timeoutMs: 20 });
    expect((await pipe3.classify(input("write an essay comparing two poets"))).by).toBe("keywords");
  });
});
