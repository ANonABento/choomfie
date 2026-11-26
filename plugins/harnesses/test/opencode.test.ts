import { expect, test } from "bun:test";
import oc, { parseOpenCode } from "../harnesses/opencode.ts";

const lines = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

test("events: the text parts, the session, tokens summed over steps", () => {
  const stdout = lines(
    { type: "step_start", sessionID: "ses_1", part: {} },
    { type: "tool_use", sessionID: "ses_1", part: { tool: "write", state: { status: "completed" } } },
    { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 12925, output: 14, cache: { read: 0 } } } },
    { type: "text", sessionID: "ses_1", part: { text: "Created note.txt with 42." } },
    { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 320, output: 9, cache: { read: 12800 } } } }
  );
  expect(parseOpenCode({ stdout, stderr: "", code: 0 })).toEqual({ text: "Created note.txt with 42.", ref: "ses_1", tokens: { in: 26045, out: 23 } });
});

test("an error event with no answer fails with its message; a failed tool is noted", () => {
  const err = lines({ type: "error", sessionID: "ses_2", error: { name: "UnknownError", data: { message: "Unexpected server error." } } });
  expect(parseOpenCode({ stdout: err, stderr: "", code: 1 })).toMatchObject({ failed: "Unexpected server error.", ref: "ses_2" });
  expect(parseOpenCode({ stdout: "", stderr: "boom\n", code: 1 }).failed).toBe("boom");
  const tool = lines({ type: "tool_use", sessionID: "s", part: { tool: "bash", state: { status: "error" } } }, { type: "text", sessionID: "s", part: { text: "couldn't" } });
  expect(parseOpenCode({ stdout: tool, stderr: "", code: 0 }).text).toBe("couldn't\n-# failed: bash");
});

test("what it did: commands and edits, not looking around", () => {
  const stdout = lines(
    { type: "tool_use", sessionID: "s", part: { tool: "glob", state: { status: "completed", input: { pattern: "*.ts" } } } },
    { type: "tool_use", sessionID: "s", part: { tool: "write", state: { status: "completed", input: { filePath: "/tmp/x/note.txt" } } } },
    { type: "tool_use", sessionID: "s", part: { tool: "edit", state: { status: "completed", input: { filePath: "/tmp/x/app.ts" } } } },
    { type: "tool_use", sessionID: "s", part: { tool: "bash", state: { status: "completed", input: { command: "npm test" } } } },
    { type: "text", sessionID: "s", part: { text: "done" } }
  );
  expect(parseOpenCode({ stdout, stderr: "", code: 0 }).actions).toEqual(["wrote note.txt", "edited app.ts", "ran `npm test`"]);
});

test("command line: plan agent for ask, resume by session, prompt after --", () => {
  expect(oc.args({ prompt: "-x hi", ref: "ses_1", model: "opencode/big-pickle", mode: "ask", cwd: "/w" })).toEqual([
    "run", "--format", "json", "--agent", "plan", "--session", "ses_1", "--model", "opencode/big-pickle", "--", "-x hi",
  ]);
  expect(oc.args({ prompt: "hi", mode: "work", cwd: "/w" })).toEqual(["run", "--format", "json", "--", "hi"]);
  expect(oc.listModels!.parse("opencode/big-pickle\nopencode/glm-5.3-flash-free\nnot a model\n")).toEqual(["opencode/big-pickle", "opencode/glm-5.3-flash-free"]);
});
