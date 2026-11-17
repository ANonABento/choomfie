import { describe, expect, test } from "bun:test";
import {
  CascadedPipeline,
  EMOTIONS,
  NoopEmotionClassifier,
  RealtimePipeline,
  normalizeEmotion,
  routeEmotionToolCall,
} from "./index.ts";
import type {
  EmotionClassifier,
  RealtimeProviderEvent,
  RealtimeVoiceProvider,
  STTProvider,
  TTSProvider,
  VoiceEvent,
} from "./index.ts";

const status = { available: true, reason: "fake", type: "local" as const };
const fakeSTT: STTProvider = { name: "fake-stt", transcribe: async () => "hi", detect: async () => status };
const fakeTTS: TTSProvider = { name: "fake-tts", synthesize: async (t) => Buffer.from(t), detect: async () => status };
const fakeClassifier = (name: string | null): EmotionClassifier => ({
  classify: async () => (name ? { name, intensity: 0.7 } : null),
});

describe("emotion mapping", () => {
  test("canonical names map to themselves", () => {
    for (const e of EMOTIONS) expect(normalizeEmotion(e)).toBe(e);
  });

  test("aliases and case map onto the fixed set", () => {
    expect(normalizeEmotion(" Joy ")).toBe("happy");
    expect(normalizeEmotion("shy")).toBe("embarrassed");
    expect(normalizeEmotion("MAD")).toBe("angry");
    expect(normalizeEmotion("curious")).toBe("thinking");
    expect(normalizeEmotion("shocked")).toBe("surprised");
  });

  test("unknown names are rejected", () => {
    expect(normalizeEmotion("smug")).toBeNull();
  });
});

describe("set_emotion routing", () => {
  test("maps alias and clamps intensity", () => {
    const e = routeEmotionToolCall({ id: "1", name: "set_emotion", args: { name: "joy", intensity: 3 } });
    expect(e).toEqual({ type: "emotion", name: "happy", intensity: 1 });
  });

  test("missing intensity defaults to 1", () => {
    const e = routeEmotionToolCall({ id: "1", name: "set_emotion", args: { name: "sad" } });
    expect(e).toEqual({ type: "emotion", name: "sad", intensity: 1 });
  });

  test("unknown emotion becomes an error event", () => {
    const e = routeEmotionToolCall({ id: "1", name: "set_emotion", args: { name: "smug" } });
    expect(e?.type).toBe("error");
  });

  test("other tools are not routed", () => {
    expect(routeEmotionToolCall({ id: "1", name: "room_action", args: { action: "poke" } })).toBeNull();
  });

  test("realtime path emits the normalised emotion before the tool call", async () => {
    let push: (e: RealtimeProviderEvent) => void = () => {};
    const provider: RealtimeVoiceProvider = {
      name: "fake",
      connect: async (cb) => { push = cb; },
      sendAudio: async () => {},
      sendToolResult: async () => {},
      close: async () => {},
    };
    const p = new RealtimePipeline(provider);
    const events: VoiceEvent[] = [];
    p.on((e) => events.push(e));
    await p.sendUtterance(Buffer.alloc(4));
    push({ type: "tool_call", call: { id: "1", name: "set_emotion", args: { name: "blush", intensity: 0.4 } } });
    expect(events.map((e) => e.type)).toEqual(["emotion", "tool_call"]);
    expect(events[0]).toEqual({ type: "emotion", name: "embarrassed", intensity: 0.4 });
  });

  test("brain path: setEmotion emits the event", () => {
    const p = new CascadedPipeline(fakeSTT, fakeTTS, async () => "ok");
    const events: VoiceEvent[] = [];
    p.on((e) => events.push(e));
    p.setEmotion("thinking", 0.5);
    expect(events).toEqual([{ type: "emotion", name: "thinking", intensity: 0.5 }]);
    expect(() => p.setEmotion("smug")).toThrow(/unknown emotion/);
  });
});

describe("EmotionClassifier", () => {
  test("no-op default emits no emotion", async () => {
    expect(await new NoopEmotionClassifier().classify()).toBeNull();
    const p = new CascadedPipeline(fakeSTT, fakeTTS, async () => "ok");
    const events: VoiceEvent[] = [];
    p.on((e) => events.push(e));
    await p.sendUtterance(Buffer.alloc(4));
    expect(events.some((e) => e.type === "emotion")).toBe(false);
  });

  test("fake classifier on assistant text emits a mapped emotion", async () => {
    const p = new CascadedPipeline(fakeSTT, fakeTTS, async () => "yay", { classifier: fakeClassifier("excited") });
    const events: VoiceEvent[] = [];
    p.on((e) => events.push(e));
    await p.sendUtterance(Buffer.alloc(4));
    expect(events.map((e) => e.type)).toEqual([
      "user_transcript", "assistant_text", "emotion", "speaking_start", "audio_chunk", "speaking_end",
    ]);
    expect(events[2]).toEqual({ type: "emotion", name: "happy", intensity: 0.7 });
  });

  test("fake classifier on realtime output transcript", async () => {
    let push: (e: RealtimeProviderEvent) => void = () => {};
    const provider: RealtimeVoiceProvider = {
      name: "fake",
      connect: async (cb) => { push = cb; },
      sendAudio: async () => {},
      sendToolResult: async () => {},
      close: async () => {},
    };
    const p = new RealtimePipeline(provider, fakeClassifier("upset"));
    const events: VoiceEvent[] = [];
    p.on((e) => events.push(e));
    await p.sendUtterance(Buffer.alloc(4));
    push({ type: "output_transcript", text: "oh no" });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual([
      { type: "assistant_text", text: "oh no" },
      { type: "emotion", name: "sad", intensity: 0.7 },
    ]);
  });
});
