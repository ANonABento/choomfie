/**
 * French tutor module.
 */

import type { DictionaryEntry, QuizQuestion, TutorModule, TutorPromptContext } from "../../core/types.ts";
import { pick, pickN, shuffle } from "../../core/random.ts";
import { frenchA1Vocab } from "./data/a1-vocab.ts";

const LEVEL_GUIDES: Record<string, string> = {
  A1: `Student is a COMPLETE BEGINNER (CEFR A1).
- Use only high-frequency A1 vocabulary and short sentence patterns
- Include pronunciation hints for new words: bonjour (bohn-zhoor)
- Explain liaison, silent final letters, and nasal vowels when pronunciation matters
- Focus on: greetings, introductions, numbers, food, places, time, and simple requests
- Keep sentences short and concrete
- Accept missing accents in typed answers while gently showing the standard spelling`,

  A2: `Student is ELEMENTARY (CEFR A2).
- Use A1-A2 vocabulary
- Introduce common present-tense verbs, near future, and everyday routines
- Include pronunciation hints for new or difficult words`,

  B1: `Student is LOWER-INTERMEDIATE (CEFR B1).
- Use practical connected sentences and short paragraphs
- Correct agreement, verb forms, and word order with concise explanations`,
};

const PRONUNCIATION_QUESTIONS: QuizQuestion[] = [
  {
    question: "In **vous avez**, what liaison sound connects vous to avez?",
    options: ["z", "t", "r", "k"],
    correctIndex: 0,
    explanation: "The final -s in vous links before a vowel and sounds like z: voo-zah-vay.",
  },
  {
    question: "In **salut**, which final letter is normally silent?",
    options: ["t", "s", "a", "u"],
    correctIndex: 0,
    explanation: "Final -t is usually silent in salut.",
  },
  {
    question: "Which word has a nasal vowel?",
    options: ["pain", "merci", "salut", "madame"],
    correctIndex: 0,
    explanation: "Pain has a nasal vowel; the final n marks the vowel quality.",
  },
];

function asDictionaryEntry(item: (typeof frenchA1Vocab)[number]): DictionaryEntry {
  return {
    word: item.term,
    reading: item.reading,
    meanings: [item.meaning],
    partOfSpeech: ["A1 vocabulary"],
    level: "A1",
  };
}

export const frenchModule: TutorModule = {
  name: "french",
  displayName: "French",
  description: "French learning with A1 vocabulary, pronunciation, and first conversations",
  icon: "🇫🇷",
  levels: ["A1", "A2", "B1"],
  defaultLevel: "A1",
  quizTypes: ["pronunciation", "vocab"],

  async lookup(query: string): Promise<DictionaryEntry[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    return frenchA1Vocab
      .filter((item) => {
        return (
          item.term.toLowerCase().includes(normalized) ||
          item.reading.toLowerCase().includes(normalized) ||
          item.meaning.toLowerCase().includes(normalized)
        );
      })
      .slice(0, 10)
      .map(asDictionaryEntry);
  },

  buildTutorPrompt(level: string, ctx?: TutorPromptContext): string {
    const pronunciationDirective = (() => {
      const fl = ctx?.furiganaLevel;
      if (fl === "full") return "\nPronunciation: ALWAYS include beginner pronunciation hints for new French words, and point out liaison or silent final letters.";
      if (fl === "partial") return "\nPronunciation: include hints for new or difficult words, but keep familiar A1 words natural.";
      if (fl === "none") return "\nPronunciation: do not add pronunciation hints unless the student asks; this is review without aids.";
      return "";
    })();

    return `You are a French language tutor. ${LEVEL_GUIDES[level] || LEVEL_GUIDES.A1}${pronunciationDirective}

When the student writes in French, respond with a JSON block:
\`\`\`json
{
  "response_fr": "Your French response",
  "response_en": "English translation",
  "pronunciation": "Beginner-friendly pronunciation hints for new French",
  "corrections": [
    { "original": "what they wrote wrong", "corrected": "correct version", "type": "accent|agreement|verb|vocabulary|word_order|pronunciation", "explanation": "why" }
  ],
  "new_words": [
    { "word": "bonjour", "reading": "bohn-zhoor", "meaning": "hello" }
  ]
}
\`\`\`

If the student writes in English, respond naturally as a tutor: teach the French phrase, pronunciation, and a short A1 example.`;
  },

  generateQuiz(_level: string, type: string): QuizQuestion {
    if (type === "pronunciation") {
      return pick(PRONUNCIATION_QUESTIONS);
    }

    const correct = pick(frenchA1Vocab);
    const wrongOptions = pickN(
      frenchA1Vocab.filter((item) => item.meaning !== correct.meaning),
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
