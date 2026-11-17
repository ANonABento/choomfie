import { describe, expect, test } from "bun:test";
import { RealtimePipeline } from "../../pipeline/realtime.ts";
import type { RealtimeProviderEvent, VoiceEvent } from "../../pipeline/types.ts";
import { GeminiLiveProvider, type LiveSocket } from "./live.ts";
import { discordToGemini, geminiToDiscord } from "./resample.ts";

class FakeSocket implements LiveSocket {
  readyState = 0;
  sent: Record<string, any>[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string): void {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (msg.setup) queueMicrotask(() => this.server({ setupComplete: {} }));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  server(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function makeProvider() {
  const sockets: FakeSocket[] = [];
  const provider = new GeminiLiveProvider({
    apiKey: "test-key",
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { provider, sockets };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("resample", () => {
  test("48 kHz stereo in → 16 kHz mono (20 ms frame: 960 frames → 320 samples)", () => {
    const out = discordToGemini(Buffer.alloc(960 * 4));
    expect(out.length / 2).toBe(320);
  });

  test("24 kHz mono out → 48 kHz stereo (480 samples → 960 frames)", () => {
    const out = geminiToDiscord(Buffer.alloc(480 * 2));
    expect(out.length / 4).toBe(960);
  });

  test("averages channels and keeps level", () => {
    const pcm = Buffer.alloc(3 * 4);
    for (let f = 0; f < 3; f++) {
      pcm.writeInt16LE(1000, f * 4);
      pcm.writeInt16LE(3000, f * 4 + 2);
    }
    expect(discordToGemini(pcm).readInt16LE(0)).toBe(2000);
    const up = geminiToDiscord(Buffer.from(new Int16Array([100, 300]).buffer));
    expect([0, 1, 2, 3].map((i) => up.readInt16LE(i * 2))).toEqual([100, 100, 200, 200]);
  });
});

describe("GeminiLiveProvider", () => {
  test("setup enables compression, transcription and tools", async () => {
    const { provider, sockets } = makeProvider();
    await provider.connect(() => {});
    const setup = sockets[0].sent[0].setup;
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.tools[0].functionDeclarations.map((f: { name: string }) => f.name)).toEqual([
      "set_emotion",
      "room_action",
    ]);
    expect(sockets[0].url).toContain("key=test-key");
  });

  test("sends audio as 16 kHz base64 PCM", async () => {
    const { provider, sockets } = makeProvider();
    await provider.connect(() => {});
    await provider.sendAudio(Buffer.alloc(960 * 4));
    const audio = sockets[0].sent[1].realtimeInput.audio;
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(audio.data, "base64").length).toBe(640);
  });

  test("keeps the latest resumption handle and reuses it after goAway", async () => {
    const { provider, sockets } = makeProvider();
    await provider.connect(() => {});
    sockets[0].server({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } });
    sockets[0].server({ sessionResumptionUpdate: { newHandle: "h2", resumable: true } });
    sockets[0].server({ sessionResumptionUpdate: { resumable: false } });
    expect(provider.handle).toBe("h2");

    sockets[0].server({ goAway: { timeLeft: "5s" } });
    await tick();
    await tick();
    expect(sockets[0].closed).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].sent[0].setup.sessionResumption).toEqual({ handle: "h2" });

    await provider.sendAudio(Buffer.alloc(12));
    expect(sockets[1].sent[1].realtimeInput).toBeDefined();
  });

  test("routes transcripts, audio and tool calls", async () => {
    const { provider, sockets } = makeProvider();
    const events: RealtimeProviderEvent[] = [];
    await provider.connect((e) => events.push(e));
    sockets[0].server({
      serverContent: {
        inputTranscription: { text: "hi" },
        outputTranscription: { text: "hello" },
        modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480 * 2).toString("base64") } }] },
        turnComplete: true,
      },
    });
    sockets[0].server({
      toolCall: { functionCalls: [{ id: "c1", name: "room_action", args: { action: "headpat" } }] },
    });
    expect(events.map((e) => e.type)).toEqual([
      "input_transcript",
      "output_transcript",
      "audio",
      "turn_complete",
      "tool_call",
    ]);
    const audio = events[2] as { type: "audio"; pcm: Buffer };
    expect(audio.pcm.length).toBe(960 * 4);
    expect(events[4]).toEqual({
      type: "tool_call",
      call: { id: "c1", name: "room_action", args: { action: "headpat" } },
    });

    await provider.sendToolResult("c1", "ok");
    expect(sockets[0].sent.at(-1)).toEqual({
      toolResponse: { functionResponses: [{ id: "c1", response: { result: "ok" } }] },
    });
  });

  test("set_emotion reaches the pipeline as an emotion event", async () => {
    const { provider, sockets } = makeProvider();
    const pipeline = new RealtimePipeline(provider);
    const events: VoiceEvent[] = [];
    pipeline.on((e) => events.push(e));
    await pipeline.sendUtterance(Buffer.alloc(12));
    sockets[0].server({
      toolCall: { functionCalls: [{ id: "e1", name: "set_emotion", args: { name: "happy", intensity: 0.5 } }] },
    });
    expect(events[0]).toEqual({ type: "emotion", name: "happy", intensity: 0.5 });
    expect(events[1].type).toBe("tool_call");
  });

  test("fails loudly without an API key", () => {
    expect(() => new GeminiLiveProvider({ apiKey: "" })).toThrow(/GEMINI_API_KEY/);
  });
});

const apiKey = process.env.GEMINI_API_KEY;
describe.skipIf(!apiKey)("GeminiLiveProvider live smoke", () => {
  test("connects and gets setupComplete", async () => {
    const provider = new GeminiLiveProvider({
      apiKey: apiKey ?? "",
      model: process.env.GEMINI_LIVE_MODEL,
    });
    await provider.connect(() => {});
    await provider.sendAudio(Buffer.alloc(960 * 4 * 10));
    await provider.close();
  }, 20_000);
});
