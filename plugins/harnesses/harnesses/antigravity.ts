import { defineHarness, lastLine, type HarnessResult } from "@choomfie/harness";

/**
 * Google's Antigravity CLI (`agy`). Free with a Google account, on a weekly
 * quota; every turn carries ~10k tokens of the agent's own setup against it.
 * Log in once by running `agy` in a terminal. Checked Nov 24 (agy 1.5.10):
 * `--mode auto` isn't on free accounts; the default mode edits and runs
 * commands without asking, `--mode plan` refuses both (`denied_actions`).
 */
export default defineHarness({
  id: "antigravity",
  label: "Antigravity",
  bin: "agy",
  note: "Google account, weekly quota; ~10k tokens of agent setup per turn",
  modes: [
    { id: "work", label: "Work", description: "Edits files and runs commands in this chat's folder (owner only)" },
    { id: "ask", label: "Ask", description: "Reads and answers; changes nothing" },
  ],
  defaultMode: "work",
  readOnlyMode: "ask",
  args: ({ prompt, ref, model, mode }) => [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--disable-slash-commands",
    ...(mode === "ask" ? ["--mode", "plan"] : []),
    ...(ref ? ["--conversation", ref] : []),
    ...(model ? ["--model", model] : []),
  ],
  parse: parseAgy,
  listModels: {
    args: ["models"],
    parse: (stdout) => stdout.split("\n").map((l) => l.split("\t")[0].trim()).filter((id) => /^[a-z0-9][\w.-]*$/i.test(id)),
  },
});

/** `--output-format json`: one object, `{conversation_id, status, response, usage, denied_actions?}`. */
export function parseAgy({ stdout, stderr, code }: { stdout: string; stderr: string; code: number | null }): HarnessResult {
  const start = stdout.indexOf("{");
  let o: Record<string, unknown> | null = null;
  try {
    o = start >= 0 ? JSON.parse(stdout.slice(start)) : null;
  } catch {
    o = null;
  }
  if (!o) {
    const why = lastLine(stderr) || `exited with ${code}`;
    if (/auth|log ?in|sign ?in/i.test(why)) return { text: "", failed: "isn't logged in — run `agy` once in a terminal on the Mac running Choomfie" };
    return { text: "", failed: why.slice(0, 300) };
  }
  const ref = typeof o.conversation_id === "string" ? o.conversation_id : undefined;
  const usage = (o.usage ?? {}) as Record<string, number>;
  const tokens = { in: usage.input_tokens ?? 0, out: usage.output_tokens ?? 0 };
  if (o.status !== "SUCCESS") return { text: "", ref, tokens, failed: String(o.response || o.status || "failed").slice(0, 300) };
  const denied = Array.isArray(o.denied_actions) ? (o.denied_actions as { display_name?: string; action?: string }[]) : [];
  // Local file links mean nothing in Discord: keep the name.
  let text = String(o.response ?? "").replace(/\[([^\]]+)\]\(file:\/\/[^)]+\)/g, "`$1`");
  if (denied.length) text += `${text ? "\n" : ""}-# not allowed in this mode: ${[...new Set(denied.map((d) => d.display_name ?? d.action))].join(", ")}`;
  return { text, ref, tokens };
}
