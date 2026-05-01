/**
 * Unit 5: Basic Kanji — 50 early JLPT N5 kanji.
 */

import type { Exercise, Lesson, LessonSRSItem } from "../../../core/lesson-types.ts";
import { BASIC_N5_KANJI, type KanjiInfo } from "../kanji.ts";
import { mc } from "./phrase-helpers.ts";

function srsItems(items: KanjiInfo[]): LessonSRSItem[] {
  return items.map((item) => ({
    front: item.character,
    back: item.meaning,
    reading: [item.onyomi, item.kunyomi].filter(Boolean).join("; "),
    tags: "kanji n5",
  }));
}

function meaningExercise(item: KanjiInfo, pool: KanjiInfo[]): Exercise {
  return mc(
    `What does **${item.character}** mean?`,
    item.meaning,
    pool.filter((other) => other.character !== item.character).slice(0, 3).map((other) => other.meaning),
    `${item.character} means ${item.meaning}. It has ${item.strokes} strokes and radical ${item.radical}.`,
  );
}

function readingExercise(item: KanjiInfo, pool: KanjiInfo[]): Exercise {
  const answer = item.kunyomi ?? item.onyomi ?? "";
  return mc(
    `Which reading is associated with **${item.character}**?`,
    answer,
    pool
      .filter((other) => other.character !== item.character)
      .map((other) => other.kunyomi ?? other.onyomi ?? "")
      .filter((reading) => reading && reading !== answer)
      .slice(0, 3),
    `${item.character}: on-reading ${item.onyomi ?? "none listed"}, kun-reading ${item.kunyomi ?? "none listed"}.`,
  );
}

function productionExercise(item: KanjiInfo): Exercise {
  return {
    type: "production",
    prompt: `Type the kanji for **${item.meaning}** (${item.kunyomi ?? item.onyomi})`,
    answer: item.character,
  };
}

function buildLesson(index: number, title: string, items: KanjiInfo[], prerequisite: string): Lesson {
  const pool = BASIC_N5_KANJI.filter((item) => !items.some((current) => current.character === item.character));
  return {
    id: `5.${index}`,
    unit: "kanji",
    unitIndex: 5,
    title,
    prerequisites: [prerequisite],
    introduction: {
      text: "Kanji are characters that carry meaning. Learn each character with its meaning, readings, stroke count, and radical.",
      items: items.map((item) => ({
        char: item.character,
        reading: [item.onyomi, item.kunyomi].filter(Boolean).join("; "),
        meaning: `${item.meaning} (${item.strokes} strokes, radical ${item.radical})`,
      })),
    },
    exercises: [
      ...items.slice(0, 5).map((item) => meaningExercise(item, pool)),
      ...items.slice(5, 8).map((item) => readingExercise(item, pool)),
      ...items.slice(8, 10).map(productionExercise),
    ],
    srsItems: srsItems(items),
    skillsTaught: ["basic_kanji", `basic_kanji_${index}`],
    furiganaLevel: "full",
  };
}

export const kanjiLessons: Lesson[] = [
  buildLesson(1, "Numbers & People Kanji", BASIC_N5_KANJI.slice(0, 10), "4.6"),
  buildLesson(2, "Amounts & Calendar Kanji", BASIC_N5_KANJI.slice(10, 20), "5.1"),
  buildLesson(3, "Time & Question Kanji", BASIC_N5_KANJI.slice(20, 30), "5.2"),
  buildLesson(4, "Direction & Action Kanji", BASIC_N5_KANJI.slice(30, 40), "5.3"),
  buildLesson(5, "Study & Daily Verb Kanji", BASIC_N5_KANJI.slice(40, 50), "5.4"),
];
