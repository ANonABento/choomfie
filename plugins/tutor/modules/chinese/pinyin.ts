/**
 * Mandarin pinyin utilities.
 *
 * Supports the two common tone styles used by CC-CEDICT and learners:
 * numbered pinyin (ni3 hao3) and marked pinyin (nǐ hǎo).
 */

export type PinyinTone = 1 | 2 | 3 | 4 | 5;

const TONE_MARKS: Record<string, [string, string, string, string]> = {
  a: ["ā", "á", "ǎ", "à"],
  e: ["ē", "é", "ě", "è"],
  i: ["ī", "í", "ǐ", "ì"],
  o: ["ō", "ó", "ǒ", "ò"],
  u: ["ū", "ú", "ǔ", "ù"],
  ü: ["ǖ", "ǘ", "ǚ", "ǜ"],
};

const MARK_TO_BASE = new Map<string, { base: string; tone: PinyinTone }>();
for (const [base, marks] of Object.entries(TONE_MARKS)) {
  marks.forEach((mark, index) => {
    const tone = (index + 1) as PinyinTone;
    MARK_TO_BASE.set(mark, { base, tone });
    MARK_TO_BASE.set(mark.toUpperCase(), { base: base.toUpperCase(), tone });
  });
}

const MARKED_PINYIN_RE =
  /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ]/;

const PINYIN_TOKEN_RE =
  /[A-Za-züÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ:]+/g;

function normalizeUmlaut(input: string): string {
  return input
    .replace(/u:/gi, (match) => (match[0] === "U" ? "Ü" : "ü"))
    .replace(/[vV]/g, (match) => (match === "V" ? "Ü" : "ü"));
}

function withCase(mark: string, source: string): string {
  return source === source.toUpperCase() ? mark.toUpperCase() : mark;
}

function toneMarkIndex(syllable: string): number {
  const lower = syllable.toLowerCase();
  const a = lower.indexOf("a");
  if (a !== -1) return a;

  const e = lower.indexOf("e");
  if (e !== -1) return e;

  const ou = lower.indexOf("ou");
  if (ou !== -1) return ou;

  for (let i = syllable.length - 1; i >= 0; i--) {
    if ("aeiouüAEIOUÜ".includes(syllable[i])) return i;
  }

  return -1;
}

export function numberedSyllableToMarks(syllable: string, tone: PinyinTone): string {
  const normalized = normalizeUmlaut(syllable);
  if (tone === 5) return normalized;

  const index = toneMarkIndex(normalized);
  if (index === -1) return normalized;

  const source = normalized[index];
  const base = source.toLowerCase();
  const mark = TONE_MARKS[base]?.[tone - 1];
  if (!mark) return normalized;

  return `${normalized.slice(0, index)}${withCase(mark, source)}${normalized.slice(index + 1)}`;
}

export function numbersToMarks(input: string): string {
  return input.replace(/([A-Za-züÜvV:]+)([1-5])/g, (_match, syllable: string, tone: string) =>
    numberedSyllableToMarks(syllable, Number(tone) as PinyinTone)
  );
}

function markedTokenToNumbered(token: string): string {
  let tone: PinyinTone | null = null;
  let output = "";

  for (const char of token) {
    const marked = MARK_TO_BASE.get(char);
    if (marked) {
      output += marked.base;
      tone = marked.tone;
    } else {
      output += char;
    }
  }

  return tone ? `${output}${tone}` : output;
}

export function marksToNumbers(input: string): string {
  return input.replace(PINYIN_TOKEN_RE, (token) => markedTokenToNumbered(token));
}

export function normalizePinyin(input: string, style: "marks" | "numbers"): string {
  return style === "marks" ? numbersToMarks(input) : marksToNumbers(input);
}

export function hasToneMarks(input: string): boolean {
  return MARKED_PINYIN_RE.test(input);
}

export function stripToneNumbers(input: string): string {
  return input.replace(/[1-5]/g, "");
}

export function getToneNumber(syllable: string): PinyinTone | null {
  const numbered = marksToNumbers(syllable);
  const match = numbered.match(/[1-5]$/);
  return match ? (Number(match[0]) as PinyinTone) : null;
}

export function isValidNumberedPinyin(input: string): boolean {
  if (hasToneMarks(input)) return false;

  const normalized = normalizeUmlaut(input.trim());
  if (normalized.length === 0) return false;

  return normalized
    .split(/\s+/)
    .every((syllable) => /^[A-Za-züÜ:]+[1-5]?$/.test(syllable));
}
