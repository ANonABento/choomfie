import type { VoiceEvent, VoiceEventListener } from "./types.ts";

/** Minimal fan-out shared by both pipeline shapes */
export class VoiceEventEmitter {
  private listeners = new Set<VoiceEventListener>();

  on(listener: VoiceEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
