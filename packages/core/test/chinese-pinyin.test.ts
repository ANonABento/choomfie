import { describe, expect, test } from "bun:test";
import {
  getToneNumber,
  isValidNumberedPinyin,
  marksToNumbers,
  normalizePinyin,
  numbersToMarks,
} from "../../../plugins/tutor/modules/chinese/pinyin.ts";

describe("Chinese pinyin utilities", () => {
  test("converts numbered pinyin to tone marks", () => {
    expect(numbersToMarks("ni3 hao3")).toBe("nǐ hǎo");
    expect(numbersToMarks("ma1 ma2 ma3 ma4 ma5")).toBe("mā má mǎ mà ma");
    expect(numbersToMarks("lü4 se4")).toBe("lǜ sè");
    expect(numbersToMarks("lu:4 se4")).toBe("lǜ sè");
  });

  test("converts tone marks to numbered pinyin", () => {
    expect(marksToNumbers("nǐ hǎo")).toBe("ni3 hao3");
    expect(marksToNumbers("mā má mǎ mà ma")).toBe("ma1 ma2 ma3 ma4 ma");
    expect(marksToNumbers("lǜ sè")).toBe("lü4 se4");
  });

  test("normalizes pinyin in either direction", () => {
    expect(normalizePinyin("Zhong1 guo2", "marks")).toBe("Zhōng guó");
    expect(normalizePinyin("Zhōng guó", "numbers")).toBe("Zhong1 guo2");
  });

  test("validates numbered pinyin without accepting mixed tone marks", () => {
    expect(isValidNumberedPinyin("ni3 hao3")).toBe(true);
    expect(isValidNumberedPinyin("lü4 se4")).toBe(true);
    expect(isValidNumberedPinyin("nǐ hao3")).toBe(false);
    expect(isValidNumberedPinyin("")).toBe(false);
  });

  test("extracts tone numbers from marked or numbered syllables", () => {
    expect(getToneNumber("mǎ")).toBe(3);
    expect(getToneNumber("ma5")).toBe(5);
    expect(getToneNumber("ma")).toBeNull();
  });
});
