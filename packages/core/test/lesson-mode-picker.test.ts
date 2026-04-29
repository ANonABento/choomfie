import { describe, expect, test } from "bun:test";
import {
  buildModePickerComponents,
  lessonSupportsModePicker,
  setSessionMode,
  type ActiveLessonSession,
} from "../../../plugins/tutor/lesson-interactions.ts";
import type { Lesson } from "../../../plugins/tutor/core/lesson-types.ts";
import { LessonDB } from "../../../plugins/tutor/core/lesson-db.ts";
import { registerLessons, completeLesson } from "../../../plugins/tutor/core/lesson-engine.ts";

const baseLesson: Lesson = {
  id: "mode.1",
  unit: "test",
  unitIndex: 1,
  title: "Mode lesson",
  prerequisites: [],
  introduction: { text: "intro" },
  exercises: [
    {
      type: "multiple_choice",
      prompt: "Pick one",
      answer: "yes",
      distractors: ["no"],
    },
  ],
};

function makeSession(lesson: Lesson): ActiveLessonSession {
  return {
    userId: "u1",
    module: "japanese",
    lessonId: lesson.id,
    exerciseIndex: 3,
    lesson,
    exercises: lesson.exercises,
    answerOptionsByExercise: new Map([[0, new Map([["0", "stale"]])]]),
  };
}

describe("lesson mode picker helpers", () => {
  test("lessons without selectable generated content skip the mode picker", () => {
    expect(lessonSupportsModePicker(baseLesson)).toBe(false);
    expect(buildModePickerComponents(baseLesson)).toEqual([]);
  });

  test("lessons with selectable generated content render one button per mode", () => {
    const lesson: Lesson = {
      ...baseLesson,
      contentSets: [
        {
          items: [
            { term: "あ", reading: "a", meaning: "a" },
            { term: "い", reading: "i", meaning: "i" },
          ],
        },
      ],
      selectableModes: ["recognition", "production", "matching", "mixed"],
    };

    const rows = buildModePickerComponents(lesson);
    const components = rows[0].toJSON().components as Array<{ custom_id: string; label: string }>;

    expect(lessonSupportsModePicker(lesson)).toBe(true);
    expect(components.map((component) => component.custom_id)).toEqual([
      "lesson:mode:mode.1:recognition",
      "lesson:mode:mode.1:production",
      "lesson:mode:mode.1:matching",
      "lesson:mode:mode.1:mixed",
    ]);
  });

  test("mode selection resets progress state and stores exact generated exercises", () => {
    const lesson: Lesson = {
      ...baseLesson,
      contentSets: [
        {
          items: [
            { term: "あ", reading: "a", meaning: "a" },
            { term: "い", reading: "i", meaning: "i" },
          ],
        },
      ],
      selectableModes: ["recognition", "production", "matching", "mixed"],
    };
    const session = makeSession(lesson);

    setSessionMode(session, "matching");

    expect(session.exerciseIndex).toBe(0);
    expect(session.answerOptionsByExercise.size).toBe(0);
    expect(session.exercises).toHaveLength(2);
    expect(session.exercises.every((exercise) => exercise.type === "matching")).toBe(true);
  });

  test("completion scoring uses the selected generated exercise count", () => {
    const lesson: Lesson = {
      ...baseLesson,
      id: "mode.generated",
      exercises: [baseLesson.exercises[0]],
      contentSets: [
        {
          items: [
            { term: "あ", reading: "a", meaning: "a" },
            { term: "い", reading: "i", meaning: "i" },
          ],
        },
      ],
      selectableModes: ["matching"],
    };
    const session = makeSession(lesson);
    setSessionMode(session, "matching");

    registerLessons("mode-test", [lesson], []);
    const db = new LessonDB(":memory:");
    db.ensureLesson(session.userId, "mode-test", lesson.id);
    db.startLesson(session.userId, "mode-test", lesson.id);

    db.saveExerciseResult(session.userId, "mode-test", lesson.id, 0, {
      index: 0,
      correct: true,
      userAnswer: session.exercises[0].answer,
    });
    db.saveExerciseResult(session.userId, "mode-test", lesson.id, 1, {
      index: 1,
      correct: true,
      userAnswer: session.exercises[1].answer,
    });

    const result = completeLesson(
      db,
      session.userId,
      "mode-test",
      lesson.id,
      session.lesson
    );

    expect(result.totalExercises).toBe(2);
    expect(result.totalCorrect).toBe(2);
    expect(result.score).toBe(1);
    expect(result.passed).toBe(true);
    db.close();
  });
});
