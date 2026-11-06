/**
 * Multi-session daemon (`daemon.multiSession`): the daemon runs the Discord
 * worker itself and keeps one Claude session per location.
 *
 *   daemon (hub) ── WorkerHost ── worker.ts (Discord, tools)
 *        │  └─ loopback MCP endpoint (every tool, token in memory)
 *        └─ SessionPool ── ChatSession × N (Agent SDK, mcpServers → endpoint)
 *
 * Inbound messages still arrive through meta/incoming and control requests
 * through meta/control.json; the hub routes both by location. Restarting a
 * session never touches Discord, and restarting the worker never touches a
 * session.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  CLAUDE_BRAIN,
  CONTROL_POLL_INTERVAL_MS,
  INBOUND_LOCATION_KEY,
  INCOMING_POLL_INTERVAL_MS,
  writeJsonAtomic,
  type DaemonControlRequest,
} from "@choomfie/shared";
import { ChatStore } from "../../lib/chats/store.ts";
import { startLocalMcp } from "../../lib/remote-mcp.ts";
import { VERSION } from "../../lib/version.ts";
import { WorkerHost } from "../../lib/worker-host.ts";
import { DATA_DIR, META_DIR, WORKER_HEALTH_INTERVAL, WORKER_MAX_CONSECUTIVE_FAILURES } from "../constants.ts";
import { takeControlRequest } from "../control.ts";
import { getErrorMessage } from "../error.ts";
import { formatChannelPrompt, takeInboundMessages } from "../incoming.ts";
import { todayKey } from "../lifecycle.ts";
import { log, setSessionId } from "../log.ts";
import { releasePid } from "../pid.ts";
import { assessWorkerHealth } from "../runtime.ts";
import { DAEMON_STATE_PATH, setDaemonStateWriter, writeStateFile } from "../state-file.ts";
import type { DaemonSettings } from "../types.ts";
import { withSeed } from "../chat-state.ts";
import { ChatSession } from "./chat-session.ts";
import { SessionPool, type PoolChat } from "./pool.ts";

const SEEDS_PATH = `${META_DIR}/claude-seeds.json`;
const IDLE_CLOSE_MS = 20 * 60_000;
const EVICT_INTERVAL_MS = 60_000;
const STATE_INTERVAL_MS = 30_000;

export interface HubSettings extends DaemonSettings {
  maxSessions: number;
}

function loadSeeds(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(SEEDS_PATH, "utf-8"));
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export async function runHub(settings: HubSettings): Promise<void> {
  setSessionId("hub");
  const startedAt = Date.now();

  const host = new WorkerHost({
    name: "Hub",
    env: { CHOOMFIE_DAEMON_PID: String(process.pid) },
    log: (m) => log(m),
  });
  host.start();
  if (!(await host.waitReady())) log("Worker not ready after 30s — sessions will see a starting-up message until it is");

  const endpoint = startLocalMcp({
    name: "choomfie",
    version: VERSION,
    listTools: () => host.listTools(),
    callTool: (name, args) => host.callTool(name, args),
    instructions: () => host.instructions,
  });
  log(`Tool endpoint on ${endpoint.url}`);

  // The worker's database; WAL lets both processes use it. The worker owns
  // bindings, the hub only records each chat's SDK session id.
  const db = new Database(`${DATA_DIR}/choomfie.db`, { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  const chats = new ChatStore(db);

  let seeds = loadSeeds();
  const setSeed = (chatId: string, summary: string | undefined) => {
    seeds = withSeed(seeds, chatId, summary);
    void writeJsonAtomic(SEEDS_PATH, seeds).catch((e: unknown) => log(`Failed to save seeds: ${getErrorMessage(e)}`));
  };

  let usageToday = { date: todayKey(), inputTokens: 0 };
  let cycles = 0;
  let rateLimit: ChatSession["state"]["rateLimit"] = null;
  let healthFailures = 0;

  const pool = new SessionPool({
    max: settings.maxSessions,
    idleMs: IDLE_CLOSE_MS,
    log: (m) => log(m),
    boundChat: (location): PoolChat | null => {
      const chat = chats.bound(location, CLAUDE_BRAIN);
      return chat ? { id: chat.id, backendRef: chat.backendRef, cwd: chat.cwd, title: chat.title } : null;
    },
    open: (location, chat) =>
      new ChatSession({
        location,
        chat,
        settings,
        mcp: { url: endpoint.url, token: endpoint.token },
        seed: (id) => seeds[id],
        setSeed,
        onSessionId: (chatId, sid) => {
          try {
            chats.setBackendRef(chatId, sid);
          } catch (e: unknown) {
            log(`Couldn't record session ${sid ?? "(none)"} on chat ${chatId}: ${getErrorMessage(e)}`);
          }
          void writeState();
        },
        onUsage: (tokens) => {
          if (usageToday.date !== todayKey()) usageToday = { date: todayKey(), inputTokens: 0 };
          usageToday.inputTokens += tokens;
          void writeState(); // once per turn, so /status is current
        },
        log: (m) => log(m),
      }).start(),
  });

  const live = () => [...pool.sessions.values()] as ChatSession[];

  async function writeState(): Promise<void> {
    const sessions = live();
    const latest = sessions.reduce<ChatSession | null>(
      (a, s) => (!a || s.lastActivityAt() > a.lastActivityAt() ? s : a),
      null
    );
    for (const s of sessions) if (s.state.rateLimit && (s.state.rateLimit.updatedAt ?? 0) >= (rateLimit?.updatedAt ?? 0)) rateLimit = s.state.rateLimit;
    cycles = Math.max(cycles, sessions.reduce((n, s) => n + s.state.totalCycles, 0));
    const st = latest?.state;
    await writeStateFile({
      mode: "daemon",
      multiSession: true,
      pid: process.pid,
      state: "ACTIVE",
      sessionId: st?.chat.sdkSessionId ?? "hub",
      sessionUptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      model: settings.model ?? null,
      fallbackModel: settings.fallbackModel ?? null,
      resolvedModel: st?.resolved.model ?? null,
      claudeCodeVersion: st?.resolved.claudeCodeVersion ?? null,
      turns: { current: st?.turnCount ?? 0, threshold: settings.turnThreshold },
      context: { ...(st?.context ?? {}), threshold: settings.tokenThreshold },
      cumulativeInputTokens: sessions.reduce((n, s) => n + s.state.totalInputTokens, 0),
      tokenUsageToday: usageToday,
      modelUsage: st?.modelUsage ?? {},
      rateLimit,
      costUsd: sessions.reduce((n, s) => n + s.state.totalCostUsd, 0),
      totalCycles: cycles,
      lastCycleReason: st?.lastCycleReason ?? null,
      pendingCycleReason: null,
      workerHealth: { processAlive: host.ready, lastHealthyAt: null, consecutiveFailures: healthFailures },
      chat: null,
      maxSessions: settings.maxSessions,
      sessions: sessions.map((s) => ({
        location: s.location,
        chatId: s.chatId,
        title: s.title,
        cwd: s.state.chat.cwd,
        sdkSessionId: s.state.chat.sdkSessionId,
        busy: s.busy(),
        turns: s.state.turnCount,
        contextTokens: s.state.context.tokens,
        lastActivityAt: s.lastActivityAt(),
      })),
      updatedAt: new Date().toISOString(),
    });
  }
  // Sessions report rate limits and init through the runtime's writer.
  setDaemonStateWriter(() => writeState());
  await writeState();

  // --- Inbound: route each message to its location's session ---
  let sweeping = false;
  const incomingTimer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (const m of await takeInboundMessages()) {
        const location = m.meta[INBOUND_LOCATION_KEY] ?? m.meta.chat_id;
        if (!location) {
          log("Inbound message without a location — dropped");
          continue;
        }
        if (await pool.deliver(location, formatChannelPrompt(m.content, m.meta))) void writeState();
      }
    } catch (e: unknown) {
      log(`Incoming sweep failed: ${getErrorMessage(e)}`);
    } finally {
      sweeping = false;
    }
  }, INCOMING_POLL_INTERVAL_MS);

  // --- Control: /stop, /compact, /clear, /resume for one location ---
  const controlTimer = setInterval(async () => {
    let request: DaemonControlRequest | null = null;
    try {
      request = await takeControlRequest();
      if (!request) return;
      const location = request.location ?? request.chatId;
      log(`Control request: ${request.command} at ${location ?? "?"}`);
      if (!location) return;
      if (request.command === "stop") {
        if (!(await pool.stop(location))) log("Nothing to stop there");
      } else if (request.command === "compact") {
        if (!(await pool.compact(location, request.chatId))) log("No live session there to compact");
      } else {
        // clear / resume: the worker already rebound the location.
        await pool.release(location);
      }
      void writeState();
    } catch (e: unknown) {
      log(`Control request ${request?.command ?? ""} failed: ${getErrorMessage(e)}`);
    }
  }, CONTROL_POLL_INTERVAL_MS);

  const evictTimer = setInterval(() => void pool.evictIdle().then(writeState), EVICT_INTERVAL_MS);
  const stateTimer = setInterval(() => void writeState(), STATE_INTERVAL_MS);

  // --- Worker health: the heartbeat, restarting the worker (not a session) ---
  const healthTimer = setInterval(async () => {
    if (!host.ready) return; // starting, or the host's crash backoff has it
    try {
      const h = await assessWorkerHealth();
      // No heartbeat yet reads as "process not alive" here (there's no
      // supervisor pid file in hub mode); the host knows the worker is up.
      if (h.healthy || h.cycleWontHelp || h.reason.startsWith("process")) {
        healthFailures = 0;
        return;
      }
      healthFailures++;
      log(`Worker health: UNHEALTHY — ${h.reason} (${healthFailures}/${WORKER_MAX_CONSECUTIVE_FAILURES})`);
      if (healthFailures >= WORKER_MAX_CONSECUTIVE_FAILURES) {
        healthFailures = 0;
        await host.restart(`unhealthy: ${h.reason}`);
      }
    } catch (e: unknown) {
      log(`Worker health check error: ${getErrorMessage(e)}`);
    }
  }, WORKER_HEALTH_INTERVAL);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    for (const t of [incomingTimer, controlTimer, evictTimer, stateTimer, healthTimer]) clearInterval(t);
    setDaemonStateWriter(null);
    await pool.closeAll();
    await host.stop();
    endpoint.stop();
    db.close();
    await unlink(DAEMON_STATE_PATH).catch(() => {});
    await releasePid();
    log("Shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  log(`Hub running: up to ${settings.maxSessions} Claude sessions, one per thread / channel / DM`);
}
