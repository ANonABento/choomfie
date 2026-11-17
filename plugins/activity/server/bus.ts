/**
 * Avatar state bus — authenticated WebSocket from the bot to Activity clients.
 *
 * Out: mouth (~30 Hz RMS of reply audio), emotion, speaking, look_at, room.
 * In:  chat, poke, headpat → forwarded to the brain as system messages.
 * Only allowlisted Discord user IDs may connect (403 otherwise).
 */

import { resolve, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { VoiceEvent, VoicePipeline } from "@choomfie/voice/pipeline/index.ts";
import { MOUTH_HZ, mouthLevels } from "./mouth.ts";
import { handleTokenRequest, type DiscordOAuth } from "./token.ts";

export type BusMessage =
  | { type: "mouth"; value: number }
  | { type: "emotion"; name: string; intensity: number }
  | { type: "speaking"; value: boolean }
  | { type: "look_at"; x: number; y: number }
  | { type: "room"; action: string; args: Record<string, unknown> };

export type ClientEvent =
  | { type: "chat"; text: string }
  | { type: "poke" }
  | { type: "headpat" };

export interface AvatarBusOptions {
  port?: number;
  pipeline: VoicePipeline;
  /** Discord user IDs allowed to connect */
  allowlist: readonly string[];
  /** Resolve the client's bearer token to a Discord user ID (null = invalid) */
  verifyToken: (token: string) => Promise<string | null>;
  /** Deliver a room event to the brain as a system message */
  toBrain: (systemMessage: string) => void;
  /** Serve POST /api/token (Activity sign-in) with these app credentials */
  oauth?: DiscordOAuth;
  /** Serve the built web client (GET, any path but /bus) from this directory */
  staticDir?: string;
  /** Serve this file as /avatar.vrm */
  vrmPath?: string;
}

export interface AvatarBus {
  readonly port: number;
  /** Publish a message the pipeline doesn't produce (e.g. look_at) */
  publish(msg: BusMessage): void;
  stop(): Promise<void>;
}

const TOPIC = "avatar";
const ROOM_ACTION_TOOL = "room_action";

interface SocketData {
  userId: string;
}

export function parseClientEvent(raw: string): ClientEvent {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`activity bus: client sent invalid JSON: ${String(err)}`);
  }
  const msg = data as { type?: unknown; text?: unknown };
  if (msg.type === "poke" || msg.type === "headpat") return { type: msg.type };
  if (msg.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
    return { type: "chat", text: msg.text.trim() };
  }
  throw new Error(`activity bus: unknown client event ${JSON.stringify(data)}`);
}

export function systemMessageFor(event: ClientEvent, userId: string): string {
  switch (event.type) {
    case "chat":
      return `[Activity] <@${userId}> says in the room: ${event.text}`;
    case "poke":
      return `[Activity] <@${userId}> poked your avatar.`;
    case "headpat":
      return `[Activity] <@${userId}> gave your avatar a headpat.`;
  }
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // Browsers can't set headers on WebSocket; the Activity passes it as a query param
  return new URL(req.url).searchParams.get("token");
}

const BUS_PATH = "/bus";

/** Web client files and the avatar; null when the request is not for one */
async function staticAsset(req: Request, opts: AvatarBusOptions): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (req.method !== "GET" || pathname === BUS_PATH) return null;
  if (pathname === "/avatar.vrm" && opts.vrmPath) return fileResponse(opts.vrmPath);
  if (!opts.staticDir) return null;
  const root = resolve(opts.staticDir);
  const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(root + sep)) return new Response("not found", { status: 404 });
  return fileResponse(file);
}

async function fileResponse(path: string): Promise<Response> {
  const file = Bun.file(path);
  return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
}

export function startAvatarBus(opts: AvatarBusOptions): AvatarBus {
  const allowed = new Set(opts.allowlist);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let mouthEndsAt = 0;

  const server: Server<SocketData> = Bun.serve<SocketData, undefined>({
    port: opts.port ?? 0,
    async fetch(req, srv) {
      if (opts.oauth && new URL(req.url).pathname === "/api/token") return handleTokenRequest(req, opts.oauth);
      const asset = await staticAsset(req, opts);
      if (asset) return asset;
      const token = bearerToken(req);
      if (!token) return new Response("missing token", { status: 401 });
      const userId = await opts.verifyToken(token);
      if (!userId) return new Response("invalid token", { status: 401 });
      if (!allowed.has(userId)) return new Response("forbidden", { status: 403 });
      if (srv.upgrade(req, { data: { userId } })) return undefined;
      return new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        ws.subscribe(TOPIC);
      },
      message(ws: ServerWebSocket<SocketData>, raw) {
        try {
          const event = parseClientEvent(String(raw));
          opts.toBrain(systemMessageFor(event, ws.data.userId));
        } catch (err: unknown) {
          ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
        }
      },
    },
  });

  const publish = (msg: BusMessage) => {
    server.publish(TOPIC, JSON.stringify(msg));
  };

  /** Pace mouth frames at MOUTH_HZ, queued after any frames still playing */
  const scheduleMouth = (pcm: Buffer) => {
    const frameMs = 1000 / MOUTH_HZ;
    const now = Date.now();
    const startAt = Math.max(now, mouthEndsAt);
    const levels = mouthLevels(pcm);
    levels.forEach((value, i) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        publish({ type: "mouth", value });
      }, startAt - now + i * frameMs);
      timers.add(timer);
    });
    mouthEndsAt = startAt + levels.length * frameMs;
  };

  const onEvent = (event: VoiceEvent) => {
    switch (event.type) {
      case "audio_chunk":
        scheduleMouth(event.pcm);
        break;
      case "emotion":
        publish({ type: "emotion", name: event.name, intensity: event.intensity });
        break;
      case "speaking_start":
        publish({ type: "speaking", value: true });
        break;
      case "speaking_end":
        publish({ type: "speaking", value: false });
        break;
      case "tool_call":
        if (event.call.name === ROOM_ACTION_TOOL) {
          const { action, ...args } = event.call.args;
          publish({ type: "room", action: String(action), args });
        }
        break;
      default:
        break;
    }
  };
  const unsubscribe = opts.pipeline.on(onEvent);

  return {
    get port() {
      return server.port;
    },
    publish,
    async stop() {
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await server.stop(true);
    },
  };
}
