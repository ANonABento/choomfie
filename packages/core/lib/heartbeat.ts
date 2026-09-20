/**
 * Worker heartbeat writer.
 *
 * Publishes worker liveness + Discord gateway state to a file the daemon can
 * read. See @choomfie/shared's worker-health.ts for the contract and why a file
 * rather than IPC.
 */

import { unlink } from "node:fs/promises";
import {
  HEARTBEAT_INTERVAL_MS,
  workerHealthPath,
  writeJsonAtomic,
  type WorkerHeartbeat,
} from "@choomfie/shared";
import type { AppContext } from "./types.ts";

let timer: ReturnType<typeof setInterval> | null = null;
let discordConfigured = true;

function snapshot(ctx: AppContext): WorkerHeartbeat {
  const discord = ctx.discord;
  const ready = Boolean(discord?.isReady());

  // discord.js reports -1 for ping until the first heartbeat ack lands.
  const ping = ready && discord ? discord.ws.ping : -1;

  let lastEventAt: number | null = null;
  for (const time of ctx.lastMessageTime.values()) {
    if (lastEventAt === null || time > lastEventAt) lastEventAt = time;
  }

  return {
    pid: process.pid,
    discordConfigured,
    discordReady: ready,
    wsPing: ping >= 0 ? Math.round(ping) : null,
    lastEventAt,
    updatedAt: Date.now(),
  };
}

async function write(ctx: AppContext): Promise<void> {
  const path = workerHealthPath(ctx.DATA_DIR);
  try {
    // Atomic so the daemon never parses a half-written beat and concludes the
    // worker is unhealthy.
    await writeJsonAtomic(path, snapshot(ctx));
  } catch (error) {
    // A failed heartbeat write is itself a health signal — the daemon will see
    // a stale file. Never let it take the worker down.
    console.error(
      `Heartbeat write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Begin publishing heartbeats. Writes one immediately, then on an interval. */
export function startHeartbeat(
  ctx: AppContext,
  options: { discordConfigured: boolean },
): void {
  discordConfigured = options.discordConfigured;
  stopHeartbeat();
  void write(ctx);
  timer = setInterval(() => void write(ctx), HEARTBEAT_INTERVAL_MS);
  // Don't hold the event loop open on shutdown.
  timer.unref?.();
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Remove the heartbeat file on clean shutdown, so a restarting worker is never
 * judged against its predecessor's last beat.
 */
export async function clearHeartbeat(dataDir: string): Promise<void> {
  try {
    await unlink(workerHealthPath(dataDir));
  } catch {
    // Already gone.
  }
}
