/**
 * Hangul → Revised Romanization of Korean.
 *
 * Implements basic syllable decomposition via Unicode arithmetic.
 * Covers the 14 basic consonants and 10 basic vowels used at A1.
 * Phonological assimilation rules (liaison, tensification) are intentionally
 * omitted — a learner hint, not an IPA transcription.
 */

// Hangul Syllables block: U+AC00–U+D7A3
const HANGUL_START = 0xac00;
const LEAD_COUNT = 19;
const VOWEL_COUNT = 21;
const TRAIL_COUNT = 28;

// Initial consonants (onset)
const LEAD: readonly string[] = [
  "g", "kk", "n", "d", "tt", "r", "m", "b", "pp",
  "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h",
];

// Vowels
const VOWEL: readonly string[] = [
  "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye",
  "o", "wa", "wae", "oe", "yo",
  "u", "wo", "we", "wi", "yu",
  "eu", "ui", "i",
];

// Final consonants (coda) — simplified for pronunciation hints
const TRAIL: readonly string[] = [
  "",    // 0  none
  "k",   // 1  ㄱ
  "k",   // 2  ㄲ
  "k",   // 3  ㄳ
  "n",   // 4  ㄴ
  "n",   // 5  ㄵ
  "n",   // 6  ㄶ
  "t",   // 7  ㄷ
  "l",   // 8  ㄹ
  "k",   // 9  ㄺ
  "m",   // 10 ㄻ
  "l",   // 11 ㄼ
  "l",   // 12 ㄽ
  "l",   // 13 ㄾ
  "p",   // 14 ㄿ
  "l",   // 15 ㅀ
  "m",   // 16 ㅁ
  "p",   // 17 ㅂ
  "p",   // 18 ㅄ
  "t",   // 19 ㅅ
  "t",   // 20 ㅆ
  "ng",  // 21 ㅇ
  "t",   // 22 ㅈ
  "t",   // 23 ㅊ
  "k",   // 24 ㅋ
  "t",   // 25 ㅌ
  "p",   // 26 ㅍ
  "t",   // 27 ㅎ (often silent, shown as t for coda)
];

function romanizeSyllable(code: number): string {
  const offset = code - HANGUL_START;
  const trailIdx = offset % TRAIL_COUNT;
  const vowelIdx = Math.floor(offset / TRAIL_COUNT) % VOWEL_COUNT;
  const leadIdx = Math.floor(offset / (TRAIL_COUNT * VOWEL_COUNT));
  return LEAD[leadIdx] + VOWEL[vowelIdx] + TRAIL[trailIdx];
}

export function hangulToRomanization(text: string): string {
  let result = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= HANGUL_START && code < HANGUL_START + LEAD_COUNT * VOWEL_COUNT * TRAIL_COUNT) {
      result += romanizeSyllable(code);
    } else {
      result += char;
    }
  }
  return result;
}
