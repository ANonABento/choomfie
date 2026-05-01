/**
 * Persona-aware filler phrases for masking LLM latency (Phase 4).
 *
 * Fillers are pre-synthesized at voice init and played immediately when
 * the user finishes speaking, giving instant audio feedback while Claude
 * processes the transcript. Each persona has distinct phrases matching
 * their character.
 */

export interface FillerSet {
  thinking: string[];
}

export const FILLER_SETS: Record<string, FillerSet> = {
  choomfie: {
    thinking: [
      "Hmm, let me think...",
      "Oh, interesting...",
      "Give me a sec...",
      "Okay so...",
      "Right, right...",
    ],
  },
  taiga: {
    thinking: [
      "Hmph, hold on...",
      "Tch, let me think about that...",
      "W-well...",
      "Ugh, fine, give me a second...",
      "It's not like I need to think about this or anything...",
    ],
  },
  takagi: {
    thinking: [
      "Hmm...",
      "Oh, that's interesting...",
      "Let me think...",
      "Hmm, good question...",
      "Oh~?",
    ],
  },
};

const DEFAULT_FILLERS: FillerSet = {
  thinking: [
    "Hmm, let me think...",
    "Give me a sec...",
    "Okay so...",
    "Right...",
    "Interesting...",
  ],
};

export function getFillersForPersona(persona: string): FillerSet {
  return FILLER_SETS[persona.toLowerCase()] ?? DEFAULT_FILLERS;
}
