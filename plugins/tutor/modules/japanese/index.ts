/**
 * Japanese tutor module.
 */

import type { TutorModule, QuizQuestion, TutorPromptContext } from "../../core/types.ts";
import { lookupJisho } from "./dictionary.ts";
import { initFurigana } from "./furigana.ts";
import { japaneseTools } from "./tools.ts";
import { pick, pickN, shuffle } from "../../core/random.ts";
import { BASIC_N5_KANJI } from "./kanji.ts";
import { n5Vocab } from "./vocab.ts";

const HIRAGANA = [
  ["あ", "a"], ["い", "i"], ["う", "u"], ["え", "e"], ["お", "o"],
  ["か", "ka"], ["き", "ki"], ["く", "ku"], ["け", "ke"], ["こ", "ko"],
  ["さ", "sa"], ["し", "shi"], ["す", "su"], ["せ", "se"], ["そ", "so"],
  ["た", "ta"], ["ち", "chi"], ["つ", "tsu"], ["て", "te"], ["と", "to"],
  ["な", "na"], ["に", "ni"], ["ぬ", "nu"], ["ね", "ne"], ["の", "no"],
  ["は", "ha"], ["ひ", "hi"], ["ふ", "fu"], ["へ", "he"], ["ほ", "ho"],
  ["ま", "ma"], ["み", "mi"], ["む", "mu"], ["め", "me"], ["も", "mo"],
  ["や", "ya"], ["ゆ", "yu"], ["よ", "yo"],
  ["ら", "ra"], ["り", "ri"], ["る", "ru"], ["れ", "re"], ["ろ", "ro"],
  ["わ", "wa"], ["を", "wo"], ["ん", "n"],
];

const KATAKANA = [
  ["ア", "a"], ["イ", "i"], ["ウ", "u"], ["エ", "e"], ["オ", "o"],
  ["カ", "ka"], ["キ", "ki"], ["ク", "ku"], ["ケ", "ke"], ["コ", "ko"],
  ["サ", "sa"], ["シ", "shi"], ["ス", "su"], ["セ", "se"], ["ソ", "so"],
  ["タ", "ta"], ["チ", "chi"], ["ツ", "tsu"], ["テ", "te"], ["ト", "to"],
  ["ナ", "na"], ["ニ", "ni"], ["ヌ", "nu"], ["ネ", "ne"], ["ノ", "no"],
  ["ハ", "ha"], ["ヒ", "hi"], ["フ", "fu"], ["ヘ", "he"], ["ホ", "ho"],
  ["マ", "ma"], ["ミ", "mi"], ["ム", "mu"], ["メ", "me"], ["モ", "mo"],
  ["ヤ", "ya"], ["ユ", "yu"], ["ヨ", "yo"],
  ["ラ", "ra"], ["リ", "ri"], ["ル", "ru"], ["レ", "re"], ["ロ", "ro"],
  ["ワ", "wa"], ["ヲ", "wo"], ["ン", "n"],
];

const LEVEL_GUIDES: Record<string, string> = {
  N5: `Student is a COMPLETE BEGINNER (JLPT N5).
- Use only basic vocabulary and grammar
- Always include furigana for kanji: 食[た]べる
- Explain everything in English first, then show Japanese
- Focus on: greetings, self-introduction, basic verbs, numbers, time
- Grammar: です/ます form, particles は/が/を/に/で/へ, question か
- Keep sentences SHORT (5-10 words max)
- If they write in romaji, gently encourage hiragana but still understand
- Celebrate small wins, be encouraging`,

  N4: `Student is ELEMENTARY (JLPT N4).
- Use N5+N4 vocabulary
- Include furigana for N4+ kanji
- Mix English and Japanese explanations
- Focus on: て-form, ない-form, たい-form, basic counters, giving/receiving
- Grammar: conditional ば/たら, てもいい/てはいけない, ている
- Introduce casual speech alongside polite`,

  N3: `Student is INTERMEDIATE (JLPT N3).
- Use up to N3 vocabulary freely
- Furigana only for uncommon kanji
- Explain primarily in Japanese with English for complex grammar
- Focus on: passive, causative, keigo basics, compound sentences
- Longer conversations, abstract topics`,

  N2: `Student is UPPER-INTERMEDIATE (JLPT N2).
- Natural Japanese, minimal English
- Complex grammar and expressions
- Nuance, context, register differences
- Business Japanese, formal writing`,

  N1: `Student is ADVANCED (JLPT N1).
- Native-level Japanese
- Literary expressions, classical grammar references
- Debate, persuasion, academic topics
- Only use English if explicitly asked`,
};

const GRAMMAR_QUESTIONS: QuizQuestion[] = [
  {
    question: 'Fill in the blank: わたし＿学生です。(I am a student)',
    options: ["は", "が", "を", "に"],
    correctIndex: 0,
    explanation: "は (wa) is the topic marker. わたしは = 'As for me...'",
  },
  {
    question: 'Fill in the blank: 水＿飲みます。(I drink water)',
    options: ["を", "は", "に", "で"],
    correctIndex: 0,
    explanation: "を (wo) marks the direct object. 水を飲む = drink water",
  },
  {
    question: 'Fill in the blank: 学校＿行きます。(I go to school)',
    options: ["に", "を", "は", "が"],
    correctIndex: 0,
    explanation: "に (ni) marks the destination. 学校に行く = go to school",
  },
  {
    question: "How do you say 'I don't eat' in Japanese?",
    options: ["食べません", "食べます", "食べない", "食べた"],
    correctIndex: 0,
    explanation: "食べません is the polite negative form of 食べる (to eat)",
  },
  {
    question: "Which is the correct question form?",
    options: ["これは何ですか？", "これは何です。", "これは何でか？", "これは何かです？"],
    correctIndex: 0,
    explanation: "か at the end of a です/ます sentence makes it a question",
  },
];

export const japaneseModule: TutorModule = {
  name: "japanese",
  displayName: "Japanese",
  description: "JLPT-based Japanese language learning with kana, kanji, and grammar",
  icon: "🇯🇵",
  levels: ["N5", "N4", "N3", "N2", "N1"],
  defaultLevel: "N5",
  quizTypes: ["reading", "vocab", "grammar", "kanji"],

  tools: japaneseTools,

  async lookup(query: string) {
    return lookupJisho(query);
  },

  buildTutorPrompt(level: string, ctx?: TutorPromptContext): string {
    const furiganaDirective = (() => {
      const fl = ctx?.furiganaLevel;
      if (fl === "full") return "\nFurigana: ALWAYS show readings for every kanji — 食[た]べる.";
      if (fl === "partial") return "\nFurigana: only show readings for uncommon kanji; common N5 kanji can appear bare.";
      if (fl === "none") return "\nFurigana: do not add furigana — the student is reviewing without aids.";
      return "";
    })();

    return `You are a Japanese language tutor. ${LEVEL_GUIDES[level] || LEVEL_GUIDES.N5}${furiganaDirective}

When the student writes in Japanese, respond with a JSON block:
\`\`\`json
{
  "response_jp": "Your Japanese response",
  "response_en": "English translation",
  "furigana": "Response with furigana: 食[た]べる",
  "corrections": [
    { "original": "what they wrote wrong", "corrected": "correct version", "type": "grammar|vocabulary|particle|formality|spelling", "explanation": "why" }
  ],
  "new_words": [
    { "word": "新しい", "reading": "あたらしい", "meaning": "new" }
  ]
}
\`\`\`

If the student writes in English, respond naturally as a tutor — teach, explain, give examples.
Always be encouraging and patient. Language learning is hard!`;
  },

  generateQuiz(level: string, type: string): QuizQuestion {
    if (type === "reading") {
      const kanaSet = Math.random() > 0.5 ? HIRAGANA : KATAKANA;
      const setName = kanaSet === HIRAGANA ? "hiragana" : "katakana";
      const correct = pick(kanaSet);
      const wrongOptions = pickN(
        kanaSet.filter((k) => k[1] !== correct[1]),
        3
      );
      const options = shuffle([correct[1], ...wrongOptions.map((w) => w[1])]);

      return {
        question: `What is the reading of this ${setName}: **${correct[0]}**?`,
        options,
        correctIndex: options.indexOf(correct[1]),
        explanation: `${correct[0]} is read as "${correct[1]}"`,
      };
    }

    if (type === "vocab") {
      const correct = pick(n5Vocab);
      const wrongOptions = pickN(
        n5Vocab.filter((item) => item.back !== correct.back),
        3
      );
      const options = shuffle([correct.back, ...wrongOptions.map((item) => item.back)]);

      return {
        question: `What does **${correct.front}** (${correct.reading}) mean?`,
        options,
        correctIndex: options.indexOf(correct.back),
        explanation: `${correct.front} (${correct.reading}) means "${correct.back}"`,
      };
    }

    if (type === "kanji") {
      const correct = pick(BASIC_N5_KANJI);
      const wrongOptions = pickN(
        BASIC_N5_KANJI.filter((item) => item.meaning !== correct.meaning),
        3
      );
      const options = shuffle([correct.meaning, ...wrongOptions.map((item) => item.meaning)]);

      return {
        question: `What does **${correct.character}** mean?`,
        options,
        correctIndex: options.indexOf(correct.meaning),
        explanation: `${correct.character} means "${correct.meaning}" and has ${correct.strokes} strokes.`,
      };
    }

    // Grammar
    const q = pick(GRAMMAR_QUESTIONS);
    const correctAnswer = q.options[q.correctIndex];
    const shuffled = shuffle(q.options);
    return {
      ...q,
      options: shuffled,
      correctIndex: shuffled.indexOf(correctAnswer),
    };
  },

  async init() {
    try {
      await initFurigana();
    } catch (e) {
      console.error(`Japanese module: furigana init failed (non-critical): ${e}`);
    }
  },
};
