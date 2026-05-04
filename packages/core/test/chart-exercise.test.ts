import { describe, expect, test } from "bun:test";
import { expandExercisesForSession, buildExerciseButtons, type ActiveLessonSession } from "../../../plugins/tutor/lesson-interactions.ts";
import { chartReview } from "../../../plugins/tutor/modules/japanese/lessons/kana-helpers.ts";
import type { Lesson } from "../../../plugins/tutor/core/lesson-types.ts";

const lesson: Lesson = {
  id: "chart.1",
  unit: "test",
  unitIndex: 1,
  title: "Chart lesson",
  prerequisites: [],
  introduction: { text: "intro" },
  exercises: [],
};

describe("chart exercise runtime expansion", () => {
  test("chartReview stores structured chart data with ordered blanks", () => {
    const exercise = chartReview([
      ["あ", "a"],
      ["い", "i"],
      ["う", "u"],
      ["え", "e"],
      ["お", "o"],
      ["か", "ka"],
    ]);

    expect(exercise.type).toBe("chart");
    expect(exercise.chart?.blanks.length).toBeGreaterThan(0);
    expect(exercise.chart?.blanks[0].answer).toBe(exercise.answer);
    expect(exercise.prompt).toContain("__");
  });

  test("expanded chart answers use chart custom IDs without raw answers", () => {
    const exercise = chartReview([
      ["あ", "a"],
      ["い", "i"],
      ["う", "u"],
      ["え", "e"],
      ["お", "o"],
      ["か", "ka"],
    ]);
    const expanded = expandExercisesForSession([exercise]);
    const session: ActiveLessonSession = {
      userId: "u1",
      module: "japanese",
      lessonId: lesson.id,
      exerciseIndex: 0,
      lesson,
      exercises: expanded,
      answerOptionsByExercise: new Map(),
    };

    const rows = buildExerciseButtons(expanded[0], lesson.id, 0, session);
    const components = rows[0].toJSON().components as Array<{ custom_id: string }>;

    expect(components.length).toBeGreaterThan(0);
    for (const component of components) {
      expect(component.custom_id.startsWith("lesson:chart:chart.1:0:0:")).toBe(true);
      expect(component.custom_id).not.toContain(expanded[0].answer);
      expect(component.custom_id.length).toBeLessThanOrEqual(100);
    }
  });
});
