import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health } from "../health.ts";
import { Quota } from "../quota.ts";

describe("Quota", () => {
  test("rpm window and rpd day roll over", () => {
    let now = Date.parse("2026-11-20T10:00:00Z");
    const q = new Quota(null, () => now);
    q.record("u", 100);
    expect(q.hasCapacity("u", { rpm: 1 })).toBe(false);
    now += 61_000;
    expect(q.hasCapacity("u", { rpm: 1 })).toBe(true);
    expect(q.hasCapacity("u", { rpd: 1 })).toBe(false);
    now = Date.parse("2026-11-21T00:00:01Z");
    expect(q.hasCapacity("u", { rpd: 1 })).toBe(true);
  });

  test("headers saying nothing is left block until reset", () => {
    let now = 1_000;
    const q = new Quota(null, () => now);
    q.observe("u", { remainingRequests: 0, resetRequestsMs: 5_000 });
    expect(q.waitMs("u")).toBe(5_000);
    now += 5_001;
    expect(q.waitMs("u")).toBe(0);
  });

  test("daily counts survive a restart", () => {
    const file = join(mkdtempSync(join(tmpdir(), "apibrain-")), "meta", "usage.json");
    const a = new Quota(file);
    a.record("groq#1", 50);
    a.flush();
    expect(new Quota(file).usage("groq#1")).toMatchObject({ requestsToday: 1, tokensToday: 50 });
  });
});

describe("Health", () => {
  test("one blip is free, then exponential", () => {
    let now = 0;
    const h = new Health({ baseMs: 1_000, threshold: 2 }, () => now);
    h.fail("x", "timeout");
    expect(h.available("x")).toBe(true);
    h.fail("x", "timeout");
    expect(h.waitMs("x")).toBe(1_000);
    h.fail("x", "timeout");
    expect(h.waitMs("x")).toBe(2_000);
    h.ok("x");
    expect(h.available("x")).toBe(true);
  });

  test("cool takes the longer of two", () => {
    const h = new Health({}, () => 0);
    h.cool("k", 5_000, "a");
    h.cool("k", 1_000, "b");
    expect(h.waitMs("k")).toBe(5_000);
    expect(h.cooling()[0][0]).toBe("k");
  });
});
