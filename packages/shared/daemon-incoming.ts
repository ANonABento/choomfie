/**
 * Inbound Discord message contract — shared between the worker (writer) and the
 * daemon (reader).
 *
 * The third leg of the file channel that `worker-health.ts` and
 * `daemon-control.ts` already run over. The worker sits two processes below the
 * daemon (daemon → Agent SDK → claude CLI → supervisor → worker), so a small
 * file in the data dir is the only channel both sides can see.
 *
 * Why this exists at all: in foreground mode an inbound Discord message travels
 * as a `notifications/claude/channel` MCP notification, and Claude Code turns it
 * into a prompt. That conversion is gated behind the experimental
 * `claude/channel` capability, and the only path that enables it for a session
 * driven through the Agent SDK — `Query.enableChannel()` — refuses any server
 * that is not marketplace-sourced, which a `{ type: "local" }` plugin can never
 * be. Daemon sessions therefore never registered the capability and every
 * message was dropped: the bot booted, went green, started typing, and answered
 * nothing.
 *
 * The capability was only ever a notification-to-prompt adapter, and the daemon
 * already owns the session's prompt queue. So in daemon mode the worker writes
 * the message here instead and the daemon injects it directly, producing the
 * same `<channel …>` prompt Claude Code would have produced. See
 * `packages/core/daemon/incoming.ts` for the reader and the formatter.
 *
 * One message per file, in a directory, rather than lines appended to one file:
 * it gives the same consume-once semantics as `control.json` (delete before
 * acting), ordering by filename, and no way to read a half-appended line.
 */

/**
 * How often the daemon sweeps the incoming queue.
 *
 * A person is waiting and the typing indicator is already running, so this is
 * far shorter than the health monitor's interval. A `readdir` of a directory
 * that is empty almost all of the time costs nothing, which is why this polls
 * rather than carrying the lifecycle of an `fs.watch` through session cycles.
 */
export const INCOMING_POLL_INTERVAL_MS = 1_000;

/**
 * Messages older than this are discarded unread.
 *
 * A message written while the daemon was down would otherwise be answered
 * whenever it next came up — replying to something said hours ago, in a
 * conversation that has moved on, reads as a malfunction. Generous enough to
 * survive a session cycle, which takes a handoff summary plus a 2s pause.
 */
export const INCOMING_MESSAGE_STALE_MS = 3 * 60_000;

/**
 * Most pending messages the worker will leave on disk.
 *
 * Nothing consumes the incoming queue when the daemon is not running, and the worker has
 * no way to know that. Without a cap, a busy channel would fill the data dir
 * with messages that staleness will discard anyway.
 */
export const INCOMING_MAX_PENDING = 50;

export type InboundMessage = {
  /** Message text, @mentions already stripped by the worker. */
  content: string;
  /** Flat string metadata — chat_id, user, role, attachments, and so on. */
  meta: Record<string, string>;
  /** Epoch ms the worker wrote this. */
  receivedAt: number;
};

export function daemonIncomingDir(dataDir: string): string {
  return `${dataDir}/meta/incoming`;
}

/**
 * Filename for one pending message.
 *
 * `receivedAt` leads so a plain lexicographic sort is chronological (epoch ms
 * stays 13 digits until the year 2286), and the Discord message id makes it
 * unique when two arrive in the same millisecond.
 */
export function inboundMessageFilename(
  receivedAt: number,
  messageId?: string,
): string {
  const suffix = (messageId ?? "").replace(/[^A-Za-z0-9_-]/g, "") ||
    Math.random().toString(36).slice(2, 10);
  return `${receivedAt}-${suffix}.json`;
}

/**
 * Narrow an unknown parsed JSON value to an inbound message. Returns null for
 * anything malformed, so a file the worker did not write reads as "nothing
 * pending" rather than throwing — the same contract `parseDaemonControlRequest`
 * offers.
 *
 * Non-string meta values are dropped rather than coerced: meta becomes XML
 * attributes downstream, and a nested object would stringify to `[object
 * Object]` in Claude's prompt.
 */
export function parseInboundMessage(value: unknown): InboundMessage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  if (typeof raw.content !== "string") return null;
  if (typeof raw.receivedAt !== "number") return null;

  const meta: Record<string, string> = {};
  if (raw.meta && typeof raw.meta === "object") {
    for (const [key, entry] of Object.entries(raw.meta as Record<string, unknown>)) {
      if (typeof entry === "string") meta[key] = entry;
    }
  }

  return { content: raw.content, meta, receivedAt: raw.receivedAt };
}

/** True when the message is too old to answer. */
export function isInboundMessageStale(
  message: InboundMessage,
  now: number = Date.now(),
): boolean {
  return now - message.receivedAt > INCOMING_MESSAGE_STALE_MS;
}

/**
 * True when this process was started by the daemon.
 *
 * The daemon injects `CHOOMFIE_DAEMON_PID` into its session's env
 * (`daemon/session-core.ts`) and the supervisor passes its whole env to the
 * worker, so the variable reaches every process in the tree. The worker uses it
 * to choose a delivery route: set means the channel capability is unavailable
 * and the incoming queue is the only path that works.
 *
 * Deliberately checks presence rather than liveness. It answers "who launched
 * me", which cannot change while the process runs; `isDaemonMode()` answers "is
 * a daemon alive right now", which is a different and slower question.
 */
export function isDaemonOwnedProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.CHOOMFIE_DAEMON_PID);
}
