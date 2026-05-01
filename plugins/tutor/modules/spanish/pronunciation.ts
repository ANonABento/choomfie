/**
 * Small Spanish pronunciation helper for A1 lessons.
 *
 * This is a practical teaching transcription, not a dialect-complete phonology engine.
 * It defaults to Latin American seseo: c/z before e/i are /s/, ll/y are /ʝ/.
 */

const WORD_EXCEPTIONS = new Map<string, string>([
  ["hola", "ˈola"],
  ["hoy", "oj"],
  ["ayer", "aˈʝeɾ"],
  ["gracias", "ˈɡɾasjas"],
  ["adios", "aˈðjos"],
  ["que", "ke"],
  ["quien", "kjen"],
  ["agua", "ˈaɣwa"],
  ["usted", "usˈteð"],
]);

const VOWELS = "aeiouáéíóúü";

function stripAccents(input: string): string {
  return input
    .replace(/[áÁ]/g, "a")
    .replace(/[éÉ]/g, "e")
    .replace(/[íÍ]/g, "i")
    .replace(/[óÓ]/g, "o")
    .replace(/[úÚüÜ]/g, "u");
}

function isVowel(char: string): boolean {
  return VOWELS.includes(char);
}

function stressIndex(syllables: string[], original: string): number {
  const accented = syllables.findIndex((syllable) => /[áéíóú]/.test(syllable));
  if (accented >= 0) return accented;

  const plain = stripAccents(original);
  if (/[aeiouns]$/.test(plain)) return Math.max(0, syllables.length - 2);
  return syllables.length - 1;
}

function roughSyllables(word: string): string[] {
  const syllables: string[] = [];
  let current = "";

  for (let i = 0; i < word.length; i++) {
    current += word[i];
    const next = word[i + 1] ?? "";
    const afterNext = word[i + 2] ?? "";

    if (!isVowel(word[i])) continue;
    if (!next) {
      syllables.push(current);
      current = "";
    } else if (!isVowel(next) && isVowel(afterNext)) {
      syllables.push(current);
      current = "";
    }
  }

  if (current) syllables.push(current);
  return syllables.length > 0 ? syllables : [word];
}

function lettersToIpa(word: string): string {
  let ipa = stripAccents(word.toLowerCase());

  ipa = ipa
    .replace(/qu/g, "k")
    .replace(/gue/g, "ɡe")
    .replace(/gui/g, "ɡi")
    .replace(/ch/g, "tʃ")
    .replace(/ll/g, "ʝ")
    .replace(/rr/g, "r")
    .replace(/ñ/g, "ɲ")
    .replace(/j/g, "x")
    .replace(/ge/g, "xe")
    .replace(/gi/g, "xi")
    .replace(/ce/g, "se")
    .replace(/ci/g, "si")
    .replace(/z/g, "s")
    .replace(/v/g, "b")
    .replace(/h/g, "")
    .replace(/y/g, "ʝ")
    .replace(/c/g, "k")
    .replace(/g/g, "ɡ");

  ipa = ipa.replace(/[bdg]/g, (match, offset, text) => {
    const previous = text[offset - 1] ?? " ";
    if (offset === 0 || /[mnɲlɾr\s]/.test(previous)) return match;
    if (match === "b") return "β";
    if (match === "d") return "ð";
    return "ɣ";
  });

  return ipa.replace(/r(?!$)/g, "ɾ");
}

export function spanishToIpa(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part) || part.length === 0) return part;

      const exception = WORD_EXCEPTIONS.get(stripAccents(part));
      if (exception) return exception;

      const syllables = roughSyllables(part);
      const stressed = stressIndex(syllables, part);
      const ipaSyllables = syllables.map((syllable, index) => {
        const ipa = lettersToIpa(syllable);
        return index === stressed ? `ˈ${ipa}` : ipa;
      });

      return ipaSyllables.join(".");
    })
    .join("");
}
