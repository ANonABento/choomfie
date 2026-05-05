/**
 * Korean tutor module — A1 / TOPIK I.
 */

import type { DictionaryEntry, QuizQuestion, TutorModule, TutorPromptContext } from "../../core/types.ts";
import { pick, pickN, shuffle } from "../../core/random.ts";
import { koreanA1Vocab } from "./data/a1-vocab.ts";
import { koreanTools } from "./tools.ts";

const LEVEL_GUIDES: Record<string, string> = {
  A1: `Student is a COMPLETE BEGINNER (CEFR A1 / TOPIK I).
- Use only A1 Korean vocabulary and short sentence patterns
- Always show Revised Romanization as a hint after Hangul: 안녕하세요 (annyeonghaseyo)
- Explain particles (은/는, 이/가, 을/를) every time they appear
- Focus on: Hangul reading, greetings, numbers, particles, -아요/-어요 present tense
- Keep sentences short: Subject + Object + Verb
- If the student types romanization instead of Hangul, accept it while gently redirecting to Hangul`,

  A2: `Student is ELEMENTARY (CEFR A2 / TOPIK I upper).
- Use A1-A2 Korean vocabulary
- Show Revised Romanization only for new or uncommon words
- Introduce additional tenses (-겠어요, -고 있어요) and connector particles (-(이)랑, -하고)
- Build towards short connected sentences about daily routines`,

  B1: `Student is LOWER-INTERMEDIATE (CEFR B1 / TOPIK II lower).
- Use practical connected sentences and short paragraphs
- Correct particle errors, verb endings, and word order with concise explanations
- Reduce romanization — expect Hangul input
- Introduce common grammar patterns: -(으)면, -지만, -아/어서`,
};

const PARTICLE_QUESTIONS: QuizQuestion[] = [
  {
    question: "Which particle marks the **topic** of a sentence?",
    options: ["은/는", "이/가", "을/를", "에서"],
    correctIndex: 0,
    explanation: "은/는 is the topic marker. It sets what the sentence is about.",
  },
  {
    question: "Which particle marks the **object** of a verb?",
    options: ["을/를", "은/는", "이/가", "에"],
    correctIndex: 0,
    explanation: "을/를 is the object marker. It shows what the action acts upon.",
  },
  {
    question: "After the vowel-ending noun 나 (I), the topic marker is:",
    options: ["는", "은", "가", "이"],
    correctIndex: 0,
    explanation: "는 follows vowels; 은 follows consonants. 나 ends in ㅏ (vowel) → 나는.",
  },
  {
    question: "After the consonant-ending noun 밥 (rice), the object marker is:",
    options: ["을", "를", "이", "가"],
    correctIndex: 0,
    explanation: "을 follows consonants; 를 follows vowels. 밥 ends in ㅂ → 밥을.",
  },
  {
    question: "Which particle means 'at/from' for the location of an action?",
    options: ["에서", "에", "의", "을/를"],
    correctIndex: 0,
    explanation: "에서 marks where an action happens: 학교에서 공부해요 (study at school).",
  },
];

function asDictionaryEntry(item: (typeof koreanA1Vocab)[number]): DictionaryEntry {
  return {
    word: item.term,
    reading: item.reading,
    meanings: [item.meaning],
    partOfSpeech: ["A1 vocabulary"],
    level: "A1",
  };
}

export const koreanModule: TutorModule = {
  name: "korean",
  displayName: "Korean",
  description: "Korean learning with Hangul, particles, and A1 / TOPIK I vocabulary",
  icon: "🇰🇷",
  levels: ["A1", "A2", "B1"],
  defaultLevel: "A1",
  quizTypes: ["particles", "vocab"],
  tools: koreanTools,

  async lookup(query: string): Promise<DictionaryEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    return koreanA1Vocab
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
    const romanizationDirective = (() => {
      const fl = ctx?.furiganaLevel;
      if (fl === "full") return "\nRomanization: ALWAYS include Revised Romanization after Hangul, e.g. 안녕하세요 (annyeonghaseyo).";
      if (fl === "partial") return "\nRomanization: include Revised Romanization for new or uncommon words; omit for familiar A1 vocabulary.";
      if (fl === "none") return "\nRomanization: do not add romanization unless the student asks; this is review without reading aids.";
      return "";
    })();

    return `You are a Korean language tutor. ${LEVEL_GUIDES[level] || LEVEL_GUIDES.A1}${romanizationDirective}

When the student writes in Korean, respond with a JSON block:
\`\`\`json
{
  "response_ko": "Your Korean response in Hangul",
  "response_en": "English translation",
  "romanization": "Revised Romanization for the Korean response",
  "corrections": [
    { "original": "what they wrote wrong", "corrected": "correct version", "type": "particle|verb_ending|vocabulary|word_order|spelling", "explanation": "why" }
  ],
  "new_words": [
    { "word": "학교", "reading": "hakgyo", "meaning": "school" }
  ]
}
\`\`\`

If the student writes in English, respond naturally as a tutor: teach the Korean phrase in Hangul, give the Revised Romanization, and a short A1 example sentence.`;
  },

  generateQuiz(_level: string, type: string): QuizQuestion {
    if (type === "particles") {
      return pick(PARTICLE_QUESTIONS);
    }

    const correct = pick(koreanA1Vocab);
    const wrongOptions = pickN(
      koreanA1Vocab.filter((item) => item.meaning !== correct.meaning),
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
