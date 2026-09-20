/**
 * PID file + process identification, shared by the supervisor's single-instance
 * guard and the daemon's worker health check.
 *
 * Both used to grep `ps` output for their own hardcoded substrings. When
 * `server.ts` was deleted and the supervisor's command line became
 * `bun packages/core/supervisor.ts`, the supervisor's list ("choomfie",
 * "server.ts") silently stopped matching anything — the single-instance guard
 * quietly became a no-op and two supervisors could run at once. One list, in
 * one place, with a test that derives the expected command from package.json.
 */

import { readFile } from "node:fs/promises";

/**
 * Substrings that identify a Choomfie process in a `ps -o command=` line.
 *
 * Entry-point filenames only — keep in sync with the scripts in package.json.
 * Deliberately NOT "choomfie": the data directory and repo are both named
 * that, so any command line mentioning a path under them (a script touching
 * meta/, a shell running from the repo) would match. If such a process ever
 * inherited a recycled PID from a stale PID file we would signal it, or refuse
 * to start on its behalf. bin/choomfie always exec's into `bun <entry>.ts`, so
 * matching the filenames loses nothing.
 */
export const CHOOMFIE_PROCESS_MARKERS = [
  "supervisor.ts",
  "worker.ts",
  "daemon.ts",
] as const;

/** The daemon's entry point specifically — used for "is a daemon supervising us". */
export const CHOOMFIE_DAEMON_MARKER = "daemon.ts";

export function isChoomfieCommand(command: string): boolean {
  if (!command) return false;
  return CHOOMFIE_PROCESS_MARKERS.some((marker) => command.includes(marker));
}

export function isChoomfieDaemonCommand(command: string): boolean {
  return Boolean(command) && command.includes(CHOOMFIE_DAEMON_MARKER);
}

/** Read a PID file, returning null when missing or unparseable. */
export async function readPidFile(path: string): Promise<number | null> {
  try {
    const pid = parseInt((await readFile(path, "utf-8")).trim(), 10);
    return pid && !Number.isNaN(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** The process's command line, or null if it isn't running. */
export async function processCommand(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const command = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

/** True when `pid` is alive AND looks like a Choomfie process. */
export async function isChoomfieProcessAlive(pid: number): Promise<boolean> {
  const command = await processCommand(pid);
  return command !== null && isChoomfieCommand(command);
}

/** Read a PID file and confirm it points at a live Choomfie process. */
export async function readLiveChoomfiePid(path: string): Promise<number | null> {
  return readLivePid(path, isChoomfieCommand);
}

/** Read a PID file and confirm it points at a live Choomfie *daemon*. */
export async function readLiveDaemonPid(path: string): Promise<number | null> {
  return readLivePid(path, isChoomfieDaemonCommand);
}

async function readLivePid(
  path: string,
  matches: (command: string) => boolean,
): Promise<number | null> {
  const pid = await readPidFile(path);
  if (pid === null) return null;
  const command = await processCommand(pid);
  return command !== null && matches(command) ? pid : null;
}
