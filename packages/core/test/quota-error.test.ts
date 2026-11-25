import { describe, expect, test } from "bun:test";
import { isQuotaReached, parseResetAt, QuotaReachedError } from "@choomfie/shared";

const NOW = Date.parse("2026-11-25T12:00:00Z");
const H = 3_600_000;

describe("parseResetAt", () => {
  test("relative times", () => {
    expect(parseResetAt("Quota exhausted. Resets in 3 hours.", NOW)).toBe(NOW + 3 * H);
    expect(parseResetAt("try again in 2h 15m", NOW)).toBe(NOW + 2.25 * H);
    expect(parseResetAt("limit resets in 1 day and 4 hours", NOW)).toBe(NOW + 28 * H);
    expect(parseResetAt("wait in 45 minutes", NOW)).toBe(NOW + 0.75 * H);
    expect(parseResetAt("back in 30s", NOW)).toBe(NOW + 30_000);
  });

  test("absolute times; nothing usable is undefined", () => {
    expect(parseResetAt("resets at 2026-11-27T17:00:00Z", NOW)).toBe(Date.parse("2026-11-27T17:00:00Z"));
    expect(parseResetAt("reset 2020-01-01T00:00:00Z", NOW)).toBeUndefined();
    expect(parseResetAt("You've hit your limit for today.", NOW)).toBeUndefined();
    expect(parseResetAt("in 3 months", NOW)).toBeUndefined();
  });
});

test("QuotaReachedError is recognised by name, so a copy from another package counts", () => {
  const e = new QuotaReachedError("Gemini", NOW + H);
  expect(isQuotaReached(e)).toBe(true);
  expect(e.message).toStartWith("Gemini is out of its free allowance until ");
  expect(isQuotaReached(Object.assign(new Error("x"), { name: "QuotaReachedError" }))).toBe(true);
  expect(isQuotaReached(new Error("quota"))).toBe(false);
  expect(new QuotaReachedError("X").message).toBe("X is out of its free allowance for now.");
});
