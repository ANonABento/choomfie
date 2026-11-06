#!/usr/bin/env bun
/**
 * Choomfie Daemon — autonomous mode entry point.
 *
 * The implementation lives under ./daemon so this file stays a small CLI
 * runner for the package entrypoint.
 */

import { ConfigManager } from "./lib/config.ts";
import { DATA_DIR, PLUGIN_DIR, WORKER_HEALTH_INTERVAL, WORKER_MAX_CONSECUTIVE_FAILURES } from "./daemon/constants.ts";
import { FLAG_STATUS, FLAG_STOP, FLAG_VERBOSE } from "./daemon/flags.ts";
import { log } from "./daemon/log.ts";
import { acquirePid } from "./daemon/pid.ts";
import { runDaemon } from "./daemon/hub.ts";
import { showStatus, stopDaemon } from "./daemon/cli.ts";
import { getErrorMessage } from "./daemon/error.ts";
import type { DaemonSettings } from "./daemon/types.ts";

async function main(): Promise<void> {
  if (FLAG_STOP) return stopDaemon();
  if (FLAG_STATUS) return showStatus();

  // Daemon settings live in config.json (the single settings source for every
  // mode). Resolved here, at the entry point. Thresholds are daemon-only; the
  // model is shared with foreground mode and lives at the top level of
  // config.json, so it is read separately.
  const config = new ConfigManager(DATA_DIR);
  const settings: DaemonSettings = {
    ...config.getDaemonConfig(),
    model: config.getModel(),
    fallbackModel: config.getFallbackModel(),
  };

  log("Choomfie daemon starting...");
  log(`Plugin directory: ${PLUGIN_DIR}`);
  log(`Data directory: ${DATA_DIR}`);
  log(`Thresholds: ${settings.tokenThreshold} tokens, ${settings.turnThreshold} turns; up to ${settings.maxSessions} sessions`);
  log(
    `Model: ${settings.model ?? "Claude Code default"}` +
      (settings.fallbackModel ? ` (fallback: ${settings.fallbackModel})` : "")
  );
  log(
    `Worker health: check every ${WORKER_HEALTH_INTERVAL / 1000}s, ` +
      `max ${WORKER_MAX_CONSECUTIVE_FAILURES} failures before restart`
  );
  if (FLAG_VERBOSE) log("Verbose logging enabled");

  await acquirePid();
  log(`PID ${process.pid} acquired`);
  await runDaemon(settings);
  await new Promise(() => {});
}

main().catch((error: unknown) => {
  log(`Fatal error: ${getErrorMessage(error)}`);
  console.error(error);
  process.exit(1);
});
