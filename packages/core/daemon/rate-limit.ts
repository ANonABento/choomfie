/**
 * Normalising the SDK's rate-limit events into something worth persisting.
 *
 * `SDKRateLimitInfo` in the SDK's own `.d.ts` describes a single window —
 * `utilization`, `resetsAt`, `rateLimitType`. The payload that actually arrives
 * carries an undeclared `unifiedWindows` object holding *every* window at once:
 *
 *   { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.97,
 *     unifiedWindows: { five_hour: { utilization: 0.47, resetsAt: … },
 *                       seven_day: { utilization: 0.97, resetsAt: … } } }
 *
 * The flat fields describe whichever window is tightest, so reading only those
 * would report "97%" with no way to tell which limit that is or how the other
 * one is doing. We prefer `unifiedWindows` and fall back to the flat fields, so
 * this keeps working whichever shape a future CLI sends.
 */

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

export type RateLimitWindow = {
  /** 0–1. */
  utilization: number;
  /** Unix seconds, as the SDK sends it. Null when not reported. */
  resetsAt: number | null;
};

export type RateLimitSnapshot = {
  status: string | null;
  /** Keyed by window name: five_hour, seven_day, seven_day_opus, … */
  windows: Record<string, RateLimitWindow>;
  /** The window the flat fields were describing, when one was named. */
  tightest: string | null;
  isUsingOverage: boolean;
  overageStatus: string | null;
  /** Epoch ms this snapshot was received. */
  updatedAt: number;
};

function toWindow(value: unknown): RateLimitWindow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.utilization !== "number") return null;
  return {
    utilization: raw.utilization,
    resetsAt: typeof raw.resetsAt === "number" ? raw.resetsAt : null,
  };
}

export function parseRateLimitInfo(
  info: SDKRateLimitInfo | undefined,
  now: number = Date.now(),
): RateLimitSnapshot | null {
  if (!info || typeof info !== "object") return null;
  const raw = info as unknown as Record<string, unknown>;

  const windows: Record<string, RateLimitWindow> = {};

  const unified = raw.unifiedWindows;
  if (unified && typeof unified === "object") {
    for (const [name, value] of Object.entries(unified as Record<string, unknown>)) {
      const window = toWindow(value);
      if (window) windows[name] = window;
    }
  }

  // Fallback: no unifiedWindows, so the flat fields are all there is. Only
  // usable when the payload names which window they describe — an unlabelled
  // percentage is worse than none.
  if (Object.keys(windows).length === 0 && typeof raw.rateLimitType === "string") {
    const window = toWindow(raw);
    if (window) windows[raw.rateLimitType] = window;
  }

  if (Object.keys(windows).length === 0) return null;

  return {
    status: typeof raw.status === "string" ? raw.status : null,
    windows,
    tightest: typeof raw.rateLimitType === "string" ? raw.rateLimitType : null,
    isUsingOverage: raw.isUsingOverage === true,
    overageStatus:
      typeof raw.overageStatus === "string" ? raw.overageStatus : null,
    updatedAt: now,
  };
}
