/**
 * Unit 3: First Words & Phrases — 8 lessons teaching essential vocabulary.
 *
 * Each lesson introduces a category of useful words/phrases using ContentSet
 * + generateExercises() for recognition/production, with hand-written cloze
 * exercises where appropriate.
 */

import type { Lesson } from "../../../core/lesson-types.ts";
import { generateExercises, type ContentSet } from "../../../core/exercise-generator.ts";
import { vocabSRS, cloze, mc } from "./phrase-helpers.ts";

// --- Content Sets ---

const greetingsContent: ContentSet = {
  items: [
    { term: "おはよう", reading: "ohayou", meaning: "good morning (casual)" },
    { term: "おはようございます", reading: "ohayou gozaimasu", meaning: "good morning (polite)" },
    { term: "こんにちは", reading: "konnichiwa", meaning: "hello" },
    { term: "こんばんは", reading: "konbanwa", meaning: "good evening" },
    { term: "さようなら", reading: "sayounara", meaning: "goodbye" },
    { term: "おやすみなさい", reading: "oyasuminasai", meaning: "good night" },
  ],
};

const introContent: ContentSet = {
  items: [
    { term: "はじめまして", reading: "hajimemashite", meaning: "nice to meet you" },
    { term: "わたし", reading: "watashi", meaning: "I/me" },
    { term: "なまえ", reading: "namae", meaning: "name" },
    { term: "です", reading: "desu", meaning: "is/am" },
    { term: "よろしくおねがいします", reading: "yoroshiku onegaishimasu", meaning: "please treat me well" },
  ],
};

const numbersContent: ContentSet = {
  items: [
    { term: "いち", reading: "ichi", meaning: "one (1)" },
    { term: "に", reading: "ni", meaning: "two (2)" },
    { term: "さん", reading: "san", meaning: "three (3)" },
    { term: "よん/し", reading: "yon/shi", meaning: "four (4)" },
    { term: "ご", reading: "go", meaning: "five (5)" },
    { term: "ろく", reading: "roku", meaning: "six (6)" },
    { term: "なな/しち", reading: "nana/shichi", meaning: "seven (7)" },
    { term: "はち", reading: "hachi", meaning: "eight (8)" },
    { term: "きゅう/く", reading: "kyuu/ku", meaning: "nine (9)" },
    { term: "じゅう", reading: "juu", meaning: "ten (10)" },
  ],
};

const daysContent: ContentSet = {
  items: [
    { term: "げつようび", reading: "getsuyoubi", meaning: "Monday" },
    { term: "かようび", reading: "kayoubi", meaning: "Tuesday" },
    { term: "すいようび", reading: "suiyoubi", meaning: "Wednesday" },
    { term: "もくようび", reading: "mokuyoubi", meaning: "Thursday" },
    { term: "きんようび", reading: "kinyoubi", meaning: "Friday" },
    { term: "どようび", reading: "doyoubi", meaning: "Saturday" },
    { term: "にちようび", reading: "nichiyoubi", meaning: "Sunday" },
  ],
};

const objectsContent: ContentSet = {
  items: [
    { term: "ほん", reading: "hon", meaning: "book" },
    { term: "ペン", reading: "pen", meaning: "pen" },
    { term: "みず", reading: "mizu", meaning: "water" },
    { term: "でんわ", reading: "denwa", meaning: "telephone" },
    { term: "かばん", reading: "kaban", meaning: "bag" },
    { term: "くるま", reading: "kuruma", meaning: "car" },
  ],
};

const verbsContent: ContentSet = {
  items: [
    { term: "たべる", reading: "taberu", meaning: "to eat" },
    { term: "のむ", reading: "nomu", meaning: "to drink" },
    { term: "いく", reading: "iku", meaning: "to go" },
    { term: "くる", reading: "kuru", meaning: "to come" },
    { term: "みる", reading: "miru", meaning: "to see/watch" },
    { term: "きく", reading: "kiku", meaning: "to hear/ask" },
  ],
};

const adjectivesContent: ContentSet = {
  items: [
    { term: "おおきい", reading: "ookii", meaning: "big" },
    { term: "ちいさい", reading: "chiisai", meaning: "small" },
    { term: "あたらしい", reading: "atarashii", meaning: "new" },
    { term: "ふるい", reading: "furui", meaning: "old" },
    { term: "いい", reading: "ii", meaning: "good" },
    { term: "わるい", reading: "warui", meaning: "bad" },
  ],
};

// --- Lessons ---

export const phraseLessons: Lesson[] = [
  // --- 3.1: Greetings ---
  {
    id: "3.1",
    unit: "phrases",
    unitIndex: 3,
    title: "Greetings",
    prerequisites: ["2.8"],
    introduction: {
      text: "Time to learn your first Japanese phrases! Greetings change based on the time of day and formality level. Japanese has casual and polite forms — using the polite form is always safe.",
      items: greetingsContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(greetingsContent, "recognition"),
      ...generateExercises(greetingsContent, "production").slice(0, 3),
      mc(
        "It's 9 AM. Which greeting is most appropriate?",
        "おはようございます",
        ["こんにちは", "こんばんは", "おやすみなさい"],
        "おはようございます is the polite form of 'good morning', used in the morning hours.",
      ),
      mc(
        "Which greeting would you use at bedtime?",
        "おやすみなさい",
        ["こんにちは", "おはよう", "さようなら"],
        "おやすみなさい means 'good night' — used when someone is going to sleep.",
      ),
      cloze(
        "おはよう___",
        "ございます",
        "Add the polite ending",
        "The casual おはよう becomes polite by adding ございます.",
      ),
    ],
    srsItems: vocabSRS(greetingsContent.items, "greetings"),
    skillsTaught: ["greetings"],
    furiganaLevel: "full",
  },

  // --- 3.2: Self-Introduction ---
  {
    id: "3.2",
    unit: "phrases",
    unitIndex: 3,
    title: "Self-Introduction",
    prerequisites: ["3.1"],
    introduction: {
      text: "The most important thing to learn early is how to introduce yourself. A basic self-introduction follows the pattern: はじめまして。わたしは [name] です。よろしくおねがいします。",
      items: introContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(introContent, "recognition"),
      ...generateExercises(introContent, "production").slice(0, 3),
      cloze(
        "わたしは___です",
        "なまえ",
        "Fill in what goes in the blank of a self-introduction",
        "In a self-introduction, you fill in your name: わたしは [name] です = 'I am [name]'.",
      ),
      cloze(
        "___。わたしはベンです。よろしくおねがいします。",
        "はじめまして",
        "What do you say first when meeting someone?",
        "はじめまして ('nice to meet you') is how you start a self-introduction.",
      ),
      mc(
        "What does 'わたしはベンです' mean?",
        "I am Ben",
        ["My name is here", "Ben is me", "Hello Ben"],
        "わたし = I, は = topic marker, ベン = Ben, です = am/is. 'I am Ben.'",
      ),
      mc(
        "What do you say at the end of a self-introduction?",
        "よろしくおねがいします",
        ["さようなら", "ありがとう", "おはよう"],
        "よろしくおねがいします literally means 'please treat me well' — used to wrap up introductions.",
      ),
    ],
    srsItems: vocabSRS(introContent.items, "self_intro"),
    skillsTaught: ["self_intro"],
    furiganaLevel: "full",
  },

  // --- 3.3: Numbers 1-10 ---
  {
    id: "3.3",
    unit: "phrases",
    unitIndex: 3,
    title: "Numbers 1-10",
    prerequisites: ["3.2"],
    introduction: {
      text: "Numbers are essential! Japanese numbers 1-10 are straightforward, but note that 4, 7, and 9 each have two readings. The alternate readings exist because し (4), しち (7), and く (9) sound like words for 'death' and 'suffering', so よん, なな, and きゅう are often preferred.",
      items: numbersContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(numbersContent, "recognition"),
      mc(
        "Why does 4 have two readings (し and よん)?",
        "し sounds like the word for 'death'",
        ["They mean different amounts", "One is for counting objects", "し is the old form"],
        "し sounds like 死 (death), so よん is often preferred in daily use.",
      ),
      cloze(
        "いち、に、さん、___、ご",
        "よん",
        "Count from 1 to 5",
        "The sequence is: いち (1), に (2), さん (3), よん (4), ご (5).",
      ),
    ],
    srsItems: vocabSRS(numbersContent.items, "numbers"),
    skillsTaught: ["numbers"],
    furiganaLevel: "full",
  },

  // --- 3.4: Days of the Week ---
  {
    id: "3.4",
    unit: "phrases",
    unitIndex: 3,
    title: "Days of the Week",
    prerequisites: ["3.3"],
    introduction: {
      text: "All days of the week end in ようび (曜日). Each day is named after a natural element: 月 (moon) = Monday, 火 (fire) = Tuesday, 水 (water) = Wednesday, 木 (tree) = Thursday, 金 (gold) = Friday, 土 (earth) = Saturday, 日 (sun) = Sunday.",
      items: daysContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(daysContent, "recognition"),
      ...generateExercises(daysContent, "production").slice(0, 3),
      mc(
        "What element is Friday (きんようび) associated with?",
        "Gold/Metal (金)",
        ["Fire (火)", "Water (水)", "Earth (土)"],
        "きん comes from 金 (gold/metal). The days follow: moon, fire, water, tree, gold, earth, sun.",
      ),
      cloze(
        "げつようび、かようび、___ようび",
        "すい",
        "Monday, Tuesday, ___day",
        "After Monday (げつ) and Tuesday (か) comes Wednesday (すい).",
      ),
    ],
    srsItems: vocabSRS(daysContent.items, "days"),
    skillsTaught: ["days_of_week"],
    furiganaLevel: "full",
  },

  // --- 3.5: Common Objects ---
  {
    id: "3.5",
    unit: "phrases",
    unitIndex: 3,
    title: "Common Objects",
    prerequisites: ["3.4"],
    introduction: {
      text: "Let's learn some everyday objects. Notice that ペン is written in katakana — it's a loanword from English! Many modern/foreign words in Japanese use katakana.",
      items: objectsContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(objectsContent, "recognition"),
      ...generateExercises(objectsContent, "production").slice(0, 3),
      mc(
        "Which word is written in katakana because it's a loanword?",
        "ペン (pen)",
        ["ほん (book)", "みず (water)", "かばん (bag)"],
        "ペン comes from English 'pen' — loanwords are written in katakana.",
      ),
      mc(
        "What does でんわ mean?",
        "telephone",
        ["television", "train", "electricity"],
        "でんわ (電話) means telephone. でん = electricity, わ = talk.",
      ),
      cloze(
        "___をのむ",
        "みず",
        "What do you drink?",
        "みずをのむ = 'to drink water'. みず = water, のむ = to drink.",
      ),
    ],
    srsItems: vocabSRS(objectsContent.items, "objects"),
    skillsTaught: ["common_objects"],
    furiganaLevel: "full",
  },

  // --- 3.6: Common Verbs ---
  {
    id: "3.6",
    unit: "phrases",
    unitIndex: 3,
    title: "Common Verbs",
    prerequisites: ["3.5"],
    introduction: {
      text: "Verbs are the heart of Japanese sentences. These are in dictionary form (plain/casual). Japanese verbs always end in an -u sound. In Unit 4, you'll learn the polite ます form.",
      items: verbsContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(verbsContent, "recognition"),
      ...generateExercises(verbsContent, "production").slice(0, 3),
      mc(
        "Which verb means 'to eat'?",
        "たべる",
        ["のむ", "みる", "きく"],
      ),
      mc(
        "What ending do all Japanese dictionary-form verbs share?",
        "They end in an -u sound",
        ["They end in -i", "They end in -a", "They end in -e"],
        "All dictionary-form verbs end in an -u sound: たべる, のむ, いく, くる, みる, きく.",
      ),
      cloze(
        "ほんを___",
        "みる",
        "What do you do with a book? (to see/read)",
        "ほんをみる = 'to look at/read a book'. を marks the object.",
      ),
    ],
    srsItems: vocabSRS(verbsContent.items, "verbs"),
    skillsTaught: ["common_verbs"],
    furiganaLevel: "full",
  },

  // --- 3.7: Common Adjectives ---
  {
    id: "3.7",
    unit: "phrases",
    unitIndex: 3,
    title: "Common Adjectives",
    prerequisites: ["3.6"],
    introduction: {
      text: "These are い-adjectives — they all end in い. This ending is important because it changes when you conjugate them (negative, past). You'll learn conjugation in Unit 4.",
      items: adjectivesContent.items.map((item) => ({
        word: item.term,
        reading: item.reading,
        meaning: item.meaning,
      })),
    },
    exercises: [
      ...generateExercises(adjectivesContent, "recognition"),
      ...generateExercises(adjectivesContent, "production").slice(0, 3),
      mc(
        "What do all these adjectives have in common?",
        "They all end in い",
        ["They all start with お", "They all have 3 characters", "They are all positive words"],
        "These are い-adjectives (i-adjectives). The い ending is what makes them a distinct adjective type in Japanese.",
      ),
      mc(
        "What is the opposite of おおきい (big)?",
        "ちいさい (small)",
        ["ふるい (old)", "わるい (bad)", "あたらしい (new)"],
      ),
      mc(
        "What is the opposite of あたらしい (new)?",
        "ふるい (old)",
        ["いい (good)", "ちいさい (small)", "おおきい (big)"],
      ),
    ],
    srsItems: vocabSRS(adjectivesContent.items, "adjectives"),
    skillsTaught: ["common_adjectives"],
    furiganaLevel: "full",
  },

  // --- 3.8: Unit Review ---
  {
    id: "3.8",
    unit: "phrases",
    unitIndex: 3,
    title: "Unit 3 Review",
    prerequisites: ["3.7"],
    introduction: {
      text: "Great work! Let's review everything from Unit 3 — greetings, introductions, numbers, days, objects, verbs, and adjectives. This is a mixed review to make sure it all sticks.",
    },
    exercises: [
      // Greetings review
      ...generateExercises({ items: greetingsContent.items.slice(0, 3) }, "matching"),
      // Numbers cloze
      cloze(
        "ろく、なな、___、きゅう、じゅう",
        "はち",
        "Count from 6 to 10",
        "The sequence is: ろく (6), なな (7), はち (8), きゅう (9), じゅう (10).",
      ),
      // Days matching
      ...generateExercises({ items: daysContent.items.slice(0, 4) }, "matching"),
      // Verb + object combos
      mc(
        "Which phrase means 'to drink water'?",
        "みずをのむ",
        ["みずをたべる", "ほんをのむ", "みずをみる"],
        "みず = water, を = object marker, のむ = to drink.",
      ),
      mc(
        "How would you say 'the car is big'?",
        "くるまはおおきい",
        ["くるまはちいさい", "ほんはおおきい", "くるまはあたらしい"],
        "くるま = car, は = topic marker, おおきい = big.",
      ),
      // Self-intro production
      {
        type: "production" as const,
        prompt: 'Type the Japanese for **"nice to meet you"**',
        answer: "はじめまして",
        accept: ["hajimemashite"],
      },
      {
        type: "production" as const,
        prompt: 'Type the Japanese for **"hello"**',
        answer: "こんにちは",
        accept: ["konnichiwa"],
      },
    ],
    srsItems: [], // review only, no new items
    skillsTaught: ["unit3_review"],
    furiganaLevel: "full",
  },
];
