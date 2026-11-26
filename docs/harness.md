# Harness brains

A **harness** is a coding-agent CLI installed on this machine, driven as a Choomfie brain: `/brain antigravity`. Kit: `@choomfie/harness` (`packages/harness`). Plugin: `harnesses` (`plugins/harnesses`).

## How a turn runs

- Each Discord message is one run of the CLI, over **ACP** (Agent Client Protocol: `agy acp`, `opencode acp`, JSON-RPC on stdin/stdout, `packages/harness/acp.ts`) when the spec has `acp`, else in print mode (`agy -p … --output-format json`). No shell; arguments are passed as a list. Config `harnesses.<id>.acp: false` goes back to print mode.
- **Over ACP** the agent streams: its tool calls show on the chat's status line on a long run (the same shared `statusLine` web brains use), and a **permission request** (Antigravity's `auto` mode asks before irreversible actions) becomes an **Allow / Deny** card for the owner; the run waits for the click (15 minutes, then no). A read-only turn, or anyone but the owner, gets no for everything asked. `session/load` resumes the chat's conversation; one that can't be reopened starts a new one and the reply says so. One process per turn: nothing stays open between messages.
- **What it did is kept.** Each reply carries a `record` (files changed in the folder; commands run and files edited, from the agent's own events): not posted, but free puts it in its transcript, so after **Back to auto** the next model knows what changed. Links to this machine's files (`[note.txt](file:///…)`) become plain names.
- **One conversation per chat.** The CLI's conversation id is the chat's `backendRef`, resumed on the next message. `/clear` starts a new chat, so the next run starts a new conversation.
- **One folder per chat:** `<data dir>/harness/<id>/<chat id>`. Discord attachments are copied into its `attachments/` and named in the prompt. Files the agent creates or changes in the folder come back as attachments (up to 10, each under Discord's limit; the rest are named).
- One turn at a time per chat. `/stop` kills the run; a turn is killed after 20 minutes.
- A failed run throws, so the free router can fail over.
- The run's `PWD` is set to the folder as well as its cwd: OpenCode takes its working folder from `PWD`, and without it wrote into whatever folder Choomfie was started from.

## Who can do what

The agent runs tools **on this machine**. Only the owner gets the working modes. Anyone else's message runs in the spec's read-only mode, whatever `/mode` says.

## Harnesses

| Brain | CLI | Free? | Modes |
|---|---|---|---|
| `antigravity` | `agy` (Google Antigravity CLI) | Yes: Google account, weekly quota. Each turn carries ~10k tokens of the agent's own setup. | `work` (default, owner): ACP mode `auto`, edits and safe commands without asking, a card before anything irreversible (print mode: edits and runs); `ask`: mode `plan`, refuses writes and commands. |
| `opencode` | `opencode` (npm `opencode-ai`) | Yes, no account: OpenCode Zen's free models (`opencode/*-free`, `opencode/big-pickle`); `opencode providers` adds keys. ~13k tokens of setup per turn, mostly cached. | `work` (default, owner): the `build` agent, edits and runs shell commands without asking; `ask`: the `plan` agent, refuses changes. `run --format json` prints one event per line; `--session` resumes. |

Checked Nov 24, 2026:
- **Cursor CLI** (`cursor-agent`): the free plan's agent usage runs out fast ("You've hit your usage limit"). Not added.
- **Gemini CLI**: free serving ended June 2026 (Antigravity replaced it).
- **Qwen Code**: free OAuth tier ended April 2026; needs a key.
- **Codex**: needs a ChatGPT plan or an OpenAI key.
- Both harnesses speak **ACP** (checked Nov 25: opencode 1.19.6, agy 1.5.17), and so do Gemini CLI and Goose: a new harness that does needs only `acp: { args, modes }` in its spec, no output parser.

## In the free brain

Harnesses are free's members for the `local` bucket (work on this computer), Antigravity first, OpenCode if it's out of quota or failing. Like Waymond, one takes a chat on its first message or through **Hand this to …**, holds it while the work goes on, and gives it back with the **Back to auto** button under each of its replies (see [free-brain.md](free-brain.md)). Its folder is per harness chat, so files carry across turns; the free models see its replies and its work record (what changed, what ran), not the files themselves.

**Out of quota:** a failed run whose output matches the spec's `quota` pattern (default `QUOTA_PATTERN`: `RESOURCE_EXHAUSTED`, "quota exhausted", "usage limit", 429, …) throws `QuotaReachedError` with the reset time read from the output (`parseResetAt`). `/brain antigravity` shows it as the answer; free benches the harness until then and offers the other one.

## Adding a harness

One spec file in `plugins/harnesses/harnesses/` plus a line in its `index.ts`: the executable, its modes (one read-only), and either `acp: { args, modes }` (the CLI's ACP command and which of its modes each of ours is) or `args(turn)` / `parse(output)` for print mode (keep them as the fallback), and optionally how to list models for `/model`. The plugin registers each harness whose executable is on PATH.

Enable with `/plugins enable harnesses`, then `/brain antigravity` or `/brain opencode` in a channel. Log in to `agy` once in a terminal first; OpenCode needs nothing. Install OpenCode with `npm i -g opencode-ai` (npm needs `--allow-scripts=opencode-ai` for its postinstall); the executable must be on Choomfie's PATH.
