/**
 * Unit 1: Hiragana — 10 lessons teaching all 46 basic hiragana characters.
 *
 * Each lesson introduces ~5 characters with mnemonics, then drills with
 * recognition + production exercises that mix new and previously learned chars.
 */

import type { Lesson, Exercise, LessonSRSItem } from "../../../core/lesson-types.ts";
import { recognition, production, chartReview } from "./kana-helpers.ts";

// --- Local helpers ---

function wordReading(word: string, reading: string, meaning: string, pool: string[]): Exercise {
  const distractors = pool.filter((r) => r !== reading).slice(0, 3);
  return {
    type: "recognition",
    prompt: `How do you read **${word}**? (${meaning})`,
    answer: reading,
    distractors,
  };
}

function srsItems(pairs: [string, string][]): LessonSRSItem[] {
  return pairs.map(([char, reading]) => ({
    front: char,
    back: reading,
    reading,
    tags: "hiragana",
  }));
}

// --- Lesson data ---

const VOWEL_READINGS = ["a", "i", "u", "e", "o"];
const K_READINGS = ["ka", "ki", "ku", "ke", "ko"];
const S_READINGS = ["sa", "shi", "su", "se", "so"];
const T_READINGS = ["ta", "chi", "tsu", "te", "to"];
const N_READINGS = ["na", "ni", "nu", "ne", "no"];
const H_READINGS = ["ha", "hi", "fu", "he", "ho"];
const M_READINGS = ["ma", "mi", "mu", "me", "mo"];
const YRW_READINGS = ["ya", "yu", "yo", "ra", "ri", "ru", "re", "ro", "wa", "wo", "n"];

const ALL_BASIC = [
  ...VOWEL_READINGS, ...K_READINGS, ...S_READINGS, ...T_READINGS,
  ...N_READINGS, ...H_READINGS, ...M_READINGS, ...YRW_READINGS,
];

export const hiraganaLessons: Lesson[] = [
  // --- Lesson 1.1: Vowels ---
  {
    id: "1.1",
    unit: "hiragana",
    unitIndex: 1,
    title: "Vowels: あいうえお",
    prerequisites: [],
    introduction: {
      text: "Japanese has 5 vowel sounds — the building blocks of the entire writing system. Every Japanese syllable contains one of these vowels.",
      items: [
        { char: "あ", reading: "a", mnemonic: "Looks like someone going 'Ahhh!' at the dentist", audioHint: "Like 'a' in 'father'" },
        { char: "い", reading: "i", mnemonic: "Two sticks standing side by side — 'ee'", audioHint: "Like 'ee' in 'feet'" },
        { char: "う", reading: "u", mnemonic: "A mouth shape ready to say 'oo'", audioHint: "Like 'oo' in 'food'" },
        { char: "え", reading: "e", mnemonic: "Looks like an energetic dancer", audioHint: "Like 'e' in 'pet'" },
        { char: "お", reading: "o", mnemonic: "A golf ball on a tee — 'Oh nice shot!'", audioHint: "Like 'o' in 'go'" },
      ],
    },
    exercises: [
      recognition("あ", "a", VOWEL_READINGS),
      recognition("い", "i", VOWEL_READINGS),
      recognition("う", "u", VOWEL_READINGS),
      recognition("え", "e", VOWEL_READINGS),
      recognition("お", "o", VOWEL_READINGS),
      production("あ", "a", "hiragana"),
      production("い", "i", "hiragana"),
      production("う", "u", "hiragana"),
      recognition("お", "o", VOWEL_READINGS),
      recognition("え", "e", VOWEL_READINGS),
      production("え", "e", "hiragana"),
      production("お", "o", "hiragana"),
    ],
    srsItems: srsItems([["あ", "a"], ["い", "i"], ["う", "u"], ["え", "e"], ["お", "o"]]),
    skillsTaught: ["hiragana_vowels"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.2: K-row ---
  {
    id: "1.2",
    unit: "hiragana",
    unitIndex: 1,
    title: "K-row: かきくけこ",
    prerequisites: ["1.1"],
    introduction: {
      text: "The K-row adds a 'k' sound before each vowel. か = ka, き = ki, く = ku, け = ke, こ = ko.",
      items: [
        { char: "か", reading: "ka", mnemonic: "A blade cutting — 'ka-chop!'", audioHint: "'ka' as in 'car'" },
        { char: "き", reading: "ki", mnemonic: "A key — 'ki' sounds like 'key'", audioHint: "'ki' as in 'key'" },
        { char: "く", reading: "ku", mnemonic: "A bird's beak going 'koo'", audioHint: "'ku' as in 'cool'" },
        { char: "け", reading: "ke", mnemonic: "A keg of beer on its side", audioHint: "'ke' as in 'Ken'" },
        { char: "こ", reading: "ko", mnemonic: "Two worms having a conversation — 'ko-nversation'", audioHint: "'ko' as in 'coat'" },
      ],
    },
    exercises: [
      recognition("か", "ka", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("き", "ki", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("く", "ku", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("け", "ke", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("こ", "ko", [...K_READINGS, ...VOWEL_READINGS]),
      production("か", "ka", "hiragana"),
      production("き", "ki", "hiragana"),
      // Mix in vowels for review
      recognition("あ", "a", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("う", "u", [...K_READINGS, ...VOWEL_READINGS]),
      production("く", "ku", "hiragana"),
      production("け", "ke", "hiragana"),
      production("こ", "ko", "hiragana"),
    ],
    srsItems: srsItems([["か", "ka"], ["き", "ki"], ["く", "ku"], ["け", "ke"], ["こ", "ko"]]),
    skillsTaught: ["hiragana_k"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.3: S-row ---
  {
    id: "1.3",
    unit: "hiragana",
    unitIndex: 1,
    title: "S-row: さしすせそ",
    prerequisites: ["1.2"],
    introduction: {
      text: "The S-row: さ = sa, し = shi (not 'si'), す = su, せ = se, そ = so. Note: し is 'shi', not 'si' — this is a common exception.",
      items: [
        { char: "さ", reading: "sa", mnemonic: "A samurai's face in profile", audioHint: "'sa' as in 'saw'" },
        { char: "し", reading: "shi", mnemonic: "A fishing hook — 'she' caught a fish!", audioHint: "'shi' as in 'she'" },
        { char: "す", reading: "su", mnemonic: "A curvy line like a swing — 'su-wing!'", audioHint: "'su' as in 'sue'" },
        { char: "せ", reading: "se", mnemonic: "A mouth saying something", audioHint: "'se' as in 'set'" },
        { char: "そ", reading: "so", mnemonic: "A zigzag — 'so' many turns!", audioHint: "'so' as in 'so'" },
      ],
    },
    exercises: [
      recognition("さ", "sa", [...S_READINGS, ...K_READINGS]),
      recognition("し", "shi", [...S_READINGS, ...K_READINGS]),
      recognition("す", "su", [...S_READINGS, ...VOWEL_READINGS]),
      recognition("せ", "se", [...S_READINGS, ...K_READINGS]),
      recognition("そ", "so", [...S_READINGS, ...VOWEL_READINGS]),
      production("さ", "sa", "hiragana"),
      production("し", "shi", "hiragana"),
      // Review
      recognition("か", "ka", [...S_READINGS, ...K_READINGS]),
      recognition("き", "ki", [...S_READINGS, ...K_READINGS]),
      production("す", "su", "hiragana"),
      production("せ", "se", "hiragana"),
      production("そ", "so", "hiragana"),
      // Chart review: vowels + K + S (15 chars)
      chartReview([
        ["あ", "a"], ["い", "i"], ["う", "u"], ["え", "e"], ["お", "o"],
        ["か", "ka"], ["き", "ki"], ["く", "ku"], ["け", "ke"], ["こ", "ko"],
        ["さ", "sa"], ["し", "shi"], ["す", "su"], ["せ", "se"], ["そ", "so"],
      ]),
    ],
    srsItems: srsItems([["さ", "sa"], ["し", "shi"], ["す", "su"], ["せ", "se"], ["そ", "so"]]),
    skillsTaught: ["hiragana_s"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.4: T-row ---
  {
    id: "1.4",
    unit: "hiragana",
    unitIndex: 1,
    title: "T-row: たちつてと",
    prerequisites: ["1.3"],
    introduction: {
      text: "The T-row: た = ta, ち = chi (not 'ti'), つ = tsu (not 'tu'), て = te, と = to. Two exceptions here: ち = 'chi' and つ = 'tsu'.",
      items: [
        { char: "た", reading: "ta", mnemonic: "Looks like 'ta' written in a fancy way", audioHint: "'ta' as in 'taco'" },
        { char: "ち", reading: "chi", mnemonic: "A cheerful face — 'chi-rful!'", audioHint: "'chi' as in 'cheese'" },
        { char: "つ", reading: "tsu", mnemonic: "A tsunami wave", audioHint: "'tsu' — the 'ts' from 'cats' + 'oo'" },
        { char: "て", reading: "te", mnemonic: "A hand reaching out — 'te' means hand in Japanese!", audioHint: "'te' as in 'ten'" },
        { char: "と", reading: "to", mnemonic: "A toe with a nail sticking up", audioHint: "'to' as in 'toe'" },
      ],
    },
    exercises: [
      recognition("た", "ta", [...T_READINGS, ...S_READINGS]),
      recognition("ち", "chi", [...T_READINGS, ...S_READINGS]),
      recognition("つ", "tsu", [...T_READINGS, ...K_READINGS]),
      recognition("て", "te", [...T_READINGS, ...VOWEL_READINGS]),
      recognition("と", "to", [...T_READINGS, ...S_READINGS]),
      production("た", "ta", "hiragana"),
      production("ち", "chi", "hiragana"),
      production("つ", "tsu", "hiragana"),
      // Review
      recognition("し", "shi", [...T_READINGS, ...S_READINGS]),
      recognition("さ", "sa", [...T_READINGS, ...S_READINGS]),
      production("て", "te", "hiragana"),
      production("と", "to", "hiragana"),
    ],
    srsItems: srsItems([["た", "ta"], ["ち", "chi"], ["つ", "tsu"], ["て", "te"], ["と", "to"]]),
    skillsTaught: ["hiragana_t"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.5: N-row ---
  {
    id: "1.5",
    unit: "hiragana",
    unitIndex: 1,
    title: "N-row: なにぬねの",
    prerequisites: ["1.4"],
    introduction: {
      text: "The N-row: な = na, に = ni, ぬ = nu, ね = ne, の = no. The character の is one of the most common in Japanese — it means 'of' or 'belonging to'.",
      items: [
        { char: "な", reading: "na", mnemonic: "A knot being tied — 'na-t'", audioHint: "'na' as in 'not'" },
        { char: "に", reading: "ni", mnemonic: "Looks like a knee", audioHint: "'ni' as in 'knee'" },
        { char: "ぬ", reading: "nu", mnemonic: "Noodles! ぬ looks like swirly noodles", audioHint: "'nu' as in 'noodle'" },
        { char: "ね", reading: "ne", mnemonic: "A cat with a curly tail — 'neko' (cat) starts with ね", audioHint: "'ne' as in 'net'" },
        { char: "の", reading: "no", mnemonic: "The universal 'no' — a circle like shaking your head", audioHint: "'no' as in 'no'" },
      ],
    },
    exercises: [
      recognition("な", "na", [...N_READINGS, ...T_READINGS]),
      recognition("に", "ni", [...N_READINGS, ...T_READINGS]),
      recognition("ぬ", "nu", [...N_READINGS, ...S_READINGS]),
      recognition("ね", "ne", [...N_READINGS, ...K_READINGS]),
      recognition("の", "no", [...N_READINGS, ...T_READINGS]),
      production("な", "na", "hiragana"),
      production("に", "ni", "hiragana"),
      production("の", "no", "hiragana"),
      // Review
      recognition("た", "ta", [...N_READINGS, ...T_READINGS]),
      recognition("つ", "tsu", [...N_READINGS, ...T_READINGS]),
      production("ぬ", "nu", "hiragana"),
      production("ね", "ne", "hiragana"),
    ],
    srsItems: srsItems([["な", "na"], ["に", "ni"], ["ぬ", "nu"], ["ね", "ne"], ["の", "no"]]),
    skillsTaught: ["hiragana_n"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.6: H-row ---
  {
    id: "1.6",
    unit: "hiragana",
    unitIndex: 1,
    title: "H-row: はひふへほ",
    prerequisites: ["1.5"],
    introduction: {
      text: "The H-row: は = ha, ひ = hi, ふ = fu (not 'hu'), へ = he, ほ = ho. Note: ふ = 'fu', a soft sound between 'f' and 'h'. Also: は is read 'wa' when used as a particle!",
      items: [
        { char: "は", reading: "ha", mnemonic: "Looks like 'ha' — a person laughing", audioHint: "'ha' as in 'haha'" },
        { char: "ひ", reading: "hi", mnemonic: "A smiling mouth — 'hee hee!'", audioHint: "'hi' as in 'he'" },
        { char: "ふ", reading: "fu", mnemonic: "Mount Fuji! ふ looks like the mountain", audioHint: "'fu' — soft, between 'f' and 'h'" },
        { char: "へ", reading: "he", mnemonic: "A simple hill — going 'he-re'", audioHint: "'he' as in 'hen'" },
        { char: "ほ", reading: "ho", mnemonic: "A person laughing 'ho ho ho!'", audioHint: "'ho' as in 'home'" },
      ],
    },
    exercises: [
      recognition("は", "ha", [...H_READINGS, ...N_READINGS]),
      recognition("ひ", "hi", [...H_READINGS, ...N_READINGS]),
      recognition("ふ", "fu", [...H_READINGS, ...K_READINGS]),
      recognition("へ", "he", [...H_READINGS, ...T_READINGS]),
      recognition("ほ", "ho", [...H_READINGS, ...N_READINGS]),
      production("は", "ha", "hiragana"),
      production("ひ", "hi", "hiragana"),
      production("ふ", "fu", "hiragana"),
      // Review
      recognition("ね", "ne", [...H_READINGS, ...N_READINGS]),
      recognition("の", "no", [...H_READINGS, ...N_READINGS]),
      production("へ", "he", "hiragana"),
      production("ほ", "ho", "hiragana"),
      // Chart review: vowels + K + S + T + N + H (30 chars)
      chartReview([
        ["あ", "a"], ["い", "i"], ["う", "u"], ["え", "e"], ["お", "o"],
        ["か", "ka"], ["き", "ki"], ["く", "ku"], ["け", "ke"], ["こ", "ko"],
        ["さ", "sa"], ["し", "shi"], ["す", "su"], ["せ", "se"], ["そ", "so"],
        ["た", "ta"], ["ち", "chi"], ["つ", "tsu"], ["て", "te"], ["と", "to"],
        ["な", "na"], ["に", "ni"], ["ぬ", "nu"], ["ね", "ne"], ["の", "no"],
        ["は", "ha"], ["ひ", "hi"], ["ふ", "fu"], ["へ", "he"], ["ほ", "ho"],
      ]),
    ],
    srsItems: srsItems([["は", "ha"], ["ひ", "hi"], ["ふ", "fu"], ["へ", "he"], ["ほ", "ho"]]),
    skillsTaught: ["hiragana_h"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.7: M-row ---
  {
    id: "1.7",
    unit: "hiragana",
    unitIndex: 1,
    title: "M-row: まみむめも",
    prerequisites: ["1.6"],
    introduction: {
      text: "The M-row: ま = ma, み = mi, む = mu, め = me, も = mo. Almost there — just two more groups after this!",
      items: [
        { char: "ま", reading: "ma", mnemonic: "Looks like 'mama' with arms open", audioHint: "'ma' as in 'mama'" },
        { char: "み", reading: "mi", mnemonic: "The number 21 — 'mi' (me) at 21!", audioHint: "'mi' as in 'me'" },
        { char: "む", reading: "mu", mnemonic: "A cow going 'moo'", audioHint: "'mu' as in 'moo'" },
        { char: "め", reading: "me", mnemonic: "Looks like an eye — め means 'eye' in Japanese!", audioHint: "'me' as in 'met'" },
        { char: "も", reading: "mo", mnemonic: "Looks like a fishing hook catching 'mo-re' fish", audioHint: "'mo' as in 'more'" },
      ],
    },
    exercises: [
      recognition("ま", "ma", [...M_READINGS, ...H_READINGS]),
      recognition("み", "mi", [...M_READINGS, ...H_READINGS]),
      recognition("む", "mu", [...M_READINGS, ...N_READINGS]),
      recognition("め", "me", [...M_READINGS, ...H_READINGS]),
      recognition("も", "mo", [...M_READINGS, ...H_READINGS]),
      production("ま", "ma", "hiragana"),
      production("み", "mi", "hiragana"),
      production("む", "mu", "hiragana"),
      // Review
      recognition("ふ", "fu", [...M_READINGS, ...H_READINGS]),
      recognition("ほ", "ho", [...M_READINGS, ...H_READINGS]),
      production("め", "me", "hiragana"),
      production("も", "mo", "hiragana"),
    ],
    srsItems: srsItems([["ま", "ma"], ["み", "mi"], ["む", "mu"], ["め", "me"], ["も", "mo"]]),
    skillsTaught: ["hiragana_m"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.8: Y-row + R-row ---
  {
    id: "1.8",
    unit: "hiragana",
    unitIndex: 1,
    title: "Y & R-rows: やゆよ + らりるれろ",
    prerequisites: ["1.7"],
    introduction: {
      text: "Two rows at once! Y-row only has 3: や = ya, ゆ = yu, よ = yo. R-row has 5: ら = ra, り = ri, る = ru, れ = re, ろ = ro. Japanese 'r' sounds like a mix between 'r', 'l', and 'd'.",
      items: [
        { char: "や", reading: "ya", mnemonic: "Looks like a yak's horns", audioHint: "'ya' as in 'yard'" },
        { char: "ゆ", reading: "yu", mnemonic: "A fish — 'yu' like 'you' caught one!", audioHint: "'yu' as in 'you'" },
        { char: "よ", reading: "yo", mnemonic: "A person waving 'yo!'", audioHint: "'yo' as in 'yo!'" },
        { char: "ら", reading: "ra", mnemonic: "Looks like ち but messier — ra!", audioHint: "'ra' — tongue taps the roof lightly" },
        { char: "り", reading: "ri", mnemonic: "Two river streams flowing", audioHint: "'ri' as in 'reef'" },
        { char: "る", reading: "ru", mnemonic: "A loop — 'ru-n around' in circles", audioHint: "'ru' as in 'route'" },
        { char: "れ", reading: "re", mnemonic: "Looks like ね but with a straight end", audioHint: "'re' as in 'red'" },
        { char: "ろ", reading: "ro", mnemonic: "A road — 'ro-ad'", audioHint: "'ro' as in 'road'" },
      ],
    },
    exercises: [
      recognition("や", "ya", YRW_READINGS),
      recognition("ゆ", "yu", YRW_READINGS),
      recognition("よ", "yo", YRW_READINGS),
      recognition("ら", "ra", [...YRW_READINGS, ...M_READINGS]),
      recognition("り", "ri", [...YRW_READINGS, ...M_READINGS]),
      recognition("る", "ru", [...YRW_READINGS, ...H_READINGS]),
      recognition("れ", "re", [...YRW_READINGS, ...N_READINGS]),
      recognition("ろ", "ro", [...YRW_READINGS, ...H_READINGS]),
      production("や", "ya", "hiragana"),
      production("ゆ", "yu", "hiragana"),
      production("ら", "ra", "hiragana"),
      production("る", "ru", "hiragana"),
      // Chart review: all through Y+R rows (38 chars)
      chartReview([
        ["あ", "a"], ["い", "i"], ["う", "u"], ["え", "e"], ["お", "o"],
        ["か", "ka"], ["き", "ki"], ["く", "ku"], ["け", "ke"], ["こ", "ko"],
        ["さ", "sa"], ["し", "shi"], ["す", "su"], ["せ", "se"], ["そ", "so"],
        ["た", "ta"], ["ち", "chi"], ["つ", "tsu"], ["て", "te"], ["と", "to"],
        ["な", "na"], ["に", "ni"], ["ぬ", "nu"], ["ね", "ne"], ["の", "no"],
        ["は", "ha"], ["ひ", "hi"], ["ふ", "fu"], ["へ", "he"], ["ほ", "ho"],
        ["ま", "ma"], ["み", "mi"], ["む", "mu"], ["め", "me"], ["も", "mo"],
        ["や", "ya"], ["ゆ", "yu"], ["よ", "yo"],
      ]),
    ],
    srsItems: srsItems([
      ["や", "ya"], ["ゆ", "yu"], ["よ", "yo"],
      ["ら", "ra"], ["り", "ri"], ["る", "ru"], ["れ", "re"], ["ろ", "ro"],
    ]),
    skillsTaught: ["hiragana_y", "hiragana_r"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.9: W-row + ん ---
  {
    id: "1.9",
    unit: "hiragana",
    unitIndex: 1,
    title: "W-row + ん: わをん",
    prerequisites: ["1.8"],
    introduction: {
      text: "The final characters! わ = wa, を = wo (used as a particle, pronounced 'o'), and ん = n (the only consonant that stands alone). You now know all 46 basic hiragana!",
      items: [
        { char: "わ", reading: "wa", mnemonic: "Looks like わ-ter flowing", audioHint: "'wa' as in 'wander'" },
        { char: "を", reading: "wo", mnemonic: "Only used as particle を — pronounced 'o' in modern Japanese", audioHint: "Pronounced 'o' (same as お) in speech" },
        { char: "ん", reading: "n", mnemonic: "The only standalone consonant — looks like the letter 'n'!", audioHint: "'n' as in 'sun' (no vowel after)" },
      ],
    },
    exercises: [
      recognition("わ", "wa", [...YRW_READINGS, ...H_READINGS]),
      recognition("を", "wo", [...YRW_READINGS, ...VOWEL_READINGS]),
      recognition("ん", "n", [...YRW_READINGS, ...N_READINGS]),
      production("わ", "wa", "hiragana"),
      production("を", "wo", "hiragana"),
      production("ん", "n", "hiragana"),
      // Comprehensive review
      recognition("あ", "a", ALL_BASIC),
      recognition("か", "ka", ALL_BASIC),
      recognition("さ", "sa", ALL_BASIC),
      recognition("た", "ta", ALL_BASIC),
      recognition("は", "ha", ALL_BASIC),
      recognition("ま", "ma", ALL_BASIC),
    ],
    srsItems: srsItems([["わ", "wa"], ["を", "wo"], ["ん", "n"]]),
    skillsTaught: ["hiragana_w", "hiragana_nn"],
    furiganaLevel: "full",
  },

  // --- Lesson 1.10: Review + Word Reading ---
  {
    id: "1.10",
    unit: "hiragana",
    unitIndex: 1,
    title: "Review: Read Real Words!",
    prerequisites: ["1.9"],
    introduction: {
      text: "You've learned all 46 hiragana! Let's put them together — time to read real Japanese words. No new characters, just practice combining what you know.",
      items: [
        { word: "さくら", reading: "sakura", meaning: "cherry blossom" },
        { word: "ねこ", reading: "neko", meaning: "cat" },
        { word: "すし", reading: "sushi", meaning: "sushi" },
        { word: "ありがとう", reading: "arigatou", meaning: "thank you" },
        { word: "おはよう", reading: "ohayou", meaning: "good morning" },
      ],
    },
    exercises: [
      wordReading("さくら", "sakura", "cherry blossom", ["sakana", "sakura", "samura", "saruki"]),
      wordReading("ねこ", "neko", "cat", ["neko", "niko", "nako", "nuku"]),
      wordReading("すし", "sushi", "sushi", ["sashi", "sushi", "soshi", "sishi"]),
      wordReading("ありがとう", "arigatou", "thank you", ["arigatou", "ohagatou", "arugatou", "irigatou"]),
      wordReading("おはよう", "ohayou", "good morning", ["ohayou", "ahayou", "uhayou", "ehayou"]),
      wordReading("ともだち", "tomodachi", "friend", ["tomodachi", "tamodachi", "temudachi", "tomudachi"]),
      wordReading("たべる", "taberu", "to eat", ["taberu", "taneru", "toberu", "takeru"]),
      wordReading("のむ", "nomu", "to drink", ["nomu", "namu", "nimu", "nemu"]),
      // Production
      { type: "production" as const, prompt: 'Type **"cat"** in hiragana', answer: "ねこ", accept: ["neko"] },
      { type: "production" as const, prompt: 'Type **"sushi"** in hiragana', answer: "すし", accept: ["sushi"] },
      { type: "production" as const, prompt: 'Type **"thank you"** in hiragana', answer: "ありがとう", accept: ["arigatou"] },
      { type: "production" as const, prompt: 'Type **"good morning"** in hiragana', answer: "おはよう", accept: ["ohayou"] },
    ],
    srsItems: srsItems([
      ["さくら", "sakura (cherry blossom)"],
      ["ねこ", "neko (cat)"],
      ["ありがとう", "arigatou (thank you)"],
      ["おはよう", "ohayou (good morning)"],
    ]),
    skillsTaught: ["hiragana_words"],
    furiganaLevel: "full",
  },
];
