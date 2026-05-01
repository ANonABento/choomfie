/**
 * Spanish tutor module.
 */

import type { DictionaryEntry, QuizQuestion, TutorModule } from "../../core/types.ts";
import { pick, pickN, shuffle } from "../../core/random.ts";
import { spanishA1Vocab } from "./data/a1-vocab.ts";
import { spanishToIpa } from "./pronunciation.ts";
import { spanishTools } from "./tools.ts";
import { spanishExampleSentences } from "./example-sentences.ts";

const LEVEL_GUIDES: Record<string, string> = {
  A1: `Student is a COMPLETE BEGINNER (CEFR A1).
- Use only basic A1 vocabulary and short sentence patterns
- Explain in English first, then show Spanish examples
- Include a simple pronunciation note for new words when useful
- Focus on: greetings, introductions, numbers, family, food, places, daily actions
- Grammar: ser vs estar, tener, regular present-tense verbs, gender/number agreement, basic questions
- Keep Spanish sentences short and concrete
- If they omit accents, accept the answer while showing the standard spelling`,

  A2: `Student is ELEMENTARY (CEFR A2).
- Use A1-A2 vocabulary and everyday topics
- Add short connected sentences about routines, plans, preferences, and past experiences
- Introduce common present, near future, and high-frequency preterite forms`,

  B1: `Student is LOWER-INTERMEDIATE (CEFR B1).
- Use more Spanish in explanations while keeping complex grammar clear
- Encourage paragraph-level answers, opinions, and narration`,
};

const GRAMMAR_QUESTIONS: QuizQuestion[] = [
  {
    question: "Choose the Spanish for **I am a student**.",
    options: ["Soy estudiante.", "Estoy estudiante.", "Tengo estudiante.", "Voy estudiante."],
    correctIndex: 0,
    explanation: "Use ser for identity: Soy estudiante.",
  },
  {
    question: "Choose the Spanish for **I am here**.",
    options: ["Estoy aquí.", "Soy aquí.", "Tengo aquí.", "Hago aquí."],
    correctIndex: 0,
    explanation: "Use estar for location: Estoy aquí.",
  },
  {
    question: "Which question word means **where**?",
    options: ["dónde", "cuándo", "quién", "cuánto"],
    correctIndex: 0,
    explanation: "Dónde asks where.",
  },
];

const PRONUNCIATION_QUESTIONS: QuizQuestion[] = [
  {
    question: "Which letter is silent in **hola**?",
    options: ["h", "o", "l", "a"],
    correctIndex: 0,
    explanation: "Spanish h is silent in hola.",
  },
  {
    question: "In Latin American Spanish, **ci** in ciudad sounds like:",
    options: ["si", "ki", "chi", "ji"],
    correctIndex: 0,
    explanation: "Before e or i, c is commonly /s/ in Latin American Spanish.",
  },
  {
    question: "Which spelling makes the /tʃ/ sound?",
    options: ["ch", "qu", "ll", "rr"],
    correctIndex: 0,
    explanation: "Spanish ch is pronounced /tʃ/, like English ch.",
  },
];

function asDictionaryEntry(item: (typeof spanishA1Vocab)[number]): DictionaryEntry {
  return {
    word: item.term,
    reading: `/${item.reading}/`,
    meanings: [item.meaning],
    partOfSpeech: ["A1 vocabulary"],
    level: "A1",
    examples: spanishExampleSentences[item.term],
  };
}

function normalizeSearch(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export const spanishModule: TutorModule = {
  name: "spanish",
  displayName: "Spanish",
  description: "CEFR-aligned Spanish learning with pronunciation, A1 grammar, and core vocabulary",
  icon: "🇪🇸",
  levels: ["A1", "A2", "B1"],
  defaultLevel: "A1",
  quizTypes: ["pronunciation", "vocab", "grammar"],
  tools: spanishTools,

  async lookup(query: string): Promise<DictionaryEntry[]> {
    const normalized = normalizeSearch(query);
    if (!normalized) return [];

    return spanishA1Vocab
      .filter((item) => {
        const term = normalizeSearch(item.term);
        const reading = normalizeSearch(item.reading);
        const meaning = normalizeSearch(item.meaning);
        return (
          term.includes(normalized) ||
          reading.includes(normalized) ||
          meaning.includes(normalized)
        );
      })
      .slice(0, 10)
      .map(asDictionaryEntry);
  },

  buildTutorPrompt(level: string): string {
    return `You are a Spanish language tutor. ${LEVEL_GUIDES[level] || LEVEL_GUIDES.A1}

When the student writes in Spanish, respond with a JSON block:
\`\`\`json
{
  "response_es": "Your Spanish response",
  "response_en": "English translation",
  "pronunciation": "Simple IPA or pronunciation notes for key words",
  "corrections": [
    { "original": "what they wrote wrong", "corrected": "correct version", "type": "accent|gender|number|verb|word_order|vocabulary|pronunciation", "explanation": "why" }
  ],
  "new_words": [
    { "word": "escuela", "reading": "/esˈkwela/", "meaning": "school" }
  ]
}
\`\`\`

If the student writes in English, respond naturally as a tutor: teach the Spanish, pronunciation, and a short example.`;
  },

  generateQuiz(_level: string, type: string): QuizQuestion {
    if (type === "pronunciation") {
      return pick(PRONUNCIATION_QUESTIONS);
    }

    if (type === "grammar") {
      return pick(GRAMMAR_QUESTIONS);
    }

    const correct = pick(spanishA1Vocab);
    const wrongOptions = pickN(
      spanishA1Vocab.filter((item) => item.meaning !== correct.meaning),
      3,
    );
    const options = shuffle([correct.meaning, ...wrongOptions.map((item) => item.meaning)]);

    return {
      question: `What does **${correct.term}** (/${spanishToIpa(correct.term)}/) mean?`,
      options,
      correctIndex: options.indexOf(correct.meaning),
      explanation: `${correct.term} means "${correct.meaning}".`,
    };
  },
};
