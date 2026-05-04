/**
 * Furigana engine — auto-adds readings to kanji text.
 *
 * Uses kuroshiro for morphological analysis + reading generation.
 * Output format: 食[た]べ物[もの] (Discord-friendly bracket notation)
 */

import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "@sglkc/kuroshiro-analyzer-kuromoji";

let kuroshiro: any = null;
let initPromise: Promise<void> | null = null;

/** Initialize kuroshiro (async, loads ~2MB dictionary). Call once. */
export async function initFurigana(): Promise<void> {
  if (kuroshiro) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      kuroshiro = new Kuroshiro();
      await kuroshiro.init(new KuromojiAnalyzer());
      console.error("Furigana engine initialized");
    } catch (e) {
      kuroshiro = null;
      initPromise = null;
      throw e;
    }
  })();

  return initPromise;
}

/** Add furigana to Japanese text. Returns bracket notation: 食[た]べる */
export async function addFurigana(text: string): Promise<string> {
  if (!kuroshiro) await initFurigana();
  const html = await kuroshiro.convert(text, {
    mode: "furigana",
    to: "hiragana",
  });
  return html
    .replace(/<ruby>/g, "")
    .replace(/<\/ruby>/g, "")
    .replace(/<rp>\(<\/rp>/g, "")
    .replace(/<rp>\)<\/rp>/g, "")
    .replace(/<rt>/g, "[")
    .replace(/<\/rt>/g, "]");
}

/** Convert Japanese text to hiragana */
export async function toHiragana(text: string): Promise<string> {
  if (!kuroshiro) await initFurigana();
  return kuroshiro.convert(text, { to: "hiragana" });
}

/** Convert Japanese text to romaji */
export async function toRomaji(text: string): Promise<string> {
  if (!kuroshiro) await initFurigana();
  return kuroshiro.convert(text, { to: "romaji" });
}

/** Check if text contains kanji */
export function hasKanji(text: string): boolean {
  return Kuroshiro.Util.hasKanji(text);
}
