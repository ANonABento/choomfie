import type { AudioPlayer, VoiceConnection } from "@discordjs/voice";
import type { SileroVAD, SpeechDetector } from "./vad.ts";

/** Per-speaker VAD + endpointing pipeline (Phase 6) */
export interface SpeakerPipeline {
  vad: SileroVAD;
  speechDetector: SpeechDetector;
  lastActive: number;
  ready: boolean;
}

export interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  listeningTo: Set<string>;
  /** Serializes speak() calls so they don't race on the audio player */
  speakQueue: Promise<void>;
  /** Monotonic counter — incremented on interruption to invalidate stale speak() calls */
  generationId: number;
  /** Text of chunks actually played (for interruption context) */
  lastSpokenText: string;
  /** Timer for barge-in debounce (filters coughs/backchannels) */
  bargeInTimer: ReturnType<typeof setTimeout> | null;
  /** Per-speaker VAD pipelines (Phase 6) */
  speakerPipelines: Map<string, SpeakerPipeline>;
  /** Periodic cleanup timer for idle pipelines */
  pipelineCleanupTimer: ReturnType<typeof setInterval> | null;
  /** Set when bot is interrupted — prepended to next voice notification for context */
  interruptionContext?: string;
}
