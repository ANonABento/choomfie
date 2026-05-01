import { describe, expect, test } from "bun:test";
import { getAllModuleTools, getModule, listModules } from "../../../plugins/tutor/modules/index.ts";
import { japaneseModule } from "../../../plugins/tutor/modules/japanese/index.ts";
import { getActiveModule, getModuleLevel } from "../../../plugins/tutor/core/session.ts";
import { moduleTools } from "../../../plugins/tutor/tools/module-tools.ts";
import { testPluginContext } from "./helpers/plugin-context.ts";

describe("Japanese tutor module", () => {
  test("is registered as a tutor module", () => {
    expect(getModule("japanese")).toBe(japaneseModule);
    expect(listModules().map((module) => module.name)).toContain("japanese");
  });

  test("exposes N5 metadata and tutor prompt", () => {
    expect(japaneseModule.defaultLevel).toBe("N5");
    expect(japaneseModule.levels).toContain("N5");

    const prompt = japaneseModule.buildTutorPrompt!("N5");
    expect(prompt).toContain("Japanese language tutor");
    expect(prompt).toContain("furigana");
    expect(prompt).toContain("hiragana");
  });

  test("generates basic quiz types", () => {
    for (const quizType of japaneseModule.quizTypes ?? []) {
      const quiz = japaneseModule.generateQuiz!("N5", quizType);
      expect(quiz.question.length).toBeGreaterThan(0);
      expect(quiz.options.length).toBeGreaterThanOrEqual(2);
      expect(quiz.correctIndex).toBeGreaterThanOrEqual(0);
      expect(quiz.correctIndex).toBeLessThan(quiz.options.length);
    }
  });

  test("registers Japanese-specific tools", () => {
    const toolNames = getAllModuleTools().map((tool) => tool.definition.name);

    expect(toolNames).toContain("convert_kana");
    expect(toolNames).toContain("kanji_stroke_info");
  });

  test("switch_module selects Japanese with the default N5 level", async () => {
    const switchModuleTool = moduleTools.find((tool) => tool.definition.name === "switch_module");
    expect(switchModuleTool).toBeDefined();

    const userId = "test-switch-japanese";
    const result = await switchModuleTool!.handler(
      { user_id: userId, module: "japanese" },
      testPluginContext
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Japanese");
    expect(getActiveModule(userId)).toBe("japanese");
    expect(getModuleLevel(userId, "japanese")).toBe("N5");
  });
});
