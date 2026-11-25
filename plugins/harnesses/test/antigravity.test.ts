import { expect, test } from "bun:test";
import agy, { parseAgy } from "../harnesses/antigravity.ts";

const run = (o: unknown, stderr = "") => parseAgy({ stdout: JSON.stringify(o), stderr, code: 0 });

test("agy's JSON: the answer, the conversation, file links made plain", () => {
  const r = run({ conversation_id: "c1", status: "SUCCESS", response: "wrote [shell.txt](file:///tmp/x/shell.txt).\n", usage: { input_tokens: 12787, output_tokens: 518 } });
  expect(r).toEqual({ text: "wrote `shell.txt`.\n", ref: "c1", tokens: { in: 12787, out: 518 } });
});

test("read-only mode: what it wasn't allowed to do is said", () => {
  const r = run({ conversation_id: "c2", status: "SUCCESS", response: "", denied_actions: [{ action: "command", display_name: "Bash" }] });
  expect(r.text).toBe("-# not allowed in this mode: Bash");
});

test("no JSON: the last stderr line; a login problem says how to fix it", () => {
  expect(parseAgy({ stdout: "", stderr: "Error: authentication required\n", code: 1 }).failed).toContain("run `agy` once");
  expect(parseAgy({ stdout: "", stderr: "boom\nquota exceeded\n", code: 1 }).failed).toBe("quota exceeded");
  expect(run({ conversation_id: "c3", status: "ERROR", response: "rate limited" })).toMatchObject({ failed: "rate limited", ref: "c3" });
});

test("command line: plan mode for ask, resume by conversation, model if picked", () => {
  expect(agy.args({ prompt: "-x hi", ref: "c1", model: "gemini-3.8-flash-low", mode: "ask", cwd: "/w" })).toEqual([
    "-p", "-x hi", "--output-format", "json", "--disable-slash-commands", "--mode", "plan", "--conversation", "c1", "--model", "gemini-3.8-flash-low",
  ]);
  expect(agy.args({ prompt: "hi", mode: "work", cwd: "/w" })).toEqual(["-p", "hi", "--output-format", "json", "--disable-slash-commands"]);
  expect(agy.listModels!.parse("Fetching available models...\ngemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n")).toEqual(["gemini-4-hydrogen-high"]);
});
