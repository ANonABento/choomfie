import { describe, expect, test } from "bun:test";
import { parseVoiceConfig } from "../lib/config.ts";

describe("parseVoiceConfig", () => {
  test("defaults to the cascaded pipeline", () => {
    expect(parseVoiceConfig({ stt: "auto", tts: "auto" }).pipeline).toBe("cascaded");
  });

  test("accepts a realtime pipeline with a provider per slot", () => {
    const voice = parseVoiceConfig({
      stt: "whisper",
      tts: "kokoro",
      pipeline: "realtime",
      realtime: "gemini",
      realtimeModel: "gemini-3.8-live",
      dailyLimits: { "gemini:gemini-3.8-live": 100 },
      blockCloudInPrivate: true,
    });
    expect(voice.pipeline).toBe("realtime");
    expect(voice.realtime).toBe("gemini");
  });

  test("unknown provider fails with a clear error", () => {
    expect(() => parseVoiceConfig({ stt: "nope", tts: "auto" })).toThrow(
      'Unknown voice stt provider: "nope". Available: auto, whisper, groq, elevenlabs',
    );
    expect(() =>
      parseVoiceConfig({ stt: "auto", tts: "auto", pipeline: "realtime", realtime: "openai" }),
    ).toThrow('Unknown voice realtime provider: "openai"');
  });

  test("unknown pipeline and bad limit fail", () => {
    expect(() =>
      parseVoiceConfig({ stt: "auto", tts: "auto", pipeline: "magic" as never }),
    ).toThrow('Unknown voice.pipeline: "magic"');
    expect(() =>
      parseVoiceConfig({ stt: "auto", tts: "auto", dailyLimits: { "gemini:x": -1 } }),
    ).toThrow("non-negative integer");
  });
});
