import { describe, expect, test } from "bun:test";
import { Availability, RECHECK_MS } from "../availability.ts";
import { classifyFailure } from "../client.ts";
import { isChatModel, modelTraits, newestOnly, score } from "../models.ts";
import { dayIn, msToMidnight, Quota } from "../quota.ts";

const ids = (ms: { id: string }[]) => ms.map((m) => m.id).sort();

describe("models from live lists", () => {
  test("non-chat models are left out", () => {
    for (const id of ["whisper-large-v3", "meta-llama/llama-prompt-guard-2-22m", "openai/gpt-oss-safeguard-20b", "canopylabs/orpheus-v1-english", "text-embedding-004", "gemini-2.5-flash-image", "imagen-4", "veo-3"]) {
      expect(isChatModel(id)).toBe(false);
    }
    for (const id of ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "gemini-3.8-flash", "allam-2-7b"]) expect(isChatModel(id)).toBe(true);
    expect(isChatModel("some-model", { id: "some-model", chat: false })).toBe(false);
  });

  test("sizes come from the id; tier words fill in when it has none", () => {
    expect(modelTraits("openai/gpt-oss-120b").params).toBe(120);
    expect(modelTraits("nvidia/nemotron-3-ultra-550b-a55b").params).toBe(550);
    expect(modelTraits("mistralai/mixtral-8x7b").params).toBe(56);
    expect(modelTraits("gemma-3n-e4b-it").params).toBe(4);
    expect(modelTraits("gemini-3.5-flash-lite").tier).toBe("small");
    expect(modelTraits("gemini-3.1-pro-preview").tier).toBe("big");
    expect(modelTraits("gemini-3.8-flash").sized).toBe(false);
  });

  test("newest of each family only; sizes are separate families; an alias goes when a release is listed", () => {
    const list = ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.8-flash-preview-05-20", "gemini-flash-latest", "gemini-3.5-flash-lite", "openai/gpt-oss-20b", "openai/gpt-oss-120b"].map((id) => modelTraits(id));
    expect(ids(newestOnly(list))).toEqual(["gemini-3.5-flash-lite", "gemini-3.8-flash", "openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });

  test("needs order differently: strong takes the biggest, tiny the small quick one, scarce quotas lose small talk", () => {
    const c = { scarce: false, contextTokens: 8_000 };
    const big = modelTraits("x-120b");
    const small = modelTraits("x-20b");
    expect(score(big, "strong", c)).toBeGreaterThan(score(small, "strong", c));
    expect(score(small, "tiny", c)).toBeGreaterThan(score(big, "tiny", c));
    expect(score(big, "fast", c)).toBeGreaterThan(score(big, "fast", { ...c, scarce: true }));
    expect(score(big, "vision", c)).toBe(-Infinity);
    expect(score(modelTraits("x-vl-12b", undefined, true), "vision", c)).toBeGreaterThan(-Infinity);
  });

  test("a zero quota is 'not on the free plan', not a rate limit", () => {
    expect(classifyFailure(429, "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro").kind).toBe("not_free");
    expect(classifyFailure(429, "Rate limit reached for requests per minute").kind).toBe("rate_limit");
  });

  test("availability: refused models are skipped until a re-check is due", () => {
    let now = 1_000;
    const av = new Availability(null, () => now);
    expect(av.untested("g:pro")).toBe(true);
    av.mark("g:pro", false, "not on the free plan");
    expect(av.refused("g:pro")).toBe(true);
    expect(av.untested("g:pro")).toBe(false);
    now += RECHECK_MS;
    expect(av.refused("g:pro")).toBe(false);
    expect(av.untested("g:pro")).toBe(true);
  });
});

describe("daily limits reset in the provider's zone", () => {
  test("dayIn and msToMidnight", () => {
    const t = Date.parse("2026-11-24T05:00:00Z"); // 21:00 the day before in Los Angeles
    expect(dayIn(t)).toBe("2026-11-24");
    expect(dayIn(t, "America/Los_Angeles")).toBe("2026-11-23");
    expect(msToMidnight(t, "America/Los_Angeles")).toBe(3 * 3_600_000);
  });

  test("a Gemini key's day rolls over at Pacific midnight", () => {
    let now = Date.parse("2026-11-24T05:00:00Z");
    const q = new Quota(null, () => now);
    q.zone("gemini", "America/Los_Angeles");
    q.record("gemini#1:m", 10);
    expect(q.waitMs("gemini#1:m", { rpd: 1 })).toBe(3 * 3_600_000);
    now += 3 * 3_600_000;
    expect(q.usage("gemini#1:m").requestsToday).toBe(0);
  });
});
