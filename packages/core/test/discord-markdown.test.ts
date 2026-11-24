import { describe, expect, test } from "bun:test";
import { chunkForDiscord } from "../lib/brain-router.ts";
import { tablesForDiscord } from "../lib/discord-markdown.ts";

describe("tables for Discord", () => {
  test("a narrow table becomes an aligned code block, markdown stripped", () => {
    const out = tablesForDiscord("Sizes:\n\n| Model | Size |\n|---|:-:|\n| gpt-oss | 120B |\n| **qwen** | 27B |\n\nok");
    expect(out).toBe("Sizes:\n\n```\nModel    Size\n───────  ────\ngpt-oss  120B\nqwen     27B\n```\n\nok");
  });

  test("a wide table becomes one bullet per row, labelled by header", () => {
    const out = tablesForDiscord(
      "| Type | Example | How it's used |\n|---|---|---|\n| **Continuous** | any real-valued angle within the joint limits | most real-world control |"
    );
    expect(out).toBe("- **Continuous** — Example: any real-valued angle within the joint limits · How it's used: most real-world control");
  });

  test("tables inside code blocks and lone pipes are left alone", () => {
    const text = "```\n| a | b |\n|---|---|\n```\nuse a | b to pipe";
    expect(tablesForDiscord(text)).toBe(text);
  });

  test("every reply passes through it on the way out", () => {
    expect(chunkForDiscord("| a | b |\n|---|---|\n| 1 | 2 |")[0]).toStartWith("```");
  });
});
