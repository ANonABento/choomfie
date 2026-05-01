/**
 * Typed access to the built-in JLPT N5 vocabulary deck.
 */

import n5VocabJson from "./data/n5-vocab.json";

export interface JapaneseVocabItem {
  front: string;
  reading: string;
  back: string;
  tags: string;
}

function isJapaneseVocabItem(item: unknown): item is JapaneseVocabItem {
  if (!item || typeof item !== "object") return false;
  const candidate = item as Partial<JapaneseVocabItem>;
  return (
    typeof candidate.front === "string" &&
    typeof candidate.reading === "string" &&
    typeof candidate.back === "string" &&
    typeof candidate.tags === "string"
  );
}

function isCompleteVocabItem(item: JapaneseVocabItem): boolean {
  return Boolean(item.front.trim() && item.reading.trim() && item.back.trim());
}

const rawDeck = Array.isArray(n5VocabJson) ? n5VocabJson : [];
export const n5Vocab: JapaneseVocabItem[] = rawDeck
  .filter(isJapaneseVocabItem)
  .filter(isCompleteVocabItem);
