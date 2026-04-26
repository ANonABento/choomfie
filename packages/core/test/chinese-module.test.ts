import { describe, expect, test } from "bun:test";
import { getAllModuleTools, getModule, listModules } from "../../../plugins/tutor/modules/index.ts";
import { chineseModule } from "../../../plugins/tutor/modules/chinese/index.ts";

describe("Chinese tutor module", () => {
  test("is registered as a tutor module", () => {
    expect(getModule("chinese")).toBe(chineseModule);
    expect(listModules().map((module) => module.name)).toContain("chinese");
  });

  test("exposes HSK level metadata and tutor prompt", () => {
    expect(chineseModule.defaultLevel).toBe("HSK 1");
    expect(chineseModule.levels).toContain("HSK 6");

    const prompt = chineseModule.buildTutorPrompt!("HSK 1");
    expect(prompt).toContain("Mandarin Chinese tutor");
    expect(prompt).toContain("pinyin");
    expect(prompt).toContain("tone");
  });

  test("generates basic quiz types", () => {
    for (const quizType of chineseModule.quizTypes ?? []) {
      const quiz = chineseModule.generateQuiz!("HSK 1", quizType);
      expect(quiz.question.length).toBeGreaterThan(0);
      expect(quiz.options.length).toBeGreaterThanOrEqual(2);
      expect(quiz.correctIndex).toBeGreaterThanOrEqual(0);
      expect(quiz.correctIndex).toBeLessThan(quiz.options.length);
    }
  });

  test("registers Chinese-specific tools", () => {
    const toolNames = getAllModuleTools().map((tool) => tool.definition.name);

    expect(toolNames).toContain("convert_pinyin");
    expect(toolNames).toContain("stroke_info");
    expect(toolNames).toContain("convert_hanzi");
  });
});
