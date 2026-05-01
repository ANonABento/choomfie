import { describe, expect, test } from "bun:test";
import { scoreExercise } from "../../../plugins/tutor/core/lesson-engine.ts";
import type { Exercise } from "../../../plugins/tutor/core/lesson-types.ts";

describe("lesson-engine scoring", () => {
  test("accepts typed answers without French accents", () => {
    const exercise: Exercise = {
      type: "cloze",
      prompt: "Complete: Combien ça ____ ?",
      answer: "coûte",
    };

    expect(scoreExercise(exercise, "coute").correct).toBe(true);
  });

  test("accepts unaccented ligatures in typed answers", () => {
    const exercise: Exercise = {
      type: "production",
      prompt: 'Type the French for **"sister"**',
      answer: "sœur",
    };

    expect(scoreExercise(exercise, "soeur").correct).toBe(true);
  });
});
