/**
 * Provider interfaces — STT and TTS are swappable backends.
 *
 * To add a new provider:
 *   1. Create a folder: providers/<name>/
 *   2. Implement STTProvider and/or TTSProvider
 *   3. Register in providers/index.ts
 */

export interface STTProvider {
  name: string;
  /** Transcribe a WAV audio buffer to text */
  transcribe(audio: Buffer, language?: string): Promise<string>;
}

export interface TTSProvider {
  name: string;
  /** Synthesize text to PCM audio buffer (48kHz, 16-bit, mono) */
  synthesize(text: string, language?: string): Promise<Buffer>;
}
