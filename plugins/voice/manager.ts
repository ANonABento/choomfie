/**
 * VoiceManager — handles voice connections, audio receive/playback.
 *
 * Uses provider interfaces for STT/TTS — backend is swappable via config.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { AppContext } from "../../lib/types.ts";
import {
  getSTTProvider,
  getTTSProvider,
  type STTProvider,
  type TTSProvider,
} from "./providers/index.ts";
import { STT_WAV, DISCORD_PCM } from "./providers/audio.ts";
import { splitSentences } from "./sentence-splitter.ts";

// --- Timeouts ---
const CONNECTION_TIMEOUT = 10_000; // 10s to establish voice connection
const PLAYBACK_START_TIMEOUT = 5_000; // 5s for player to start playing
const PLAYBACK_FINISH_TIMEOUT = 120_000; // 2min for current playback to finish (long TTS responses)

// --- Audio thresholds ---
const MIN_OPUS_CHUNKS = 10; // Skip utterances shorter than ~200ms
const MIN_PCM_BYTES = 4800; // Skip audio < 300ms at 16kHz mono

interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  listeningTo: Set<string>;
  /** Serializes speak() calls so they don't race on the audio player */
  speakQueue: Promise<void>;
}

export class VoiceManager {
  private guilds = new Map<string, GuildVoice>();
  private stt!: STTProvider;
  private tts!: TTSProvider;

  constructor(private ctx: AppContext) {}

  async init() {
    this.stt = await getSTTProvider(this.ctx.config);
    this.tts = await getTTSProvider(this.ctx.config);
    console.error(
      `Voice providers: STT=${this.stt.name}, TTS=${this.tts.name}`
    );
  }

  private ensureInitialized() {
    if (!this.stt || !this.tts) {
      throw new Error("Voice manager not initialized — call init() first");
    }
  }

  async join(channelId: string, guildId: string) {
    this.leave(guildId);

    const guild = await this.ctx.discord.guilds.fetch(guildId);

    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, CONNECTION_TIMEOUT);
    } catch (error) {
      connection.destroy();
      throw error;
    }

    const guildVoice: GuildVoice = {
      connection,
      player,
      listeningTo: new Set(),
      speakQueue: Promise.resolve(),
    };
    this.guilds.set(guildId, guildVoice);

    // Play a short silence frame to prime Discord's voice receive pipeline.
    // Without this, Discord won't send us audio packets (speaking events never fire).
    const silenceBuffer = Buffer.alloc(DISCORD_PCM.sampleRate * DISCORD_PCM.channels * 2 * 0.5, 0); // 0.5s silence
    const silenceStream = Readable.from(silenceBuffer);
    const silenceResource = createAudioResource(silenceStream, { inputType: StreamType.Raw });
    player.play(silenceResource);
    await entersState(player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT);
    await entersState(player, AudioPlayerStatus.Idle, PLAYBACK_FINISH_TIMEOUT);

    connection.receiver.speaking.on("start", (userId: string) => {
      if (guildVoice.listeningTo.has(userId)) return;
      this.listenToUser(guildId, userId);
    });

    console.error(`Voice: joined channel ${channelId} in guild ${guildId}`);
  }

  leave(guildId: string): boolean {
    const gv = this.guilds.get(guildId);
    if (!gv) return false;

    gv.connection.destroy();
    gv.player.stop();
    this.guilds.delete(guildId);
    console.error(`Voice: left guild ${guildId}`);
    return true;
  }

  disconnectAll() {
    for (const [guildId] of this.guilds) {
      this.leave(guildId);
    }
  }

  async speak(guildId: string, text: string, language: string = "en") {
    this.ensureInitialized();
    const gv = this.guilds.get(guildId);
    if (!gv) throw new Error("Not connected to voice in this server");

    // Queue speak calls to prevent racing on the audio player
    const task = gv.speakQueue.then(() => this.doSpeak(gv, text, language));
    gv.speakQueue = task.catch(() => {}); // swallow errors in queue chain
    return task;
  }

  private async doSpeak(gv: GuildVoice, text: string, language: string) {
    if (gv.connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error("Voice connection not ready");
    }

    const speed = this.ctx.config.getVoiceConfig().ttsSpeed ?? 1.0;
    const sentences = splitSentences(text);

    if (sentences.length <= 1) {
      // Short text or single sentence — play directly (no chunking overhead)
      await this.playSingleChunk(gv, sentences[0] ?? text, language, speed);
      return;
    }

    // Streaming: synthesize + play in pipeline.
    // While chunk N plays, chunk N+1 is being synthesized.
    console.error(`Voice: streaming ${sentences.length} sentence chunks`);

    let nextPcm: Promise<Buffer | null> = this.synthesizeSafe(sentences[0], language, speed);

    for (let i = 0; i < sentences.length; i++) {
      // Await the current chunk's PCM (already synthesizing)
      const pcm = await nextPcm;

      // Start synthesizing the next chunk immediately (pipeline)
      if (i + 1 < sentences.length) {
        nextPcm = this.synthesizeSafe(sentences[i + 1], language, speed);
      }

      // Skip failed chunks
      if (!pcm) {
        console.error(`Voice: skipping chunk ${i + 1}/${sentences.length} (synthesis failed)`);
        continue;
      }

      // Play this chunk and wait for it to finish
      await this.playPcmBuffer(gv, pcm);
    }
  }

  /** Synthesize text to PCM, returning null on error instead of throwing */
  private async synthesizeSafe(text: string, language: string, speed: number): Promise<Buffer | null> {
    try {
      return await this.tts.synthesize(text, language, speed);
    } catch (e) {
      console.error(`Voice TTS error: ${e}`);
      return null;
    }
  }

  /** Play a single text chunk (synthesize + play, no pipelining) */
  private async playSingleChunk(gv: GuildVoice, text: string, language: string, speed: number) {
    const audioBuffer = await this.tts.synthesize(text, language, speed);
    await this.playPcmBuffer(gv, audioBuffer);
  }

  /** Play a raw PCM buffer on the audio player, waiting for completion */
  private async playPcmBuffer(gv: GuildVoice, pcm: Buffer) {
    const stream = Readable.from(pcm);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
    });

    if (gv.player.state.status === AudioPlayerStatus.Playing) {
      await entersState(gv.player, AudioPlayerStatus.Idle, PLAYBACK_FINISH_TIMEOUT);
    }

    gv.player.play(resource);
    await entersState(gv.player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT);
    await entersState(gv.player, AudioPlayerStatus.Idle, PLAYBACK_FINISH_TIMEOUT);
  }

  private listenToUser(guildId: string, userId: string) {
    const gv = this.guilds.get(guildId);
    if (!gv) return;

    if (userId === this.ctx.discord.user?.id) return;

    gv.listeningTo.add(userId);

    const opusStream = gv.connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000,
      },
    });

    const chunks: Buffer[] = [];

    opusStream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    opusStream.on("end", async () => {
      gv.listeningTo.delete(userId);

      if (chunks.length < MIN_OPUS_CHUNKS) return;

      try {
        const pcmBuffer = await this.opusToPcm(chunks);
        if (pcmBuffer.length < MIN_PCM_BYTES) return;

        const transcript = await this.stt.transcribe(pcmBuffer);
        if (!transcript || transcript.trim().length === 0) return;

        // Filter out whisper hallucinations on silence/noise
        const normalized = transcript.trim().toLowerCase();
        if (normalized === "[blank_audio]" || normalized === "(blank audio)") return;

        console.error(`Voice STT [${userId}]: ${transcript}`);

        const user = await this.ctx.discord.users.fetch(userId);
        const channelId =
          this.guilds.get(guildId)?.connection.joinConfig.channelId;

        this.ctx.mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: transcript,
            meta: {
              chat_id: channelId || guildId,
              message_id: `voice_${Date.now()}`,
              user: user.username,
              user_id: userId,
              ts: new Date().toISOString(),
              is_dm: "false",
              role:
                this.ctx.ownerUserId && userId === this.ctx.ownerUserId
                  ? "owner"
                  : "user",
              source: "voice",
              guild_id: guildId,
            },
          },
        });
      } catch (e) {
        console.error(`Voice STT error: ${e}`);
      }
    });
  }

  private async opusToPcm(opusChunks: Buffer[]): Promise<Buffer> {
    // Discord sends individual Opus frames (not an OggOpus container).
    // Decode each frame with @discordjs/opus, then resample with ffmpeg.
    const { OpusEncoder } = require("@discordjs/opus");
    const decoder = new OpusEncoder(48000, 2); // Discord sends stereo 48kHz opus

    // Decode each opus frame to raw PCM
    const pcmChunks: Buffer[] = [];
    for (const chunk of opusChunks) {
      try {
        pcmChunks.push(decoder.decode(chunk));
      } catch {
        // Skip corrupted frames
      }
    }

    if (pcmChunks.length === 0) {
      throw new Error("No valid opus frames decoded");
    }

    const rawPcm = Buffer.concat(pcmChunks);

    // Resample from 48kHz stereo to 16kHz mono for STT via ffmpeg
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "-i", "pipe:0",
        "-f", "wav",
        "-ar", String(STT_WAV.sampleRate),
        "-ac", String(STT_WAV.channels),
        "-c:a", STT_WAV.codec,
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
    );

    proc.stdin.write(rawPcm);
    proc.stdin.end();

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error(`ffmpeg resample failed: ${stderr}`);
    }

    return Buffer.from(output);
  }
}
