import { describe, expect, test } from "bun:test";
import { getAllModuleTools, getModule, listModules } from "../../../plugins/tutor/modules/index.ts";
import { chineseModule } from "../../../plugins/tutor/modules/chinese/index.ts";
import { getModuleLevel, setModule } from "../../../plugins/tutor/core/session.ts";
import { tutorTools } from "../../../plugins/tutor/tools/tutor-tools.ts";
import { testPluginContext } from "./helpers/plugin-context.ts";

describe("Chinese tutor module", () => {
  test("is registered as a tutor module", () => {
    expect(getModule("chinese")).toBe(chineseModule);
    expect(listModules().map((module) => module.name)).toContain("chinese");
  });

  test("exposes HSK level metadata and tutor prompt", () => {
    expect(chineseModule.defaultLevel).toBe("HSK1");
    expect(chineseModule.levels).toContain("HSK3");

    const prompt = chineseModule.buildTutorPrompt!("HSK1");
    expect(prompt).toContain("Mandarin Chinese tutor");
    expect(prompt).toContain("pinyin");
    expect(prompt).toContain("tone");

    const hsk2Prompt = chineseModule.buildTutorPrompt!("HSK2");
    expect(hsk2Prompt).toContain("Student is ELEMENTARY (HSK 2)");
    expect(hsk2Prompt).not.toContain("COMPLETE BEGINNER");
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

  test("set_level accepts compact HSK aliases and stores canonical level", async () => {
    const userId = "test-chinese-level-alias";
    setModule(userId, "chinese", chineseModule.defaultLevel);

    const setLevelTool = tutorTools.find((tool) => tool.definition.name === "set_level");
    expect(setLevelTool).toBeDefined();

    const result = await setLevelTool!.handler(
      { user_id: userId, level: "hsk2" },
      testPluginContext
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("HSK2");
    expect(getModuleLevel(userId, "chinese")).toBe("HSK2");
  });
});
