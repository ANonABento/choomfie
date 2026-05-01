/**
 * Small built-in kanji metadata table for early JLPT N5 learning.
 *
 * This mirrors the Chinese module's stroke/radical metadata shape so the tutor
 * tools can share the same simple contract until a full stroke-order dataset is
 * introduced.
 */

export interface KanjiInfo {
  character: string;
  strokes: number;
  radical: string;
  meaning: string;
  onyomi?: string;
  kunyomi?: string;
}

export const BASIC_N5_KANJI: KanjiInfo[] = [
  { character: "一", strokes: 1, radical: "一", meaning: "one", onyomi: "ichi, itsu", kunyomi: "hito" },
  { character: "二", strokes: 2, radical: "二", meaning: "two", onyomi: "ni, ji", kunyomi: "futa" },
  { character: "三", strokes: 3, radical: "一", meaning: "three", onyomi: "san", kunyomi: "mi" },
  { character: "四", strokes: 5, radical: "囗", meaning: "four", onyomi: "shi", kunyomi: "yon, yo" },
  { character: "五", strokes: 4, radical: "二", meaning: "five", onyomi: "go", kunyomi: "itsu" },
  { character: "六", strokes: 4, radical: "八", meaning: "six", onyomi: "roku", kunyomi: "mu" },
  { character: "七", strokes: 2, radical: "一", meaning: "seven", onyomi: "shichi", kunyomi: "nana" },
  { character: "八", strokes: 2, radical: "八", meaning: "eight", onyomi: "hachi", kunyomi: "ya" },
  { character: "九", strokes: 2, radical: "乙", meaning: "nine", onyomi: "kyuu, ku", kunyomi: "kokono" },
  { character: "十", strokes: 2, radical: "十", meaning: "ten", onyomi: "juu", kunyomi: "too" },
  { character: "百", strokes: 6, radical: "白", meaning: "hundred", onyomi: "hyaku" },
  { character: "千", strokes: 3, radical: "十", meaning: "thousand", onyomi: "sen", kunyomi: "chi" },
  { character: "万", strokes: 3, radical: "一", meaning: "ten thousand", onyomi: "man, ban" },
  { character: "円", strokes: 4, radical: "冂", meaning: "yen; circle", onyomi: "en", kunyomi: "maru" },
  { character: "人", strokes: 2, radical: "人", meaning: "person", onyomi: "jin, nin", kunyomi: "hito" },
  { character: "日", strokes: 4, radical: "日", meaning: "day; sun", onyomi: "nichi, jitsu", kunyomi: "hi, ka" },
  { character: "月", strokes: 4, radical: "月", meaning: "month; moon", onyomi: "getsu, gatsu", kunyomi: "tsuki" },
  { character: "火", strokes: 4, radical: "火", meaning: "fire", onyomi: "ka", kunyomi: "hi" },
  { character: "水", strokes: 4, radical: "水", meaning: "water", onyomi: "sui", kunyomi: "mizu" },
  { character: "木", strokes: 4, radical: "木", meaning: "tree; wood", onyomi: "moku, boku", kunyomi: "ki" },
  { character: "金", strokes: 8, radical: "金", meaning: "gold; money", onyomi: "kin", kunyomi: "kane" },
  { character: "土", strokes: 3, radical: "土", meaning: "earth; soil", onyomi: "do, to", kunyomi: "tsuchi" },
  { character: "曜", strokes: 18, radical: "日", meaning: "weekday", onyomi: "you" },
  { character: "年", strokes: 6, radical: "干", meaning: "year", onyomi: "nen", kunyomi: "toshi" },
  { character: "時", strokes: 10, radical: "日", meaning: "time; hour", onyomi: "ji", kunyomi: "toki" },
  { character: "分", strokes: 4, radical: "刀", meaning: "minute; part", onyomi: "fun, bun", kunyomi: "wa" },
  { character: "半", strokes: 5, radical: "十", meaning: "half", onyomi: "han", kunyomi: "naka" },
  { character: "今", strokes: 4, radical: "人", meaning: "now", onyomi: "kon, kin", kunyomi: "ima" },
  { character: "毎", strokes: 6, radical: "毋", meaning: "every", onyomi: "mai" },
  { character: "何", strokes: 7, radical: "人", meaning: "what", onyomi: "ka", kunyomi: "nani, nan" },
  { character: "大", strokes: 3, radical: "大", meaning: "big", onyomi: "dai, tai", kunyomi: "oo" },
  { character: "小", strokes: 3, radical: "小", meaning: "small", onyomi: "shou", kunyomi: "chii, ko, o" },
  { character: "中", strokes: 4, radical: "丨", meaning: "middle; inside", onyomi: "chuu", kunyomi: "naka" },
  { character: "上", strokes: 3, radical: "一", meaning: "up; above", onyomi: "jou", kunyomi: "ue, a" },
  { character: "下", strokes: 3, radical: "一", meaning: "down; below", onyomi: "ka, ge", kunyomi: "shita, sa" },
  { character: "来", strokes: 7, radical: "木", meaning: "come", onyomi: "rai", kunyomi: "ku, ki" },
  { character: "行", strokes: 6, radical: "行", meaning: "go", onyomi: "kou, gyou", kunyomi: "i, yu, okona" },
  { character: "食", strokes: 9, radical: "食", meaning: "eat; food", onyomi: "shoku", kunyomi: "ta" },
  { character: "飲", strokes: 12, radical: "食", meaning: "drink", onyomi: "in", kunyomi: "no" },
  { character: "見", strokes: 7, radical: "見", meaning: "see", onyomi: "ken", kunyomi: "mi" },
  { character: "聞", strokes: 14, radical: "耳", meaning: "hear; ask", onyomi: "bun, mon", kunyomi: "ki" },
  { character: "読", strokes: 14, radical: "言", meaning: "read", onyomi: "doku", kunyomi: "yo" },
  { character: "書", strokes: 10, radical: "曰", meaning: "write", onyomi: "sho", kunyomi: "ka" },
  { character: "話", strokes: 13, radical: "言", meaning: "speak; story", onyomi: "wa", kunyomi: "hana" },
  { character: "買", strokes: 12, radical: "貝", meaning: "buy", onyomi: "bai", kunyomi: "ka" },
  { character: "学", strokes: 8, radical: "子", meaning: "study; learning", onyomi: "gaku", kunyomi: "mana" },
  { character: "校", strokes: 10, radical: "木", meaning: "school", onyomi: "kou" },
  { character: "生", strokes: 5, radical: "生", meaning: "life; birth; student", onyomi: "sei, shou", kunyomi: "i, u, nama" },
  { character: "先", strokes: 6, radical: "儿", meaning: "previous; ahead", onyomi: "sen", kunyomi: "saki" },
  { character: "私", strokes: 7, radical: "禾", meaning: "I; private", onyomi: "shi", kunyomi: "watashi, watakushi" },
];

const BASIC_N5_KANJI_BY_CHARACTER = Object.fromEntries(
  BASIC_N5_KANJI.map((info) => [info.character, info])
);

export function getKanjiInfo(character: string): KanjiInfo | null {
  const first = [...character.trim()][0];
  if (!first) return null;
  return BASIC_N5_KANJI_BY_CHARACTER[first] ?? null;
}
