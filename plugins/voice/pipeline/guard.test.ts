import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyBudget, budgetKey, checkCloudAudio, selectWithBudget } from "./guard.ts";

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "voice-budget-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gemini = budgetKey("gemini", "gemini-3.8-live");

describe("DailyBudget", () => {
  test("falls back to the next pipeline once the limit is spent, and persists", () => {
    const dir = dataDir();
    const budget = new DailyBudget(dir, { [gemini]: 2 });
    const choices = [
      { key: gemini, value: "realtime" },
      { key: "local", value: "cascaded" },
    ];
    const logs: string[] = [];
    expect(budget.consume(gemini)).toBe(true);
    expect(budget.consume(gemini)).toBe(true);
    expect(budget.consume(gemini)).toBe(false);
    expect(selectWithBudget(choices, budget, (l) => logs.push(l)).value).toBe("cascaded");
    expect(logs[0]).toContain(`falling back to local`);
    expect(new DailyBudget(dir, { [gemini]: 2 }).used(gemini)).toBe(2);
  });

  test("resets on a new day", () => {
    const dir = dataDir();
    let now = new Date(2026, 10, 16, 12);
    const budget = new DailyBudget(dir, { [gemini]: 1 }, () => now);
    budget.consume(gemini);
    expect(budget.hasBudget(gemini)).toBe(false);
    now = new Date(2026, 10, 17, 12);
    expect(budget.hasBudget(gemini)).toBe(true);
  });

  test("throws when every pipeline is out of budget", () => {
    const budget = new DailyBudget(dataDir(), { [gemini]: 0 });
    expect(() => selectWithBudget([{ key: gemini, value: 1 }], budget, () => {})).toThrow("out of budget");
  });
});

describe("checkCloudAudio", () => {
  const ctx = { isPrivate: true, blockCloudInPrivate: true, cloudProviders: ["gemini"] };

  test("refuses a blocked cloud provider in private", () => {
    expect(() => checkCloudAudio("gemini", ctx, () => {})).toThrow("blocked for DMs / private memory");
  });

  test("allows local providers and logs cloud audio when not blocked", () => {
    const logs: string[] = [];
    checkCloudAudio("whisper", ctx, (l) => logs.push(l));
    checkCloudAudio("gemini", { ...ctx, isPrivate: false }, (l) => logs.push(l));
    expect(logs).toEqual(["⚠️ VOICE AUDIO SENT TO CLOUD PROVIDER: gemini"]);
  });
});
