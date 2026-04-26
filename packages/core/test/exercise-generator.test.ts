/**
 * Tests for the exercise generator — pure logic, no DB or Discord deps.
 */
import { test, expect, describe } from "bun:test";
import {
  generateExercises,
  generateAllExercises,
  type ContentItem,
  type ContentSet,
} from "../../../plugins/tutor/core/exercise-generator.ts";

const SAMPLE: ContentItem[] = [
  { term: "あ", reading: "a", meaning: "a (vowel)" },
  { term: "い", reading: "i", meaning: "i (vowel)" },
  { term: "う", reading: "u", meaning: "u (vowel)" },
  { term: "え", reading: "e", meaning: "e (vowel)" },
];

describe("exercise-generator", () => {
  test("recognition: one exercise per item, distractors drawn from set", () => {
    const ex = generateExercises({ items: SAMPLE }, "recognition");
    expect(ex.length).toBe(SAMPLE.length);
    for (const e of ex) {
      expect(e.type).toBe("recognition");
      expect(e.distractors?.length).toBeGreaterThan(0);
      // Distractors must not include the answer
      expect(e.distractors).not.toContain(e.answer);
      // All distractors must be from the same content set
      for (const d of e.distractors ?? []) {
        expect(SAMPLE.map((s) => s.meaning)).toContain(d);
      }
    }
  });

  test("recognition with 3 items has 2 distractors max", () => {
    const set: ContentSet = { items: SAMPLE.slice(0, 3) };
    const ex = generateExercises(set, "recognition");
    expect(ex.length).toBe(3);
    for (const e of ex) {
      expect(e.distractors?.length).toBeLessThanOrEqual(2);
    }
  });

  test("production: includes reading in accept[]", () => {
    const ex = generateExercises({ items: SAMPLE }, "production");
    expect(ex.length).toBe(SAMPLE.length);
    for (let i = 0; i < ex.length; i++) {
      expect(ex[i].type).toBe("production");
      expect(ex[i].answer).toBe(SAMPLE[i].term);
      expect(ex[i].accept).toContain(SAMPLE[i].reading);
    }
  });

  test("production: uses custom content label when provided", () => {
    const ex = generateExercises(
      {
        items: [{ term: "你好", reading: "ni3 hao3", meaning: "hello" }],
        productionLabel: "hanzi",
      },
      "production"
    );

    expect(ex[0].prompt).toBe('Type the hanzi for **"hello"**');
  });

  test("matching: groups items in chunks of <=5 and yields one exercise per item", () => {
    const items: ContentItem[] = [];
    for (let i = 0; i < 8; i++) {
      items.push({ term: `t${i}`, reading: `r${i}`, meaning: `m${i}` });
    }
    const ex = generateExercises({ items }, "matching");
    // 8 items split as 5 + 3 = 8 exercises total
    expect(ex.length).toBe(items.length);
    // First 5 should be matching with up to 4 distractors each
    for (let i = 0; i < 5; i++) {
      expect(ex[i].type).toBe("matching");
      expect(ex[i].distractors?.length).toBeLessThanOrEqual(4);
    }
    // Remaining group of 3 still has >=2 items so stays as matching
    for (let i = 5; i < 8; i++) {
      expect(ex[i].type).toBe("matching");
    }
  });

  test("matching: chunk with <2 items falls back to recognition", () => {
    // 6 items → 5 + 1: the 1-item chunk falls back to recognition
    const items: ContentItem[] = [];
    for (let i = 0; i < 6; i++) {
      items.push({ term: `t${i}`, reading: `r${i}`, meaning: `m${i}` });
    }
    const ex = generateExercises({ items }, "matching");
    expect(ex.length).toBe(items.length);
    // First 5 should be matching
    for (let i = 0; i < 5; i++) expect(ex[i].type).toBe("matching");
    // Last one (a chunk of size 1) should be recognition
    expect(ex[5].type).toBe("recognition");
  });

  test("empty content set returns []", () => {
    expect(generateExercises({ items: [] }, "recognition")).toEqual([]);
    expect(generateExercises({ items: [] }, "production")).toEqual([]);
    expect(generateExercises({ items: [] }, "matching")).toEqual([]);
  });

  test("generateAllExercises emits one batch per default mode", () => {
    const ex = generateAllExercises({ items: SAMPLE });
    // 3 modes × 4 items = 12 exercises (matching uses one chunk of 4)
    expect(ex.length).toBe(SAMPLE.length * 3);
    const types = new Set(ex.map((e) => e.type));
    expect(types.has("recognition")).toBe(true);
    expect(types.has("production")).toBe(true);
    expect(types.has("matching")).toBe(true);
  });

  test("generateAllExercises respects custom modes list", () => {
    const ex = generateAllExercises({ items: SAMPLE, modes: ["recognition"] });
    expect(ex.length).toBe(SAMPLE.length);
    for (const e of ex) expect(e.type).toBe("recognition");
  });
});
