import { readFile, unlink } from "node:fs/promises";
import { PID_PATH } from "./constants.ts";
import { DAEMON_STATE_PATH } from "./state-file.ts";
import { getErrorMessage } from "./error.ts";

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
    console.error(`  Uptime: ${state.sessionUptimeSeconds}s`);
    console.error(
      `  Model: ${state.model ?? "Claude Code default"}` +
        (state.resolvedModel && state.resolvedModel !== state.model
          ? ` → ${state.resolvedModel}`
          : "") +
        (state.fallbackModel ? ` (fallback: ${state.fallbackModel})` : ""),
    );
    if (state.claudeCodeVersion) {
      console.error(`  Claude Code (bundled): ${state.claudeCodeVersion}`);
    }
    const sessions: { location: string; title: string; turns: number; contextTokens: number | null; busy: boolean }[] =
      state.sessions ?? [];
    console.error(`  Sessions: ${sessions.length}/${state.maxSessions}`);
    for (const s of sessions) {
      console.error(
        `    ${s.location} "${s.title}" · ${s.turns} turns` +
          (s.contextTokens ? ` · ${Math.round(s.contextTokens / 1000)}k context` : "") +
          (s.busy ? " · busy" : "")
      );
    }
    console.error(`  Cost: $${state.costUsd?.toFixed(4)}`);
    console.error(`  Cycles: ${state.totalCycles}`);
    console.error(`  Worker: ${state.workerHealth?.processAlive ? "alive" : "dead"}`);
    console.error(`  Updated: ${state.updatedAt}`);
  } catch {
    console.error("  State file not found");
  }

  process.exit(0);
}
