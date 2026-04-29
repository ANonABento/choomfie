#!/usr/bin/env bun
/**
 * Choomfie Daemon — autonomous mode entry point.
 *
 * The implementation lives under ./daemon so this file stays as a small CLI
 * runner for the package entrypoint.
 */

import {
  DATA_DIR,
  PLUGIN_DIR,
  TOKEN_THRESHOLD,
  TURN_THRESHOLD,
  WORKER_HEALTH_INTERVAL,
  WORKER_MAX_CONSECUTIVE_FAILURES,
} from "./daemon/constants.ts";
import {
  FLAG_BENCHMARK,
  FLAG_STATUS,
  FLAG_STOP,
  FLAG_TEST_CYCLE,
  FLAG_VERBOSE,
} from "./daemon/flags.ts";
import { loadHandoffs, getLastHandoffSummary } from "./daemon/handoffs.ts";
import { createInitialState, setupShutdown } from "./daemon/lifecycle.ts";
import { log } from "./daemon/log.ts";
import { acquirePid } from "./daemon/pid.ts";
import { startSession } from "./daemon/runtime.ts";
import {
  benchmark,
  showStatus,
  stopDaemon,
  testCycle,
} from "./daemon/cli.ts";
import { getErrorMessage } from "./daemon/error.ts";

async function main(): Promise<void> {
  if (FLAG_STOP) return stopDaemon();
  if (FLAG_STATUS) return showStatus();
  if (FLAG_TEST_CYCLE) return testCycle();
  if (FLAG_BENCHMARK) return benchmark();

  log("Choomfie daemon starting...");
  log(`Plugin directory: ${PLUGIN_DIR}`);
  log(`Data directory: ${DATA_DIR}`);
  log(`Thresholds: ${TOKEN_THRESHOLD} tokens, ${TURN_THRESHOLD} turns`);
  log(
    `Worker health: check every ${WORKER_HEALTH_INTERVAL / 1000}s, ` +
      `max ${WORKER_MAX_CONSECUTIVE_FAILURES} failures before recovery`
  );
  if (FLAG_VERBOSE) log("Verbose logging enabled");

  await acquirePid();
  log(`PID ${process.pid} acquired`);

  const handoffs = await loadHandoffs();
  const lastSummary = getLastHandoffSummary(handoffs);
  if (lastSummary) {
    log(`Found previous handoff summary (${handoffs.length} total)`);
  }

  const state = createInitialState();
  setupShutdown(state);
  await startSession(state, lastSummary);

  log("Daemon running. Press Ctrl+C to stop.");
  await new Promise(() => {});
}

main().catch((error: unknown) => {
  log(`Fatal error: ${getErrorMessage(error)}`);
  console.error(error);
  process.exit(1);
});
