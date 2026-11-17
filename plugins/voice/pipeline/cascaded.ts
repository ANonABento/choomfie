import type { PluginConfig } from "@choomfie/shared";
import { getSTTProvider, getTTSProvider } from "../providers/index.ts";
import { VoiceEventEmitter } from "./emitter.ts";
import type { STTProvider, TTSProvider, VoiceBrain, VoiceEventListener, VoicePipeline } from "./types.ts";

export interface CascadedOptions {
  language?: string;
  speed?: number;
}

/** STT → brain → TTS behind the shared event contract. Providers are used as-is. */
export class CascadedPipeline implements VoicePipeline {
  readonly kind = "cascaded" as const;
  private events = new VoiceEventEmitter();

  constructor(
    private stt: STTProvider,
    private tts: TTSProvider,
    private brain: VoiceBrain,
    private options: CascadedOptions = {}
  ) {}

  on(listener: VoiceEventListener): () => void {
    return this.events.on(listener);
  }

  async sendUtterance(wav: Buffer): Promise<void> {
    const { language, speed } = this.options;
    try {
      const userText = (await this.stt.transcribe(wav, language)).trim();
      if (!userText) return;
      this.events.emit({ type: "user_transcript", text: userText });

      const reply = (await this.brain(userText)).trim();
      if (!reply) return;
      this.events.emit({ type: "assistant_text", text: reply });

      const pcm = await this.tts.synthesize(reply, language, speed);
      this.events.emit({ type: "speaking_start" });
      this.events.emit({ type: "audio_chunk", pcm });
      this.events.emit({ type: "speaking_end" });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.events.emit({ type: "error", error });
    }
  }

  async close(): Promise<void> {}
}

/** Build the cascaded pipeline from the existing provider factory (voice.stt / voice.tts) */
export async function createCascadedPipeline(
  config: PluginConfig,
  brain: VoiceBrain,
  options?: CascadedOptions
): Promise<CascadedPipeline> {
  const [stt, tts] = await Promise.all([getSTTProvider(config), getTTSProvider(config)]);
  return new CascadedPipeline(stt, tts, brain, options);
}
