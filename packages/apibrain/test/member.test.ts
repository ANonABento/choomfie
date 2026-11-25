import { describe, expect, test } from "bun:test";
import { Availability } from "../availability.ts";
import { Health } from "../health.ts";
import { discoverKeys } from "../keys.ts";
import { ApiMember } from "../member.ts";
import { defineProvider } from "../provider.ts";
import { Quota } from "../quota.ts";
import { fail, fakeFetch, ok } from "./fakes.ts";

const spec = defineProvider({
  id: "acme",
  label: "Acme",
  baseURL: "https://acme/v1",
  keyEnv: "ACME_API_KEY",
  fallbackModels: ["big", "small"],
  limits: { rpm: 2 },
});

function member(answer: Parameters<typeof fakeFetch>[0], env: Record<string, string> = { ACME_API_KEY: "k1", ACME_API_KEY_2: "k2" }, extra = {}) {
  const f = fakeFetch(answer);
  const health = new Health();
  const quota = new Quota();
  const m = new ApiMember({ ...spec, ...extra }, { env, health, quota, fetch: f });
  return { m, f, health, quota };
}

const msgs = [{ role: "user" as const, content: "hi" }];

test("discoverKeys pools numbered keys in order, without repeats", () => {
  const keys = discoverKeys("acme", "ACME_API_KEY", { ACME_API_KEY_10: "c", ACME_API_KEY: "a", ACME_API_KEY_2: "b", ACME_API_KEY_3: "a" });
  expect(keys.map((k) => [k.unit, k.value])).toEqual([
    ["acme#1", "a"],
    ["acme#2", "b"],
    ["acme#3", "c"],
  ]);
});

describe("ApiMember.complete", () => {
  test("a rate-limited key cools; the next key answers", async () => {
    const { m, f, health } = member((c) => (c.auth === "Bearer k1" ? fail(429, "rate limit", { "retry-after": "30" }) : ok("from k2")));
    const r = await m.complete(msgs);
    expect(r.text).toBe("from k2");
    expect(f.calls.map((c) => c.auth)).toEqual(["Bearer k1", "Bearer k2"]);
    expect(health.available("acme#1")).toBe(false);
    // Next call goes straight to the healthy key.
    await m.complete(msgs);
    expect(f.calls.at(-1)!.auth).toBe("Bearer k2");
  });

  test("a gone model is skipped for the next one", async () => {
    const { m, f, health } = member((c) => (c.body!.model === "big" ? fail(404, "model_not_found") : ok("small here")));
    expect((await m.complete(msgs)).text).toBe("small here");
    expect(f.calls.map((c) => c.body!.model)).toEqual(["big", "small"]);
    expect(health.available("acme:big")).toBe(false);
  });

  test("local rpm stops calls before the provider has to", async () => {
    const { m, f } = member(() => ok("x"), { ACME_API_KEY: "k1" });
    await m.complete(msgs);
    await m.complete(msgs);
    const e = await m.complete(msgs).catch((x) => x);
    expect(e.kind).toBe("rate_limit");
    expect(e.retryAfterMs).toBeGreaterThan(0);
    expect(f.calls.length).toBe(2);
    expect(m.waitMs()).toBeGreaterThan(0);
  });

  test("a paid model is refused, never called", async () => {
    const { m, f } = member(() => ok("x"), undefined, { isFree: (id: string) => id.endsWith(":free") });
    const e = await m.complete(msgs, { model: "gpt-paid" }).catch((x) => x);
    expect(e.kind).toBe("bad_request");
    expect(f.calls.length).toBe(0);
  });

  test("model scope: a 429 on one model leaves the key free for another", async () => {
    const { m, health } = member((c) => (c.body!.model === "big" ? fail(429, "rpm") : ok("ok")), { ACME_API_KEY: "k1" }, { limitScope: "model" });
    expect((await m.complete(msgs)).text).toBe("ok");
    expect(health.available("acme#1:big")).toBe(false);
    expect(health.available("acme#1")).toBe(true);
  });

  test("no key: not configured", async () => {
    const { m } = member(() => ok("x"), {});
    expect(m.configured).toBe(false);
    expect(m.waitMs()).toBe(Infinity);
    expect((await m.complete(msgs).catch((x) => x)).kind).toBe("auth");
  });

  test("catalog: models come from the live list — free chat models only, newest of each family, strongest first", async () => {
    const { m } = member(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "x-8b:free" },
              { id: "x-70b:free" },
              { id: "y-2.5-flash:free" },
              { id: "y-3.1-flash:free" },
              { id: "z-embed-1b:free" },
              { id: "paid-400b" },
            ],
          })
        ),
      undefined,
      { isFree: (id: string) => id.endsWith(":free") }
    );
    await m.refreshCatalog(true);
    expect(m.models()).toEqual(["y-3.1-flash:free", "x-70b:free", "x-8b:free"]);
    expect(m.ranked("tiny")[0].id).toBe("x-8b:free");
  });
});

describe("models that think first", () => {
  const spec2 = defineProvider({ ...spec, limits: {} });
  const reasoning = (text: string) => ok(text, { choices: [{ message: { content: text, reasoning: "hmm" } }], usage: { prompt_tokens: 10, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } } });

  test("are remembered, then asked to keep it brief on one-line calls", async () => {
    const f = fakeFetch(() => reasoning("ok"));
    const availability = new Availability();
    const m = new ApiMember(spec2, { env: { ACME_API_KEY: "k" }, health: new Health(), quota: new Quota(), fetch: f, availability });
    await m.complete(msgs, { model: "big", briefThinking: true });
    expect(f.calls[0].body?.reasoning_effort).toBeUndefined(); // not known yet
    expect(availability.get("acme:big")?.reasons).toBe(true);
    await m.complete(msgs, { model: "big", briefThinking: true });
    expect(f.calls[1].body?.reasoning_effort).toBe("low");
    await m.complete(msgs, { model: "big" });
    expect(f.calls[2].body?.reasoning_effort).toBeUndefined(); // only when asked
  });

  test("a model that refuses the field is asked again without it, and never sent it again", async () => {
    const f = fakeFetch((c) => (c.body?.reasoning_effort ? fail(400, "Model 'big' does not support reasoning.") : reasoning("ok")));
    const availability = new Availability();
    availability.note("acme:big", { reasons: true });
    const m = new ApiMember(spec2, { env: { ACME_API_KEY: "k" }, health: new Health(), quota: new Quota(), fetch: f, availability });
    expect((await m.complete(msgs, { model: "big", briefThinking: true })).text).toBe("ok");
    await m.complete(msgs, { model: "big", briefThinking: true });
    expect(f.calls.map((c) => c.body?.reasoning_effort)).toEqual(["low", undefined, undefined]);
  });

  test("an answer that was all thinking is a failure, except for a probe", async () => {
    const empty = () => ok("", { choices: [{ message: { content: null, reasoning: "1. Analyze the request" } }] });
    const m = new ApiMember(spec2, { env: { ACME_API_KEY: "k" }, health: new Health(), quota: new Quota(), fetch: fakeFetch(empty) });
    await expect(m.complete(msgs, { model: "big" })).rejects.toThrow("thinking");
    expect((await m.complete(msgs, { model: "small", purpose: "probe" })).text).toBe("");
  });

  test("rank below plain models for tiny jobs", () => {
    const availability = new Availability();
    const m = new ApiMember(defineProvider({ ...spec2, fallbackModels: ["think-20b", "plain-27b"] }), { env: { ACME_API_KEY: "k" }, health: new Health(), quota: new Quota(), fetch: fakeFetch(() => ok("x")), availability });
    availability.mark("acme:think-20b", true);
    availability.mark("acme:plain-27b", true);
    expect(m.ranked("tiny")[0].id).toBe("think-20b");
    availability.note("acme:think-20b", { reasons: true });
    expect(m.ranked("tiny")[0].id).toBe("plain-27b");
  });
});

describe("benched keys across a restart", () => {
  const spec3 = defineProvider({ ...spec, limits: {} });
  test("a key that wants a card stays out after a restart, by fingerprint only; an answer clears it", async () => {
    const availability = new Availability();
    const card = () => fail(402, '{"error":{"code":"PAYMENT_METHOD_REQUIRED","message":"A payment method is required"}}');
    const before = new ApiMember(spec3, { env: { ACME_API_KEY: "secret-key" }, health: new Health(), quota: new Quota(), fetch: fakeFetch(card), availability });
    await expect(before.complete(msgs, { model: "big" })).rejects.toThrow();
    const saved = JSON.stringify(Object.fromEntries((availability as unknown as { checks: Map<string, unknown> }).checks));
    expect(saved).not.toContain("secret-key");
    expect(saved).toContain("key:acme:");

    // After a restart: fresh health, same file.
    const f = fakeFetch(() => ok("hi"));
    const after = new ApiMember(spec3, { env: { ACME_API_KEY: "secret-key" }, health: new Health(), quota: new Quota(), fetch: f, availability });
    after.restoreBenches();
    await expect(after.complete(msgs, { model: "big" })).rejects.toThrow("cooling");
    expect(f.calls.length).toBe(0);

    // The doctor (no restoreBenches) re-checks; an answer clears the bench.
    const doctor = new ApiMember(spec3, { env: { ACME_API_KEY: "secret-key" }, health: new Health(), quota: new Quota(), fetch: f, availability });
    expect((await doctor.complete(msgs, { model: "big" })).text).toBe("hi");
    const again = new ApiMember(spec3, { env: { ACME_API_KEY: "secret-key" }, health: new Health(), quota: new Quota(), fetch: f, availability });
    again.restoreBenches();
    expect((await again.complete(msgs, { model: "big" })).text).toBe("hi");
  });
});
