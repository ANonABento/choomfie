/**
 * Gemini Live realtime provider — raw WebSocket (BidiGenerateContent, v1beta).
 *
 * Sliding-window context compression, input/output transcription, session
 * resumption: the latest SessionResumptionUpdate handle is kept and used to
 * reconnect when the server sends goAway.
 */

import type { RealtimeProviderEvent, RealtimeVoiceProvider } from "../../pipeline/types.ts";
import { discordToGemini, geminiToDiscord } from "./resample.ts";

export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.8-live";

/** The subset of the WebSocket API this provider uses (browser/Bun shape). */
export interface LiveSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Tools the model may call; the pipeline turns set_emotion into an emotion event. */
export const GEMINI_LIVE_TOOLS: FunctionDeclaration[] = [
  {
    name: "set_emotion",
    description: "Set the avatar's facial expression.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: ["neutral", "happy", "sad", "angry", "surprised", "embarrassed", "thinking"],
        },
        intensity: { type: "number", description: "0 to 1" },
      },
      required: ["name"],
    },
  },
  {
    name: "room_action",
    description: "Do something in the shared room (react to a poke or headpat, open a watch-together link).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["poke", "headpat", "watch_together"] },
        target: { type: "string", description: "Optional link or object" },
      },
      required: ["action"],
    },
  },
];

export interface GeminiLiveOptions {
  apiKey: string;
  model?: string;
  systemInstruction?: string;
  tools?: FunctionDeclaration[];
  /** Injectable for tests; defaults to the global WebSocket. */
  createSocket?: (url: string) => LiveSocket;
}

const OPEN = 1;

export class GeminiLiveProvider implements RealtimeVoiceProvider {
  readonly name = "gemini";
  private socket: LiveSocket | null = null;
  private onEvent: ((e: RealtimeProviderEvent) => void) | null = null;
  private resumeHandle: string | null = null;
  private closing = false;

  constructor(private opts: GeminiLiveOptions) {
    if (!opts.apiKey) throw new Error("Gemini Live: apiKey is required (GEMINI_API_KEY)");
  }

  /** Latest session resumption handle, if the server has sent one. */
  get handle(): string | null {
    return this.resumeHandle;
  }

  async connect(onEvent: (event: RealtimeProviderEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.closing = false;
    await this.open();
  }

  async sendAudio(pcm: Buffer): Promise<void> {
    this.send({
      realtimeInput: {
        audio: { data: discordToGemini(pcm).toString("base64"), mimeType: "audio/pcm;rate=16000" },
      },
    });
  }

  async sendToolResult(id: string, result: unknown): Promise<void> {
    this.send({ toolResponse: { functionResponses: [{ id, response: { result } }] } });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.socket?.close();
    this.socket = null;
  }

  private open(): Promise<void> {
    const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(this.opts.apiKey)}`;
    const create = this.opts.createSocket ?? ((u: string) => new WebSocket(u) as unknown as LiveSocket);
    const socket = create(url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      let ready = false;
      socket.onopen = () => socket.send(JSON.stringify({ setup: this.setupMessage() }));
      socket.onerror = () => {
        const error = new Error("Gemini Live: WebSocket error");
        if (ready) this.emit({ type: "error", error });
        else reject(error);
      };
      socket.onclose = () => {
        if (!ready) reject(new Error("Gemini Live: socket closed before setupComplete"));
      };
      socket.onmessage = (ev) => {
        const msg = parseMessage(ev.data);
        if (msg.setupComplete !== undefined && !ready) {
          ready = true;
          resolve();
        }
        this.handleMessage(socket, msg);
      };
    });
  }

  private setupMessage(): Record<string, unknown> {
    const model = this.opts.model ?? DEFAULT_GEMINI_LIVE_MODEL;
    return {
      model: model.startsWith("models/") ? model : `models/${model}`,
      generationConfig: { responseModalities: ["AUDIO"] },
      ...(this.opts.systemInstruction
        ? { systemInstruction: { parts: [{ text: this.opts.systemInstruction }] } }
        : {}),
      tools: [{ functionDeclarations: this.opts.tools ?? GEMINI_LIVE_TOOLS }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
    };
  }

  private handleMessage(socket: LiveSocket, msg: ServerMessage): void {
    const update = msg.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) this.resumeHandle = update.newHandle;

    const content = msg.serverContent;
    if (content) {
      if (content.inputTranscription?.text) {
        this.emit({ type: "input_transcript", text: content.inputTranscription.text });
      }
      if (content.outputTranscription?.text) {
        this.emit({ type: "output_transcript", text: content.outputTranscription.text });
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          this.emit({ type: "audio", pcm: geminiToDiscord(Buffer.from(part.inlineData.data, "base64")) });
        }
      }
      if (content.turnComplete) this.emit({ type: "turn_complete" });
    }

    for (const call of msg.toolCall?.functionCalls ?? []) {
      this.emit({ type: "tool_call", call: { id: call.id, name: call.name, args: call.args ?? {} } });
    }

    if (msg.goAway !== undefined && socket === this.socket && !this.closing) {
      this.reconnect(socket);
    }
  }

  private reconnect(old: LiveSocket): void {
    old.onclose = null;
    old.onerror = null;
    old.onmessage = null;
    old.close();
    this.open().catch((error: unknown) => {
      this.emit({
        type: "error",
        error: new Error(`Gemini Live: reconnect after goAway failed: ${String(error)}`),
      });
    });
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error("Gemini Live: not connected");
    }
    this.socket.send(JSON.stringify(msg));
  }

  private emit(event: RealtimeProviderEvent): void {
    this.onEvent?.(event);
  }
}

interface ServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
}

function parseMessage(data: unknown): ServerMessage {
  const text =
    typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
  return JSON.parse(text) as ServerMessage;
}
