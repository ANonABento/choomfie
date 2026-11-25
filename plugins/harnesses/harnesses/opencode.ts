import { defineHarness, lastLine, type HarnessResult } from "@choomfie/harness";

/**
 * OpenCode (`opencode`, npm `opencode-ai`). Free with no account: OpenCode
 * Zen's free models (`opencode/*-free`, `opencode/big-pickle`) work out of the
 * box; keys added with `opencode providers` add more. Checked Nov 25
 * (opencode 1.19.6): `run --format json` prints one JSON event per line; the
 * default `build` agent edits and runs shell commands without asking, the
 * `plan` agent refuses changes; `--session` resumes. ~13k tokens of setup per
 * turn, mostly cached after the first step.
 */
export default defineHarness({
  id: "opencode",
  label: "OpenCode",
  bin: "opencode",
  note: "no account needed (Zen free models); ~13k tokens of agent setup per turn",
  modes: [
    { id: "work", label: "Work", description: "Edits files and runs commands in this chat's folder (owner only)" },
    { id: "ask", label: "Ask", description: "Reads and answers; changes nothing" },
  ],
  defaultMode: "work",
  readOnlyMode: "ask",
  args: ({ prompt, ref, model, mode }) => [
    "run",
    "--format",
    "json",
    ...(mode === "ask" ? ["--agent", "plan"] : []),
    ...(ref ? ["--session", ref] : []),
    ...(model ? ["--model", model] : []),
    // After `--`, a prompt starting with "-" is still the prompt.
    "--",
    prompt,
  ],
  parse: parseOpenCode,
  listModels: {
    args: ["models"],
    parse: (stdout) => stdout.split("\n").map((l) => l.trim()).filter((id) => /^[\w.-]+\/[\w.:/-]+$/.test(id)),
  },
});

interface OcEvent {
  type?: string;
  sessionID?: string;
  part?: { type?: string; text?: string; tokens?: { input?: number; output?: number; cache?: { read?: number } }; tool?: string; state?: { status?: string; error?: string } };
  error?: { name?: string; data?: { message?: string } };
}

/** `run --format json`: one event per line. The reply is the text parts; tokens add up over steps. */
export function parseOpenCode({ stdout, stderr, code }: { stdout: string; stderr: string; code: number | null }): HarnessResult {
  const events: OcEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      events.push(JSON.parse(line) as OcEvent);
    } catch {
      /* a partial line from a killed run */
    }
  }
  const ref = events.find((e) => e.sessionID)?.sessionID;
  const tokens = { in: 0, out: 0 };
  const texts: string[] = [];
  const toolErrors: string[] = [];
  let error: string | undefined;
  for (const e of events) {
    if (e.type === "text" && e.part?.text) texts.push(e.part.text);
    else if (e.type === "step_finish" && e.part?.tokens) {
      tokens.in += (e.part.tokens.input ?? 0) + (e.part.tokens.cache?.read ?? 0);
      tokens.out += e.part.tokens.output ?? 0;
    } else if (e.type === "tool_use" && e.part?.state?.status === "error") toolErrors.push(e.part.tool ?? "tool");
    else if (e.type === "error") error = e.error?.data?.message || e.error?.name || "failed";
  }
  const text = texts.join("\n\n").trim();
  if (!text && (error || code !== 0)) return { text: "", ref, tokens, failed: (error || lastLine(stderr) || `exited with ${code}`).slice(0, 300) };
  const note = toolErrors.length ? `\n-# failed: ${[...new Set(toolErrors)].join(", ")}` : "";
  return { text: text + (error ? `\n-# then: ${error.slice(0, 200)}` : "") + note, ref, tokens };
}
