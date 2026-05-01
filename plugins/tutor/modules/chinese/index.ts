/**
 * Chinese tutor module.
 */

import type { DictionaryEntry, QuizQuestion, TutorModule, TutorPromptContext } from "../../core/types.ts";
import { pick, pickN, shuffle } from "../../core/random.ts";
import { hsk1Vocab } from "./data/hsk1-vocab.ts";
import { chineseTools } from "./tools.ts";

const LEVEL_GUIDES: Record<string, string> = {
  "HSK 1": `Student is a COMPLETE BEGINNER (HSK 1).
- Use only basic HSK 1 vocabulary and short sentence patterns
- Always include pinyin with tone numbers for new hanzi: 你好 (ni3 hao3)
- Explain tones explicitly when pronunciation matters
- Focus on: greetings, numbers, people, dates, locations, food, simple actions
- Keep sentences SHORT and concrete
- If they answer in pinyin, accept it while gently tying it back to hanzi`,

  "HSK 2": `Student is ELEMENTARY (HSK 2).
- Use HSK 1-2 vocabulary
- Include pinyin for new or difficult hanzi
- Build simple connected sentences with common verbs, time words, and complements`,

  "HSK 3": `Student is LOWER-INTERMEDIATE (HSK 3).
- Use HSK 1-3 vocabulary
- Include pinyin only for new words
- Encourage longer answers and simple paragraph-level explanations`,

  "HSK 4": `Student is INTERMEDIATE (HSK 4).
- Use HSK 1-4 vocabulary
- Explain grammar with short Mandarin examples and concise English support
- Encourage connected answers about daily life, plans, and opinions`,

  "HSK 5": `Student is UPPER-INTERMEDIATE (HSK 5).
- Use natural Mandarin with targeted English explanations for nuance
- Practice longer reading, discussion, and register differences
- Correct word choice, collocation, and sentence flow`,

  "HSK 6": `Student is ADVANCED (HSK 6).
- Use native-like Mandarin for most instruction
- Focus on nuance, idioms, formal writing, and abstract discussion
- Use English only for difficult explanations or when requested`,
};

const LEVELS = ["HSK1", "HSK2", "HSK3"] as const;

function normalizeLevel(level: string): string {
  return level.replace(/\s+/g, "").toUpperCase();
}

const TONE_QUESTIONS: QuizQuestion[] = [
  {
    question: "Which pinyin marks the first tone?",
    options: ["ma1", "ma2", "ma3", "ma4"],
    correctIndex: 0,
    explanation: "First tone is high and level, written with tone number 1.",
  },
  {
    question: "Which pinyin marks the fourth tone?",
    options: ["ma4", "ma1", "ma2", "ma3"],
    correctIndex: 0,
    explanation: "Fourth tone falls sharply, written with tone number 4.",
  },
  {
    question: "What does the number in ni3 show?",
    options: ["tone", "stroke count", "word order", "volume"],
    correctIndex: 0,
    explanation: "Tone numbers show the Mandarin tone for each syllable.",
  },
];

function asDictionaryEntry(item: (typeof hsk1Vocab)[number]): DictionaryEntry {
  return {
    word: item.term,
    reading: item.reading,
    meanings: [item.meaning],
    partOfSpeech: ["HSK 1 vocabulary"],
    level: "HSK 1",
  };
}

export const chineseModule: TutorModule = {
  name: "chinese",
  displayName: "Chinese",
  description: "Mandarin Chinese learning with tones, hanzi, and HSK vocabulary",
  icon: "🇨🇳",
  levels: [...LEVELS],
  defaultLevel: LEVELS[0],
  quizTypes: ["tones", "hanzi", "vocab"],
  tools: chineseTools,

  async lookup(query: string): Promise<DictionaryEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    return hsk1Vocab
      .filter((item) => {
        return (
          item.term.includes(query.trim()) ||
          item.reading.toLowerCase().includes(normalized) ||
          item.meaning.toLowerCase().includes(normalized)
        );
      })
      .slice(0, 10)
      .map(asDictionaryEntry);
  },

  buildTutorPrompt(level: string, ctx?: TutorPromptContext): string {
    const levelKey = normalizeLevel(level);
    const pinyinDirective = (() => {
      const fl = ctx?.furiganaLevel;
      if (fl === "full") return "\nPinyin: ALWAYS include pinyin with tone numbers for hanzi, e.g. 你好 (ni3 hao3).";
      if (fl === "partial") return "\nPinyin: include pinyin for new or uncommon hanzi, but leave familiar HSK 1 words bare when reviewing.";
      if (fl === "none") return "\nPinyin: do not add pinyin unless the student asks; this is review without aids.";
      return "";
    })();

    return `You are a Mandarin Chinese tutor. ${LEVEL_GUIDES[levelKey] || LEVEL_GUIDES.HSK1}${pinyinDirective}

When the student writes in Chinese or pinyin, respond with a JSON block:
\`\`\`json
{
  "response_zh": "Your Chinese response",
  "response_en": "English translation",
  "pinyin": "Tone-number pinyin for the Chinese response",
  "corrections": [
    { "original": "what they wrote wrong", "corrected": "correct version", "type": "tone|hanzi|vocabulary|grammar|word_order", "explanation": "why" }
  ],
  "new_words": [
    { "word": "学习", "reading": "xue2xi2", "meaning": "to study" }
  ]
}
\`\`\`

If the student writes in English, respond naturally as a tutor: teach the Chinese, pinyin, tones, and a short example.`;
  },

  generateQuiz(_level: string, type: string): QuizQuestion {
    if (type === "tones") {
      return pick(TONE_QUESTIONS);
    }

    if (type === "hanzi") {
      const correct = pick(hsk1Vocab);
      const wrongOptions = pickN(
        hsk1Vocab.filter((item) => item.reading !== correct.reading),
        3,
      );
      const options = shuffle([correct.reading, ...wrongOptions.map((item) => item.reading)]);

      return {
        question: `What is the pinyin for **${correct.term}**?`,
        options,
        correctIndex: options.indexOf(correct.reading),
        explanation: `${correct.term} is read as ${correct.reading}.`,
      };
    }

    const correct = pick(hsk1Vocab);
    const wrongOptions = pickN(
      hsk1Vocab.filter((item) => item.meaning !== correct.meaning),
      3,
    );
    const options = shuffle([correct.meaning, ...wrongOptions.map((item) => item.meaning)]);

    return {
      question: `What does **${correct.term}** (${correct.reading}) mean?`,
      options,
      correctIndex: options.indexOf(correct.meaning),
      explanation: `${correct.term} (${correct.reading}) means "${correct.meaning}".`,
    };
  },
};
