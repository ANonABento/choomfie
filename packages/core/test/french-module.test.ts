import { describe, expect, test } from "bun:test";
import { getModule, listModules } from "../../../plugins/tutor/modules/index.ts";
import { frenchModule } from "../../../plugins/tutor/modules/french/index.ts";

describe("French tutor module", () => {
  test("is registered as a tutor module", () => {
    expect(getModule("french")).toBe(frenchModule);
    expect(listModules().map((module) => module.name)).toContain("french");
  });

  test("exposes A1 level metadata and tutor prompt", () => {
    expect(frenchModule.defaultLevel).toBe("A1");
    expect(frenchModule.levels).toContain("A1");

    const prompt = frenchModule.buildTutorPrompt!("A1");
    expect(prompt).toContain("French language tutor");
    expect(prompt).toContain("liaison");
    expect(prompt).toContain("silent final letters");
  });

  test("looks up A1 vocabulary", async () => {
    const results = await frenchModule.lookup!("bonjour");

    expect(results[0]?.word).toBe("bonjour");
    expect(results[0]?.level).toBe("A1");
  });

  test("generates basic quiz types", () => {
    for (const quizType of frenchModule.quizTypes ?? []) {
      const quiz = frenchModule.generateQuiz!("A1", quizType);
      expect(quiz.question.length).toBeGreaterThan(0);
      expect(quiz.options.length).toBeGreaterThanOrEqual(2);
      expect(quiz.correctIndex).toBeGreaterThanOrEqual(0);
      expect(quiz.correctIndex).toBeLessThan(quiz.options.length);
    }
  });
});
