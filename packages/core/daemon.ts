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
import { RESTART_EXIT_CODE, runDaemon } from "./daemon/hub.ts";
import { showStatus, stopDaemon } from "./daemon/cli.ts";
import { getErrorMessage } from "./daemon/error.ts";
import type { DaemonSettings } from "./daemon/types.ts";

/** Set on the daemon a keeper started, so it doesn't start a keeper of its own. */
const KEPT_ENV = "CHOOMFIE_DAEMON_KEPT";

/** launchd starts it again after a restart (`KeepAlive`, install-launchd.sh); a terminal doesn't. */
function underLaunchd(): boolean {
  return process.ppid === 1 || (process.env.XPC_SERVICE_NAME ?? "").startsWith("dev.choomfie");
}

/**
 * Run from a terminal, `/restart` would exit the daemon for good: it exits
 * with RESTART_EXIT_CODE expecting launchd to start it again. So here this
 * process becomes a small keeper that runs the daemon as its child and starts
 * it again on that exit code, in the same terminal. Any other exit ends both.
 * Ctrl-C reaches the child directly (same process group); SIGTERM/SIGHUP are passed on.
 */
async function keep(): Promise<never> {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  process.on("SIGINT", () => {}); // the child got it too, and shuts down cleanly
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => child?.kill(sig));
  for (;;) {
    child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      env: { ...process.env, [KEPT_ENV]: "1" },
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await child.exited;
    if (code !== RESTART_EXIT_CODE) process.exit(code ?? 0);
    log("Starting again on the code on disk");
  }
}

async function main(): Promise<void> {
  if (FLAG_STOP) return stopDaemon();
  if (FLAG_STATUS) return showStatus();
  if (!process.env[KEPT_ENV] && !underLaunchd()) return void (await keep());

  // Daemon settings live in config.json (the single settings source for every
  // mode). Resolved here, at the entry point. Thresholds are daemon-only; the
  // model is shared with foreground mode and lives at the top level of
  // config.json, so it is read separately.
  const config = new ConfigManager(DATA_DIR);
  const settings: DaemonSettings = {
    ...config.getDaemonConfig(),
    model: config.getModel(),
    fallbackModel: config.getFallbackModel(),
    effort: config.getEffort(),
  };

  log("Choomfie daemon starting...");
  log(`Plugin directory: ${PLUGIN_DIR}`);
  log(`Data directory: ${DATA_DIR}`);
  log(`Thresholds: ${settings.tokenThreshold} tokens, ${settings.turnThreshold} turns; up to ${settings.maxSessions} sessions`);
  log(
    `Model: ${settings.model ?? "Claude Code default"}` +
      (settings.fallbackModel ? ` (fallback: ${settings.fallbackModel})` : "") +
      `, effort ${settings.effort}`
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
