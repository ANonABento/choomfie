/**
 * Mandarin Chinese tutor module.
 */

import type { QuizQuestion, TutorModule } from "../../core/types.ts";
import { pick, pickN, shuffle } from "../../core/random.ts";
import { errorMessage } from "@choomfie/shared";
import { initCedict, lookupCedict } from "./dictionary.ts";
import hsk1Vocab from "./data/hsk-1-vocab.json";
import { chineseTools } from "./tools.ts";

interface ChineseVocabItem {
  term: string;
  reading: string;
  meaning: string;
  measure?: string;
}

const CHINESE_LEVELS = ["HSK 1", "HSK 2", "HSK 3", "HSK 4", "HSK 5", "HSK 6"] as const;

type ChineseLevel = (typeof CHINESE_LEVELS)[number];

const HSK1_VOCAB: readonly ChineseVocabItem[] = hsk1Vocab;

const TONE_ITEMS = [
  { char: "妈", reading: "mā", tone: "1st tone", meaning: "mother" },
  { char: "麻", reading: "má", tone: "2nd tone", meaning: "hemp; numb" },
  { char: "马", reading: "mǎ", tone: "3rd tone", meaning: "horse" },
  { char: "骂", reading: "mà", tone: "4th tone", meaning: "to scold" },
  { char: "吗", reading: "ma", tone: "neutral tone", meaning: "question particle" },
];

const MEASURE_ITEMS = HSK1_VOCAB.filter((item) => item.measure);

const LEVEL_GUIDES: Record<ChineseLevel, string> = {
  "HSK 1": `Student is a COMPLETE BEGINNER (HSK 1).
- Use short English explanations first, then simple Mandarin examples
- Always include pinyin with tone marks after new words: 你好 (nǐ hǎo)
- Focus on greetings, numbers, pronouns, basic verbs, time, family, and food
- Keep Chinese sentences short and high-frequency
- Correct tones explicitly and explain tone changes when relevant`,

  "HSK 2": `Student is ELEMENTARY (HSK 2).
- Use HSK 1-2 vocabulary
- Include pinyin for new or corrected words
- Practice daily-life topics: shopping, transport, weather, hobbies, and routine
- Introduce simple complements and common question patterns`,

  "HSK 3": `Student is LOWER-INTERMEDIATE (HSK 3).
- Mix Mandarin examples with English explanations
- Use pinyin selectively for new words
- Focus on comparisons, result complements, aspect particles, and opinions`,

  "HSK 4": `Student is INTERMEDIATE (HSK 4).
- Use more Mandarin in explanations
- Teach nuance, word choice, sentence connectors, and paragraph-level expression
- Pinyin only for uncommon words or pronunciation corrections`,

  "HSK 5": `Student is UPPER-INTERMEDIATE (HSK 5).
- Prefer Mandarin explanations with English for difficult grammar
- Discuss culture, current events, work, and abstract topics
- Emphasize register, collocations, and idiomatic phrasing`,

  "HSK 6": `Student is ADVANCED (HSK 6).
- Use natural Mandarin by default
- Cover academic, literary, formal, and rhetorical language
- Correct subtle tone, rhythm, register, and discourse issues`,
};

function isChineseLevel(level: string): level is ChineseLevel {
  return (CHINESE_LEVELS as readonly string[]).includes(level);
}

function makeMultipleChoice(
  question: string,
  answer: string,
  distractorPool: string[],
  explanation: string
): QuizQuestion {
  const options = shuffle([answer, ...pickN(distractorPoolWithout(answer, distractorPool), 3)]);
  return {
    question,
    options,
    correctIndex: options.indexOf(answer),
    explanation,
  };
}

function distractorPoolWithout(answer: string, pool: string[]): string[] {
  return pool.filter((option) => option !== answer);
}

export const chineseModule: TutorModule = {
  name: "chinese",
  displayName: "Chinese (Mandarin)",
  description: "HSK-based Mandarin learning with pinyin, tones, Hanzi, and CC-CEDICT lookup",
  icon: "🇨🇳",
  levels: [...CHINESE_LEVELS],
  defaultLevel: "HSK 1",
  quizTypes: ["vocab", "pinyin", "tone", "hanzi", "measure"],
  tools: chineseTools,

  async lookup(query: string) {
    return lookupCedict(query);
  },

  buildTutorPrompt(level: string): string {
    const guide = isChineseLevel(level) ? LEVEL_GUIDES[level] : LEVEL_GUIDES["HSK 1"];

    return `You are a Mandarin Chinese tutor. ${guide}

When the student writes in Chinese or pinyin, respond with a JSON block:
\`\`\`json
{
  "response_zh": "Your Mandarin response",
  "pinyin": "Pinyin with tone marks",
  "response_en": "English translation",
  "corrections": [
    { "original": "what they wrote", "corrected": "correct Mandarin or pinyin", "type": "tone|pinyin|grammar|vocabulary|word_order|character", "explanation": "why" }
  ],
  "new_words": [
    { "word": "你好", "pinyin": "nǐ hǎo", "meaning": "hello" }
  ]
}
\`\`\`

If the student writes in English, teach naturally and give Mandarin examples with pinyin.
Be precise about tones; tone accuracy is part of meaning in Mandarin.`;
  },

  generateQuiz(_level: string, type: string): QuizQuestion {
    if (type === "pinyin") {
      const correct = pick(HSK1_VOCAB);
      return makeMultipleChoice(
        `What is the pinyin for **${correct.term}**?`,
        correct.reading,
        HSK1_VOCAB.map((item) => item.reading),
        `${correct.term} is pronounced ${correct.reading}.`
      );
    }

    if (type === "tone") {
      const correct = pick(TONE_ITEMS);
      return makeMultipleChoice(
        `Which tone is **${correct.reading}** in **${correct.char}** (${correct.meaning})?`,
        correct.tone,
        TONE_ITEMS.map((item) => item.tone),
        `${correct.char} (${correct.reading}) uses the ${correct.tone}.`
      );
    }

    if (type === "hanzi") {
      const correct = pick(HSK1_VOCAB);
      return makeMultipleChoice(
        `Which characters mean **"${correct.meaning}"**?`,
        correct.term,
        HSK1_VOCAB.map((item) => item.term),
        `${correct.term} (${correct.reading}) means "${correct.meaning}".`
      );
    }

    if (type === "measure") {
      const correct = pick(MEASURE_ITEMS);
      return makeMultipleChoice(
        `Choose the measure word: 一___${correct.term}`,
        correct.measure ?? "",
        ["个", "本", "杯", "张", "只", "位", "块"],
        `${correct.term} commonly uses the measure word ${correct.measure}.`
      );
    }

    const correct = pick(HSK1_VOCAB);
    return makeMultipleChoice(
      `What does **${correct.term}** (${correct.reading}) mean?`,
      correct.meaning,
      HSK1_VOCAB.map((item) => item.meaning),
      `${correct.term} (${correct.reading}) means "${correct.meaning}".`
    );
  },

  async init() {
    try {
      await initCedict();
    } catch (e: unknown) {
      console.error(
        `Chinese module: CC-CEDICT init failed (non-critical): ${errorMessage(e)}`
      );
    }
  },
};
