/**
 * Daemon control contract — shared between the worker (writer) and the daemon
 * (reader).
 *
 * Same reasoning as worker-health.ts: the daemon sits outside the worker's
 * process tree (daemon → Agent SDK → claude CLI → supervisor → worker), so a
 * small file in the data dir is the only channel both sides can see. This one
 * runs the other way — the worker asks, the daemon acts.
 *
 * Only the daemon owns the Claude session, so only the daemon can replace it.
 * `/compact` and `/clear` in Discord write a request here; the daemon polls,
 * consumes it, and cycles.
 */

/** How often the daemon checks for a request. Short: a person is waiting. */
export const CONTROL_POLL_INTERVAL_MS = 2_000;

/**
 * Requests older than this are discarded unread.
 *
 * Without it, a `/compact` issued while the daemon is down would sit on disk
 * and cycle the *next* session seconds after it started — the user would see a
 * brand-new session throw itself away for a request they made yesterday.
 */
export const CONTROL_REQUEST_STALE_MS = 2 * 60_000;

/**
 * `compact` keeps a handoff summary (Claude Code's `/compact`); `clear` starts
 * the next session with nothing (Claude Code's `/clear`). Neither touches
 * memories, reminders or personas — those live in SQLite.
 */
export type DaemonControlCommand = "compact" | "clear";

export type DaemonControlRequest = {
  command: DaemonControlCommand;
  /** Epoch ms the request was written. */
  requestedAt: number;
  /** Discord user who asked, for the daemon log. */
  requestedBy?: string;
  /** Discord channel to report back in once the new session is up. */
  chatId?: string;
};

export function daemonControlPath(dataDir: string): string {
  return `${dataDir}/meta/control.json`;
}

/**
 * Narrow an unknown parsed JSON value to a request. Returns null for anything
 * malformed, so a truncated or half-written file reads as "no request" rather
 * than throwing — the same contract parseWorkerHeartbeat offers.
 */
export function parseDaemonControlRequest(
  value: unknown,
): DaemonControlRequest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  if (raw.command !== "compact" && raw.command !== "clear") return null;
  if (typeof raw.requestedAt !== "number") return null;

  return {
    command: raw.command,
    requestedAt: raw.requestedAt,
    requestedBy: typeof raw.requestedBy === "string" ? raw.requestedBy : undefined,
    chatId: typeof raw.chatId === "string" ? raw.chatId : undefined,
  };
}

/** True when the request is too old to act on. */
export function isControlRequestStale(
  request: DaemonControlRequest,
  now: number = Date.now(),
): boolean {
  return now - request.requestedAt > CONTROL_REQUEST_STALE_MS;
}
