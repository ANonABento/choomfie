import { afterEach, describe, expect, test } from "bun:test";
import { VoiceEventEmitter } from "@choomfie/voice/pipeline/emitter.ts";
import type { VoicePipeline } from "@choomfie/voice/pipeline/types.ts";
import { mouthLevels, MOUTH_HZ } from "./mouth.ts";
import { startAvatarBus, type AvatarBus } from "./bus.ts";

const OWNER = "111";
const STRANGER = "222";

class FakePipeline extends VoiceEventEmitter implements VoicePipeline {
  readonly kind = "cascaded" as const;
  async sendUtterance(): Promise<void> {}
  async close(): Promise<void> {}
}

/** 48 kHz stereo s16le sine at the given amplitude (0–1) */
function tone(seconds: number, amplitude: number): Buffer {
  const frames = Math.round(48_000 * seconds);
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const s = Math.round(Math.sin((2 * Math.PI * 220 * i) / 48_000) * amplitude * 32767);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

let bus: AvatarBus | null = null;
afterEach(async () => {
  await bus?.stop();
  bus = null;
});

function setup() {
  const pipeline = new FakePipeline();
  const brain: string[] = [];
  bus = startAvatarBus({
    pipeline,
    allowlist: [OWNER],
    verifyToken: async (token) => ({ "tok-owner": OWNER, "tok-stranger": STRANGER })[token] ?? null,
    toBrain: (m) => brain.push(m),
  });
  return { pipeline, brain, url: `ws://localhost:${bus.port}`, http: `http://localhost:${bus.port}` };
}

function connect(url: string): Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>> }> {
  const ws = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, messages });
    ws.onerror = () => reject(new Error("socket error"));
  });
}

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

describe("mouthLevels", () => {
  test("one level per 1/30 s window, louder audio opens wider", () => {
    expect(mouthLevels(tone(1, 0.2))).toHaveLength(MOUTH_HZ);
    expect(mouthLevels(tone(0.1, 0)).every((v) => v === 0)).toBe(true);
    const [quiet] = mouthLevels(tone(0.1, 0.05));
    const [loud] = mouthLevels(tone(0.1, 0.2));
    expect(loud).toBeGreaterThan(quiet);
    expect(loud).toBeLessThanOrEqual(1);
  });
});

describe("avatar bus", () => {
  test("fake audio chunk produces mouth frames", async () => {
    const { pipeline, url } = setup();
    const { ws, messages } = await connect(`${url}/?token=tok-owner`);
    pipeline.emit({ type: "speaking_start" });
    pipeline.emit({ type: "audio_chunk", pcm: tone(0.1, 0.2) });
    pipeline.emit({ type: "emotion", name: "happy", intensity: 0.8 });
    await waitFor(() => messages.filter((m) => m.type === "mouth").length === 3);
    const mouth = messages.filter((m) => m.type === "mouth");
    expect(mouth.every((m) => (m.value as number) > 0 && (m.value as number) <= 1)).toBe(true);
    expect(messages).toContainEqual({ type: "speaking", value: true });
    expect(messages).toContainEqual({ type: "emotion", name: "happy", intensity: 0.8 });
    ws.close();
  });

  test("non-allowlisted user gets 403, bad token 401", async () => {
    const { http } = setup();
    const headers = { upgrade: "websocket", connection: "Upgrade" };
    expect((await fetch(`${http}/?token=tok-stranger`, { headers })).status).toBe(403);
    expect((await fetch(`${http}/?token=nope`, { headers })).status).toBe(401);
  });

  test("poke reaches the brain as a system message", async () => {
    const { url, brain } = setup();
    const { ws } = await connect(`${url}/?token=tok-owner`);
    ws.send(JSON.stringify({ type: "poke" }));
    ws.send(JSON.stringify({ type: "chat", text: "hi" }));
    await waitFor(() => brain.length === 2);
    expect(brain[0]).toBe(`[Activity] <@${OWNER}> poked your avatar.`);
    expect(brain[1]).toContain("hi");
    ws.close();
  });

  test("room_action tool calls and look_at are published", async () => {
    const { pipeline, url } = setup();
    const { ws, messages } = await connect(`${url}/?token=tok-owner`);
    pipeline.emit({ type: "tool_call", call: { id: "1", name: "room_action", args: { action: "watch_together", url: "x" } } });
    bus!.publish({ type: "look_at", x: 0.5, y: 0.2 });
    await waitFor(() => messages.length === 2);
    expect(messages).toEqual([
      { type: "room", action: "watch_together", args: { url: "x" } },
      { type: "look_at", x: 0.5, y: 0.2 },
    ]);
    ws.close();
  });
});
