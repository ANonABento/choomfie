/**
 * Small built-in Hanzi metadata table for early HSK 1 learning.
 *
 * This is intentionally modest; a full stroke/radical dataset can replace it
 * without changing the tool contract.
 */

export interface HanziInfo {
  character: string;
  strokes: number;
  radical: string;
  meaning: string;
}

const HANZI_INFO: Record<string, HanziInfo> = {
  一: { character: "一", strokes: 1, radical: "一", meaning: "one" },
  二: { character: "二", strokes: 2, radical: "二", meaning: "two" },
  三: { character: "三", strokes: 3, radical: "一", meaning: "three" },
  人: { character: "人", strokes: 2, radical: "人", meaning: "person" },
  口: { character: "口", strokes: 3, radical: "口", meaning: "mouth" },
  女: { character: "女", strokes: 3, radical: "女", meaning: "woman" },
  子: { character: "子", strokes: 3, radical: "子", meaning: "child" },
  好: { character: "好", strokes: 6, radical: "女", meaning: "good; well" },
  你: { character: "你", strokes: 7, radical: "亻", meaning: "you" },
  我: { character: "我", strokes: 7, radical: "戈", meaning: "I; me" },
  他: { character: "他", strokes: 5, radical: "亻", meaning: "he; him" },
  她: { character: "她", strokes: 6, radical: "女", meaning: "she; her" },
  是: { character: "是", strokes: 9, radical: "日", meaning: "to be" },
  有: { character: "有", strokes: 6, radical: "月", meaning: "to have" },
  不: { character: "不", strokes: 4, radical: "一", meaning: "not; no" },
  大: { character: "大", strokes: 3, radical: "大", meaning: "big" },
  小: { character: "小", strokes: 3, radical: "小", meaning: "small" },
  中: { character: "中", strokes: 4, radical: "丨", meaning: "middle; China" },
  国: { character: "国", strokes: 8, radical: "囗", meaning: "country" },
  学: { character: "学", strokes: 8, radical: "子", meaning: "to study" },
};

const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = {
  国: "國",
  学: "學",
  书: "書",
  汉: "漢",
  语: "語",
  马: "馬",
  吗: "嗎",
};

const TRADITIONAL_TO_SIMPLIFIED = Object.fromEntries(
  Object.entries(SIMPLIFIED_TO_TRADITIONAL).map(([simplified, traditional]) => [
    traditional,
    simplified,
  ])
);

export function getHanziInfo(character: string): HanziInfo | null {
  const first = [...character.trim()][0];
  if (!first) return null;
  return HANZI_INFO[first] ?? null;
}

export function convertHanzi(text: string, to: "simplified" | "traditional"): string {
  const map = to === "simplified" ? TRADITIONAL_TO_SIMPLIFIED : SIMPLIFIED_TO_TRADITIONAL;
  return [...text].map((char) => map[char] ?? char).join("");
}
