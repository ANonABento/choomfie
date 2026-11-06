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
 * consumes it, and cycles. `/stop` interrupts the turn in flight instead.
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
 * A `/stop` goes stale much sooner: it means "the reply I'm watching", and a
 * leftover one must never cut off some later, unrelated turn.
 */
export const STOP_REQUEST_STALE_MS = 20_000;

/**
 * What happens to one location's session:
 *
 * - `compact` summarises it and carries on fresh with the summary (Claude Code's `/compact`)
 * - `stop` interrupts the turn in progress and keeps the session (Esc)
 * - `clear` / `resume` — the worker bound another chat here (a new one, or an
 *   earlier one); the daemon closes the old session and the next message opens
 *   the bound chat's (Claude Code's `/clear`, `--resume`)
 *
 * None touches memories, reminders or personas — those live in SQLite.
 */
export type DaemonControlCommand = "compact" | "clear" | "stop" | "resume";

const COMMANDS: readonly DaemonControlCommand[] = ["compact", "clear", "stop", "resume"];

export type DaemonControlRequest = {
  command: DaemonControlCommand;
  /** Epoch ms the request was written. */
  requestedAt: number;
  /** Discord user who asked, for the daemon log. */
  requestedBy?: string;
  /** `compact`: Discord channel to report back in once the new session is up. */
  chatId?: string;
  /**
   * The location (thread, channel, DM, group DM) whose session this is about.
   * For `clear` / `resume` the worker has already bound the new chat there.
   */
  location: string;
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

  if (!COMMANDS.includes(raw.command as DaemonControlCommand)) return null;
  if (typeof raw.requestedAt !== "number") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  // Every command acts on one location's session.
  const location = str(raw.location);
  if (!location) return null;

  const request: DaemonControlRequest = {
    command: raw.command as DaemonControlCommand,
    requestedAt: raw.requestedAt,
    requestedBy: str(raw.requestedBy),
    chatId: str(raw.chatId),
    location,
  };
  return request;
}

/** True when the request is too old to act on. */
export function isControlRequestStale(
  request: DaemonControlRequest,
  now: number = Date.now(),
): boolean {
  const limit = request.command === "stop" ? STOP_REQUEST_STALE_MS : CONTROL_REQUEST_STALE_MS;
  return now - request.requestedAt > limit;
}
