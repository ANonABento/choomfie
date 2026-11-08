/**
 * Remote MCP endpoint — lets a cloud agent (e.g. Ambition's Waymond) call a
 * small, allowlisted subset of Choomfie's tools over streamable HTTP.
 *
 * Off unless `remoteMcp.enabled` is true in config.json. Binds loopback only;
 * reach it from outside through a tunnel (Tailscale Funnel, Cloudflare Tunnel).
 * Every request needs `Authorization: Bearer <token>`, where the token lives in
 * `<dataDir>/remote-mcp-token` (generated on first start, mode 0600).
 *
 * Runs in whichever process owns the worker (the supervisor, or the daemon),
 * so it survives worker restarts. Stateless: each HTTP
 * request gets a fresh Server + transport, because an SDK Server binds to
 * exactly one transport and the stdio one is already taken by Claude Code.
 *
 * The allowlist is the security boundary. Tools called here run with owner
 * authority (there is no Discord role on an IPC tool call), so the default is
 * read-only. Waymond's own approval prompts are a second layer, not the first.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IpcToolDef } from "./ipc-types.ts";

export const DEFAULT_REMOTE_TOOLS = [
  "choomfie_status",
  "list_memories",
  "search_memory",
  "memory_stats",
  "list_reminders",
] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface RemoteMcpConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Tool names exposed remotely. Anything not listed is invisible and uncallable. */
  tools: string[];
}

export function parseRemoteMcpConfig(raw: unknown): RemoteMcpConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const host = typeof r.host === "string" ? r.host : "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `remoteMcp.host must be loopback (got "${host}"); expose it through a tunnel instead`
    );
  }
  const port =
    typeof r.port === "number" && Number.isInteger(r.port) && r.port > 0 && r.port < 65536
      ? r.port
      : 4142;
  const tools =
    Array.isArray(r.tools) && r.tools.every((t) => typeof t === "string")
      ? (r.tools as string[])
      : [...DEFAULT_REMOTE_TOOLS];
  return { enabled: r.enabled === true, host, port, tools };
}

/** Read `remoteMcp` from config.json without going through ConfigManager (which may rewrite the file). */
export function loadRemoteMcpConfig(dataDir: string): RemoteMcpConfig {
  try {
    const saved = JSON.parse(readFileSync(`${dataDir}/config.json`, "utf-8"));
    return parseRemoteMcpConfig(saved?.remoteMcp);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("remoteMcp.")) throw e;
    return parseRemoteMcpConfig(undefined);
  }
}

/** Return the bearer token, creating it on first use. */
export function ensureRemoteMcpToken(dataDir: string): string {
  const path = `${dataDir}/remote-mcp-token`;
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(path, token + "\n", { mode: 0o600 });
  return token;
}

function tokenMatches(header: string | null, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  // Hash both sides so timingSafeEqual sees equal lengths.
  const a = createHash("sha256").update(header.slice(7).trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

export interface RemoteMcpDeps {
  name: string;
  version: string;
  /** Current tool list (supervisor + worker), re-read on every request. */
  listTools: () => IpcToolDef[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

const REMOTE_INSTRUCTIONS = "Choomfie remote tools: read the owner's Choomfie memories, reminders and bot status.";

/** `allowed` null = every tool (the daemon hub's own sessions). */
function buildServer(allowed: Set<string> | null, instructions: string, deps: RemoteMcpDeps): Server {
  const server = new Server(
    { name: deps.name, version: deps.version },
    { capabilities: { tools: {} }, instructions }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: deps.listTools().filter((t) => !allowed || allowed.has(t.name)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (allowed && !allowed.has(name)) {
      return {
        content: [{ type: "text", text: `Tool not available remotely: ${name}` }],
        isError: true,
      };
    }
    try {
      return (await deps.callTool(
        name,
        (req.params.arguments ?? {}) as Record<string, unknown>
      )) as { content: unknown[] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  });
  return server;
}

export function handleRemoteMcpRequest(
  req: Request,
  cfg: RemoteMcpConfig,
  token: string,
  deps: RemoteMcpDeps
): Promise<Response> {
  return handleMcpRequest(req, token, () => buildServer(new Set(cfg.tools), REMOTE_INSTRUCTIONS, deps));
}

async function handleMcpRequest(req: Request, token: string, build: () => Server): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
  if (!tokenMatches(req.headers.get("authorization"), token)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }
  // Stateless mode has no session to stream to or delete.
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const server = build();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // JSON responses are fully built before handleRequest resolves.
    void server.close();
  }
}

export function startRemoteMcp(
  cfg: RemoteMcpConfig,
  token: string,
  deps: RemoteMcpDeps
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    fetch: (req) => handleRemoteMcpRequest(req, cfg, token, deps),
  });
}

/**
 * Start the endpoint if config.json turns it on. Never throws: a bad config or
 * a taken port must not take down the process that owns Discord.
 */
export function startConfiguredRemoteMcp(
  dataDir: string,
  deps: RemoteMcpDeps,
  log: (message: string) => void
): { stop: () => void } | null {
  try {
    const cfg = loadRemoteMcpConfig(dataDir);
    if (!cfg.enabled) return null;
    const server = startRemoteMcp(cfg, ensureRemoteMcpToken(dataDir), deps);
    log(`remote MCP on http://${cfg.host}:${cfg.port}/mcp (${cfg.tools.length} tools allowed)`);
    return { stop: () => void server.stop(true) };
  } catch (e) {
    log(`remote MCP not started: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The daemon's endpoint for its own sessions: loopback, an ephemeral port,
 * a token that lives only in the daemon's memory, every tool, and the worker's
 * instructions (persona, security rules) as the server instructions.
 */
export function startLocalMcp(
  deps: RemoteMcpDeps & { instructions: () => string }
): { url: string; token: string; stop: () => void } {
  const token = randomBytes(32).toString("base64url");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req, server) => {
      // Responses are JSON, sent when the tool finishes: a long tool (ask_brain)
      // is silent for minutes, and Bun would close it after 10 s idle.
      server.timeout(req, 0);
      return handleMcpRequest(req, token, () => buildServer(null, deps.instructions() || "Choomfie is starting up...", deps));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, token, stop: () => server.stop(true) };
}
