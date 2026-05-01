import { readFile, unlink } from "node:fs/promises";
import { ANTHROPIC_FALLBACK_THRESHOLD, OLLAMA_MODEL, PID_PATH } from "./constants.ts";
import { loadHandoffs } from "./handoffs.ts";
import { cleanup, createInitialState, setupShutdown } from "./lifecycle.ts";
import { log } from "./log.ts";
import { acquirePid } from "./pid.ts";
import { cycleSession, startSession, waitForResult } from "./runtime.ts";
import { applyAnthropicFailure, isAnthropicError } from "./session-core.ts";
import { DAEMON_STATE_PATH } from "./state-file.ts";
import { getErrorMessage } from "./error.ts";
import type { MetaState } from "./types.ts";

async function withCliSession(
  run: (state: MetaState) => Promise<number | void>
): Promise<void> {
  await acquirePid();
  const state = createInitialState();
  setupShutdown(state);

  try {
    await startSession(state);
    const exitCode = ((await run(state)) ?? 0) as number;
    await cleanup(state);
    process.exit(exitCode as number);
  } catch (error: unknown) {
    log(`CLI session failed: ${getErrorMessage(error)}`);
    await cleanup(state);
    process.exit(1);
  }
}

export async function testCycle(): Promise<void> {
  log("=== TEST: Session Cycling ===");
  await withCliSession(async (state) => {
    log("Sending test message...");
    state.pushMessage?.({
      type: "user",
      message: {
        role: "user",
        content: "Say hello and tell me your current persona name. Keep it brief.",
      },
      parent_tool_use_id: null,
    });

    log("Waiting for response...");
    try {
      const result = await waitForResult(state, 30_000);
      log(`Got response: ${result.result?.slice(0, 200)}`);
    } catch (error: unknown) {
      log(`Response wait failed: ${getErrorMessage(error)}`);
    }

    log("Waiting 10s before triggering cycle...");
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    log("Triggering manual cycle...");
    const preCycleTurns = state.turnCount;
    state.lastCycleReason = "manual_test";
    await cycleSession(state, state.totalInputTokens);

    if (state.state !== "ACTIVE") {
      log("FAIL: Session did not reach ACTIVE state after cycle");
      return 1;
    }

    const handoffs = await loadHandoffs();
    const lastHandoff = handoffs[handoffs.length - 1];
    if (!lastHandoff) {
      log("FAIL: No handoff entry found");
      return 1;
    }

    log(`Handoff summary (first 200 chars): ${lastHandoff.summary.slice(0, 200)}`);

    const isGenericFallback = lastHandoff.summary.startsWith("Session cycled at");
    if (isGenericFallback) {
      log("WARN: Got generic fallback summary — handoff capture may not have worked");
    } else {
      log("OK: Got meaningful handoff summary");
    }

    log("Sending post-cycle message...");
    state.pushMessage?.({
      type: "user",
      message: {
        role: "user",
        content:
          "Do you have any handoff context from a previous session? Just say yes or no briefly.",
      },
      parent_tool_use_id: null,
    });

    try {
      const result = await waitForResult(state, 30_000);
      log(`Post-cycle response: ${result.result?.slice(0, 200)}`);
    } catch (error: unknown) {
      log(`Post-cycle response wait failed: ${getErrorMessage(error)}`);
    }

    log(`Turns before cycle: ${preCycleTurns}, after cycle reset to: ${state.turnCount}`);
    log("=== TEST COMPLETE: Session Cycling ===");
  });
}

export async function benchmark(): Promise<void> {
  log("=== BENCHMARK: Latency Measurement ===");
  await withCliSession(async (state) => {
    const NUM_MESSAGES = 5;
    const latencies: number[] = [];

    for (let i = 0; i < NUM_MESSAGES; i++) {
      log(`Message ${i + 1}/${NUM_MESSAGES}...`);
      const start = performance.now();

      state.pushMessage?.({
        type: "user",
        message: {
          role: "user",
          content: "Respond with exactly the word 'ok' and nothing else.",
        },
        parent_tool_use_id: null,
      });

      try {
        await waitForResult(state, 60_000);
        const elapsed = performance.now() - start;
        latencies.push(elapsed);
        log(`  Latency: ${elapsed.toFixed(0)}ms`);
      } catch (error: unknown) {
        log(`  FAILED: ${getErrorMessage(error)}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (latencies.length === 0) {
      log("FAIL: No successful responses");
      return 1;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];

    log("=== BENCHMARK RESULTS ===");
    log(`  Messages:  ${latencies.length}/${NUM_MESSAGES} successful`);
    log(`  Average:   ${avg.toFixed(0)}ms`);
    log(`  P50:       ${p50.toFixed(0)}ms`);
    log(`  P95:       ${p95.toFixed(0)}ms`);
    log(`  Min:       ${sorted[0].toFixed(0)}ms`);
    log(`  Max:       ${sorted[sorted.length - 1].toFixed(0)}ms`);
    log("=========================");
  });
}

export async function stopDaemon(): Promise<void> {
  try {
    const pidStr = await readFile(PID_PATH, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);
    if (!pid || Number.isNaN(pid)) {
      console.error("No daemon PID found");
      process.exit(1);
    }

    try {
      process.kill(pid, 0);
    } catch {
      console.error(`Daemon PID ${pid} is not running (stale PID file)`);
      await unlink(PID_PATH).catch(() => {});
      process.exit(1);
    }

    console.error(`Sending SIGTERM to daemon (PID ${pid})...`);
    process.kill(pid, "SIGTERM");

    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        process.kill(pid, 0);
      } catch {
        console.error("Daemon stopped");
        process.exit(0);
      }
    }

    console.error("Daemon didn't stop gracefully, sending SIGKILL...");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
    await unlink(PID_PATH).catch(() => {});
    console.error("Daemon killed");
    process.exit(0);
  } catch (error: unknown) {
    console.error(`Failed to stop daemon: ${getErrorMessage(error)}`);
    process.exit(1);
  }
}

/**
 * Simulate Anthropic API failures and verify the daemon switches to Ollama.
 * Does not require a live Claude Code session or real API credentials.
 *
 * Usage: bun daemon.ts --test-fallback
 */
export async function testFallback(): Promise<void> {
  log("=== TEST: Anthropic → Ollama Fallback ===");

  await acquirePid();
  const state = createInitialState();
  setupShutdown(state);

  let allPassed = true;

  // 1. Verify initial state
  if (state.activeProvider !== "anthropic") {
    log(`FAIL: Expected initial provider 'anthropic', got '${state.activeProvider}'`);
    allPassed = false;
  } else {
    log("OK: Initial provider is 'anthropic'");
  }

  if (state.anthropicFailureCount !== 0) {
    log(`FAIL: Expected initial anthropicFailureCount 0, got ${state.anthropicFailureCount}`);
    allPassed = false;
  } else {
    log("OK: Initial anthropicFailureCount is 0");
  }

  // 2. Verify error classification
  const cases: Array<[string, boolean]> = [
    ["429 rate_limit_error: Too many requests", true],
    ["overloaded_error: Claude is temporarily overloaded", true],
    ["402 Payment Required: billing issue", true],
    ["credit balance is too low", true],
    ["authentication_error: invalid api key", true],
    ["ECONNRESET", false],
    ["Connection timeout after 30s", false],
    ["spawn ENOENT", false],
  ];

  for (const [msg, expected] of cases) {
    const result = isAnthropicError(new Error(msg));
    const passed = result === expected;
    log(`${passed ? "OK" : "FAIL"}: isAnthropicError("${msg.slice(0, 60)}") = ${result}`);
    if (!passed) allPassed = false;
  }

  // 3. Simulate threshold errors and verify provider switch
  log(`\nSimulating ${ANTHROPIC_FALLBACK_THRESHOLD} consecutive Anthropic errors...`);

  const rateLimitError = new Error("429: rate_limit exceeded");
  for (let i = 1; i <= ANTHROPIC_FALLBACK_THRESHOLD; i++) {
    applyAnthropicFailure(state, rateLimitError);
    log(
      `  Error ${i}: provider=${state.activeProvider}, failureCount=${state.anthropicFailureCount}`
    );
  }

  if (state.activeProvider !== "ollama") {
    log(
      `FAIL: Expected provider 'ollama' after ${ANTHROPIC_FALLBACK_THRESHOLD} errors, got '${state.activeProvider}'`
    );
    allPassed = false;
  } else {
    log(`OK: Provider switched to 'ollama' (model: ${OLLAMA_MODEL})`);
  }

  // 4. Verify count resets after switch
  if (state.anthropicFailureCount !== 0) {
    log(`FAIL: anthropicFailureCount should reset to 0 after switch, got ${state.anthropicFailureCount}`);
    allPassed = false;
  } else {
    log("OK: anthropicFailureCount reset to 0 after switch");
  }

  // 5. Summary
  if (allPassed) {
    log("=== TEST PASSED: Anthropic → Ollama Fallback ===");
    await cleanup(state);
    process.exit(0);
  } else {
    log("=== TEST FAILED: Anthropic → Ollama Fallback ===");
    await cleanup(state);
    process.exit(1);
  }
}

export async function showStatus(): Promise<void> {
  let daemonPid: number | null = null;
  let running = false;
  try {
    const pidStr = await readFile(PID_PATH, "utf-8");
    daemonPid = parseInt(pidStr.trim(), 10);
    try {
      process.kill(daemonPid, 0);
      running = true;
    } catch {
      running = false;
    }
  } catch {
    console.error("Daemon: not running (no PID file)");
    process.exit(0);
  }

  if (!running) {
    console.error(`Daemon: not running (stale PID ${daemonPid})`);
    process.exit(0);
  }

  try {
    const proc = Bun.spawn(["ps", "-p", String(daemonPid), "-o", "etime=,rss=,command="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    console.error(`Daemon: running (PID ${daemonPid})`);
    console.error(`  Process: ${output}`);
  } catch {
    // Status works without ps details.
  }

  try {
    const stateData = await readFile(DAEMON_STATE_PATH, "utf-8");
    const state = JSON.parse(stateData);
    console.error(`  State: ${state.state}`);
    console.error(`  Session: ${state.sessionId}`);
    console.error(`  Uptime: ${state.sessionUptimeSeconds}s`);
    console.error(`  Turns: ${state.turns?.current}/${state.turns?.threshold}`);
    console.error(`  Tokens: ${state.tokens?.current}/${state.tokens?.threshold}`);
    console.error(`  Cost: $${state.costUsd?.toFixed(4)}`);
    console.error(`  Cycles: ${state.totalCycles}`);
    console.error(`  Provider: ${state.activeProvider ?? "anthropic"}`);
    console.error(`  Worker: ${state.workerHealth?.processAlive ? "alive" : "dead"}`);
    console.error(`  Updated: ${state.updatedAt}`);
  } catch {
    console.error("  State file not found");
  }

  process.exit(0);
}
