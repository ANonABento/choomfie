import { describe, expect, test } from "bun:test";
import {
  lookupCedict,
  parseCedict,
  parseCedictLine,
} from "../../../plugins/tutor/modules/chinese/dictionary.ts";

describe("Chinese CC-CEDICT dictionary integration", () => {
  test("parses a CC-CEDICT line", () => {
    const entry = parseCedictLine("你好 你好 [ni3 hao3] /hello/hi/how are you?/");

    expect(entry).toEqual({
      traditional: "你好",
      simplified: "你好",
      pinyinNumbered: "ni3 hao3",
      pinyinMarked: "nǐ hǎo",
      definitions: ["hello", "hi", "how are you?"],
    });
  });

  test("skips comments and malformed lines", () => {
    expect(parseCedict("# comment\nbad line\n馬 马 [ma3] /horse/")).toEqual([
      {
        traditional: "馬",
        simplified: "马",
        pinyinNumbered: "ma3",
        pinyinMarked: "mǎ",
        definitions: ["horse"],
      },
    ]);
  });

  test("looks up bundled entries by characters and pinyin", async () => {
    const byCharacters = await lookupCedict("你好");
    expect(byCharacters[0].word).toBe("你好");
    expect(byCharacters[0].reading).toBe("nǐ hǎo");
    expect(byCharacters[0].meanings).toContain("hello");

    const byPinyin = await lookupCedict("ni3 hao3");
    expect(byPinyin[0].word).toBe("你好");
  });

  test("returns traditional variant metadata when present", async () => {
    const entries = await lookupCedict("书");

    expect(entries[0].word).toBe("书");
    expect(entries[0].partOfSpeech).toContain("traditional: 書");
  });
});
