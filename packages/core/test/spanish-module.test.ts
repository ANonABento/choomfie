import { describe, expect, test } from "bun:test";
import type { PluginContext } from "@choomfie/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LessonDB } from "../../../plugins/tutor/core/lesson-db.ts";
import { registerLessons } from "../../../plugins/tutor/core/lesson-engine.ts";
import { setLessonDB } from "../../../plugins/tutor/core/lesson-db-instance.ts";
import { spanishLessons, spanishUnits } from "../../../plugins/tutor/modules/spanish/lessons/index.ts";
import { getAllModuleTools, getModule, listModules } from "../../../plugins/tutor/modules/index.ts";
import { spanishModule } from "../../../plugins/tutor/modules/spanish/index.ts";
import { spanishTools } from "../../../plugins/tutor/modules/spanish/tools.ts";
import { spanishToIpa } from "../../../plugins/tutor/modules/spanish/pronunciation.ts";
import { lessonTools } from "../../../plugins/tutor/tools/lesson-tools.ts";
import { moduleTools } from "../../../plugins/tutor/tools/module-tools.ts";

const emptyContext = {} as PluginContext;

describe("Spanish tutor module", () => {
  test("is registered as a tutor module", () => {
    expect(getModule("spanish")).toBe(spanishModule);
    expect(listModules().map((module) => module.name)).toContain("spanish");
  });

  test("exposes A1 level metadata and tutor prompt", () => {
    expect(spanishModule.defaultLevel).toBe("A1");
    expect(spanishModule.levels).toContain("B1");

    const prompt = spanishModule.buildTutorPrompt!("A1");
    expect(prompt).toContain("Spanish language tutor");
    expect(prompt).toContain("CEFR A1");
    expect(prompt).toContain("pronunciation");
  });

  test("generates basic quiz types", () => {
    for (const quizType of spanishModule.quizTypes ?? []) {
      const quiz = spanishModule.generateQuiz!("A1", quizType);
      expect(quiz.question.length).toBeGreaterThan(0);
      expect(quiz.options.length).toBeGreaterThanOrEqual(2);
      expect(quiz.correctIndex).toBeGreaterThanOrEqual(0);
      expect(quiz.correctIndex).toBeLessThan(quiz.options.length);
    }
  });

  test("registers Spanish-specific pronunciation tool", () => {
    const toolNames = getAllModuleTools().map((tool) => tool.definition.name);

    expect(toolNames).toContain("spanish_pronunciation");
  });

  test("pronunciation tool rejects blank input", async () => {
    const pronunciationTool = spanishTools.find((tool) => tool.definition.name === "spanish_pronunciation");
    expect(pronunciationTool).toBeDefined();

    const result = await pronunciationTool!.handler({ text: "   " }, emptyContext);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("non-empty string");
  });

  test("switch_module spanish makes lesson_status report Spanish progress", async () => {
    registerLessons("spanish", spanishLessons, spanishUnits);
    const userId = "spanish-module-test-user";
    const dir = mkdtempSync(join(tmpdir(), "spanish-module-"));
    const db = new LessonDB(join(dir, "lessons.db"));
    setLessonDB(db);

    try {
      const switchModule = moduleTools.find((tool) => tool.definition.name === "switch_module")!;
      const switchResult = await switchModule.handler(
        { user_id: userId, module: "SPANISH" },
        emptyContext,
      );
      expect(switchResult.isError).toBeUndefined();
      expect(switchResult.content[0].text).toContain("**Spanish**");
      expect(switchResult.content[0].text).toContain("A1");

      const lessonStatus = lessonTools.find((tool) => tool.definition.name === "lesson_status")!;
      const statusResult = await lessonStatus.handler({ user_id: userId }, emptyContext);
      expect(statusResult.isError).toBeUndefined();
      expect(statusResult.content[0].text).toContain("**Spanish Progress**");
      expect(statusResult.content[0].text).toContain("Pronunciation");
      expect(statusResult.content[0].text).toContain("0/17 lessons completed");
      expect(statusResult.content[0].text).toContain("Next:** Lesson 1.1");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("generates practical IPA for basic words", () => {
    expect(spanishToIpa("hola")).toBe("ˈola");
    expect(spanishToIpa("gracias")).toBe("ˈɡɾasjas");
    expect(spanishToIpa("niño")).toBe("ˈni.ɲo");
  });
});
