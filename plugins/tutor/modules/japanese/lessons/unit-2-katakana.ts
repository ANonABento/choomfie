/**
 * Unit 2: Katakana — 8 lessons teaching all katakana characters.
 *
 * Condensed compared to hiragana since students already know the sounds.
 * Each lesson introduces characters with visual mnemonics specific to
 * katakana shapes, then drills with recognition + production exercises.
 * Lessons 2.7-2.8 use loanword practice via the exercise generator.
 */

import type { Lesson, LessonSRSItem } from "../../../core/lesson-types.ts";
import { generateExercises, type ContentSet } from "../../../core/exercise-generator.ts";
import { recognition, production, chartReview } from "./kana-helpers.ts";

function srsItems(pairs: [string, string][]): LessonSRSItem[] {
  return pairs.map(([char, reading]) => ({
    front: char,
    back: reading,
    reading,
    tags: "katakana",
  }));
}

// --- Reading pools ---

const VOWEL_READINGS = ["a", "i", "u", "e", "o"];
const K_READINGS = ["ka", "ki", "ku", "ke", "ko"];
const S_READINGS = ["sa", "shi", "su", "se", "so"];
const T_READINGS = ["ta", "chi", "tsu", "te", "to"];
const N_READINGS = ["na", "ni", "nu", "ne", "no"];
const H_READINGS = ["ha", "hi", "fu", "he", "ho"];
const M_READINGS = ["ma", "mi", "mu", "me", "mo"];
const YRW_READINGS = ["ya", "yu", "yo", "ra", "ri", "ru", "re", "ro", "wa", "wo", "n"];

const DAKUTEN_READINGS = [
  "ga", "gi", "gu", "ge", "go",
  "za", "ji", "zu", "ze", "zo",
  "da", "di", "du", "de", "do",
  "ba", "bi", "bu", "be", "bo",
];

const HANDAKUTEN_READINGS = ["pa", "pi", "pu", "pe", "po"];

const ALL_BASIC = [
  ...VOWEL_READINGS, ...K_READINGS, ...S_READINGS, ...T_READINGS,
  ...N_READINGS, ...H_READINGS, ...M_READINGS, ...YRW_READINGS,
];

// --- Loanword content sets ---

const commonLoanwords: ContentSet = {
  items: [
    { term: "コーヒー", reading: "koohii", meaning: "coffee" },
    { term: "テレビ", reading: "terebi", meaning: "television" },
    { term: "パソコン", reading: "pasokon", meaning: "personal computer" },
    { term: "ビール", reading: "biiru", meaning: "beer" },
    { term: "タクシー", reading: "takushii", meaning: "taxi" },
    { term: "レストラン", reading: "resutoran", meaning: "restaurant" },
    { term: "ホテル", reading: "hoteru", meaning: "hotel" },
    { term: "アイスクリーム", reading: "aisukuriimu", meaning: "ice cream" },
    { term: "チョコレート", reading: "chokoreeto", meaning: "chocolate" },
    { term: "ハンバーガー", reading: "hanbaagaa", meaning: "hamburger" },
  ],
};

const moreLoanwords: ContentSet = {
  items: [
    { term: "スマホ", reading: "sumaho", meaning: "smartphone" },
    { term: "インターネット", reading: "intaanetto", meaning: "internet" },
    { term: "ゲーム", reading: "geemu", meaning: "game" },
    { term: "カメラ", reading: "kamera", meaning: "camera" },
    { term: "ペン", reading: "pen", meaning: "pen" },
    { term: "ノート", reading: "nooto", meaning: "notebook" },
    { term: "バス", reading: "basu", meaning: "bus" },
    { term: "トイレ", reading: "toire", meaning: "toilet" },
    { term: "エレベーター", reading: "erebeetaa", meaning: "elevator" },
    { term: "コンビニ", reading: "konbini", meaning: "convenience store" },
  ],
};

// --- Lessons ---

export const katakanaLessons: Lesson[] = [
  // --- Lesson 2.1: Vowels + K-row ---
  {
    id: "2.1",
    unit: "katakana",
    unitIndex: 2,
    title: "Vowels + K-row: アイウエオ カキクケコ",
    prerequisites: ["1.10"],
    introduction: {
      text: "Time for katakana! Same sounds as hiragana, but angular shapes used for foreign words, sound effects, and emphasis. You already know the sounds — now learn the new look.",
      items: [
        { char: "ア", reading: "a", mnemonic: "Looks like an axe — 'A-xe!'", audioHint: "Same 'a' as あ" },
        { char: "イ", reading: "i", mnemonic: "An easel standing up", audioHint: "Same 'i' as い" },
        { char: "ウ", reading: "u", mnemonic: "A bird with wings spread — 'oo'", audioHint: "Same 'u' as う" },
        { char: "エ", reading: "e", mnemonic: "Looks like an elevator going up", audioHint: "Same 'e' as え" },
        { char: "オ", reading: "o", mnemonic: "A man with a hat bowing — 'Oh!'", audioHint: "Same 'o' as お" },
        { char: "カ", reading: "ka", mnemonic: "A blade that can cut — 'ka-t!'", audioHint: "Same 'ka' as か" },
        { char: "キ", reading: "ki", mnemonic: "A key with sharp teeth", audioHint: "Same 'ki' as き" },
        { char: "ク", reading: "ku", mnemonic: "A corner angle — 'koo-l corner'", audioHint: "Same 'ku' as く" },
        { char: "ケ", reading: "ke", mnemonic: "The letter K on its side", audioHint: "Same 'ke' as け" },
        { char: "コ", reading: "ko", mnemonic: "A corner or box — 'ko-rner'", audioHint: "Same 'ko' as こ" },
      ],
    },
    exercises: [
      recognition("ア", "a", [...VOWEL_READINGS, ...K_READINGS]),
      recognition("イ", "i", [...VOWEL_READINGS, ...K_READINGS]),
      recognition("ウ", "u", [...VOWEL_READINGS, ...K_READINGS]),
      recognition("エ", "e", [...VOWEL_READINGS, ...K_READINGS]),
      recognition("オ", "o", [...VOWEL_READINGS, ...K_READINGS]),
      recognition("カ", "ka", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("キ", "ki", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("ク", "ku", [...K_READINGS, ...VOWEL_READINGS]),
      production("ア", "a", "katakana"),
      production("カ", "ka", "katakana"),
      recognition("ケ", "ke", [...K_READINGS, ...VOWEL_READINGS]),
      recognition("コ", "ko", [...K_READINGS, ...VOWEL_READINGS]),
    ],
    srsItems: srsItems([
      ["ア", "a"], ["イ", "i"], ["ウ", "u"], ["エ", "e"], ["オ", "o"],
      ["カ", "ka"], ["キ", "ki"], ["ク", "ku"], ["ケ", "ke"], ["コ", "ko"],
    ]),
    skillsTaught: ["katakana_vowels_k"],
    furiganaLevel: "full",
  },

  // --- Lesson 2.2: S-row + T-row ---
  {
    id: "2.2",
    unit: "katakana",
    unitIndex: 2,
    title: "S-row + T-row: サシスセソ タチツテト",
    prerequisites: ["2.1"],
    introduction: {
      text: "S-row and T-row in katakana. Same exceptions: シ = shi, チ = chi, ツ = tsu. Watch out — シ(shi) and ツ(tsu) look very similar! The strokes angle differently.",
      items: [
        { char: "サ", reading: "sa", mnemonic: "Looks like a saddle on a horse", audioHint: "Same 'sa' as さ" },
        { char: "シ", reading: "shi", mnemonic: "A smiley face tilted — strokes go UP-left", audioHint: "Same 'shi' as し" },
        { char: "ス", reading: "su", mnemonic: "A ski slope — 'su-ki!'", audioHint: "Same 'su' as す" },
        { char: "セ", reading: "se", mnemonic: "Looks like a sailboat", audioHint: "Same 'se' as せ" },
        { char: "ソ", reading: "so", mnemonic: "Two strokes going down-right — like sowing seeds", audioHint: "Same 'so' as そ" },
        { char: "タ", reading: "ta", mnemonic: "Looks like a 'ta-nk' turret from above", audioHint: "Same 'ta' as た" },
        { char: "チ", reading: "chi", mnemonic: "A cheerleader doing a pose — number 5!", audioHint: "Same 'chi' as ち" },
        { char: "ツ", reading: "tsu", mnemonic: "Three drops falling DOWN — strokes go DOWN-right (opposite of シ)", audioHint: "Same 'tsu' as つ" },
        { char: "テ", reading: "te", mnemonic: "A telephone pole", audioHint: "Same 'te' as て" },
        { char: "ト", reading: "to", mnemonic: "A totem pole — straight and simple", audioHint: "Same 'to' as と" },
      ],
    },
    exercises: [
      recognition("サ", "sa", [...S_READINGS, ...T_READINGS]),
      recognition("シ", "shi", [...S_READINGS, ...T_READINGS]),
      recognition("ス", "su", [...S_READINGS, ...K_READINGS]),
      recognition("セ", "se", [...S_READINGS, ...T_READINGS]),
      recognition("ソ", "so", [...S_READINGS, ...VOWEL_READINGS]),
      recognition("タ", "ta", [...T_READINGS, ...S_READINGS]),
      recognition("チ", "chi", [...T_READINGS, ...S_READINGS]),
      recognition("ツ", "tsu", [...T_READINGS, ...S_READINGS]),
      production("シ", "shi", "katakana"),
      production("ツ", "tsu", "katakana"),
      recognition("テ", "te", [...T_READINGS, ...K_READINGS]),
      recognition("ト", "to", [...T_READINGS, ...S_READINGS]),
      // Chart review: vowels + K + S + T (20 chars)
      chartReview([
        ["ア", "a"], ["イ", "i"], ["ウ", "u"], ["エ", "e"], ["オ", "o"],
        ["カ", "ka"], ["キ", "ki"], ["ク", "ku"], ["ケ", "ke"], ["コ", "ko"],
        ["サ", "sa"], ["シ", "shi"], ["ス", "su"], ["セ", "se"], ["ソ", "so"],
        ["タ", "ta"], ["チ", "chi"], ["ツ", "tsu"], ["テ", "te"], ["ト", "to"],
      ]),
    ],
    srsItems: srsItems([
      ["サ", "sa"], ["シ", "shi"], ["ス", "su"], ["セ", "se"], ["ソ", "so"],
      ["タ", "ta"], ["チ", "chi"], ["ツ", "tsu"], ["テ", "te"], ["ト", "to"],
    ]),
    skillsTaught: ["katakana_s_t"],
    furiganaLevel: "full",
  },

  // --- Lesson 2.3: N-row + H-row ---
  {
    id: "2.3",
    unit: "katakana",
    unitIndex: 2,
    title: "N-row + H-row: ナニヌネノ ハヒフヘホ",
    prerequisites: ["2.2"],
    introduction: {
      text: "N-row and H-row. Note: フ = fu (same exception as hiragana). ヘ looks almost identical to its hiragana counterpart へ — one of the few that barely changes!",
      items: [
        { char: "ナ", reading: "na", mnemonic: "Looks like a knife — 'na-ife'", audioHint: "Same 'na' as な" },
        { char: "ニ", reading: "ni", mnemonic: "Two horizontal lines — like a knee bending", audioHint: "Same 'ni' as に" },
        { char: "ヌ", reading: "nu", mnemonic: "Chopsticks picking up noodles", audioHint: "Same 'nu' as ぬ" },
        { char: "ネ", reading: "ne", mnemonic: "Looks like a net post", audioHint: "Same 'ne' as ね" },
        { char: "ノ", reading: "no", mnemonic: "A simple slash — like saying 'no' with a stroke", audioHint: "Same 'no' as の" },
        { char: "ハ", reading: "ha", mnemonic: "Two lines spread like laughing — 'ha ha!'", audioHint: "Same 'ha' as は" },
        { char: "ヒ", reading: "hi", mnemonic: "A nose from the side — 'hee' sniff!", audioHint: "Same 'hi' as ひ" },
        { char: "フ", reading: "fu", mnemonic: "A hook hanging down — like Mount Fuji simplified", audioHint: "Same 'fu' as ふ" },
        { char: "ヘ", reading: "he", mnemonic: "Same shape as hiragana へ — a hill!", audioHint: "Same 'he' as へ" },
        { char: "ホ", reading: "ho", mnemonic: "A cross with wings — 'ho-ly!'", audioHint: "Same 'ho' as ほ" },
      ],
    },
    exercises: [
      recognition("ナ", "na", [...N_READINGS, ...H_READINGS]),
      recognition("ニ", "ni", [...N_READINGS, ...H_READINGS]),
      recognition("ヌ", "nu", [...N_READINGS, ...S_READINGS]),
      recognition("ネ", "ne", [...N_READINGS, ...H_READINGS]),
      recognition("ノ", "no", [...N_READINGS, ...T_READINGS]),
      recognition("ハ", "ha", [...H_READINGS, ...N_READINGS]),
      recognition("ヒ", "hi", [...H_READINGS, ...N_READINGS]),
      recognition("フ", "fu", [...H_READINGS, ...K_READINGS]),
      production("ナ", "na", "katakana"),
      production("フ", "fu", "katakana"),
      recognition("ヘ", "he", [...H_READINGS, ...T_READINGS]),
      recognition("ホ", "ho", [...H_READINGS, ...N_READINGS]),
    ],
    srsItems: srsItems([
      ["ナ", "na"], ["ニ", "ni"], ["ヌ", "nu"], ["ネ", "ne"], ["ノ", "no"],
      ["ハ", "ha"], ["ヒ", "hi"], ["フ", "fu"], ["ヘ", "he"], ["ホ", "ho"],
    ]),
    skillsTaught: ["katakana_n_h"],
    furiganaLevel: "full",
  },

  // --- Lesson 2.4: M-row + Y+R+W+N ---
  {
    id: "2.4",
    unit: "katakana",
    unitIndex: 2,
    title: "M-row + Y/R/W/ン: マ〜モ ヤユヨ ラ〜ロ ワヲン",
    prerequisites: ["2.3"],
    introduction: {
      text: "The biggest lesson — M-row plus all remaining characters. After this you'll know all basic katakana! ン(n) is the standalone consonant, same as hiragana ん.",
      items: [
        { char: "マ", reading: "ma", mnemonic: "Looks like an open mouth — 'Ma!'", audioHint: "Same 'ma' as ま" },
        { char: "ミ", reading: "mi", mnemonic: "Three horizontal strokes — like the number 3", audioHint: "Same 'mi' as み" },
        { char: "ム", reading: "mu", mnemonic: "Looks like a cow's horns — 'moo!'", audioHint: "Same 'mu' as む" },
        { char: "メ", reading: "me", mnemonic: "An X mark — like crossing your eyes", audioHint: "Same 'me' as め" },
        { char: "モ", reading: "mo", mnemonic: "Looks like the letter E sideways — 'mo-re lines!'", audioHint: "Same 'mo' as も" },
        { char: "ヤ", reading: "ya", mnemonic: "Looks like a yak's head from the front", audioHint: "Same 'ya' as や" },
        { char: "ユ", reading: "yu", mnemonic: "A U-turn sign — 'yu-turn!'", audioHint: "Same 'yu' as ゆ" },
        { char: "ヨ", reading: "yo", mnemonic: "Looks like a yogurt cup from the side", audioHint: "Same 'yo' as よ" },
        { char: "ラ", reading: "ra", mnemonic: "A simple 7 — lucky 'ra-cky!'", audioHint: "Same 'ra' as ら" },
        { char: "リ", reading: "ri", mnemonic: "Two reeds standing tall", audioHint: "Same 'ri' as り" },
        { char: "ル", reading: "ru", mnemonic: "Looks like a tree root", audioHint: "Same 'ru' as る" },
        { char: "レ", reading: "re", mnemonic: "A razor blade edge — sharp angle", audioHint: "Same 're' as れ" },
        { char: "ロ", reading: "ro", mnemonic: "A square mouth — 'ro-bot mouth!'", audioHint: "Same 'ro' as ろ" },
        { char: "ワ", reading: "wa", mnemonic: "A wine glass — 'wa-ine!'", audioHint: "Same 'wa' as わ" },
        { char: "ヲ", reading: "wo", mnemonic: "Rare — used as particle (like を)", audioHint: "Same 'wo' as を" },
        { char: "ン", reading: "n", mnemonic: "Like シ but tilted — strokes go different direction", audioHint: "Same 'n' as ん" },
      ],
    },
    exercises: [
      recognition("マ", "ma", [...M_READINGS, ...H_READINGS]),
      recognition("ミ", "mi", [...M_READINGS, ...N_READINGS]),
      recognition("ム", "mu", [...M_READINGS, ...K_READINGS]),
      recognition("メ", "me", [...M_READINGS, ...H_READINGS]),
      recognition("モ", "mo", [...M_READINGS, ...N_READINGS]),
      recognition("ヤ", "ya", YRW_READINGS),
      recognition("ラ", "ra", YRW_READINGS),
      recognition("ル", "ru", YRW_READINGS),
      recognition("ン", "n", YRW_READINGS),
      production("マ", "ma", "katakana"),
      production("ラ", "ra", "katakana"),
      production("ン", "n", "katakana"),
      // Chart review: all basic katakana
      chartReview([
        ["ア", "a"], ["イ", "i"], ["ウ", "u"], ["エ", "e"], ["オ", "o"],
        ["カ", "ka"], ["キ", "ki"], ["ク", "ku"], ["ケ", "ke"], ["コ", "ko"],
        ["サ", "sa"], ["シ", "shi"], ["ス", "su"], ["セ", "se"], ["ソ", "so"],
        ["タ", "ta"], ["チ", "chi"], ["ツ", "tsu"], ["テ", "te"], ["ト", "to"],
        ["ナ", "na"], ["ニ", "ni"], ["ヌ", "nu"], ["ネ", "ne"], ["ノ", "no"],
        ["ハ", "ha"], ["ヒ", "hi"], ["フ", "fu"], ["ヘ", "he"], ["ホ", "ho"],
        ["マ", "ma"], ["ミ", "mi"], ["ム", "mu"], ["メ", "me"], ["モ", "mo"],
        ["ヤ", "ya"], ["ユ", "yu"], ["ヨ", "yo"],
      ]),
    ],
    srsItems: srsItems([
      ["マ", "ma"], ["ミ", "mi"], ["ム", "mu"], ["メ", "me"], ["モ", "mo"],
      ["ヤ", "ya"], ["ユ", "yu"], ["ヨ", "yo"],
      ["ラ", "ra"], ["リ", "ri"], ["ル", "ru"], ["レ", "re"], ["ロ", "ro"],
      ["ワ", "wa"], ["ヲ", "wo"], ["ン", "n"],
    ]),
    skillsTaught: ["katakana_m", "katakana_y", "katakana_r", "katakana_w_n"],
    furiganaLevel: "full",
  },

  // --- Lesson 2.5: Dakuten ---
  {
    id: "2.5",
    unit: "katakana",
    unitIndex: 2,
    title: "Dakuten: ガ〜ゴ ザ〜ゾ ダ〜ド バ〜ボ",
    prerequisites: ["2.4"],
    introduction: {
      text: "Dakuten (゛) — those two little marks that voice a consonant. Same rule as hiragana: k→g, s→z, t→d, h→b. You already know this pattern!",
      items: [
        { char: "ガ", reading: "ga", mnemonic: "カ + dakuten = voiced 'ga'", audioHint: "'ga' as in 'garden'" },
        { char: "ギ", reading: "gi", mnemonic: "キ + dakuten = voiced 'gi'", audioHint: "'gi' as in 'geese'" },
        { char: "グ", reading: "gu", mnemonic: "ク + dakuten = voiced 'gu'", audioHint: "'gu' as in 'goo'" },
        { char: "ゲ", reading: "ge", mnemonic: "ケ + dakuten = voiced 'ge'", audioHint: "'ge' as in 'get'" },
        { char: "ゴ", reading: "go", mnemonic: "コ + dakuten = voiced 'go'", audioHint: "'go' as in 'go'" },
        { char: "ザ", reading: "za", mnemonic: "サ + dakuten = voiced 'za'", audioHint: "'za' as in 'pizza'" },
        { char: "ジ", reading: "ji", mnemonic: "シ + dakuten = voiced 'ji'", audioHint: "'ji' as in 'jeep'" },
        { char: "ズ", reading: "zu", mnemonic: "ス + dakuten = voiced 'zu'", audioHint: "'zu' as in 'zoo'" },
        { char: "ゼ", reading: "ze", mnemonic: "セ + dakuten = voiced 'ze'", audioHint: "'ze' as in 'zero'" },
        { char: "ゾ", reading: "zo", mnemonic: "ソ + dakuten = voiced 'zo'", audioHint: "'zo' as in 'zone'" },
        { char: "ダ", reading: "da", mnemonic: "タ + dakuten = voiced 'da'", audioHint: "'da' as in 'dad'" },
        { char: "ヂ", reading: "di", mnemonic: "チ + dakuten (rare — ジ is more common)", audioHint: "Usually pronounced 'ji'" },
        { char: "ヅ", reading: "du", mnemonic: "ツ + dakuten (rare — ズ is more common)", audioHint: "Usually pronounced 'zu'" },
        { char: "デ", reading: "de", mnemonic: "テ + dakuten = voiced 'de'", audioHint: "'de' as in 'desk'" },
        { char: "ド", reading: "do", mnemonic: "ト + dakuten = voiced 'do'", audioHint: "'do' as in 'door'" },
        { char: "バ", reading: "ba", mnemonic: "ハ + dakuten = voiced 'ba'", audioHint: "'ba' as in 'bat'" },
        { char: "ビ", reading: "bi", mnemonic: "ヒ + dakuten = voiced 'bi'", audioHint: "'bi' as in 'bee'" },
        { char: "ブ", reading: "bu", mnemonic: "フ + dakuten = voiced 'bu'", audioHint: "'bu' as in 'boo'" },
        { char: "ベ", reading: "be", mnemonic: "ヘ + dakuten = voiced 'be'", audioHint: "'be' as in 'bed'" },
        { char: "ボ", reading: "bo", mnemonic: "ホ + dakuten = voiced 'bo'", audioHint: "'bo' as in 'boat'" },
      ],
    },
    exercises: [
      recognition("ガ", "ga", DAKUTEN_READINGS),
      recognition("ジ", "ji", DAKUTEN_READINGS),
      recognition("ズ", "zu", DAKUTEN_READINGS),
      recognition("デ", "de", DAKUTEN_READINGS),
      recognition("ド", "do", DAKUTEN_READINGS),
      recognition("バ", "ba", DAKUTEN_READINGS),
      recognition("ビ", "bi", DAKUTEN_READINGS),
      recognition("ブ", "bu", DAKUTEN_READINGS),
      production("ガ", "ga", "katakana"),
      production("ジ", "ji", "katakana"),
      production("バ", "ba", "katakana"),
      production("ブ", "bu", "katakana"),
    ],
    srsItems: srsItems([
      ["ガ", "ga"], ["ギ", "gi"], ["グ", "gu"], ["ゲ", "ge"], ["ゴ", "go"],
      ["ザ", "za"], ["ジ", "ji"], ["ズ", "zu"], ["ゼ", "ze"], ["ゾ", "zo"],
      ["ダ", "da"], ["ヂ", "di"], ["ヅ", "du"], ["デ", "de"], ["ド", "do"],
      ["バ", "ba"], ["ビ", "bi"], ["ブ", "bu"], ["ベ", "be"], ["ボ", "bo"],
    ]),
    skillsTaught: ["katakana_dakuten"],
    furiganaLevel: "full",
  },

  // --- Lesson 2.6: Handakuten + Combos ---
  {
    id: "2.6",
    unit: "katakana",
    unitIndex: 2,
    title: "Handakuten + Combos: パ〜ポ + キャ, シュ, チョ...",
    prerequisites: ["2.5"],
    introduction: {
      text: "Handakuten (゜) turns h→p. Then combo characters: small ャ ュ ョ after certain consonants create new syllables. These are used heavily in loanwords!",
      items: [
        { char: "パ", reading: "pa", mnemonic: "ハ + handakuten circle = 'pa'", audioHint: "'pa' as in 'papa'" },
        { char: "ピ", reading: "pi", mnemonic: "ヒ + handakuten circle = 'pi'", audioHint: "'pi' as in 'pizza'" },
        { char: "プ", reading: "pu", mnemonic: "フ + handakuten circle = 'pu'", audioHint: "'pu' as in 'pool'" },
        { char: "ペ", reading: "pe", mnemonic: "ヘ + handakuten circle = 'pe'", audioHint: "'pe' as in 'pet'" },
        { char: "ポ", reading: "po", mnemonic: "ホ + handakuten circle = 'po'", audioHint: "'po' as in 'post'" },
        { char: "キャ", reading: "kya", mnemonic: "キ + small ャ = 'kya'", audioHint: "One syllable: 'kya'" },
        { char: "キュ", reading: "kyu", mnemonic: "キ + small ュ = 'kyu'", audioHint: "One syllable: 'kyu'" },
        { char: "キョ", reading: "kyo", mnemonic: "キ + small ョ = 'kyo'", audioHint: "One syllable: 'kyo'" },
        { char: "シャ", reading: "sha", mnemonic: "シ + small ャ = 'sha'", audioHint: "One syllable: 'sha'" },
        { char: "シュ", reading: "shu", mnemonic: "シ + small ュ = 'shu'", audioHint: "One syllable: 'shu'" },
        { char: "チョ", reading: "cho", mnemonic: "チ + small ョ = 'cho'", audioHint: "One syllable: 'cho'" },
      ],
    },
    exercises: [
      recognition("パ", "pa", [...HANDAKUTEN_READINGS, ...DAKUTEN_READINGS.slice(15, 20)]),
      recognition("ピ", "pi", [...HANDAKUTEN_READINGS, ...DAKUTEN_READINGS.slice(15, 20)]),
      recognition("プ", "pu", [...HANDAKUTEN_READINGS, ...DAKUTEN_READINGS.slice(15, 20)]),
      recognition("ペ", "pe", [...HANDAKUTEN_READINGS, ...DAKUTEN_READINGS.slice(15, 20)]),
      recognition("ポ", "po", [...HANDAKUTEN_READINGS, ...DAKUTEN_READINGS.slice(15, 20)]),
      production("パ", "pa", "katakana"),
      production("ピ", "pi", "katakana"),
      production("プ", "pu", "katakana"),
      recognition("キャ", "kya", ["kya", "kyu", "kyo", "sha", "shu", "cho"]),
      recognition("シュ", "shu", ["kya", "kyu", "kyo", "sha", "shu", "cho"]),
      recognition("チョ", "cho", ["kya", "kyu", "kyo", "sha", "shu", "cho"]),
      production("シャ", "sha", "katakana"),
      // Chart review: dakuten + handakuten
      chartReview([
        ["ガ", "ga"], ["ギ", "gi"], ["グ", "gu"], ["ゲ", "ge"], ["ゴ", "go"],
        ["ザ", "za"], ["ジ", "ji"], ["ズ", "zu"], ["ゼ", "ze"], ["ゾ", "zo"],
        ["ダ", "da"], ["デ", "de"], ["ド", "do"],
        ["バ", "ba"], ["ビ", "bi"], ["ブ", "bu"], ["ベ", "be"], ["ボ", "bo"],
        ["パ", "pa"], ["ピ", "pi"], ["プ", "pu"], ["ペ", "pe"], ["ポ", "po"],
      ]),
    ],
    srsItems: srsItems([
      ["パ", "pa"], ["ピ", "pi"], ["プ", "pu"], ["ペ", "pe"], ["ポ", "po"],
      ["キャ", "kya"], ["キュ", "kyu"], ["キョ", "kyo"],
      ["シャ", "sha"], ["シュ", "shu"], ["チョ", "cho"],
    ]),
    skillsTaught: ["katakana_handakuten", "katakana_combos"],
    furiganaLevel: "full",
  },

  // --- Lesson 2.7: Common Loanwords ---
  {
    id: "2.7",
    unit: "katakana",
    unitIndex: 2,
    title: "Loanwords: コーヒー, テレビ, パソコン...",
    prerequisites: ["2.6"],
    introduction: {
      text: "Katakana's main job: writing foreign loanwords! Japanese adapts English (and other languages) into katakana. Long vowels use ー (chōon). Let's read some common words you'll see everywhere in Japan.",
      items: [
        { word: "コーヒー", reading: "koohii", meaning: "coffee" },
        { word: "テレビ", reading: "terebi", meaning: "television" },
        { word: "パソコン", reading: "pasokon", meaning: "personal computer" },
        { word: "ビール", reading: "biiru", meaning: "beer" },
        { word: "タクシー", reading: "takushii", meaning: "taxi" },
        { word: "レストラン", reading: "resutoran", meaning: "restaurant" },
        { word: "ホテル", reading: "hoteru", meaning: "hotel" },
        { word: "アイスクリーム", reading: "aisukuriimu", meaning: "ice cream" },
        { word: "チョコレート", reading: "chokoreeto", meaning: "chocolate" },
        { word: "ハンバーガー", reading: "hanbaagaa", meaning: "hamburger" },
      ],
    },
    exercises: [
      ...generateExercises(commonLoanwords, "recognition"),
      ...generateExercises(commonLoanwords, "production").slice(0, 2),
    ],
    srsItems: commonLoanwords.items.map((item) => ({
      front: item.term,
      back: `${item.reading} (${item.meaning})`,
      reading: item.reading,
      tags: "katakana,loanword",
    })),
    skillsTaught: ["katakana_loanwords"],
    furiganaLevel: "full",
  },

  // --- Lesson 2.8: Review + More Loanwords ---
  {
    id: "2.8",
    unit: "katakana",
    unitIndex: 2,
    title: "Review: Mixed Katakana + Loanwords",
    prerequisites: ["2.7"],
    introduction: {
      text: "Final katakana review! You've learned all katakana characters and started reading loanwords. Let's solidify everything with more practice. After this, you'll be ready for real Japanese text!",
      items: [
        { word: "スマホ", reading: "sumaho", meaning: "smartphone" },
        { word: "インターネット", reading: "intaanetto", meaning: "internet" },
        { word: "ゲーム", reading: "geemu", meaning: "game" },
        { word: "カメラ", reading: "kamera", meaning: "camera" },
        { word: "コンビニ", reading: "konbini", meaning: "convenience store" },
      ],
    },
    exercises: [
      // Mixed basic katakana recognition
      recognition("ア", "a", ALL_BASIC),
      recognition("シ", "shi", ALL_BASIC),
      recognition("ツ", "tsu", ALL_BASIC),
      recognition("ン", "n", ALL_BASIC),
      // Loanword exercises via generator
      ...generateExercises(moreLoanwords, "recognition"),
      ...generateExercises(moreLoanwords, "production").slice(0, 2),
    ],
    srsItems: moreLoanwords.items.map((item) => ({
      front: item.term,
      back: `${item.reading} (${item.meaning})`,
      reading: item.reading,
      tags: "katakana,loanword",
    })),
    skillsTaught: ["katakana_review", "katakana_loanwords_advanced"],
    furiganaLevel: "full",
  },
];
