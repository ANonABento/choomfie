import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForSettledText } from "../settle.ts";
import { looksLikePong } from "../doctor.ts";
import { clip } from "../record.ts";
import { profileInUse } from "../paths.ts";
import { Pacer, shouldPaste } from "../engine/human.ts";

describe("waitForSettledText", () => {
  test("returns once the text stops changing and nothing is busy", async () => {
    const frames = ["", "po", "pon", "pong", "pong", "pong"];
    let i = 0;
    const text = await waitForSettledText(async () => frames[Math.min(i++, frames.length - 1)], {
      quietMs: 20,
      pollMs: 5,
      timeoutMs: 2_000,
    });
    expect(text).toBe("pong");
  });

  test("waits while the site says it's still busy", async () => {
    let busyPolls = 5;
    const text = await waitForSettledText(async () => "done", {
      quietMs: 0,
      pollMs: 5,
      timeoutMs: 2_000,
      isBusy: async () => busyPolls-- > 0,
    });
    expect(text).toBe("done");
    expect(busyPolls).toBeLessThan(0);
  });

  test("returns what's there when stopped, and times out otherwise", async () => {
    expect(await waitForSettledText(async () => "half", { timeoutMs: 1000, isBusy: async () => true, stopRequested: () => true })).toBe("half");
    await expect(waitForSettledText(async () => "", { pollMs: 5, timeoutMs: 30 })).rejects.toThrow("no settled answer");
  });
});

describe("small pieces", () => {
  test("doctor accepts pong in any case, as a word", () => {
    expect(looksLikePong("Pong")).toBe(true);
    expect(looksLikePong("pong.")).toBe(true);
    expect(looksLikePong("ping-ponged")).toBe(false);
  });

  test("record clips bodies and says so", () => {
    expect(clip("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(clip("ab", 3)).toEqual({ text: "ab", truncated: false });
  });

  test("long or multi-line messages are pasted, short ones typed", () => {
    expect(shouldPaste("hi there")).toBe(false);
    expect(shouldPaste("line one\nline two")).toBe(true);
    expect(shouldPaste("x".repeat(500))).toBe(true);
  });

  test("Chrome's dangling SingletonLock symlink counts as in use", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-lock-"));
    try {
      expect(profileInUse(dir)).toBe(false);
      symlinkSync("somehost-12345", join(dir, "SingletonLock"));
      expect(profileInUse(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the pacer spaces submits apart", async () => {
    const p = new Pacer(40);
    const t0 = Date.now();
    await p.turn();
    await p.turn();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(40);
  });
});
