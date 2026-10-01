/**
 * Regression tests for daemon session cycling and error classification.
 *
 * Replaces daemon-fallback.test.ts, which was deleted along with the
 * Anthropic→Ollama fallback. Covers what survived that removal: thresholds now
 * come from config.json via state.thresholds, and the error classifier is kept
 * to stop the retry loop on errors retrying cannot fix.
 */
import { describe, expect, test } from "bun:test";
import { createInitialState } from "../../daemon/lifecycle.ts";
import {
  isAnthropicError,
  isUnrecoverableAnthropicError,
} from "../../daemon/session-core.ts";
import { CYCLE_IDLE_DEBOUNCE_MS } from "../../daemon/constants.ts";
import {
  captureHandoffSummary,
  handleSessionMessage,
  hardCeiling,
  isIdleForCycle,
  markCyclePending,
  runPendingCycleIfIdle,
  shouldCycle,
} from "../../daemon/runtime.ts";
import type { MetaState } from "../../daemon/types.ts";

function activeState(turnThreshold = 80, tokenThreshold = 120_000): MetaState {
  const state = createInitialState({ turnThreshold, tokenThreshold });
  state.state = "ACTIVE";
  return state;
}

describe("shouldCycle", () => {
  test("uses the thresholds threaded in from config, not hardcoded constants", () => {
    const state = activeState(5, 1_000);

    state.turnCount = 4;
    expect(shouldCycle(state, 999)).toBe(false);

    state.turnCount = 5;
    expect(shouldCycle(state)).toBe(true);

    state.turnCount = 0;
    expect(shouldCycle(state, 1_000)).toBe(true);
    expect(shouldCycle(state, 999)).toBe(false);
  });

  test("never cycles unless the session is ACTIVE", () => {
    const state = activeState(5, 1_000);
    state.turnCount = 99;

    for (const phase of ["STARTING", "DRAINING", "CYCLING"] as const) {
      state.state = phase;
      expect(shouldCycle(state, 999_999)).toBe(false);
    }

    state.state = "ACTIVE";
    expect(shouldCycle(state, 999_999)).toBe(true);
  });

  test("token threshold is ignored when context usage is unavailable", () => {
    const state = activeState(80, 10);
    expect(shouldCycle(state)).toBe(false);
  });
});

describe("deferred cycling", () => {
  function idleState(): MetaState {
    const state = activeState();
    state.turnInFlight = false;
    state.lastActivityAt = Date.now() - CYCLE_IDLE_DEBOUNCE_MS - 1;
    return state;
  }

  test("idle only with no turn in flight, an empty queue, and the debounce elapsed", () => {
    const state = idleState();
    expect(isIdleForCycle(state, true)).toBe(true);

    expect(isIdleForCycle(state, false)).toBe(false);

    state.turnInFlight = true;
    expect(isIdleForCycle(state, true)).toBe(false);
    state.turnInFlight = false;

    state.lastActivityAt = Date.now() - CYCLE_IDLE_DEBOUNCE_MS + 1_000;
    expect(isIdleForCycle(state, true)).toBe(false);
  });

  test("never idle outside ACTIVE", () => {
    const state = idleState();
    for (const phase of ["STARTING", "DRAINING", "CYCLING"] as const) {
      state.state = phase;
      expect(isIdleForCycle(state, true)).toBe(false);
    }
  });

  test("stream output opens a turn and restarts the clock; any result closes it", () => {
    const state = idleState();

    handleSessionMessage(state, { type: "assistant", message: { content: [] } } as never);
    expect(state.turnInFlight).toBe(true);
    expect(isIdleForCycle(state, true)).toBe(false);

    handleSessionMessage(state, { type: "result", subtype: "error_during_execution" } as never);
    expect(state.turnInFlight).toBe(false);
    // Closed, but the debounce restarts from the result.
    expect(isIdleForCycle(state, true)).toBe(false);
    expect(isIdleForCycle(state, true, Date.now() + CYCLE_IDLE_DEBOUNCE_MS)).toBe(true);
  });

  test("a threshold crossing only marks the cycle pending", async () => {
    const state = activeState();
    state.turnInFlight = true;
    state.lastActivityAt = Date.now();

    markCyclePending(state, "token_threshold");
    expect(state.pendingCycleReason).toBe("token_threshold");

    // Busy: runPendingCycleIfIdle must leave the session alone.
    await runPendingCycleIfIdle(state, true);
    expect(state.state).toBe("ACTIVE");
    expect(state.totalCycles).toBe(0);

    // A second crossing doesn't overwrite the first reason.
    markCyclePending(state, "turn_threshold");
    expect(state.pendingCycleReason).toBe("token_threshold");
  });

  test("hard ceiling is 1.5x the threshold, capped below the real window", () => {
    const state = activeState(80, 120_000);
    expect(hardCeiling(state)).toBe(180_000);

    state.context.maxTokens = 150_000;
    expect(hardCeiling(state)).toBe(135_000);

    // Never below the soft threshold, however small the window.
    state.context.maxTokens = 100_000;
    expect(hardCeiling(state)).toBe(120_000);
  });

  test("handoff summary waits for the in-flight turn instead of taking its result", async () => {
    const state = activeState();
    state.session = {} as never;
    state.turnInFlight = true;
    const pushed: string[] = [];
    state.pushMessage = (msg) => {
      state.turnInFlight = true;
      pushed.push(String(msg.message.content));
    };

    const summary = captureHandoffSummary(state, 5_000);

    // The in-flight turn finishes first; its text must not become the summary.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushed).toHaveLength(0);
    handleSessionMessage(state, {
      type: "result",
      subtype: "success",
      num_turns: 3,
      total_cost_usd: 0,
      result: "Reading the mockup before I build the real version.",
    } as never);

    // Then the summary prompt goes out, and its own result is what's captured.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("handoff summary");
    handleSessionMessage(state, {
      type: "result",
      subtype: "success",
      num_turns: 1,
      total_cost_usd: 0,
      result: "## Handoff Summary",
    } as never);

    expect(await summary).toBe("## Handoff Summary");
  });
});

describe("isAnthropicError", () => {
  test("classifies API-side failures", () => {
    for (const msg of [
      "429: rate_limit exceeded",
      "Rate limit exceeded, try again later",
      "529: Overloaded",
      "402: payment required",
      "Billing issue: credit card declined",
      "quota exceeded: monthly limit reached",
      "401: unauthorized",
      "authentication_error: invalid API key",
    ]) {
      expect(isAnthropicError(new Error(msg))).toBe(true);
    }
  });

  test("does not classify transport failures", () => {
    for (const msg of [
      "ECONNRESET",
      "socket hang up",
      "ETIMEDOUT",
      "AbortError",
      "Session stream closed unexpectedly",
    ]) {
      expect(isAnthropicError(new Error(msg))).toBe(false);
    }
  });

  test("handles non-Error values", () => {
    expect(isAnthropicError("rate limit exceeded")).toBe(true);
    expect(isAnthropicError("network error")).toBe(false);
    expect(isAnthropicError(null)).toBe(false);
    expect(isAnthropicError(undefined)).toBe(false);
  });
});

describe("isUnrecoverableAnthropicError", () => {
  test("auth and billing failures stop the retry loop", () => {
    for (const msg of [
      "401: unauthorized",
      "402: payment required",
      "authentication_error: invalid API key",
      "Billing issue: credit card declined",
      "Credit limit exceeded for this month",
      "quota exceeded: monthly limit reached",
    ]) {
      expect(isUnrecoverableAnthropicError(new Error(msg))).toBe(true);
    }
  });

  test("rate limits and overload stay retryable — that is what backoff is for", () => {
    for (const msg of [
      "429: rate_limit exceeded",
      "Rate limit exceeded, try again later",
      "529: Overloaded",
      "API is overloaded, please retry",
    ]) {
      expect(isAnthropicError(new Error(msg))).toBe(true);
      expect(isUnrecoverableAnthropicError(new Error(msg))).toBe(false);
    }
  });

  test("transport failures stay retryable", () => {
    expect(isUnrecoverableAnthropicError(new Error("ECONNRESET"))).toBe(false);
    expect(isUnrecoverableAnthropicError(null)).toBe(false);
  });
});

describe("daily token accounting", () => {
  function successResult(inputTokens: number) {
    return {
      type: "result" as const,
      subtype: "success" as const,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: inputTokens },
      result: "",
    };
  }

  test("accumulates into tokenUsageToday, not just totalInputTokens", () => {
    const state = activeState();
    expect(state.tokenUsageToday.inputTokens).toBe(0);

    handleSessionMessage(state, successResult(100) as never);
    handleSessionMessage(state, successResult(250) as never);

    expect(state.totalInputTokens).toBe(350);
    expect(state.tokenUsageToday.inputTokens).toBe(350);
  });

  test("rolls over when the date changes", () => {
    const state = activeState();
    handleSessionMessage(state, successResult(100) as never);

    state.tokenUsageToday.date = "1999-12-31";
    handleSessionMessage(state, successResult(40) as never);

    expect(state.tokenUsageToday.date).not.toBe("1999-12-31");
    expect(state.tokenUsageToday.inputTokens).toBe(40);
  });

  test("survives a session cycle, unlike totalInputTokens", () => {
    const state = activeState();
    handleSessionMessage(state, successResult(500) as never);

    // startSession() resets per-session counters; the daily total must not be
    // one of them.
    state.totalInputTokens = 0;
    handleSessionMessage(state, successResult(25) as never);

    expect(state.totalInputTokens).toBe(25);
    expect(state.tokenUsageToday.inputTokens).toBe(525);
  });
});
