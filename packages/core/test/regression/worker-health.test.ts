/**
 * Regression tests for the worker heartbeat.
 *
 * Replaces liveness-by-PID, which passed indefinitely for a worker that was
 * still a process but no longer connected to Discord.
 */
import { describe, expect, test } from "bun:test";
import {
  HEARTBEAT_STALE_MS,
  isHeartbeatStale,
  parseWorkerHeartbeat,
  workerHealthPath,
  type WorkerHeartbeat,
} from "@choomfie/shared";

function beat(overrides: Partial<WorkerHeartbeat> = {}): WorkerHeartbeat {
  return {
    pid: 1234,
    discordConfigured: true,
    discordReady: true,
    wsPing: 42,
    lastEventAt: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("workerHealthPath", () => {
  test("lives under the data dir's meta/ alongside the other daemon state", () => {
    expect(workerHealthPath("/data")).toBe("/data/meta/worker-health.json");
  });
});

describe("isHeartbeatStale", () => {
  test("a fresh beat is not stale", () => {
    expect(isHeartbeatStale(beat())).toBe(false);
  });

  test("tolerates a few missed beats before declaring staleness", () => {
    const now = Date.now();
    const almost = beat({ updatedAt: now - (HEARTBEAT_STALE_MS - 1_000) });
    expect(isHeartbeatStale(almost, now)).toBe(false);
  });

  test("a beat older than the stale window is stale", () => {
    const now = Date.now();
    const old = beat({ updatedAt: now - (HEARTBEAT_STALE_MS + 1_000) });
    expect(isHeartbeatStale(old, now)).toBe(true);
  });
});

describe("parseWorkerHeartbeat", () => {
  test("round-trips a well-formed heartbeat", () => {
    const original = beat({ lastEventAt: 1_700_000_000_000 });
    expect(parseWorkerHeartbeat(JSON.parse(JSON.stringify(original)))).toEqual(
      original,
    );
  });

  test("rejects malformed values rather than throwing", () => {
    // A truncated or half-written file must read as "no heartbeat", so the
    // daemon falls back to the process check instead of crashing.
    expect(parseWorkerHeartbeat(null)).toBeNull();
    expect(parseWorkerHeartbeat(undefined)).toBeNull();
    expect(parseWorkerHeartbeat("{}")).toBeNull();
    expect(parseWorkerHeartbeat({})).toBeNull();
    expect(parseWorkerHeartbeat({ updatedAt: Date.now() })).toBeNull();
    expect(parseWorkerHeartbeat({ discordReady: true })).toBeNull();
  });

  test("defaults optional numeric fields instead of dropping the beat", () => {
    const parsed = parseWorkerHeartbeat({
      discordReady: false,
      updatedAt: 1_000,
    });
    expect(parsed).toEqual({
      pid: 0,
      discordConfigured: true,
      discordReady: false,
      wsPing: null,
      lastEventAt: null,
      updatedAt: 1_000,
    });
  });

  test("a disconnected gateway is still a valid, parseable heartbeat", () => {
    // This is the case liveness-by-PID missed entirely: the worker is alive
    // and writing, but is not doing its job.
    const parsed = parseWorkerHeartbeat(beat({ discordReady: false, wsPing: null }));
    expect(parsed?.discordReady).toBe(false);
    expect(isHeartbeatStale(parsed!)).toBe(false);
  });
});

describe("unconfigured worker", () => {
  test("missing token is reported but must not be treated as restartable", () => {
    // Regression: a permanently-false discordReady would make the daemon cycle
    // the session every ~90s forever, since a restart cannot produce a token.
    const parsed = parseWorkerHeartbeat(beat({ discordConfigured: false, discordReady: false }));
    expect(parsed?.discordConfigured).toBe(false);
    expect(isHeartbeatStale(parsed!)).toBe(false);
  });

  test("heartbeats from older workers default to configured", () => {
    const parsed = parseWorkerHeartbeat({
      pid: 1,
      discordReady: true,
      updatedAt: Date.now(),
    });
    expect(parsed?.discordConfigured).toBe(true);
  });
});
