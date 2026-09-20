/**
 * Rate-limit normalisation behind `/usage`.
 *
 * The SDK's `.d.ts` declares a single flat window (`utilization`, `resetsAt`,
 * `rateLimitType`), but the payload that actually arrives carries an undeclared
 * `unifiedWindows` object holding every window at once, with the flat fields
 * describing only the tightest one. These tests pin both shapes so a CLI update
 * that drops either doesn't silently start reporting one window as if it were
 * the whole picture.
 */
import { describe, expect, test } from "bun:test";
import { parseRateLimitInfo } from "../../daemon/rate-limit.ts";
import {
  bar,
  colorFor,
  formatModelUsage,
  orderedWindows,
} from "../../lib/handlers/usage-command.ts";

/** Captured verbatim from a real session, including the undeclared field. */
const REAL_EVENT = {
  status: "allowed_warning",
  resetsAt: 1789920000,
  rateLimitType: "seven_day",
  utilization: 0.97,
  isUsingOverage: false,
  surpassedThreshold: 0.75,
  unifiedWindows: {
    five_hour: { utilization: 0.47, resetsAt: 1789919400 },
    seven_day: { utilization: 0.97, resetsAt: 1789920000 },
  },
} as never;

describe("parseRateLimitInfo", () => {
  test("reads every window out of unifiedWindows, not just the tightest", () => {
    const snapshot = parseRateLimitInfo(REAL_EVENT)!;

    // Reading only the flat fields would report 97% and lose the fact that the
    // 5-hour window is at 47% — a different limit with a different reset.
    expect(Object.keys(snapshot.windows).sort()).toEqual(["five_hour", "seven_day"]);
    expect(snapshot.windows.five_hour.utilization).toBe(0.47);
    expect(snapshot.windows.seven_day.utilization).toBe(0.97);
    expect(snapshot.windows.five_hour.resetsAt).toBe(1789919400);

    expect(snapshot.status).toBe("allowed_warning");
    expect(snapshot.tightest).toBe("seven_day");
    expect(snapshot.isUsingOverage).toBe(false);
  });

  test("falls back to the flat fields when unifiedWindows is absent", () => {
    // The shape the SDK's types describe. Still has to work.
    const snapshot = parseRateLimitInfo({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.31,
      resetsAt: 1789919400,
    } as never)!;

    expect(snapshot.windows).toEqual({
      five_hour: { utilization: 0.31, resetsAt: 1789919400 },
    });
  });

  test("an unlabelled percentage is dropped rather than shown as an unnamed limit", () => {
    // No rateLimitType and no unifiedWindows: we cannot say *which* limit is at
    // 80%, and a bar with no label is worse than no bar.
    expect(parseRateLimitInfo({ status: "allowed", utilization: 0.8 } as never)).toBeNull();
  });

  test("malformed input never throws", () => {
    for (const junk of [undefined, null, {}, 42, "allowed", { unifiedWindows: 5 }]) {
      expect(parseRateLimitInfo(junk as never)).toBeNull();
    }
  });

  test("skips window entries that carry no utilization", () => {
    const snapshot = parseRateLimitInfo({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.1, resetsAt: 1 },
        broken: { resetsAt: 2 },
      },
    } as never)!;
    expect(Object.keys(snapshot.windows)).toEqual(["five_hour"]);
  });
});

describe("rendering", () => {
  test("windows are ordered 5-hour first, unknown ones last", () => {
    const snapshot = parseRateLimitInfo({
      status: "allowed",
      unifiedWindows: {
        seven_day: { utilization: 0.9, resetsAt: 2 },
        some_future_window: { utilization: 0.1, resetsAt: 3 },
        five_hour: { utilization: 0.4, resetsAt: 1 },
      },
    } as never)!;

    expect(orderedWindows(snapshot).map(([name]) => name)).toEqual([
      "five_hour",
      "seven_day",
      "some_future_window",
    ]);
  });

  test("a non-zero utilization always shows at least one filled block", () => {
    // 1% rounds to zero blocks; rendering that identically to "unused" would
    // misreport a limit that is actually being consumed.
    expect(bar(0)).not.toContain("█");
    expect(bar(0.01)).toContain("█");
    expect(bar(1)).not.toContain("░");
    // Out-of-range values are clamped rather than overflowing the bar.
    expect(bar(1.5)).toHaveLength(bar(0.5).length);
    expect(bar(-1)).not.toContain("█");
  });

  test("colour tracks the worst window, and rejection always reads red", () => {
    const at = (utilization: number, status = "allowed") =>
      colorFor({ status, windows: { seven_day: { utilization } } });

    expect(at(0.2)).toBe(0x57f287);
    expect(at(0.7)).toBe(0xfee75c);
    expect(at(0.97)).toBe(0xed4245);
    // Low utilization but actively refused — the status wins.
    expect(at(0.1, "rejected")).toBe(0xed4245);
  });

  test("model breakdown sorts by cost and says so plainly when empty", () => {
    expect(formatModelUsage({})).toBe("Nothing yet this session.");
    // A model present but unused shouldn't take up a line.
    expect(formatModelUsage({ "claude-sonnet-5": { inputTokens: 0, outputTokens: 0 } })).toBe(
      "Nothing yet this session.",
    );

    const rendered = formatModelUsage({
      "claude-haiku-4-5-20251001": { inputTokens: 897, outputTokens: 8, costUSD: 0.000937 },
      "claude-sonnet-5": { inputTokens: 4, outputTokens: 6, costUSD: 0.112507 },
    });
    // Priciest first, and the date suffix trimmed off the model id.
    expect(rendered.indexOf("sonnet")).toBeLessThan(rendered.indexOf("haiku"));
    expect(rendered).toContain("claude-haiku-4-5");
    expect(rendered).not.toContain("20251001");
  });
});
