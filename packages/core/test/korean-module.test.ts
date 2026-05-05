import { describe, expect, test } from "bun:test";
import { getAllModuleTools, getModule, listModules } from "../../../plugins/tutor/modules/index.ts";
import { koreanModule } from "../../../plugins/tutor/modules/korean/index.ts";
import { koreanLessons, koreanUnits } from "../../../plugins/tutor/modules/korean/lessons/index.ts";
import { koreanA1Vocab } from "../../../plugins/tutor/modules/korean/data/a1-vocab.ts";
import { getModuleLevel, setModule } from "../../../plugins/tutor/core/session.ts";
import { tutorTools } from "../../../plugins/tutor/tools/tutor-tools.ts";
import { isButtonExercise } from "../../../plugins/tutor/core/lesson-types.ts";
import { hangulToRomanization } from "../../../plugins/tutor/modules/korean/romanization.ts";
import { testPluginContext } from "./helpers/plugin-context.ts";

describe("Korean tutor module — registration", () => {
  test("is registered in the module registry", () => {
    expect(getModule("korean")).toBe(koreanModule);
    expect(listModules().map((m) => m.name)).toContain("korean");
  });

  test("exposes A1 level metadata", () => {
    expect(koreanModule.defaultLevel).toBe("A1");
    expect(koreanModule.levels).toContain("A1");
    expect(koreanModule.levels).toContain("A2");
    expect(koreanModule.levels).toContain("B1");
  });

  test("builds a tutor prompt for A1", () => {
    const prompt = koreanModule.buildTutorPrompt!("A1");
    expect(prompt).toContain("Korean language tutor");
    expect(prompt).toContain("Hangul");
    expect(prompt).toContain("particle");
  });

  test("registers convert_hangul tool", () => {
    const toolNames = getAllModuleTools().map((t) => t.definition.name);
    expect(toolNames).toContain("convert_hangul");
  });
});

describe("Korean tutor module — quiz generation", () => {
  test("generates particle and vocab quiz types", () => {
    for (const quizType of koreanModule.quizTypes ?? []) {
      const quiz = koreanModule.generateQuiz!("A1", quizType);
      expect(quiz.question.length).toBeGreaterThan(0);
      expect(quiz.options.length).toBeGreaterThanOrEqual(2);
      expect(quiz.correctIndex).toBeGreaterThanOrEqual(0);
      expect(quiz.correctIndex).toBeLessThan(quiz.options.length);
      expect(quiz.explanation.length).toBeGreaterThan(0);
    }
  });
});

describe("Korean tutor module — dictionary lookup", () => {
  test("finds vocab by Hangul term", async () => {
    const results = await koreanModule.lookup!("안녕하세요");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].word).toBe("안녕하세요");
    expect(results[0].reading).toBe("annyeonghaseyo");
  });

  test("finds vocab by romanization", async () => {
    const results = await koreanModule.lookup!("hakgyo");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].word).toBe("학교");
  });

  test("finds vocab by English meaning", async () => {
    const results = await koreanModule.lookup!("today");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.word === "오늘")).toBe(true);
  });

  test("returns empty for unknown query", async () => {
    const results = await koreanModule.lookup!("xyznotaword");
    expect(results).toEqual([]);
  });
});

describe("Korean lesson catalog", () => {
  test("has exactly 3 units", () => {
    expect(koreanUnits).toHaveLength(3);
    expect(koreanUnits.map((u) => u.name)).toEqual(["Hangul", "Grammar", "Vocabulary"]);
  });

  test("has at least 8 lessons", () => {
    expect(koreanLessons.length).toBeGreaterThanOrEqual(8);
  });

  test("has at least 30 vocab SRS items in vocabulary lessons", () => {
    const srsTerms = koreanLessons
      .filter((l) => l.unit === "vocabulary")
      .flatMap((l) => l.srsItems?.map((item) => item.front) ?? []);
    expect(srsTerms.length).toBeGreaterThanOrEqual(30);
  });

  test("has at least 4 grammar/particle skill tags", () => {
    const skills = koreanLessons.flatMap((l) => l.skillsTaught ?? []);
    const grammarSkills = skills.filter((s) =>
      s.includes("particle") || s.includes("present") || s.includes("past") ||
      s.includes("hangul") || s.includes("grammar")
    );
    expect(grammarSkills.length).toBeGreaterThanOrEqual(4);
  });

  test("all unit lesson IDs resolve to actual lessons", () => {
    const lessonIds = new Set(koreanLessons.map((l) => l.id));
    for (const unit of koreanUnits) {
      for (const lessonId of unit.lessonIds) {
        expect(lessonIds.has(lessonId)).toBe(true);
      }
    }
  });

  test("no orphan lessons (every lesson belongs to a unit)", () => {
    const unitLessonIds = new Set(koreanUnits.flatMap((u) => u.lessonIds));
    const orphans = koreanLessons.filter((l) => !unitLessonIds.has(l.id)).map((l) => l.id);
    expect(orphans).toEqual([]);
  });

  test("no duplicate lesson IDs", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const l of koreanLessons) {
      if (seen.has(l.id)) duplicates.push(l.id);
      seen.add(l.id);
    }
    expect(duplicates).toEqual([]);
  });

  test("all prerequisites resolve to existing lessons", () => {
    const lessonIds = new Set(koreanLessons.map((l) => l.id));
    const missing: string[] = [];
    for (const l of koreanLessons) {
      for (const prereq of l.prerequisites) {
        if (!lessonIds.has(prereq)) missing.push(`${l.id} → ${prereq}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("all lessons are reachable from root lessons through prerequisites", () => {
    const reachable = new Set(
      koreanLessons.filter((l) => l.prerequisites.length === 0).map((l) => l.id)
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const l of koreanLessons) {
        if (reachable.has(l.id)) continue;
        if (l.prerequisites.every((p) => reachable.has(p))) {
          reachable.add(l.id);
          changed = true;
        }
      }
    }
    const unreachable = koreanLessons.map((l) => l.id).filter((id) => !reachable.has(id));
    expect(unreachable).toEqual([]);
  });

  test("every lesson has valid exercises", () => {
    const emptyLessons: string[] = [];
    const emptyAnswers: string[] = [];
    const degenerateButtons: string[] = [];
    const duplicateOptions: string[] = [];
    const selfDistractors: string[] = [];

    for (const lesson of koreanLessons) {
      if (lesson.exercises.length === 0) emptyLessons.push(lesson.id);
      for (const [index, ex] of lesson.exercises.entries()) {
        const ref = `${lesson.id}#${index}`;
        if (ex.answer.trim().length === 0) emptyAnswers.push(ref);
        if (isButtonExercise(ex.type) && (ex.distractors?.length ?? 0) === 0) {
          degenerateButtons.push(ref);
        }
        if (isButtonExercise(ex.type)) {
          const opts = [ex.answer, ...(ex.distractors ?? [])];
          if (new Set(opts).size !== opts.length) duplicateOptions.push(ref);
          if ((ex.distractors ?? []).includes(ex.answer)) selfDistractors.push(ref);
        }
      }
    }

    expect(emptyLessons).toEqual([]);
    expect(emptyAnswers).toEqual([]);
    expect(degenerateButtons).toEqual([]);
    expect(duplicateOptions).toEqual([]);
    expect(selfDistractors).toEqual([]);
  });

  test("production exercises ask for Hangul, not Japanese or hanzi", () => {
    const productionPrompts = koreanLessons
      .flatMap((l) => l.exercises)
      .filter((ex) => ex.type === "production")
      .map((ex) => ex.prompt);

    expect(productionPrompts.length).toBeGreaterThan(0);
    for (const prompt of productionPrompts) {
      expect(prompt).toContain("Hangul");
      expect(prompt).not.toContain("Japanese");
      expect(prompt).not.toContain("hanzi");
    }
  });
});

describe("Korean vocab coverage", () => {
  test("has at least 60 A1 vocab items", () => {
    expect(koreanA1Vocab.length).toBeGreaterThanOrEqual(60);
  });

  test("all vocab items have Hangul term, romanization, and English meaning", () => {
    for (const item of koreanA1Vocab) {
      expect(item.term.length).toBeGreaterThan(0);
      expect(item.reading.length).toBeGreaterThan(0);
      expect(item.meaning.length).toBeGreaterThan(0);
    }
  });
});

describe("Hangul romanization", () => {
  test("romanizes basic syllables correctly", () => {
    expect(hangulToRomanization("나")).toBe("na");
    expect(hangulToRomanization("가")).toBe("ga");
    expect(hangulToRomanization("도")).toBe("do");
    expect(hangulToRomanization("미")).toBe("mi");
  });

  test("romanizes multi-syllable words", () => {
    // 한 = han, 국 = guk
    expect(hangulToRomanization("한국")).toBe("hanguk");
    // 학 = hak, 교 = gyo
    expect(hangulToRomanization("학교")).toBe("hakgyo");
    // 사 = sa, 람 = ram
    expect(hangulToRomanization("사람")).toBe("saram");
  });

  test("passes through non-Hangul characters unchanged", () => {
    expect(hangulToRomanization("A1")).toBe("A1");
    expect(hangulToRomanization("hello")).toBe("hello");
  });
});

describe("Korean set_level tool", () => {
  test("accepts A1/A2/B1 and stores canonical level", async () => {
    const userId = "test-korean-level";
    setModule(userId, "korean", koreanModule.defaultLevel);

    const setLevelTool = tutorTools.find((t) => t.definition.name === "set_level");
    expect(setLevelTool).toBeDefined();

    const result = await setLevelTool!.handler(
      { user_id: userId, level: "a2" },
      testPluginContext
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("A2");
    expect(getModuleLevel(userId, "korean")).toBe("A2");
  });
});
