import { VoiceEventEmitter } from "./emitter.ts";
import type {
  RealtimeProviderEvent,
  RealtimeVoiceProvider,
  VoiceEventListener,
  VoicePipeline,
} from "./types.ts";

/** Maps a realtime provider's raw events onto the shared event contract */
export class RealtimePipeline implements VoicePipeline {
  readonly kind = "realtime" as const;
  private events = new VoiceEventEmitter();
  private speaking = false;
  private connected: Promise<void> | null = null;

  constructor(private provider: RealtimeVoiceProvider) {}

  on(listener: VoiceEventListener): () => void {
    return this.events.on(listener);
  }

  async sendUtterance(pcm: Buffer): Promise<void> {
    this.connected ??= this.provider.connect((e) => this.handle(e));
    await this.connected;
    await this.provider.sendAudio(pcm);
  }

  async close(): Promise<void> {
    await this.provider.close();
  }

  private handle(event: RealtimeProviderEvent): void {
    switch (event.type) {
      case "input_transcript":
        this.events.emit({ type: "user_transcript", text: event.text });
        return;
      case "output_transcript":
        this.events.emit({ type: "assistant_text", text: event.text });
        return;
      case "audio":
        if (!this.speaking) {
          this.speaking = true;
          this.events.emit({ type: "speaking_start" });
        }
        this.events.emit({ type: "audio_chunk", pcm: event.pcm });
        return;
      case "tool_call":
        if (event.call.name === "set_emotion") {
          this.events.emit({
            type: "emotion",
            name: String(event.call.args.name),
            intensity: Number(event.call.args.intensity ?? 1),
          });
        }
        this.events.emit({ type: "tool_call", call: event.call });
        return;
      case "turn_complete":
        if (this.speaking) {
          this.speaking = false;
          this.events.emit({ type: "speaking_end" });
        }
        return;
      case "error":
        this.events.emit({ type: "error", error: event.error });
        return;
    }
  }
}
