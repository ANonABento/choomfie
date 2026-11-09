/**
 * The daemon: runs the Discord worker itself and keeps one Claude session per
 * location (thread, channel, DM, group DM).
 *
 *   daemon ── WorkerHost ── worker.ts (Discord, tools)
 *     │  └─ loopback MCP endpoint (every tool, token in memory)
 *     └─ SessionPool ── ChatSession × N (Agent SDK, mcpServers → endpoint)
 *
 * Inbound messages arrive through meta/incoming and control requests through
 * meta/control.json; both are routed by location. Restarting a session never
 * touches Discord, and restarting the worker never touches a session.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  CLAUDE_BRAIN,
  CONTROL_POLL_INTERVAL_MS,
  INBOUND_LOCATION_KEY,
  INCOMING_POLL_INTERVAL_MS,
  type DaemonControlRequest,
} from "@choomfie/shared";
import { ChatStore } from "../lib/chats/store.ts";
import { startConfiguredRemoteMcp, startLocalMcp } from "../lib/remote-mcp.ts";
import { VERSION } from "../lib/version.ts";
import type { ToolCaller } from "../lib/ipc-types.ts";
import { WorkerHost } from "../lib/worker-host.ts";
import {
  CHAT_HOME,
  DATA_DIR,
  META_DIR,
  PLUGIN_DIR,
  WORKER_HEALTH_INTERVAL,
  WORKER_MAX_CONSECUTIVE_FAILURES,
} from "./constants.ts";
import { takeControlRequest } from "./control.ts";
import { getErrorMessage } from "./error.ts";
import { formatChannelPrompt, takeInboundMessages } from "./incoming.ts";
import { todayKey } from "./lifecycle.ts";
import { log } from "./log.ts";
import { releasePid } from "./pid.ts";
import type { RateLimitSnapshot } from "./rate-limit.ts";
import { assessWorkerHealth, rateBudget } from "./runtime.ts";
import { loadSeeds, parseSeeds, saveSeeds, withSeed, type Seeds } from "./seeds.ts";
import { buildDaemonState, DAEMON_STATE_PATH, writeDaemonState } from "./state-file.ts";
import type { DaemonSettings } from "./types.ts";
import { ChatSession } from "./chat-session.ts";
import { SessionPool, type PoolChat } from "./pool.ts";

const IDLE_CLOSE_MS = 20 * 60_000;
const EVICT_INTERVAL_MS = 60_000;
const STATE_INTERVAL_MS = 30_000;
/**
 * Exit code for a requested restart: not 0, so launchd's KeepAlive
 * (SuccessfulExit = false) starts the daemon again.
 */
export const RESTART_EXIT_CODE = 75;

/** Health-triggered worker restarts allowed per hour; past that, stop and say so. */
const MAX_HEALTH_RESTARTS_PER_HOUR = 3;

/**
 * Older layouts, brought forward once:
 * - one shared Claude chat bound at "claude:global", with its seeds in
 *   meta/claude-chat.json: fold the seeds in and drop the binding (the chats
 *   stay resumable with `/resume`);
 * - chats with a session but no recorded cwd ran in the plugin dir, back when
 *   that was the default: record it, or they'd resume in the wrong place.
 */
export function migrateLegacy(db: Database, seeds: Seeds, legacy = `${META_DIR}/claude-chat.json`): Seeds {
  db.query("DELETE FROM chat_bindings WHERE location_id = 'claude:global'").run();
  db.query(`UPDATE chats SET cwd = ? WHERE brain = '${CLAUDE_BRAIN}' AND cwd IS NULL AND backend_ref IS NOT NULL`).run(PLUGIN_DIR);
  if (!existsSync(legacy)) return seeds;
  try {
    const old = parseSeeds(JSON.parse(readFileSync(legacy, "utf-8"))?.seeds);
    for (const [chatId, summary] of Object.entries(old)) if (!seeds[chatId]) seeds = withSeed(seeds, chatId, summary);
  } catch {
    // Unreadable: nothing worth carrying over.
  }
  rmSync(legacy, { force: true });
  return seeds;
}

export async function runDaemon(settings: DaemonSettings): Promise<void> {
  const startedAt = Date.now();

  const host = new WorkerHost({
    name: "Daemon",
    // Marks the worker as daemon-launched: it hands messages to meta/incoming.
    env: { CHOOMFIE_DAEMON_PID: String(process.pid) },
    log: (m) => log(m),
  });
  host.start();
  if (!(await host.waitReady())) log("Worker not ready after 30s — sessions will see a starting-up message until it is");

  const tools = {
    name: "choomfie",
    version: VERSION,
    listTools: () => host.listTools(),
    callTool: (name: string, args: Record<string, unknown>, caller: ToolCaller) => host.callTool(name, args, caller),
  };
  const endpoint = startLocalMcp({ ...tools, instructions: () => host.instructions });
  log(`Tool endpoint on ${endpoint.url}`);
  const remote = startConfiguredRemoteMcp(DATA_DIR, tools, (m) => log(m));

  // The worker's database; WAL lets both processes use it. The worker owns
  // bindings, the daemon only records each chat's SDK session id.
  const db = new Database(`${DATA_DIR}/choomfie.db`, { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  const chats = new ChatStore(db);

  let seeds = migrateLegacy(db, loadSeeds());
  await saveSeeds(seeds);
  mkdirSync(CHAT_HOME, { recursive: true });
  let usageToday = { date: todayKey(), inputTokens: 0 };
  let totalCycles = 0;
  let rateLimit: RateLimitSnapshot | null = null;
  let healthFailures = 0;
  const mayRestartWorker = rateBudget(MAX_HEALTH_RESTARTS_PER_HOUR, 60 * 60_000);

  const pool: SessionPool<ChatSession> = new SessionPool<ChatSession>({
    max: settings.maxSessions,
    idleMs: IDLE_CLOSE_MS,
    log: (m) => log(m),
    boundChat: (location): PoolChat | null => {
      const chat = chats.bound(location, CLAUDE_BRAIN);
      return chat ? { id: chat.id, backendRef: chat.backendRef, cwd: chat.cwd, model: chat.model, title: chat.title } : null;
    },
    open: (location, chat) =>
      new ChatSession({
        location,
        chat,
        settings,
        mcp: { url: endpoint.url, headers: endpoint.headersFor(location) },
        seed: (id) => seeds[id],
        onCompacted: (id, summary) => {
          seeds = withSeed(seeds, id, summary);
          totalCycles++;
          void saveSeeds(seeds);
          void writeState();
        },
        onSessionId: (chatId, sid, cwd) => {
          try {
            chats.setBackendRef(chatId, sid);
            if (sid) chats.setCwd(chatId, cwd);
          } catch (e: unknown) {
            log(`Couldn't record session ${sid ?? "(none)"} on chat ${chatId}: ${getErrorMessage(e)}`);
          }
          void writeState();
        },
        postReply: async (chatId, text) => {
          const res = await host.callTool("reply", { chat_id: chatId, text });
          if (res.isError) throw new Error(JSON.stringify(res.content).slice(0, 300));
        },
        onUsage: (tokens) => {
          if (usageToday.date !== todayKey()) usageToday = { date: todayKey(), inputTokens: 0 };
          usageToday.inputTokens += tokens;
          void writeState(); // once per turn, so /status is current
        },
        onChange: () => void writeState(),
        log: (m) => log(m),
      }).start(),
  });

  function writeState(): Promise<void> {
    const sessions = [...pool.sessions.values()];
    for (const s of sessions) {
      const r = s.state.rateLimit;
      if (r && (r.updatedAt ?? 0) >= (rateLimit?.updatedAt ?? 0)) rateLimit = r;
    }
    return writeDaemonState(
      buildDaemonState({
        startedAt,
        settings,
        sessions: sessions.map((s) => ({ location: s.location, title: s.title, busy: s.busy(), state: s.state })),
        usageToday,
        rateLimit,
        totalCycles,
        worker: { alive: host.ready, consecutiveFailures: healthFailures },
      })
    );
  }
  await writeState();

  // --- Inbound: each message to its location's session ---
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
        // A plain final answer is posted back to where the message came from —
        // except in conversation mode, where staying quiet is a valid answer.
        const replyTo = m.meta.conversation_mode === "true" ? null : (m.meta.chat_id ?? null);
        if (await pool.deliver(location, formatChannelPrompt(m.content, m.meta), replyTo)) void writeState();
      }
    } catch (e: unknown) {
      log(`Incoming sweep failed: ${getErrorMessage(e)}`);
    } finally {
      sweeping = false;
    }
  }, INCOMING_POLL_INTERVAL_MS);

  // --- Control: /stop, /compact, /clear, /resume for one location; restart for all ---
  let restartRequested = false;
  const controlTimer = setInterval(async () => {
    let request: DaemonControlRequest | null = null;
    // A restart waits for every session to finish its turn; launchd starts the daemon again.
    if (restartRequested && !pool.anyBusy()) {
      log("Restarting on the code on disk");
      return void shutdown(RESTART_EXIT_CODE);
    }
    try {
      request = await takeControlRequest();
      if (!request) return;
      log(`Control request: ${request.command} at ${request.location}`);
      if (request.command === "stop") {
        if (!(await pool.stop(request.location))) log("Nothing to stop there");
      } else if (request.command === "restart") {
        restartRequested = true;
        log("Restart requested: once no session is mid-turn");
      } else if (request.command === "compact") {
        if (!(await pool.compact(request.location, request.chatId))) log("No live session there to compact");
      } else {
        // clear / resume: the worker already bound the new chat here.
        await pool.release(request.location);
      }
      void writeState();
    } catch (e: unknown) {
      log(`Control request ${request?.command ?? ""} failed: ${getErrorMessage(e)}`);
    }
  }, CONTROL_POLL_INTERVAL_MS);

  const evictTimer = setInterval(() => void pool.evictIdle().then(writeState), EVICT_INTERVAL_MS);
  const stateTimer = setInterval(() => void writeState(), STATE_INTERVAL_MS);

  // --- Worker health: the heartbeat; restarts the worker, never a session ---
  const healthTimer = setInterval(async () => {
    if (!host.ready) return; // starting, or the host's crash backoff has it
    try {
      const h = await assessWorkerHealth(host.ready);
      if (h.healthy || h.cycleWontHelp) {
        healthFailures = 0;
        return;
      }
      healthFailures++;
      log(`Worker health: UNHEALTHY — ${h.reason} (${healthFailures}/${WORKER_MAX_CONSECUTIVE_FAILURES})`);
      if (healthFailures >= WORKER_MAX_CONSECUTIVE_FAILURES) {
        healthFailures = 0;
        if (!mayRestartWorker()) {
          log(`Worker still unhealthy after ${MAX_HEALTH_RESTARTS_PER_HOUR} restarts this hour — not restarting again; check the log above`);
          return;
        }
        await host.restart(`unhealthy: ${h.reason}`);
      }
    } catch (e: unknown) {
      log(`Worker health check error: ${getErrorMessage(e)}`);
    }
  }, WORKER_HEALTH_INTERVAL);

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    for (const t of [incomingTimer, controlTimer, evictTimer, stateTimer, healthTimer]) clearInterval(t);
    await pool.closeAll();
    await host.stop();
    endpoint.stop();
    remote?.stop();
    db.close();
    await unlink(DAEMON_STATE_PATH).catch(() => {});
    await releasePid();
    log("Shutdown complete");
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  process.on("SIGHUP", () => shutdown());

  log(`Running: up to ${settings.maxSessions} Claude sessions, one per thread / channel / DM`);
}
