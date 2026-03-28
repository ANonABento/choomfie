/**
 * Sentence splitter for streaming TTS.
 *
 * Splits text into sentence-level chunks so each can be synthesized
 * and played independently. This reduces time-to-first-audio for
 * long responses — the first sentence plays while later ones are
 * still being synthesized.
 */

/** Minimum character count to bother splitting. Short text plays as one chunk. */
const MIN_SPLIT_LENGTH = 80;

/**
 * Split text into sentences for TTS chunking.
 *
 * Rules:
 * - Text shorter than MIN_SPLIT_LENGTH is returned as a single chunk
 * - Splits on sentence-ending punctuation (.!?) followed by whitespace
 * - Preserves punctuation with the sentence it ends
 * - Filters out empty/whitespace-only chunks
 * - Handles common abbreviations (Mr., Mrs., Dr., etc.) to avoid false splits
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Short text — don't split, not worth the overhead
  if (trimmed.length < MIN_SPLIT_LENGTH) {
    return [trimmed];
  }

  // Split on sentence-ending punctuation followed by whitespace.
  // Uses a regex that keeps the delimiter with the preceding sentence.
  // Negative lookbehind avoids splitting on common abbreviations.
  const abbrevLookbehind = "(?<!Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Corp|approx|dept|est|vol|no|fig)";
  const pattern = new RegExp(
    `(${abbrevLookbehind}[.!?]+)\\s+`,
    "g"
  );

  const sentences: string[] = [];
  let lastIndex = 0;

  // Use matchAll to find all split points
  for (const match of trimmed.matchAll(pattern)) {
    const endOfSentence = match.index! + match[1].length;
    const chunk = trimmed.slice(lastIndex, endOfSentence).trim();
    if (chunk) sentences.push(chunk);
    lastIndex = endOfSentence + match[0].length - match[1].length;
  }

  // Remaining text after last split point
  const remainder = trimmed.slice(lastIndex).trim();
  if (remainder) sentences.push(remainder);

  // If splitting produced nothing useful, return the original
  if (sentences.length === 0) return [trimmed];

  return sentences;
}
