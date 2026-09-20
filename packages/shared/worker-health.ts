/**
 * Worker heartbeat contract — shared between the worker (writer) and the
 * daemon (reader).
 *
 * The daemon sits outside the worker's process tree (daemon → Agent SDK →
 * claude CLI → supervisor → worker), so there is no IPC channel between them.
 * A small file in the data dir is the only channel both sides can see.
 *
 * This replaces liveness-by-PID, which could only answer "does a process
 * exist". A worker whose Discord gateway had dropped, or whose event loop was
 * wedged, looked perfectly healthy under that check for as long as it stayed a
 * process. The heartbeat answers "is the worker actually doing its job".
 */

/** How often the worker rewrites its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How old a heartbeat may get before the worker counts as wedged — roughly
 * four missed beats, so a GC pause or a slow disk write doesn't trip it.
 */
export const HEARTBEAT_STALE_MS = 45_000;

export type WorkerHeartbeat = {
  /** Worker process id, for diagnostics. */
  pid: number;
  /**
   * A Discord token is configured. False means the bot was never set up — a
   * configuration problem, not a runtime fault, and one that restarting cannot
   * fix. The daemon must not cycle sessions over it.
   */
  discordConfigured: boolean;
  /** Discord client reports itself ready (gateway connected). */
  discordReady: boolean;
  /** Gateway round-trip in ms, or null when not connected. */
  wsPing: number | null;
  /** Epoch ms of the last Discord event the worker handled, if any. */
  lastEventAt: number | null;
  /** Epoch ms this heartbeat was written. */
  updatedAt: number;
};

export function workerHealthPath(dataDir: string): string {
  return `${dataDir}/meta/worker-health.json`;
}

/** True when the heartbeat is too old to trust. */
export function isHeartbeatStale(
  heartbeat: WorkerHeartbeat,
  now: number = Date.now(),
): boolean {
  return now - heartbeat.updatedAt > HEARTBEAT_STALE_MS;
}

/**
 * Narrow an unknown parsed JSON value to a heartbeat. Returns null for
 * anything malformed so a truncated or half-written file reads as "no
 * heartbeat" rather than throwing.
 */
export function parseWorkerHeartbeat(value: unknown): WorkerHeartbeat | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.updatedAt !== "number") return null;
  if (typeof raw.discordReady !== "boolean") return null;
  return {
    pid: typeof raw.pid === "number" ? raw.pid : 0,
    // Older workers didn't publish this; assume configured so their heartbeats
    // keep their previous meaning.
    discordConfigured:
      typeof raw.discordConfigured === "boolean" ? raw.discordConfigured : true,
    discordReady: raw.discordReady,
    wsPing: typeof raw.wsPing === "number" ? raw.wsPing : null,
    lastEventAt: typeof raw.lastEventAt === "number" ? raw.lastEventAt : null,
    updatedAt: raw.updatedAt,
  };
}
