import { describe, expect, test } from "bun:test";
import { isQuotaReached, parseResetAt, QuotaReachedError, mediaKindOf } from "@choomfie/shared";
import { quotaScope } from "../../../plugins/webbrains/sites/gemini.ts";

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

describe("media kinds", () => {
  test("what a message asks a media brain to make", () => {
    expect(mediaKindOf("can u make me a song about jensen")).toBe("music");
    expect(mediaKindOf("make a beat for my video")).toBe("music");
    expect(mediaKindOf("make me a short video of a cat")).toBe("video");
    expect(mediaKindOf("draw a tabby cat")).toBe("image");
    expect(mediaKindOf("can u make me a image of a tabby cat")).toBe("image");
    expect(mediaKindOf("what's the weather")).toBeUndefined();
  });

  test("Gemini's limit message names which kind is spent", () => {
    expect(quotaScope("I can create more music as soon as your limit resets. Check your usage in Settings.")).toBe("music");
    expect(quotaScope("I can create more images as soon as your limit resets.")).toBe("image");
    expect(quotaScope("You've reached your limit. Try again tomorrow.")).toBeUndefined();
  });

  test("a scoped quota error says which allowance", () => {
    expect(new QuotaReachedError("Gemini web", undefined, "…", "music").message).toBe("Gemini web is out of its free music allowance for now.");
  });
});
