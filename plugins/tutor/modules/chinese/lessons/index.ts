/**
 * Chinese lesson registry — HSK 1 foundations organized into tones, hanzi, and vocabulary.
 */

import type { Lesson, Unit } from "../../../core/lesson-types.ts";
import { generateExercises, type ContentSet } from "../../../core/exercise-generator.ts";
import { hsk1ByTerms, hsk1Vocab } from "../data/hsk1-vocab.ts";
import { cloze, introItems, mc, vocabSRS } from "../../../core/lesson-helpers.ts";

function content(terms: string[]): ContentSet {
  return { items: hsk1ByTerms(terms), productionLabel: "hanzi" };
}

function vocabularyLesson(
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
    srsItems: vocabSRS(lessonContent.items, `hsk1_${skill}`),
    skillsTaught: [`hsk1_${skill}`],
    furiganaLevel: "full",
  };
}

const tonePairContent: ContentSet = {
  items: [
    { term: "妈", reading: "ma1", meaning: "mother; first tone" },
    { term: "麻", reading: "ma2", meaning: "hemp; second tone" },
    { term: "马", reading: "ma3", meaning: "horse; third tone" },
    { term: "骂", reading: "ma4", meaning: "to scold; fourth tone" },
    { term: "吗", reading: "ma", meaning: "question particle; neutral tone" },
  ],
};

const numberContent = content(["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]);
const peopleHanziContent = content(["人", "你", "我", "他", "她", "爸爸", "妈妈", "老师", "学生", "朋友"]);
const placeHanziContent = content(["中国", "北京", "学校", "医院", "商店", "家", "里", "上", "下", "前面", "后面"]);
const tonePatternContent = content(["学生", "朋友", "谢谢", "老师", "中国", "天气"]);

export const chineseLessons: Lesson[] = [
  {
    id: "1.1",
    unit: "tones",
    unitIndex: 1,
    title: "Four Mandarin Tones",
    prerequisites: [],
    introduction: {
      text: "Mandarin syllables carry tone. HSK 1 vocabulary uses tone-marked pinyin or tone numbers: ma1 is high and level, ma2 rises, ma3 dips, and ma4 falls sharply.",
      items: [
        { word: "mā / ma1", reading: "high level", meaning: "first tone" },
        { word: "má / ma2", reading: "rising", meaning: "second tone" },
        { word: "mǎ / ma3", reading: "low dipping", meaning: "third tone" },
        { word: "mà / ma4", reading: "falling", meaning: "fourth tone" },
      ],
    },
    exercises: [
      mc("Which pinyin marks the high, level first tone?", "ma1", ["ma2", "ma3", "ma4"]),
      mc("Which pinyin marks the rising second tone?", "ma2", ["ma1", "ma3", "ma4"]),
      mc("Which pinyin marks the low dipping third tone?", "ma3", ["ma1", "ma2", "ma4"]),
      mc("Which pinyin marks the sharp falling fourth tone?", "ma4", ["ma1", "ma2", "ma3"]),
      cloze("Type the tone number for **mā**.", "1", "Use 1, 2, 3, or 4."),
      cloze("Type the tone number for **má**.", "2", "Use 1, 2, 3, or 4."),
      cloze("Type the tone number for **mǎ**.", "3", "Use 1, 2, 3, or 4."),
      cloze("Type the tone number for **mà**.", "4", "Use 1, 2, 3, or 4."),
      mc("In HSK 1 pinyin, what does the number in **hao3** show?", "the tone", ["the stroke count", "the word order", "the volume"]),
      mc("Which HSK 1 word is pronounced with third tone?", "好 (hao3)", ["吃 (chi1)", "茶 (cha2)", "去 (qu4)"]),
    ],
    srsItems: [],
    skillsTaught: ["mandarin_tones"],
    furiganaLevel: "full",
  },
  {
    id: "1.2",
    unit: "tones",
    unitIndex: 1,
    title: "Neutral Tone and Tone Changes",
    prerequisites: ["1.1"],
    introduction: {
      text: "Some common syllables are light and unstressed. They are written without a tone number here, like ma in 吗 or zi in 杯子. The word 不 is fourth tone alone, but becomes bu2 before another fourth tone.",
      items: introItems(tonePairContent.items),
    },
    exercises: [
      ...generateExercises(tonePairContent, "recognition"),
      mc("Which word has a neutral-tone final syllable?", "杯子 (bei1zi)", ["北京 (Bei3jing1)", "学生 (xue2sheng)", "中国 (Zhong1guo2)"]),
      mc("Before a fourth-tone syllable, 不 is commonly pronounced:", "bu2", ["bu1", "bu3", "bu4"]),
      cloze("Type the pinyin for **不客气** using tone numbers.", "bu2 ke4qi", "不 changes before 客.", undefined, ["bu2ke4qi"]),
      cloze("Type the pinyin for **妈妈** using tone numbers.", "ma1ma", "The second syllable is neutral.", undefined, ["ma1 ma"]),
      mc("Which particle is neutral tone in questions?", "吗", ["去", "热", "看"]),
    ],
    srsItems: [],
    skillsTaught: ["neutral_tone", "tone_sandhi"],
    furiganaLevel: "full",
  },
  {
    id: "1.3",
    unit: "tones",
    unitIndex: 1,
    title: "Tone Listening Patterns",
    prerequisites: ["1.2"],
    introduction: {
      text: "HSK 1 words often combine two syllables. Practice reading tone-number patterns aloud: xue2sheng is rising-neutral, peng2you is rising-neutral, and xie4xie is falling-neutral.",
      items: introItems(tonePatternContent.items),
    },
    exercises: [
      ...generateExercises(tonePatternContent, "recognition"),
      cloze("Type the pinyin for **学生**.", "xue2sheng", "Rising tone plus neutral tone.", undefined, ["xue2 sheng"]),
      cloze("Type the pinyin for **谢谢**.", "xie4xie", "Falling tone plus neutral tone.", undefined, ["xie4 xie"]),
      mc("Which word has the tone pattern 2-neutral?", "朋友 (peng2you)", ["中国 (Zhong1guo2)", "天气 (tian1qi4)", "老师 (lao3shi1)"]),
      mc("Which word has two first-tone syllables?", "今天 (jin1tian1)", ["明天 (ming2tian1)", "昨天 (zuo2tian1)", "学生 (xue2sheng)"]),
    ],
    srsItems: [],
    skillsTaught: ["tone_pairs"],
    furiganaLevel: "full",
  },
  {
    id: "2.1",
    unit: "hanzi",
    unitIndex: 2,
    title: "Number Hanzi",
    prerequisites: ["1.3"],
    introduction: {
      text: "Start hanzi with numbers. These characters appear constantly in HSK 1 for dates, prices, ages, and counting.",
      items: introItems(numberContent.items),
    },
    exercises: [
      ...generateExercises(numberContent, "recognition"),
      cloze("一、二、三、___、五", "四", "Fill in four.", undefined, ["si4"]),
      cloze("六、七、八、九、___", "十", "Fill in ten.", undefined, ["shi2"]),
      mc("Which character means eight?", "八", ["六", "七", "九"]),
      mc("Which character means ten?", "十", ["一", "二", "三"]),
    ],
    srsItems: [],
    skillsTaught: ["number_hanzi"],
    furiganaLevel: "full",
  },
  {
    id: "2.2",
    unit: "hanzi",
    unitIndex: 2,
    title: "People Hanzi",
    prerequisites: ["2.1"],
    introduction: {
      text: "These people words combine high-frequency characters with common family and school vocabulary.",
      items: introItems(peopleHanziContent.items),
    },
    exercises: [
      ...generateExercises(peopleHanziContent, "recognition"),
      ...generateExercises(peopleHanziContent, "production").slice(0, 3),
      mc("Which word means teacher?", "老师", ["学生", "朋友", "同学"]),
      mc("Which two pronouns share the same pronunciation ta1?", "他 and 她", ["我 and 你", "人 and 儿子", "爸爸 and 妈妈"]),
    ],
    srsItems: [],
    skillsTaught: ["people_hanzi"],
    furiganaLevel: "full",
  },
  {
    id: "2.3",
    unit: "hanzi",
    unitIndex: 2,
    title: "Place and Direction Hanzi",
    prerequisites: ["2.2"],
    introduction: {
      text: "Place and direction characters let you talk about where things are: home, school, China, Beijing, inside, on, under, in front, and behind.",
      items: introItems(placeHanziContent.items),
    },
    exercises: [
      ...generateExercises(placeHanziContent, "recognition"),
      ...generateExercises(placeHanziContent, "production").slice(0, 3),
      mc("Which word means China?", "中国", ["北京", "学校", "医院"]),
      mc("Which word means behind?", "后面", ["前面", "上", "下"]),
    ],
    srsItems: [],
    skillsTaught: ["place_hanzi"],
    furiganaLevel: "full",
  },
  vocabularyLesson(
    "3.1",
    "People and Pronouns",
    ["2.3"],
    ["你", "我", "我们", "他", "她", "人", "爸爸", "妈妈", "儿子", "女儿", "朋友", "老师", "同学", "学生", "先生", "小姐"],
    "Begin HSK 1 vocabulary with people words. Pronouns and family terms make simple introductions possible right away.",
    "people",
  ),
  vocabularyLesson(
    "3.2",
    "Greetings and Politeness",
    ["3.1"],
    ["叫", "名字", "认识", "喂", "请", "谢谢", "不客气", "对不起", "没关系", "再见", "爱", "喜欢"],
    "These words support basic conversation: names, greetings, thanks, apologies, and simple likes.",
    "greetings",
  ),
  vocabularyLesson(
    "3.3",
    "Numbers, Money, and Measures",
    ["3.2"],
    ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "几", "多少", "个", "本", "块", "钱", "点", "分钟"],
    "HSK 1 uses numbers with measure words for prices, time, quantities, and basic counting.",
    "numbers",
  ),
  vocabularyLesson(
    "3.4",
    "Time and Weather",
    ["3.3"],
    ["今天", "明天", "昨天", "上午", "中午", "下午", "现在", "时候", "年", "月", "号", "星期", "天气", "下雨", "岁"],
    "This set covers days, dates, age, time of day, and the weather vocabulary needed for simple plans.",
    "time_weather",
  ),
  vocabularyLesson(
    "3.5",
    "Food and Drink",
    ["3.4"],
    ["吃", "喝", "水", "茶", "米饭", "菜", "水果", "苹果", "饭店", "杯子", "热", "冷"],
    "Food and drink words combine naturally with 吃 and 喝 so students can describe basic needs and preferences.",
    "food_drink",
  ),
  vocabularyLesson(
    "3.6",
    "Places and Objects",
    ["3.5"],
    ["家", "学校", "医院", "商店", "北京", "中国", "出租车", "飞机", "电脑", "电视", "电影", "东西", "书", "椅子", "桌子", "衣服"],
    "These nouns cover everyday places, transport, media, and classroom or home objects.",
    "places_objects",
  ),
  vocabularyLesson(
    "3.7",
    "Common Actions",
    ["3.6"],
    ["去", "来", "回", "住", "坐", "做", "工作", "学习", "读", "写", "看", "看见", "听", "说话", "买", "开", "睡觉"],
    "This action set gives students verbs for movement, study, communication, shopping, and daily routines.",
    "actions",
  ),
  vocabularyLesson(
    "3.8",
    "Questions and Particles",
    ["3.7"],
    ["什么", "哪", "哪儿", "那", "这", "怎么", "怎么样", "吗", "呢", "的", "了", "在", "里", "和", "是"],
    "Question words and particles are small but essential. They turn vocabulary into useful HSK 1 sentences.",
    "questions_particles",
  ),
  vocabularyLesson(
    "3.9",
    "Descriptions and Amounts",
    ["3.8"],
    ["好", "很", "高兴", "漂亮", "大", "小", "多", "少", "太", "一点儿", "都", "些", "有", "没有", "不"],
    "Use these words to describe people, things, amounts, and possession in simple sentences.",
    "descriptions_amounts",
  ),
  vocabularyLesson(
    "3.10",
    "Ability, Position, and Services",
    ["3.9"],
    ["会", "能", "想", "前面", "后面", "上", "下", "打电话", "谁", "医生"],
    "This lesson combines ability, wants, position words, and service vocabulary used in everyday HSK 1 exchanges.",
    "ability_position",
  ),
  vocabularyLesson(
    "3.11",
    "Animals and Language",
    ["3.10"],
    ["狗", "猫", "汉语", "字"],
    "Finish the new HSK 1 list with animals and the language/character words 汉语 and 字.",
    "animals_language",
  ),
  {
    id: "3.12",
    unit: "vocabulary",
    unitIndex: 3,
    title: "HSK 1 Vocabulary Review",
    prerequisites: ["3.11"],
    introduction: {
      text: "This final HSK 1 lesson mixes words from the full 150-word list. Review by recognizing meanings, matching common words, and producing core vocabulary from memory.",
    },
    exercises: [
      ...generateExercises(content(["你", "好", "中国", "汉语", "学习"]), "recognition"),
      ...generateExercises(content(["今天", "明天", "昨天", "现在", "学校"]), "matching"),
      ...generateExercises(content(["谢谢", "再见", "对不起", "没关系", "不客气"]), "matching"),
      cloze("Type the hanzi for **Chinese language**.", "汉语", undefined, undefined, ["Han4yu3"]),
      cloze("Type the hanzi for **to study**.", "学习", undefined, undefined, ["xue2xi2"]),
      mc("Which phrase means you're welcome?", "不客气", ["对不起", "没关系", "谢谢"]),
      mc("Which word asks where?", "哪儿", ["哪", "那", "这"]),
    ],
    srsItems: [],
    skillsTaught: ["hsk1_review"],
    furiganaLevel: "full",
  },
];

export const chineseUnits: Unit[] = [
  {
    index: 1,
    id: "tones",
    name: "Tones",
    icon: "🎵",
    lessonIds: chineseLessons.filter((lesson) => lesson.unit === "tones").map((lesson) => lesson.id),
  },
  {
    index: 2,
    id: "hanzi",
    name: "Hanzi",
    icon: "字",
    lessonIds: chineseLessons.filter((lesson) => lesson.unit === "hanzi").map((lesson) => lesson.id),
  },
  {
    index: 3,
    id: "vocabulary",
    name: "HSK 1 Vocabulary",
    icon: "📘",
    lessonIds: chineseLessons.filter((lesson) => lesson.unit === "vocabulary").map((lesson) => lesson.id),
  },
];

export const chineseHsk1VocabularyItems = hsk1Vocab;
