import { randomBytes } from "node:crypto";
import { ChannelType } from "discord.js";
import type { MemoryStore } from "./memory.ts";

const DEFAULT_WEBHOOK_PORT = 8787;
const MAX_DISCORD_CONTENT = 2000;
const WEBHOOK_PATH_PATTERN = /^\/webhook\/([^/]+)\/?$/;

export interface WebhookTextChannel {
  type: ChannelType;
  isTextBased(): boolean;
  send(message: { content: string; allowedMentions: { parse: [] } }): Promise<unknown>;
}

export interface WebhookContext {
  memory: Pick<MemoryStore, "getIncomingWebhook">;
  discord: {
    channels: {
      fetch(channelId: string): Promise<unknown>;
    };
  };
}

export function generateWebhookToken(): string {
  return randomBytes(24).toString("base64url");
}

export function getWebhookPort(): number {
  const raw = process.env.WEBHOOK_PORT || process.env.CHOOMFIE_WEBHOOK_PORT;
  if (!raw) return DEFAULT_WEBHOOK_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : DEFAULT_WEBHOOK_PORT;
}

export function getWebhookBaseUrl(port = getWebhookPort()): string {
  const raw =
    process.env.WEBHOOK_BASE_URL ||
    process.env.CHOOMFIE_WEBHOOK_BASE_URL ||
    `http://localhost:${port}`;
  return raw.replace(/\/+$/, "");
}

export function buildWebhookUrl(token: string, port = getWebhookPort()): string {
  return `${getWebhookBaseUrl(port)}/webhook/${token}`;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function readWebhookMessage(req: Request): Promise<string | null> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";

  if (contentType.includes("application/json")) {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return null;
    }

    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const content = record.content ?? record.message ?? record.text;
      if (typeof content === "string") return content;
    }
    return JSON.stringify(payload, null, 2);
  }

  const text = await req.text();
  return text || null;
}

function clampDiscordContent(content: string): string {
  if (content.length <= MAX_DISCORD_CONTENT) return content;
  return `${content.slice(0, MAX_DISCORD_CONTENT - 20)}\n...[truncated]`;
}

function parseWebhookToken(pathname: string): string | null {
  const match = WEBHOOK_PATH_PATTERN.exec(pathname);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function isSendableTextChannel(channel: unknown): channel is WebhookTextChannel {
  if (!channel || typeof channel !== "object") return false;
  const record = channel as Partial<WebhookTextChannel>;

  return (
    record.type !== ChannelType.DM &&
    typeof record.isTextBased === "function" &&
    record.isTextBased() &&
    typeof record.send === "function"
  );
}

export async function handleWebhookRequest(req: Request, ctx: WebhookContext): Promise<Response> {
  const url = new URL(req.url);
  const token = parseWebhookToken(url.pathname);

  if (!token) return json({ error: "not_found" }, 404);
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const webhook = ctx.memory.getIncomingWebhook(token);
  if (!webhook) return json({ error: "invalid_webhook" }, 404);

  const content = await readWebhookMessage(req);
  if (!content?.trim()) return json({ error: "empty_message" }, 400);

  const channel = await ctx.discord.channels.fetch(webhook.channelId).catch(() => null);
  if (!isSendableTextChannel(channel)) {
    return json({ error: "channel_unavailable" }, 502);
  }

  try {
    await channel.send({
      content: clampDiscordContent(content.trim()),
      allowedMentions: { parse: [] },
    });
  } catch {
    return json({ error: "channel_unavailable" }, 502);
  }

  return json({ ok: true });
}

export function startWebhookServer(ctx: WebhookContext): ReturnType<typeof Bun.serve> {
  const port = getWebhookPort();
  const server = Bun.serve({
    port,
    fetch: (req) => handleWebhookRequest(req, ctx),
  });
  console.error(`Choomfie webhooks: listening on ${getWebhookBaseUrl(server.port)}`);
  return server;
}
