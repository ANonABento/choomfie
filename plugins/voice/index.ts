/**
 * Voice plugin — Discord voice channel support.
 *
 * Providers (auto-detected or configurable):
 *   STT: whisper (local), groq (free API), elevenlabs (paid)
 *   TTS: kokoro (local), edge-tts (free), elevenlabs (paid)
 *
 * Flow: User speaks → Opus → PCM → WAV → STT → Claude → TTS → Opus → Discord
 */

import { GatewayIntentBits } from "discord.js";
import type { Plugin } from "../../lib/types.ts";
import { voiceTools } from "./tools.ts";
import { VoiceManager } from "./manager.ts";

let manager: VoiceManager | null = null;

const voicePlugin: Plugin = {
  name: "voice",

  tools: voiceTools,

  intents: [GatewayIntentBits.GuildVoiceStates],

  instructions: [
    "## Voice",
    "You can join Discord voice channels and have voice conversations.",
    "Use `join_voice` with a channel ID to join. Use `leave_voice` to disconnect.",
    "Use `speak` to say something in the voice channel (TTS).",
    "When users speak in VC, their speech is automatically transcribed (STT) and sent to you.",
    "You can respond by using the `speak` tool — your response will be spoken aloud.",
    "STT/TTS providers are auto-detected or configurable in config.json.",
  ],

  userTools: ["join_voice", "leave_voice", "speak"],

  async init(ctx) {
    manager = new VoiceManager(ctx);
    await manager.init();
    // Make manager accessible to tools via a module-level ref
    setVoiceManager(manager);
    console.error("Voice plugin initialized");
  },

  async destroy() {
    if (manager) {
      manager.disconnectAll();
      manager = null;
    }
  },
};

// Module-level accessor for tools to use
let _manager: VoiceManager | null = null;
export function setVoiceManager(m: VoiceManager | null) {
  _manager = m;
}
export function getVoiceManager(): VoiceManager | null {
  return _manager;
}

export default voicePlugin;
