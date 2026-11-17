/**
 * Voice pipeline contract — one event stream, two shapes.
 *
 *   cascaded: STTProvider → brain → TTSProvider
 *   realtime: RealtimeVoiceProvider (audio in/out + transcripts + tool calls)
 *
 * Consumers (Discord playback, avatar bus, budget guard) only see VoiceEvents.
 */

import type { STTProvider, TTSProvider } from "../providers/types.ts";

export type { STTProvider, TTSProvider };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type VoiceEvent =
  | { type: "user_transcript"; text: string }
  | { type: "assistant_text"; text: string }
  /** PCM 48kHz, 16-bit, stereo — same format TTSProvider returns */
  | { type: "audio_chunk"; pcm: Buffer }
  | { type: "speaking_start" }
  | { type: "speaking_end" }
  | { type: "emotion"; name: string; intensity: number }
  | { type: "tool_call"; call: ToolCall }
  | { type: "error"; error: Error };

export type VoiceEventType = VoiceEvent["type"];
export type VoiceEventListener = (event: VoiceEvent) => void;

export interface VoicePipeline {
  readonly kind: "cascaded" | "realtime";
  /** Subscribe to events; returns an unsubscribe function */
  on(listener: VoiceEventListener): () => void;
  /** Feed one finished user utterance (WAV for cascaded, PCM for realtime) */
  sendUtterance(audio: Buffer): Promise<void>;
  close(): Promise<void>;
}

/** Brain step of the cascaded shape: user text in, reply text out */
export type VoiceBrain = (userText: string) => Promise<string>;

/** Raw events a realtime provider reports; the pipeline maps them to VoiceEvents */
export type RealtimeProviderEvent =
  | { type: "input_transcript"; text: string }
  | { type: "output_transcript"; text: string }
  | { type: "audio"; pcm: Buffer }
  | { type: "tool_call"; call: ToolCall }
  | { type: "turn_complete" }
  | { type: "error"; error: Error };

export interface RealtimeVoiceProvider {
  name: string;
  connect(onEvent: (event: RealtimeProviderEvent) => void): Promise<void>;
  sendAudio(pcm: Buffer): Promise<void>;
  sendToolResult(id: string, result: unknown): Promise<void>;
  close(): Promise<void>;
}
