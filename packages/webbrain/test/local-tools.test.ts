import { describe, expect, test } from "bun:test";
import { isLookOnly, runCalls } from "../local-tools.ts";

describe("runCalls", () => {
  test("blocks marked #!run (marker inside the code) or with language run; others ignored", () => {
    expect(runCalls("```sh\n#!run\ndf -h\n```\n```python\nprint(1)\n```\n```run\nuptime\n```")).toEqual(["df -h", "uptime"]);
    expect(runCalls("Code snippet\ndf -h", [{ lang: "code", code: "#!run\ndf -h\n" }, { code: "ls" }])).toEqual(["df -h"]);
    expect(runCalls("no blocks here")).toEqual([]);
  });
});

describe("isLookOnly", () => {
  test("status commands and read-only git run without asking", () => {
    for (const c of ["df -h", "du -sh ~/Downloads", "cd ~/choomfie && git status", "git log --oneline -5", "ps aux | grep bun | head -5", "top -l 1 | head -12", "diskutil list", "pmset -g batt", "gh pr list"]) {
      expect([c, isLookOnly(c)]).toEqual([c, true]);
    }
  });

  test("changes, chaining tricks, file reads and secrets wait for the owner", () => {
    for (const c of [
      "git commit -am wip",
      "git push",
      "rm -rf ~/x",
      "df -h; rm x",
      "ls > out.txt",
      "ls $(whoami)",
      "ls `whoami`",
      "ls & sleep 1",
      "df || rm x",
      "cat ~/.zshrc",
      "grep KEY .env",
      "ls ~/.ssh",
      "echo $GITHUB_TOKEN | wc",
      "brew install x",
      "diskutil eraseDisk",
    ]) {
      expect([c, isLookOnly(c)]).toEqual([c, false]);
    }
  });
});
