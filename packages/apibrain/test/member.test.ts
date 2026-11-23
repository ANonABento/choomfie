import { describe, expect, test } from "bun:test";
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
  defaultModels: ["big", "small"],
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

  test("catalog: configured models that vanished fall back to listed free ones", async () => {
    const { m } = member(() =>
      new Response(JSON.stringify({ data: [{ id: "new-a:free", context_length: 9 }, { id: "new-b:free", context_length: 99 }, { id: "paid" }] }))
    , undefined, { isFree: (id: string) => id.endsWith(":free") });
    await m.refreshCatalog(true);
    expect(m.models()).toEqual(["new-b:free", "new-a:free"]);
  });
});
