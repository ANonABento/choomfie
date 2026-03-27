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
import { STT_WAV } from "./providers/audio.ts";

// --- Timeouts ---
const CONNECTION_TIMEOUT = 10_000; // 10s to establish voice connection
const PLAYBACK_START_TIMEOUT = 5_000; // 5s for player to start playing
const PLAYBACK_FINISH_TIMEOUT = 30_000; // 30s for current playback to finish

// --- Audio thresholds ---
const MIN_OPUS_CHUNKS = 10; // Skip utterances shorter than ~200ms
const MIN_PCM_BYTES = 4800; // Skip audio < 300ms at 16kHz mono

interface GuildVoice {
  connection: VoiceConnection;
  player: AudioPlayer;
  listeningTo: Set<string>;
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
    };
    this.guilds.set(guildId, guildVoice);

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
    if (gv.connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error("Voice connection not ready");
    }

    const audioBuffer = await this.tts.synthesize(text, language);

    const stream = Readable.from(audioBuffer);
    const resource = createAudioResource(stream, {
      inputType: StreamType.Raw,
    });

    if (gv.player.state.status === AudioPlayerStatus.Playing) {
      await entersState(gv.player, AudioPlayerStatus.Idle, PLAYBACK_FINISH_TIMEOUT);
    }

    gv.player.play(resource);
    await entersState(gv.player, AudioPlayerStatus.Playing, PLAYBACK_START_TIMEOUT);
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
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-f",
        "opus",
        "-i",
        "pipe:0",
        "-f",
        "wav",
        "-ar",
        String(STT_WAV.sampleRate),
        "-ac",
        String(STT_WAV.channels),
        "-c:a",
        STT_WAV.codec,
        "pipe:1",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const writer = proc.stdin.getWriter();
    for (const chunk of opusChunks) {
      await writer.write(chunk);
    }
    await writer.close();

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error(`ffmpeg opus→pcm conversion failed: ${stderr}`);
    }

    return Buffer.from(output);
  }
}
