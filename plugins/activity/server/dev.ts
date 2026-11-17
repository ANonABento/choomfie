/**
 * `bun run activity:dev`: start the Activity server (bus + token exchange +
 * built web client) and a cloudflared quick tunnel to it, then print the
 * target to paste into the Developer Portal's URL Mappings.
 * Standalone: no voice manager here, so the avatar idles and room events are
 * printed instead of reaching a brain. See docs/activity.md.
 */
import { join } from "node:path";
import type { VoicePipeline } from "@choomfie/voice/pipeline/types.ts";
import { VoiceEventEmitter } from "@choomfie/voice/pipeline/emitter.ts";
import { startAvatarBus, type AvatarBus, type AvatarBusOptions } from "./bus.ts";
import { discordTokenVerifier } from "./token.ts";

export const DEFAULT_PORT = 3001;
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface Tunnel {
  /** Public https URL once cloudflared reports it */
  url: Promise<string>;
  stop(): void;
}

export interface DevDeps {
  startBus: (opts: AvatarBusOptions) => AvatarBus;
  startTunnel: (port: number) => Tunnel;
  log: (line: string) => void;
}

/** DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, ACTIVITY_ALLOWLIST, ACTIVITY_BUS_PORT, ACTIVITY_VRM */
export type DevEnv = Record<string, string | undefined>;

/** The bus needs a pipeline; with no voice manager attached nothing speaks */
class IdlePipeline implements VoicePipeline {
  readonly kind = "cascaded";
  private emitter = new VoiceEventEmitter();
  on = this.emitter.on.bind(this.emitter);
  async sendUtterance(): Promise<void> {
    throw new Error("activity:dev has no voice pipeline attached");
  }
  async close(): Promise<void> {}
}

function required(env: DevEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`activity:dev: ${key} is not set (see docs/activity.md)`);
  return value;
}

/** Find the quick-tunnel URL in cloudflared's log output */
export function parseTunnelUrl(text: string): string | null {
  return text.match(TUNNEL_URL)?.[0] ?? null;
}

export function cloudflaredTunnel(port: number): Tunnel {
  const proc = Bun.spawn(["cloudflared", "tunnel", "--url", `http://localhost:${port}`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const url = (async () => {
    let seen = "";
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
      seen += chunk;
      const found = parseTunnelUrl(seen);
      if (found) return found;
    }
    throw new Error(`cloudflared exited (${await proc.exited}) before printing a tunnel URL:\n${seen}`);
  })();
  return { url, stop: () => proc.kill() };
}

export async function startActivityDev(
  env: DevEnv,
  deps: DevDeps,
): Promise<{ bus: AvatarBus; tunnel: Tunnel; url: string }> {
  const allowlist = required(env, "ACTIVITY_ALLOWLIST").split(",").map((id) => id.trim()).filter(Boolean);
  const bus = deps.startBus({
    port: Number(env.ACTIVITY_BUS_PORT ?? DEFAULT_PORT),
    pipeline: new IdlePipeline(),
    allowlist,
    verifyToken: discordTokenVerifier(),
    toBrain: (msg) => deps.log(`room event (no brain attached): ${msg}`),
    oauth: { clientId: required(env, "DISCORD_CLIENT_ID"), clientSecret: required(env, "DISCORD_CLIENT_SECRET") },
    staticDir: join(import.meta.dirname, "../web/dist"),
    vrmPath: env.ACTIVITY_VRM,
  });
  const tunnel = deps.startTunnel(bus.port);
  try {
    const url = await tunnel.url;
    deps.log(`activity server on http://localhost:${bus.port}`);
    deps.log(`URL Mapping: prefix "/" → target "${new URL(url).host}"`);
    return { bus, tunnel, url };
  } catch (err: unknown) {
    await bus.stop();
    throw err;
  }
}

if (import.meta.main) {
  const { bus, tunnel } = await startActivityDev(process.env, {
    startBus: startAvatarBus,
    startTunnel: cloudflaredTunnel,
    log: console.log,
  });
  process.on("SIGINT", () => {
    tunnel.stop();
    void bus.stop().then(() => process.exit(0));
  });
}
