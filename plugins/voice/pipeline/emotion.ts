/**
 * Emotion signal (Req 6): a fixed expression set, alias mapping, the
 * set_emotion tool shared by the brain and realtime paths, and an optional
 * classifier on assistant text for providers that won't call tools.
 */

import type { FunctionDeclaration } from "../providers/gemini/live.ts";
import type { ToolCall, VoiceEvent } from "./types.ts";

export const EMOTIONS = ["neutral", "happy", "sad", "angry", "surprised", "embarrassed", "thinking"] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Common words models use instead of the canonical names */
const ALIASES: Record<string, Emotion> = {
  calm: "neutral",
  default: "neutral",
  joy: "happy",
  excited: "happy",
  smile: "happy",
  glad: "happy",
  upset: "sad",
  cry: "sad",
  crying: "sad",
  mad: "angry",
  annoyed: "angry",
  frustrated: "angry",
  shocked: "surprised",
  surprise: "surprised",
  amazed: "surprised",
  shy: "embarrassed",
  blush: "embarrassed",
  flustered: "embarrassed",
  curious: "thinking",
  confused: "thinking",
  pondering: "thinking",
};

/** Map a name or alias to the fixed set; null when it is not recognised */
export function normalizeEmotion(name: string): Emotion | null {
  const key = name.trim().toLowerCase();
  if ((EMOTIONS as readonly string[]).includes(key)) return key as Emotion;
  return ALIASES[key] ?? null;
}

function clampIntensity(value: unknown): number {
  const n = value === undefined ? 1 : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export type EmotionEvent = Extract<VoiceEvent, { type: "emotion" }>;

/** Build the emotion event for set_emotion(name, intensity); throws on an unknown name */
export function emotionEvent(name: unknown, intensity?: unknown): EmotionEvent {
  const emotion = normalizeEmotion(String(name ?? ""));
  if (!emotion) {
    throw new Error(`set_emotion: unknown emotion "${String(name)}" (expected one of ${EMOTIONS.join(", ")})`);
  }
  return { type: "emotion", name: emotion, intensity: clampIntensity(intensity) };
}

export const SET_EMOTION_TOOL = "set_emotion";

export const SET_EMOTION_DECLARATION: FunctionDeclaration = {
  name: SET_EMOTION_TOOL,
  description: "Set the avatar's facial expression.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", enum: [...EMOTIONS] },
      intensity: { type: "number", description: "0 to 1" },
    },
    required: ["name"],
  },
};

/** Route a tool call: set_emotion becomes an emotion (or error) event; other tools return null */
export function routeEmotionToolCall(call: ToolCall): VoiceEvent | null {
  if (call.name !== SET_EMOTION_TOOL) return null;
  try {
    return emotionEvent(call.args.name, call.args.intensity);
  } catch (err: unknown) {
    return { type: "error", error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/** Guesses an emotion from assistant text; null means "no change" */
export interface EmotionClassifier {
  classify(text: string): Promise<{ name: string; intensity: number } | null>;
}

/** Default: emotion comes from set_emotion tool calls only */
export class NoopEmotionClassifier implements EmotionClassifier {
  async classify(): Promise<null> {
    return null;
  }
}

/** Run a classifier on assistant text and map its answer onto the fixed set */
export async function classifyEmotion(classifier: EmotionClassifier, text: string): Promise<EmotionEvent | null> {
  const guess = await classifier.classify(text);
  if (!guess) return null;
  return emotionEvent(guess.name, guess.intensity);
}
