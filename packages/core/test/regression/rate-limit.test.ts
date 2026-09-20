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
  buildEmbed,
  colorFor,
  formatModelUsage,
  orderedWindows,
} from "../../lib/handlers/usage-command.ts";
import {
  isRateLimitStale,
  peakUtilization,
  viewRateLimitWindows,
} from "../../lib/daemon-status.ts";
import {
  buildAlertMessage,
  decideAlert,
  shouldNotify,
  type AlertRecord,
} from "../../lib/rate-limit-alerts.ts";

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

    expect(orderedWindows(snapshot).map((w) => w.name)).toEqual([
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

/**
 * The numbers here are the ones the live daemon was actually holding: a 97%
 * seven-day window captured at 12:04, still being rendered at 23:00 as "97% ·
 * resets 7 hours ago". The window had rolled over overnight; the session had
 * simply taken no turn since, and `rate_limit_event` only arrives on a turn.
 */
describe("a snapshot that has stopped describing the present", () => {
  const CAPTURED_AT = 1789905884292; // 12:04 UTC
  const RESETS_AT = 1789920000; // 16:00 UTC
  const NOW = 1789945222000; // 23:00 UTC — 10.9h after capture, 7h after reset

  const snapshot = {
    status: "allowed_warning",
    windows: { seven_day: { utilization: 0.97, resetsAt: RESETS_AT } },
    tightest: "seven_day",
    updatedAt: CAPTURED_AT,
  };

  test("a window whose reset has passed is marked expired, not reported at 97%", () => {
    const [week] = viewRateLimitWindows(snapshot, ["seven_day"], NOW);
    expect(week.expired).toBe(true);

    // And at 15:59, one second before the reset, it is still live.
    const [before] = viewRateLimitWindows(snapshot, ["seven_day"], RESETS_AT * 1000 - 1000);
    expect(before.expired).toBe(false);
  });

  test("peak utilization is null when every window has expired", () => {
    // Not 0: "we don't know" and "plenty left" are different answers, and only
    // one of them should keep the embed green.
    expect(peakUtilization(viewRateLimitWindows(snapshot, [], NOW))).toBeNull();
    expect(peakUtilization(viewRateLimitWindows(snapshot, [], CAPTURED_AT))).toBe(0.97);
  });

  test("staleness is measured from when the daemon last heard, not the reset", () => {
    expect(isRateLimitStale(snapshot, NOW)).toBe(true);
    expect(isRateLimitStale(snapshot, CAPTURED_AT + 60_000)).toBe(false);
    // A snapshot with no timestamp can't be judged stale.
    expect(isRateLimitStale({ windows: {} }, NOW)).toBe(false);
  });

  test("the embed says reset instead of drawing a full red bar", () => {
    const rendered = JSON.stringify(buildEmbed({ rateLimit: snapshot }, NOW).toJSON());

    expect(rendered).toContain("reset");
    expect(rendered).toContain("before it rolled over");
    // The headline claim is gone: no live percentage, and not red.
    expect(rendered).not.toContain("**97%**");
    expect(colorFor(snapshot, NOW)).not.toBe(0xed4245);
    // And the reader is told why the figures stopped moving.
    expect(rendered).toContain("stale");
  });

  test("an 11-hour-old `rejected` no longer claims you are rate limited now", () => {
    const rejected = { ...snapshot, status: "rejected" };
    const stale = JSON.stringify(buildEmbed({ rateLimit: rejected }, NOW).toJSON());
    expect(stale).not.toContain("Rate limited right now");

    // Fresh, it must still say so as loudly as ever.
    const fresh = {
      status: "rejected",
      windows: { seven_day: { utilization: 1, resetsAt: NOW / 1000 + 3600 } },
      updatedAt: NOW - 1000,
    };
    const live = JSON.stringify(buildEmbed({ rateLimit: fresh }, NOW).toJSON());
    expect(live).toContain("Rate limited right now");
    expect(colorFor(fresh, NOW)).toBe(0xed4245);
  });
});

describe("owner alerts", () => {
  const NOW = 1789945222000;
  const soon = NOW / 1000 + 3600;
  const view = (utilization: number, name = "seven_day") =>
    viewRateLimitWindows(
      { windows: { [name]: { utilization, resetsAt: soon } } },
      [],
      NOW,
    );

  test("warns at 90% and stays quiet below it", () => {
    expect(decideAlert(view(0.89), "allowed_warning", false)).toBeNull();
    expect(decideAlert(view(0.9), "allowed_warning", false)?.level).toBe("warning");
  });

  test("a refusal outranks the percentage", () => {
    // Overage or a per-model cap can refuse at a low headline number.
    expect(decideAlert(view(0.1), "rejected", false)?.level).toBe("rejected");
  });

  test("never fires on a stale snapshot", () => {
    // This is the DM version of the bug above, and the one that can't be
    // dismissed — an alert saying "you're rate limited" hours after you weren't.
    expect(decideAlert(view(0.97), "rejected", true)).toBeNull();
  });

  test("never fires on a window that has already reset", () => {
    const expired = viewRateLimitWindows(
      { windows: { seven_day: { utilization: 0.97, resetsAt: NOW / 1000 - 3600 } } },
      [],
      NOW,
    );
    expect(decideAlert(expired, "allowed_warning", false)).toBeNull();
  });

  test("reports against the tightest window, not the first", () => {
    const mixed = viewRateLimitWindows(
      {
        windows: {
          five_hour: { utilization: 0.4, resetsAt: soon },
          seven_day: { utilization: 0.95, resetsAt: soon },
        },
      },
      ["five_hour", "seven_day"],
      NOW,
    );
    expect(decideAlert(mixed, "allowed_warning", false)?.window.name).toBe("seven_day");
  });

  test("does not repeat itself, but does escalate", () => {
    const warning = decideAlert(view(0.95), "allowed_warning", false)!;
    const last: AlertRecord = { level: "warning", key: warning.key, notifiedAt: NOW };

    // The worker is respawned on every session cycle — an in-memory flag would
    // re-send this each time, which is why the record is on disk.
    expect(shouldNotify(warning, last)).toBe(false);
    expect(shouldNotify(warning, null)).toBe(true);

    const rejected = decideAlert(view(0.99), "rejected", false)!;
    expect(shouldNotify(rejected, last)).toBe(true);
    // But not twice.
    expect(shouldNotify(rejected, { ...last, level: "rejected" })).toBe(false);
  });

  test("a rolled-over window earns a fresh alert", () => {
    // Same window name, new period: the key carries resetsAt precisely so next
    // week's 95% isn't deduped against last week's.
    const lastWeek = decideAlert(view(0.95), "allowed_warning", false)!;
    const nextWeek = viewRateLimitWindows(
      { windows: { seven_day: { utilization: 0.95, resetsAt: soon + 604_800 } } },
      [],
      NOW,
    );
    const decision = decideAlert(nextWeek, "allowed_warning", false)!;
    expect(decision.key).not.toBe(lastWeek.key);
    expect(
      shouldNotify(decision, { level: "warning", key: lastWeek.key, notifiedAt: NOW }),
    ).toBe(true);
  });

  test("the message names the window, the number, and what it means for you", () => {
    const [window] = view(0.94);
    const warning = buildAlertMessage("warning", window);
    expect(warning).toContain("Weekly");
    expect(warning).toContain("94%");
    expect(warning).toContain(`<t:${Math.floor(soon)}:R>`);

    const rejected = buildAlertMessage("rejected", window);
    // The one thing the owner needs to know that /usage can't tell them.
    expect(rejected).toContain("won't be queued");
  });
});
