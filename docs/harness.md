# Harness brains

A **harness** is a coding-agent CLI installed on this machine, driven as a Choomfie brain: `/brain antigravity`. Kit: `@choomfie/harness` (`packages/harness`). Plugin: `harnesses` (`plugins/harnesses`).

## How a turn runs

- Each Discord message is one non-interactive run of the CLI (`agy -p … --output-format json`). No shell; arguments are passed as a list.
- **One conversation per chat.** The CLI's conversation id is the chat's `backendRef`, resumed on the next message. `/clear` starts a new chat, so the next run starts a new conversation.
- **One folder per chat:** `<data dir>/harness/<id>/<chat id>`. Discord attachments are copied into its `attachments/` and named in the prompt. Files the agent creates or changes in the folder come back as attachments (up to 10, each under Discord's limit; the rest are named).
- One turn at a time per chat. `/stop` kills the run; a turn is killed after 20 minutes.
- A failed run throws, so the free router (later) can fail over.

## Who can do what

The agent runs tools **on this machine**. Only the owner gets the working modes. Anyone else's message runs in the spec's read-only mode, whatever `/mode` says.

## Harnesses

| Brain | CLI | Free? | Modes |
|---|---|---|---|
| `antigravity` | `agy` (Google Antigravity CLI) | Yes: Google account, weekly quota. Each turn carries ~10k tokens of the agent's own setup. | `work` (default, owner): edits files and runs commands; `ask`: `--mode plan`, refuses writes and commands. `--mode auto` isn't on free accounts. |

Checked Nov 24, 2026:
- **Cursor CLI** (`cursor-agent`): the free plan's agent usage runs out fast ("You've hit your usage limit"). Not added.
- **Gemini CLI**: free serving ended June 2026 (Antigravity replaced it).
- **Qwen Code**: free OAuth tier ended April 2026; needs a key.
- **Codex**: needs a ChatGPT plan or an OpenAI key.
- **OpenCode**: free to run, with OpenCode Zen's free models or any of the free API keys the free brain already uses. The best candidate for a second harness; not installed here yet.
- Most of these also speak **ACP** (Agent Client Protocol, `agy acp`, `opencode acp`): streaming, tool approvals, one protocol for all. The kit uses print mode for now; ACP is the upgrade path.

## Adding a harness

One spec file in `plugins/harnesses/harnesses/` plus a line in its `index.ts`: the executable, `args(turn)` for one run, `parse(output)` for its answer and conversation id, its modes (one read-only), and optionally how to list models for `/model`. The plugin registers each harness whose executable is on PATH.

Enable with `/plugins enable harnesses`, then `/brain antigravity` in a channel. Log in to the CLI itself first (run `agy` once in a terminal).
