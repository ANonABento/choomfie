#!/usr/bin/env bun
/**
 * Choomfie Daemon — autonomous mode entry point.
 *
 * The implementation lives under ./daemon so this file stays as a small CLI
 * runner for the package entrypoint.
 */

import { ConfigManager } from "./lib/config.ts";
import {
  DATA_DIR,
  PLUGIN_DIR,
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
import type { DaemonSettings } from "./daemon/types.ts";

async function main(): Promise<void> {
  if (FLAG_STOP) return stopDaemon();
  if (FLAG_STATUS) return showStatus();

  // Daemon settings live in config.json (the single settings source for every
  // mode). Resolved here, at the entry point, so daemon/ never imports lib/.
  // Thresholds are daemon-only; the model is shared with foreground mode and
  // lives at the top level of config.json, so it is read separately.
  const config = new ConfigManager(DATA_DIR);
  const settings: DaemonSettings = {
    ...config.getDaemonConfig(),
    model: config.getModel(),
    fallbackModel: config.getFallbackModel(),
  };

  if (FLAG_TEST_CYCLE) return testCycle(settings);
  if (FLAG_BENCHMARK) return benchmark(settings);

  log("Choomfie daemon starting...");
  log(`Plugin directory: ${PLUGIN_DIR}`);
  log(`Data directory: ${DATA_DIR}`);
  log(
    `Thresholds: ${settings.tokenThreshold} tokens, ` +
      `${settings.turnThreshold} turns`
  );
  log(
    `Model: ${settings.model ?? "Claude Code default"}` +
      (settings.fallbackModel ? ` (fallback: ${settings.fallbackModel})` : "")
  );
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

  const state = createInitialState(settings);
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
