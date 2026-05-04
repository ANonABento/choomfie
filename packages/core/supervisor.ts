#!/usr/bin/env bun
/**
 * Choomfie Supervisor — immortal main process.
 *
 * Owns: MCP server (stdio transport), worker lifecycle, restart tool.
 * Spawns worker.ts as a child process via Bun.spawn({ ipc }).
 * Forwards tool calls to worker, notifications from worker to MCP.
 *
 * Never restarts — the MCP connection to Claude Code stays alive.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { VERSION } from "./lib/version.ts";
import {
  PERMISSION_REQUEST_METHOD,
  PermissionRequestNotificationSchema,
  requirePermissionRequestParams,
} from "./lib/permission-schema.ts";
import type {
  WorkerMessage,
  IpcToolDef,
} from "./lib/ipc-types.ts";
import {
  waitForPendingToolCalls,
  type PendingToolCallMap,
} from "./lib/supervisor-boundary.ts";
import { errorMessage } from "@choomfie/shared";

// --- Config ---
const WORKER_READY_TIMEOUT = 30_000; // 30s for worker to send "ready"
const TOOL_CALL_TIMEOUT = 120_000; // 2min per tool call
const RESTART_PENDING_DRAIN_TIMEOUT = 5_000; // planned restarts wait for active calls to finish
const WORKER_PATH = `${import.meta.dir}/worker.ts`;

// --- State ---
let worker: ReturnType<typeof spawnWorker> | null = null;
let workerReady = false;
let currentTools: IpcToolDef[] = [];
let currentInstructions = "";
let toolCallId = 0;
let intentionalRestart = false; // suppress auto-respawn during restart tool
let crashCount = 0;
let lastCrashTime = 0;
const MAX_CRASHES = 5; // max crashes within the reset window
const CRASH_WINDOW_MS = 60_000; // reset crash count after 1min of stability

type McpNotification = Parameters<Server["notification"]>[0];

/** Pending tool calls waiting for worker response */
const pendingCalls: PendingToolCallMap = new Map();

/** MCP server — created once, lives forever */
let mcp: Server;

// --- PID file (single-instance guard) ---
const DATA_DIR =
  process.env.CLAUDE_PLUGIN_DATA ||
  `${process.env.HOME}/.claude/plugins/data/choomfie-inline`;

const pidPath = `${DATA_DIR}/choomfie.pid`;

async function acquirePid() {
  try {
    const oldPid = parseInt(await readFile(pidPath, "utf-8"), 10);
    if (oldPid && oldPid !== process.pid) {
      try {
        // Check if it's actually a choomfie process before killing
        const proc = Bun.spawn(["ps", "-p", String(oldPid), "-o", "command="], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const command = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        if (command && (command.includes("choomfie") || command.includes("server.ts"))) {
          process.kill(oldPid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch {
        // Process already dead
      }
    }
  } catch {
    // No PID file yet
  }
  await writeFile(pidPath, String(process.pid));
}

// --- Worker lifecycle ---

function spawnWorker() {
  console.error("Supervisor: spawning worker");
  workerReady = false;

  const child = Bun.spawn(["bun", WORKER_PATH], {
    // Worker must NOT inherit stdin/stdout — those are the MCP stdio transport.
    // stdin/stdout ignored (worker doesn't use them). stderr inherited for logs.
    stdio: ["ignore", "ignore", "inherit"],
    ipc: handleWorkerMessage,
    env: { ...process.env },
  });

  child.exited.then((code) => {
    console.error(`Supervisor: worker exited (code ${code})`);

    // Only clean up state if this is still the current worker
    // (avoids race condition during restart where old worker exit resets new worker state)
    if (worker !== child) return;

    // Reject all pending tool calls
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Worker exited during tool call"));
      pendingCalls.delete(id);
    }
    workerReady = false;

    // Auto-respawn on unexpected crash (non-zero exit), but not during intentional restart
    if (code !== 0 && code !== null && !intentionalRestart) {
      const now = Date.now();
      if (now - lastCrashTime > CRASH_WINDOW_MS) crashCount = 0;
      lastCrashTime = now;
      crashCount++;

      if (crashCount >= MAX_CRASHES) {
        console.error(`Supervisor: worker crashed ${crashCount} times in ${CRASH_WINDOW_MS / 1000}s, giving up`);
      } else {
        const delay = Math.min(1000 * 2 ** (crashCount - 1), 15_000); // 1s, 2s, 4s, 8s, 15s
        console.error(`Supervisor: worker crashed (${crashCount}/${MAX_CRASHES}), respawning in ${delay}ms...`);
        setTimeout(() => {
          worker = spawnWorker();
        }, delay);
      }
    }
  });

  return child;
}

function handleWorkerMessage(msg: WorkerMessage) {
  try {
    switch (msg.type) {
      case "ready":
        currentTools = msg.tools;
        currentInstructions = msg.instructions;
        workerReady = true;
        console.error(
          `Supervisor: worker ready (${currentTools.length} tools)`
        );
        if (mcp) {
          // Update instructions for any future initialize handshake (e.g. reconnect)
          Object.assign(mcp, { _instructions: currentInstructions });
          // Notify Claude Code that the tool list changed so it re-fetches
          mcp.notification({
            method: "notifications/tools/list_changed",
          } as McpNotification);
        }
        break;

      case "tool_result": {
        const pending = pendingCalls.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve(msg.result);
          pendingCalls.delete(msg.id);
        }
        break;
      }

      case "notification":
        // Forward Discord messages / permission responses to Claude via MCP
        if (mcp) {
          mcp.notification({
            method: msg.method,
            params: msg.params,
          } as McpNotification);
        }
        break;

      case "request_restart":
        // Worker requested its own restart (e.g. after persona switch, plugin toggle).
        // Delay briefly so the tool_result IPC message (sent after requestRestart in the handler)
        // has time to arrive and be forwarded to Claude before we kill the worker.
        setTimeout(async () => {
          const chatId = msg.chat_id;
          try {
            const { timedOut } = await restartWorker(msg.reason);
            // Send confirmation to Discord via the new worker.
            // Brief delay after ready to let Discord client finish caching.
            if (chatId && worker && workerReady && !timedOut) {
              setTimeout(() => {
                try {
                  worker!.send({
                    type: "restart_confirmation",
                    reason: msg.reason,
                    chat_id: chatId,
                  });
                } catch {}
              }, 1000);
            }
          } catch (e) {
            console.error(
              `Supervisor: worker-requested restart failed: ${errorMessage(e)}`
            );
          }
        }, 100);
        break;

      case "log":
        console.error(`Worker: ${msg.message}`);
        break;
    }
  } catch (e) {
    console.error(`Supervisor: IPC message handler error: ${errorMessage(e)}`);
  }
}

/** Send a tool call to worker and wait for result */
function callWorkerTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!workerReady || !worker) {
      return reject(new Error("Worker not ready"));
    }

    const id = String(++toolCallId);
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Tool call timed out: ${name}`));
    }, TOOL_CALL_TIMEOUT);

    pendingCalls.set(id, { resolve, reject, timer });
    try {
      worker.send({ type: "tool_call", id, name, args });
    } catch (e) {
      clearTimeout(timer);
      pendingCalls.delete(id);
      reject(new Error(`Failed to send tool call to worker: ${errorMessage(e)}`));
    }
  });
}

// --- Supervisor-owned tools ---

const SUPERVISOR_TOOLS: IpcToolDef[] = [
  {
    name: "restart",
    description:
      "Restart the Choomfie worker process. Reloads all code, config, plugins, and reconnects to Discord. MCP stays alive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: {
          type: "string",
          description: "Optional reason for restart (logged to stderr)",
        },
      },
    },
  },
];

/** Shared restart logic — used by both the restart tool and worker-requested restarts. */
async function restartWorker(reason: string): Promise<{ timedOut: boolean }> {
  console.error(`Supervisor: restarting worker — ${reason}`);
  intentionalRestart = true;

  const drainStatus = await waitForPendingToolCalls(
    pendingCalls,
    RESTART_PENDING_DRAIN_TIMEOUT,
  );
  if (drainStatus === "timed_out") {
    console.error(
      `Supervisor: restarting with ${pendingCalls.size} pending tool call(s) after drain timeout`,
    );
  }

  // Graceful shutdown (even if not ready yet — worker may be mid-startup)
  if (worker) {
    try { worker.send({ type: "shutdown" }); } catch {}
    // Wait up to 5s for graceful exit
    const exitPromise = worker.exited;
    const timeout = new Promise((r) => setTimeout(r, 5000));
    await Promise.race([exitPromise, timeout]);
    // Kill if still alive
    try { worker.kill(); } catch {}
  }

  // Spawn fresh worker (reset crash count — intentional restart = clean slate)
  intentionalRestart = false;
  crashCount = 0;
  worker = spawnWorker();

  // Wait for ready
  const timedOut = await new Promise<boolean>((resolve) => {
    const readyTimer = setTimeout(() => {
      clearInterval(readyPoll);
      resolve(true);
    }, WORKER_READY_TIMEOUT);
    const readyPoll = setInterval(() => {
      if (workerReady) {
        clearInterval(readyPoll);
        clearTimeout(readyTimer);
        resolve(false);
      }
    }, 100);
  });

  return { timedOut };
}

async function handleSupervisorTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  if (name === "restart") {
    const reason = (args.reason as string) || "manual restart";
    const { timedOut } = await restartWorker(reason);

    if (timedOut) {
      return {
        content: [{ type: "text", text: `Worker spawned but not ready yet (still starting). Reason: ${reason}` }],
      };
    }
    return {
      content: [{ type: "text", text: `Restarted successfully. (${reason})` }],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown supervisor tool: ${name}` }],
    isError: true,
  };
}

// --- MCP Server ---

function createMcp(): Server {
  const server = new Server(
    { name: "choomfie", version: VERSION },
    {
      capabilities: {
        tools: {},
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
      },
      // Instructions updated when worker sends "ready"
      instructions: currentInstructions || "Choomfie is starting up...",
    }
  );

  // Tool list: supervisor tools + worker tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...SUPERVISOR_TOOLS, ...currentTools],
  }));

  // Tool call router
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    // Supervisor-owned tools
    if (SUPERVISOR_TOOLS.some((t) => t.name === name)) {
      return handleSupervisorTool(name, args);
    }

    // Worker tools
    if (!workerReady) {
      return {
        content: [{ type: "text", text: "Worker is starting up, please wait..." }],
        isError: true,
      };
    }

    try {
      return await callWorkerTool(name, args);
    } catch (e) {
      return {
        content: [{ type: "text", text: `Tool error: ${errorMessage(e)}` }],
        isError: true,
      };
    }
  });

  // Forward permission requests from MCP to worker
  server.setNotificationHandler(
    PermissionRequestNotificationSchema,
    async ({ params }) => {
      const permissionParams = requirePermissionRequestParams(params);
      if (worker && workerReady) {
        try {
          worker.send({
            type: "permission_request",
            method: PERMISSION_REQUEST_METHOD,
            params: permissionParams,
          });
        } catch {}
      }
    }
  );

  return server;
}

// --- Main ---

await acquirePid();

// Spawn worker FIRST — wait for it to send tools + instructions
// before connecting MCP, so the initialize handshake serves real data.
worker = spawnWorker();

const readyStart = Date.now();
await new Promise<void>((resolve) => {
  const readyTimer = setTimeout(() => {
    clearInterval(readyPoll);
    console.error("Supervisor: worker not ready in time, connecting MCP with fallback instructions");
    resolve();
  }, WORKER_READY_TIMEOUT);
  const readyPoll = setInterval(() => {
    if (workerReady) {
      clearInterval(readyPoll);
      clearTimeout(readyTimer);
      console.error(`Supervisor: worker ready in ${Date.now() - readyStart}ms`);
      resolve();
    }
  }, 100);
});

// Create MCP server (now has real instructions + tools from worker)
mcp = createMcp();

// Connect MCP stdio transport (this is what Claude Code talks to)
await mcp.connect(new StdioServerTransport());
console.error("Supervisor: MCP connected");

// Graceful shutdown
let shutdownCalled = false;
const shutdown = async () => {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.error("Supervisor: shutting down");

  // Tell worker to shut down gracefully (even if not ready yet)
  if (worker) {
    try {
      worker.send({ type: "shutdown" });
    } catch {}
    // Wait up to 5s
    const exitPromise = worker.exited;
    const timeout = new Promise((r) => setTimeout(r, 5000));
    await Promise.race([exitPromise, timeout]);
    // Kill if still alive
    try {
      worker.kill();
    } catch {}
  }

  // Clean up PID file
  try {
    await unlink(pidPath);
  } catch {}

  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
