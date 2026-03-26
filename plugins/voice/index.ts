/**
 * Voice plugin — Discord voice channel support.
 *
 * Phase 1: Groq Whisper (free STT) + ElevenLabs (TTS)
 * Phase 2: local whisper.cpp + VOICEVOX/Edge TTS fallbacks
 *
 * Flow: User speaks → Opus → PCM → WAV → Groq STT → Claude → ElevenLabs TTS → Opus → Discord
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
    "Use `speak` to say something in the voice channel (ElevenLabs TTS).",
    "When users speak in VC, their speech is automatically transcribed and sent to you.",
    "You can respond by using the `speak` tool — your response will be spoken aloud.",
    "Voice supports English and Japanese.",
  ],

  userTools: ["join_voice", "leave_voice", "speak"],

  async init(ctx) {
    manager = new VoiceManager(ctx);
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
