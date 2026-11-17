import { describe, expect, test } from "bun:test";
import { CascadedPipeline, RealtimePipeline } from "./index.ts";
import type {
  RealtimeProviderEvent,
  RealtimeVoiceProvider,
  STTProvider,
  TTSProvider,
  VoiceEvent,
  VoicePipeline,
} from "./index.ts";

const status = { available: true, reason: "fake", type: "local" as const };
const fakeSTT = (text: string): STTProvider => ({ name: "fake-stt", transcribe: async () => text, detect: async () => status });
const fakeTTS: TTSProvider = { name: "fake-tts", synthesize: async (t) => Buffer.from(t), detect: async () => status };

function record(p: VoicePipeline): VoiceEvent[] {
  const out: VoiceEvent[] = [];
  p.on((e) => out.push(e));
  return out;
}
const types = (events: VoiceEvent[]) => events.map((e) => e.type);

describe("CascadedPipeline", () => {
  test("emits transcript → text → audio sequence", async () => {
    const p = new CascadedPipeline(fakeSTT("hi"), fakeTTS, async (t) => `you said ${t}`);
    const events = record(p);
    await p.sendUtterance(Buffer.alloc(4));
    expect(types(events)).toEqual(["user_transcript", "assistant_text", "speaking_start", "audio_chunk", "speaking_end"]);
    expect(events[1]).toEqual({ type: "assistant_text", text: "you said hi" });
  });

  test("empty transcript emits nothing", async () => {
    const p = new CascadedPipeline(fakeSTT("  "), fakeTTS, async () => "x");
    const events = record(p);
    await p.sendUtterance(Buffer.alloc(4));
    expect(events).toEqual([]);
  });

  test("provider failure becomes an error event", async () => {
    const tts: TTSProvider = { ...fakeTTS, synthesize: async () => { throw new Error("tts down"); } };
    const p = new CascadedPipeline(fakeSTT("hi"), tts, async () => "ok");
    const events = record(p);
    await p.sendUtterance(Buffer.alloc(4));
    expect(types(events)).toEqual(["user_transcript", "assistant_text", "error"]);
  });
});

describe("RealtimePipeline", () => {
  test("maps provider events onto the shared contract", async () => {
    let emit: (e: RealtimeProviderEvent) => void = () => {};
    const provider: RealtimeVoiceProvider = {
      name: "fake-live",
      connect: async (cb) => { emit = cb; },
      sendAudio: async () => {
        emit({ type: "input_transcript", text: "hi" });
        emit({ type: "tool_call", call: { id: "1", name: "set_emotion", args: { name: "happy", intensity: 0.5 } } });
        emit({ type: "output_transcript", text: "hello" });
        emit({ type: "audio", pcm: Buffer.alloc(2) });
        emit({ type: "audio", pcm: Buffer.alloc(2) });
        emit({ type: "turn_complete" });
        emit({ type: "error", error: new Error("boom") });
      },
      sendToolResult: async () => {},
      close: async () => {},
    };
    const p = new RealtimePipeline(provider);
    const events = record(p);
    await p.sendUtterance(Buffer.alloc(2));
    expect(types(events)).toEqual([
      "user_transcript", "emotion", "tool_call", "assistant_text",
      "speaking_start", "audio_chunk", "audio_chunk", "speaking_end", "error",
    ]);
    expect(events[1]).toEqual({ type: "emotion", name: "happy", intensity: 0.5 });
  });
});
