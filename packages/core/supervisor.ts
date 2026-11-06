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
import { writeFile, unlink } from "node:fs/promises";
import { VERSION } from "./lib/version.ts";
import {
  ensureRemoteMcpToken,
  loadRemoteMcpConfig,
  startRemoteMcp,
} from "./lib/remote-mcp.ts";
import {
  PERMISSION_REQUEST_METHOD,
  PermissionRequestNotificationSchema,
  requirePermissionRequestParams,
} from "./lib/permission-schema.ts";
import { WorkerHost } from "./lib/worker-host.ts";
import {
  errorMessage,
  isChoomfieProcessAlive,
  readLiveDaemonPid,
  readPidFile,
  resolveDataDir,
} from "@choomfie/shared";

const WORKER_READY_TIMEOUT = 30_000; // 30s for worker to send "ready"

type McpNotification = Parameters<Server["notification"]>[0];

/** MCP server — created once, lives forever */
let mcp: Server;

// --- PID file (single-instance guard) ---
const DATA_DIR = resolveDataDir();

const pidPath = `${DATA_DIR}/choomfie.pid`;

const daemonPidPath = `${DATA_DIR}/meta/meta.pid`;

/**
 * Refuse to start when a daemon is already supervising an instance.
 *
 * Taking over the PID file is the right move when you re-run `choomfie` in a
 * terminal — the old foreground instance is stale. It is the wrong move when
 * launchd (or `choomfie --daemon`) is supervising one: killing that
 * supervisor makes the daemon restart its session and spawn a replacement,
 * and the two ping-pong. The daemon's own supervisor is exempt, identified by
 * CHOOMFIE_DAEMON_PID which the daemon injects into its session's env.
 */
async function assertNoSupervisingDaemon() {
  // A hub session reaches the hub's worker over HTTP. A supervisor started
  // inside one (a project .mcp.json, say) would log in to Discord a second time.
  if (process.env.CHOOMFIE_HUB_SESSION) {
    console.error("Choomfie: this session is served by the daemon hub; not starting a second worker.");
    process.exit(1);
  }

  const daemonPid = await readLiveDaemonPid(daemonPidPath);
  if (daemonPid === null) return;

  const ownedByThisDaemon =
    process.env.CHOOMFIE_DAEMON_PID === String(daemonPid);
  if (ownedByThisDaemon) return;

  console.error(
    `Choomfie is already running as a daemon (PID ${daemonPid}).\n` +
      `Starting another instance would fight it for the Discord connection.\n` +
      `\n` +
      `Stop the daemon first:\n` +
      `  bun packages/core/daemon.ts --stop\n` +
      `Or, if it was installed to run at login:\n` +
      `  bun run install:launchd --uninstall`
  );
  process.exit(1);
}

async function acquirePid() {
  await assertNoSupervisingDaemon();

  const oldPid = await readPidFile(pidPath);
  if (oldPid && oldPid !== process.pid) {
    // Only signal something that actually looks like ours.
    if (await isChoomfieProcessAlive(oldPid)) {
      try {
        process.kill(oldPid, "SIGTERM");
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        // Already gone.
      }
    }
  }

  await writeFile(pidPath, String(process.pid));
}

// --- Worker ---

const host = new WorkerHost({
  name: "Supervisor",
  onReady: (_tools, instructions) => {
    if (!mcp) return;
    // Update instructions for any future initialize handshake (e.g. reconnect)
    Object.assign(mcp, { _instructions: instructions });
    // Notify Claude Code that the tool list changed so it re-fetches
    mcp.notification({ method: "notifications/tools/list_changed" } as McpNotification);
  },
  // Forward Discord messages / permission responses to Claude via MCP
  onNotification: (method, params) => {
    mcp?.notification({ method, params } as McpNotification);
  },
});

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
      instructions: host.instructions || "Choomfie is starting up...",
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: host.listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    host.callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
  );

  // Forward permission requests from MCP to worker
  server.setNotificationHandler(
    PermissionRequestNotificationSchema,
    async ({ params }) => {
      const permissionParams = requirePermissionRequestParams(params);
      if (host.ready) {
        host.send({
          type: "permission_request",
          method: PERMISSION_REQUEST_METHOD,
          params: permissionParams as unknown as Record<string, unknown>,
        });
      }
    }
  );

  return server;
}

// --- Main ---

await acquirePid();

// Spawn worker FIRST — wait for it to send tools + instructions
// before connecting MCP, so the initialize handshake serves real data.
const readyStart = Date.now();
host.start();
if (await host.waitReady(WORKER_READY_TIMEOUT)) {
  console.error(`Supervisor: worker ready in ${Date.now() - readyStart}ms`);
} else {
  console.error("Supervisor: worker not ready in time, connecting MCP with fallback instructions");
}

// Create MCP server (now has real instructions + tools from worker)
mcp = createMcp();

// Connect MCP stdio transport (this is what Claude Code talks to)
await mcp.connect(new StdioServerTransport());
console.error("Supervisor: MCP connected");

// Optional remote MCP endpoint (off by default). A failure here — bad config,
// port taken during a daemon session handoff — must never take down stdio.
let remoteMcpServer: ReturnType<typeof startRemoteMcp> | null = null;
try {
  const remoteCfg = loadRemoteMcpConfig(DATA_DIR);
  if (remoteCfg.enabled) {
    remoteMcpServer = startRemoteMcp(remoteCfg, ensureRemoteMcpToken(DATA_DIR), {
      name: "choomfie",
      version: VERSION,
      listTools: () => host.listTools(),
      callTool: (name, args) => host.callTool(name, args),
    });
    console.error(
      `Supervisor: remote MCP on http://${remoteCfg.host}:${remoteCfg.port}/mcp ` +
        `(${remoteCfg.tools.length} tools allowed)`
    );
  }
} catch (e) {
  console.error(`Supervisor: remote MCP not started: ${errorMessage(e)}`);
}

// Graceful shutdown
let shutdownCalled = false;
const shutdown = async () => {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.error("Supervisor: shutting down");
  try { remoteMcpServer?.stop(true); } catch {}

  await host.stop();

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
