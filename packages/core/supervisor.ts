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
import { startConfiguredRemoteMcp } from "./lib/remote-mcp.ts";
import {
  PERMISSION_REQUEST_METHOD,
  PermissionRequestNotificationSchema,
  requirePermissionRequestParams,
} from "./lib/permission-schema.ts";
import { WorkerHost } from "./lib/worker-host.ts";
import {
  isChoomfieProcessAlive,
  readLiveDaemonPid,
  readPidFile,
  resolveDataDir,
} from "@choomfie/shared";


type McpNotification = Parameters<Server["notification"]>[0];

/** MCP server — created once, lives forever */
let mcp: Server;

// --- PID file (single-instance guard) ---
const DATA_DIR = resolveDataDir();

const pidPath = `${DATA_DIR}/choomfie.pid`;

const daemonPidPath = `${DATA_DIR}/meta/meta.pid`;

/**
 * Refuse to start while the daemon runs: it owns the Discord worker, and a
 * second one would fight it for the connection. Taking over the PID file is
 * right only for a stale foreground instance (re-running `choomfie`).
 */
async function assertNoDaemon() {
  const daemonPid = await readLiveDaemonPid(daemonPidPath);
  if (daemonPid === null) return;
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
  await assertNoDaemon();

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
if (await host.waitReady()) {
  console.error(`Supervisor: worker ready in ${Date.now() - readyStart}ms`);
} else {
  console.error("Supervisor: worker not ready in time, connecting MCP with fallback instructions");
}

// Create MCP server (now has real instructions + tools from worker)
mcp = createMcp();

// Connect MCP stdio transport (this is what Claude Code talks to)
await mcp.connect(new StdioServerTransport());
console.error("Supervisor: MCP connected");

// Optional remote MCP endpoint (off by default).
const remoteMcpServer = startConfiguredRemoteMcp(
  DATA_DIR,
  { name: "choomfie", version: VERSION, listTools: () => host.listTools(), callTool: (name, args) => host.callTool(name, args) },
  (m) => console.error(`Supervisor: ${m}`)
);

// Graceful shutdown
let shutdownCalled = false;
const shutdown = async () => {
  if (shutdownCalled) return;
  shutdownCalled = true;
  console.error("Supervisor: shutting down");
  remoteMcpServer?.stop();

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
