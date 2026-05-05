/**
 * Korean A1 lesson registry — Hangul, grammar, and vocabulary.
 *
 * 3 units, 9 lessons:
 *   Unit 1 (Hangul):    1.1 Basic Consonants, 1.2 Vowels and Syllable Blocks
 *   Unit 2 (Grammar):   2.1 Basic Particles, 2.2 Present Tense Polite, 2.3 Past Tense Polite
 *   Unit 3 (Vocab):     3.1 Greetings, 3.2 Numbers, 3.3 Family Food Places, 3.4 Review
 */

import type { Lesson, Unit } from "../../../core/lesson-types.ts";
import { generateExercises, type ContentSet } from "../../../core/exercise-generator.ts";
import { koreanByTerms } from "../data/a1-vocab.ts";
import { cloze, introItems, mc, vocabSRS } from "../../../core/lesson-helpers.ts";

function content(terms: string[]): ContentSet {
  return { items: koreanByTerms(terms), productionLabel: "Hangul" };
}

function vocabLesson(
  id: string,
  title: string,
  prerequisites: string[],
  terms: string[],
  introduction: string,
  skill: string,
): Lesson {
  const lessonContent = content(terms);
  return {
    id,
    unit: "vocabulary",
    unitIndex: 3,
    title,
    prerequisites,
    introduction: {
      text: introduction,
      items: introItems(lessonContent.items),
    },
    exercises: [
      ...generateExercises(lessonContent, "recognition"),
      ...generateExercises(lessonContent, "production").slice(0, 3),
      ...generateExercises({ items: lessonContent.items.slice(0, 5) }, "matching"),
    ],
    srsItems: vocabSRS(lessonContent.items, `korean_a1_${skill}`),
    skillsTaught: [`korean_a1_${skill}`],
    furiganaLevel: "full",
  };
}

// ----- Unit 1: Hangul -----

const basicConsonantsContent: ContentSet = {
  items: [
    { term: "ㄱ", reading: "g/k", meaning: "consonant: g (initial) / k (final)" },
    { term: "ㄴ", reading: "n", meaning: "consonant: n" },
    { term: "ㄷ", reading: "d/t", meaning: "consonant: d (initial) / t (final)" },
    { term: "ㄹ", reading: "r/l", meaning: "consonant: r (initial) / l (final)" },
    { term: "ㅁ", reading: "m", meaning: "consonant: m" },
    { term: "ㅂ", reading: "b/p", meaning: "consonant: b (initial) / p (final)" },
    { term: "ㅅ", reading: "s", meaning: "consonant: s" },
    { term: "ㅇ", reading: "silent/ng", meaning: "consonant: silent (initial) / ng (final)" },
    { term: "ㅈ", reading: "j", meaning: "consonant: j" },
    { term: "ㅎ", reading: "h", meaning: "consonant: h" },
  ],
};

const basicVowelsContent: ContentSet = {
  items: [
    { term: "ㅏ", reading: "a", meaning: "vowel: a (as in 'father')" },
    { term: "ㅓ", reading: "eo", meaning: "vowel: eo (as in 'run')" },
    { term: "ㅗ", reading: "o", meaning: "vowel: o (as in 'go')" },
    { term: "ㅜ", reading: "u", meaning: "vowel: u (as in 'too')" },
    { term: "ㅡ", reading: "eu", meaning: "vowel: eu (no English equivalent)" },
    { term: "ㅣ", reading: "i", meaning: "vowel: i (as in 'see')" },
    { term: "ㅐ", reading: "ae", meaning: "vowel: ae (as in 'bed')" },
    { term: "ㅔ", reading: "e", meaning: "vowel: e (as in 'bed')" },
  ],
};

const syllableBlockExamples: ContentSet = {
  items: [
    { term: "나", reading: "na", meaning: "I (informal); composed of ㄴ + ㅏ" },
    { term: "바", reading: "ba", meaning: "rock/wave; ㅂ + ㅏ" },
    { term: "도", reading: "do", meaning: "also/degree; ㄷ + ㅗ" },
    { term: "미", reading: "mi", meaning: "beauty; ㅁ + ㅣ" },
    { term: "서", reading: "seo", meaning: "west/stand; ㅅ + ㅓ" },
  ],
};

// ----- Unit 2: Grammar -----

const particlesContent: ContentSet = {
  items: [
    { term: "은/는", reading: "eun/neun", meaning: "topic marker (은 after consonant, 는 after vowel)" },
    { term: "이/가", reading: "i/ga", meaning: "subject marker (이 after consonant, 가 after vowel)" },
    { term: "을/를", reading: "eul/reul", meaning: "object marker (을 after consonant, 를 after vowel)" },
    { term: "에", reading: "e", meaning: "location/time particle: at, to, in" },
    { term: "에서", reading: "eseo", meaning: "action location particle: at, from" },
    { term: "의", reading: "ui", meaning: "possessive particle: 's, of" },
  ],
};

const presentTenseExamples: ContentSet = {
  items: [
    { term: "가요", reading: "gayo", meaning: "go (present polite); from 가다 + -아요" },
    { term: "와요", reading: "wayo", meaning: "come (present polite); from 오다 + -아요" },
    { term: "먹어요", reading: "meogeoyo", meaning: "eat (present polite); from 먹다 + -어요" },
    { term: "마셔요", reading: "masyeoyo", meaning: "drink (present polite); from 마시다 + -어요" },
    { term: "해요", reading: "haeyo", meaning: "do (present polite); from 하다 → 해요" },
    { term: "있어요", reading: "isseoyo", meaning: "have/exist (present polite); from 있다 + -어요" },
  ],
};

const pastTenseExamples: ContentSet = {
  items: [
    { term: "갔어요", reading: "gasseoyo", meaning: "went (past polite); 가다 → 갔어요" },
    { term: "왔어요", reading: "wasseoyo", meaning: "came (past polite); 오다 → 왔어요" },
    { term: "먹었어요", reading: "meogeosseoyo", meaning: "ate (past polite); 먹다 → 먹었어요" },
    { term: "했어요", reading: "haesseoyo", meaning: "did (past polite); 하다 → 했어요" },
    { term: "있었어요", reading: "isseosseoyo", meaning: "had/existed (past polite); 있다 → 있었어요" },
  ],
};

export const koreanLessons: Lesson[] = [
  // ---- Unit 1: Hangul ----
  {
    id: "1.1",
    unit: "hangul",
    unitIndex: 1,
    title: "Basic Consonants",
    prerequisites: [],
    introduction: {
      text: "Hangul is Korea's phonetic alphabet, created in 1443. Each syllable is a block built from consonants and vowels. Start with 10 basic consonants — each has a fixed sound. ㄱ makes a 'g' sound at the start of a syllable and 'k' at the end. ㅇ is silent at the start but makes 'ng' at the end.",
      items: introItems(basicConsonantsContent.items),
    },
    exercises: [
      mc("Which consonant is silent at the start of a syllable?", "ㅇ", ["ㄱ", "ㄴ", "ㅎ"],
        "ㅇ acts as a placeholder when a syllable starts with a vowel."),
      mc("Which consonant makes the 'n' sound?", "ㄴ", ["ㄱ", "ㄹ", "ㅁ"]),
      mc("Which consonant makes the 'm' sound?", "ㅁ", ["ㄴ", "ㅂ", "ㅅ"]),
      mc("Which consonant makes the 'h' sound?", "ㅎ", ["ㅈ", "ㅅ", "ㄷ"]),
      mc("Which consonant makes 'r' at the start and 'l' at the end?", "ㄹ", ["ㄱ", "ㄷ", "ㅂ"],
        "ㄹ is romanized 'r' in onset position and 'l' in coda position."),
      mc("Which consonant makes the 'j' sound?", "ㅈ", ["ㅅ", "ㄷ", "ㄴ"]),
      cloze("ㄱ makes a ___ sound at the start of a syllable.", "g", "Think of 'go'."),
      cloze("ㅂ makes a ___ sound at the start of a syllable.", "b", "Think of 'boy'."),
      mc("At the end of a syllable, ㅅ sounds like:", "t", ["s", "n", "ng"],
        "Most final consonants are unreleased; ㅅ becomes a 't' sound in coda position."),
      mc("Which consonant makes 'ng' at the end of a syllable?", "ㅇ", ["ㄴ", "ㅁ", "ㄹ"],
        "The same ㅇ that is silent at the start becomes 'ng' at the end, as in 방 (bang = room)."),
    ],
    srsItems: [],
    skillsTaught: ["hangul_consonants"],
    furiganaLevel: "full",
  },
  {
    id: "1.2",
    unit: "hangul",
    unitIndex: 1,
    title: "Vowels and Syllable Blocks",
    prerequisites: ["1.1"],
    introduction: {
      text: "Korean vowels are written as strokes beside or below the consonant. A syllable block is always: (onset consonant) + vowel, with an optional final consonant called a 받침 (batchim). If a syllable starts with a vowel sound, ㅇ fills the silent onset: 아 = ㅇ + ㅏ.",
      items: introItems(basicVowelsContent.items),
    },
    exercises: [
      ...generateExercises(basicVowelsContent, "recognition"),
      mc("How is the syllable 아 structured?", "ㅇ + ㅏ", ["ㄱ + ㅏ", "ㅏ only", "ㅇ + ㅓ"],
        "Vowel-initial syllables use ㅇ as a silent placeholder."),
      mc("What is the final consonant in Korean called?", "받침 (batchim)", ["초성 (onset)", "중성 (nucleus)", "모음 (vowel)"],
        "받침 is the optional consonant at the bottom of a syllable block."),
      ...generateExercises(syllableBlockExamples, "recognition"),
      cloze("나 is composed of ___ + ㅏ.", "ㄴ", "Consonant ㄴ plus vowel ㅏ."),
      cloze("The vowel ㅜ is romanized as ___.", "u", "Like 'oo' in 'too'."),
      mc("Which two vowels sound nearly identical and are often merged at A1?", "ㅐ and ㅔ",
        ["ㅏ and ㅓ", "ㅗ and ㅜ", "ㅡ and ㅣ"],
        "Modern Korean pronunciation rarely distinguishes ㅐ (ae) and ㅔ (e)."),
    ],
    srsItems: [],
    skillsTaught: ["hangul_vowels", "syllable_blocks"],
    furiganaLevel: "full",
  },

  // ---- Unit 2: Grammar ----
  {
    id: "2.1",
    unit: "grammar",
    unitIndex: 2,
    title: "Basic Particles",
    prerequisites: ["1.2"],
    introduction: {
      text: "Korean uses postpositional particles (조사) attached to nouns to show their role in the sentence. The form changes depending on whether the noun ends in a consonant or vowel: 은/는 (topic), 이/가 (subject), 을/를 (object), 에 (location/time), 에서 (action site), 의 (possessive).",
      items: introItems(particlesContent.items),
    },
    exercises: [
      ...generateExercises(particlesContent, "recognition"),
      mc("Which particle marks the topic of the sentence?", "은/는", ["이/가", "을/를", "에서"],
        "은/는 marks what the sentence is about; 이/가 marks the grammatical subject."),
      mc("Which particle marks the direct object?", "을/를", ["은/는", "이/가", "에"],
        "을/를 shows what the verb acts upon."),
      mc("After a vowel-ending noun, use topic marker:", "는", ["은", "이", "을"],
        "학교 ends in ㅛ (vowel) → 학교는"),
      mc("After a consonant-ending noun, use subject marker:", "이", ["가", "를", "에서"],
        "밥 ends in ㅂ (consonant) → 밥이"),
      mc("Which particle means 'at/to' for location and time?", "에",
        ["에서", "의", "을/를"],
        "학교에 가요 = go to school; 세 시에 = at 3 o'clock."),
      mc("Which particle means 'at/from' for action location?", "에서",
        ["에", "의", "이/가"],
        "학교에서 공부해요 = study at school."),
      cloze("저___ 학생이에요. (I am a student.)", "는", "저 ends in ㅓ (vowel) → use 는."),
      cloze("밥___ 먹어요. (I eat rice.)", "을", "밥 ends in ㅂ (consonant) → use 을."),
    ],
    srsItems: vocabSRS(particlesContent.items, "korean_a1_particles"),
    skillsTaught: ["korean_particles"],
    furiganaLevel: "full",
  },
  {
    id: "2.2",
    unit: "grammar",
    unitIndex: 2,
    title: "Present Tense Polite (-아요/-어요/-해요)",
    prerequisites: ["2.1"],
    introduction: {
      text: "To speak politely, Korean verbs take the -아요 or -어요 ending. The choice depends on the last vowel in the stem: ㅏ or ㅗ → -아요; everything else → -어요. 하다 verbs become 해요 irregularly. Drop 다 to get the stem: 가다 → 가 → 가요 (ㅏ stem → 아요, but 가 + 아요 contracts to 가요).",
      items: introItems(presentTenseExamples.items),
    },
    exercises: [
      ...generateExercises(presentTenseExamples, "recognition"),
      mc("The polite present ending after a ㅏ or ㅗ stem vowel is:", "-아요", ["-어요", "-해요", "-었어요"],
        "가다 (stem 가, vowel ㅏ) → 가요 (contracted from 가+아요)."),
      mc("The polite present ending for most other stem vowels is:", "-어요", ["-아요", "-해요", "-았어요"]),
      mc("하다 verbs change to:", "해요", ["하요", "하아요", "하어요"],
        "공부하다 → 공부해요."),
      cloze("오다 (to come) in polite present is:", "와요", "오 + 아요 → 와요 (contracted)."),
      cloze("먹다 (to eat) in polite present is:", "먹어요", "먹 + 어요 (last vowel ㅓ, not ㅏ/ㅗ)."),
      mc("Which sentence means 'I go to school'?", "학교에 가요",
        ["학교에서 가요", "학교를 가요", "학교는 가요"],
        "에 marks direction/destination with movement verbs."),
      mc("Which sentence means 'I eat rice'?", "밥을 먹어요",
        ["밥이 먹어요", "밥은 먹어요", "밥에서 먹어요"]),
    ],
    srsItems: vocabSRS(presentTenseExamples.items, "korean_a1_present"),
    skillsTaught: ["korean_present_polite"],
    furiganaLevel: "full",
  },
  {
    id: "2.3",
    unit: "grammar",
    unitIndex: 2,
    title: "Past Tense Polite (-았어요/-었어요)",
    prerequisites: ["2.2"],
    introduction: {
      text: "Past tense follows the same vowel harmony rule: ㅏ/ㅗ stems get -았어요; all others get -었어요. 하다 → 했어요. The past marker -았-/-었- is inserted before -어요.",
      items: introItems(pastTenseExamples.items),
    },
    exercises: [
      ...generateExercises(pastTenseExamples, "recognition"),
      mc("The past marker for ㅏ/ㅗ stems is:", "-았어요", ["-었어요", "-했어요", "-갔어요"],
        "가다 → 갔어요 (가 + 았어요, contracted)."),
      mc("The past marker for most other stems is:", "-었어요", ["-았어요", "-했어요", "-겠어요"]),
      mc("하다 → past polite:", "했어요", ["하었어요", "하았어요", "하요"],
        "하다 contracts irregularly: 하 + 았어요 → 했어요."),
      cloze("오다 past polite:", "왔어요", "오 + 았어요 → 왔어요 (contracted)."),
      cloze("먹다 past polite:", "먹었어요", "먹 + 었어요."),
      mc("Which means 'I went to the hospital'?", "병원에 갔어요",
        ["병원에서 갔어요", "병원을 갔어요", "병원은 갔어요"]),
      mc("Which means 'I drank water'?", "물을 마셨어요",
        ["물이 마셨어요", "물에 마셨어요", "물는 마셨어요"]),
    ],
    srsItems: vocabSRS(pastTenseExamples.items, "korean_a1_past"),
    skillsTaught: ["korean_past_polite"],
    furiganaLevel: "full",
  },

  // ---- Unit 3: Vocabulary ----
  vocabLesson(
    "3.1",
    "Greetings and Politeness",
    ["2.3"],
    ["안녕하세요", "안녕히 가세요", "안녕히 계세요", "감사합니다", "감사해요", "죄송합니다", "괜찮아요", "네", "아니요", "반갑습니다"],
    "These 10 expressions cover every essential polite exchange. 안녕하세요 is the universal polite greeting. Use 안녕히 가세요 when the other person is leaving; 안녕히 계세요 when you are leaving.",
    "greetings",
  ),
  vocabLesson(
    "3.2",
    "Numbers: Sino-Korean and Native",
    ["3.1"],
    ["일", "이", "삼", "사", "오", "육", "칠", "팔", "구", "십", "백", "하나", "둘", "셋", "넷", "다섯"],
    "Korean has two number systems. Sino-Korean (일, 이, 삼…) is used for dates, phone numbers, money, minutes, and floor numbers. Native Korean (하나, 둘, 셋…) is used for counting objects with measure words and telling hours.",
    "numbers",
  ),
  vocabLesson(
    "3.3",
    "Family, Food, Places, Time, and Weather",
    ["3.2"],
    ["가족", "아버지", "어머니", "동생", "밥", "물", "커피", "식당", "학교", "한국", "오늘", "내일", "어제", "지금", "시간", "날씨", "비", "눈", "덥다", "춥다"],
    "This set covers daily-life nouns: family, food and drink, common places, time words, and basic weather. Combine with the particles and verb forms from Unit 2: 오늘 날씨가 어때요? (How's the weather today?)",
    "daily_life",
  ),
  {
    id: "3.4",
    unit: "vocabulary",
    unitIndex: 3,
    title: "A1 Korean Vocabulary Review",
    prerequisites: ["3.3"],
    introduction: {
      text: "Final review across all A1 Korean vocabulary. Practice recognizing meaning, matching words, and producing Hangul from English prompts.",
    },
    exercises: [
      ...generateExercises(content(["안녕하세요", "감사합니다", "네", "아니요", "괜찮아요"]), "recognition"),
      ...generateExercises(content(["오늘", "내일", "어제", "지금", "시간"]), "matching"),
      ...generateExercises(content(["가족", "아버지", "어머니", "친구", "학생"]), "matching"),
      mc("Which word means 'thank you' (formal)?", "감사합니다", ["안녕하세요", "죄송합니다", "괜찮아요"]),
      mc("Which number system do you use to say the price in won?", "Sino-Korean (일, 이, 삼…)", ["Native Korean (하나, 둘, 셋…)", "Either system", "Arabic numerals only"]),
      mc("How do you say 'goodbye' to someone who is leaving?", "안녕히 가세요", ["안녕히 계세요", "안녕하세요", "반갑습니다"]),
      cloze("The Korean word for 'today' is:", "오늘", "오늘 = o·neul"),
      cloze("The Korean word for 'school' is:", "학교", "학교 = hak·gyo"),
    ],
    srsItems: [],
    skillsTaught: ["korean_a1_review"],
    furiganaLevel: "full",
  },
];

export const koreanUnits: Unit[] = [
  {
    index: 1,
    id: "hangul",
    name: "Hangul",
    icon: "ㅎ",
    lessonIds: koreanLessons.filter((l) => l.unit === "hangul").map((l) => l.id),
  },
  {
    index: 2,
    id: "grammar",
    name: "Grammar",
    icon: "문",
    lessonIds: koreanLessons.filter((l) => l.unit === "grammar").map((l) => l.id),
  },
  {
    index: 3,
    id: "vocabulary",
    name: "Vocabulary",
    icon: "어",
    lessonIds: koreanLessons.filter((l) => l.unit === "vocabulary").map((l) => l.id),
  },
];

