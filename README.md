# Choomfie

A personal Discord agent that runs through your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI plan — persistent memory, switchable personas, reminders, Discord interactions (buttons/slash commands/modals), GitHub integration, and voice/tutor/social plugins.

## Contents

- [Quick Start](#quick-start) · [Lifecycle](#lifecycle)
- [Requirements](#requirements) · [Install](#install)
- [Running Choomfie](#running-choomfie) · [Discord Access](#discord-access)
- [Usage & Commands](#usage--commands)
- [OpenAI-Compatible Endpoint](#openai-compatible-endpoint) · [Cost & Session Controls](#cost--session-controls)
- [Architecture](#architecture) · [Plugins](#plugins)
- [Project Structure](#project-structure) · [Troubleshooting](#troubleshooting) · [Docs](#docs)

## Quick Start

```bash
git clone https://github.com/ANonABento/choomfie.git
cd choomfie
./install.sh          # installs deps, prompts for Discord token, installs CLI to ~/.local/bin

choomfie               # foreground session, via your Claude Code plan
```

## Lifecycle

There is no separate gateway service — Choomfie runs for as long as its process does.

| Action | Command |
| --- | --- |
| Start (foreground) | `choomfie` |
| Start in tmux | `choomfie --tmux` |
| Start always-on (tmux + caffeinate) | `choomfie --always-on` |
| Start autonomous daemon | `choomfie --daemon` |
| Stop | quit the CLI (`Ctrl+C` / `/exit`), or `tmux kill-session -t choomfie-claude-code` |
| Wipe stored state | `bun packages/core/scripts/reset.ts [scope]` |

## Requirements

[Bun](https://bun.sh) · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) with a signed-in account/plan · a Discord bot token ([setup guide](docs/discord-setup.md))

## Install

```bash
git clone https://github.com/ANonABento/choomfie.git
cd choomfie
./install.sh
```

The installer installs Bun deps, prompts for a Discord token, writes Choomfie data under `~/.claude/plugins/data/choomfie-inline`, and installs `choomfie` into `~/.local/bin`. Reload your shell if `~/.local/bin` is not on your `PATH`.

## Running Choomfie

```bash
choomfie            # foreground session
choomfie --tmux     # run in a detached tmux session
choomfie --daemon   # Discord-only daemon backed by Agent SDK sessions (auto-restart, session cycling)
```

Internally this launches `claude --plugin-dir . --dangerously-load-development-channels server:choomfie` (or `bun packages/core/daemon.ts` for `--daemon`). On first run, if the installer didn't set the token, run `/choomfie:configure <discord-bot-token>` from inside Claude Code. Data lives under `~/.claude/plugins/data/choomfie-inline`.

## Discord Access

Restrict Choomfie to trusted users. **Never set an open allow-all policy** unless you intend anyone reachable by the bot to drive an agent with tool access.

Access is stored in `~/.claude/plugins/data/choomfie-inline/access.json`. To pair a user:

1. They DM the bot `!pair`, then share the 5-letter code.
2. Run `/choomfie:access pair <code>` in Claude Code.
3. Run `/choomfie:access policy allowlist` to lock down.

## Usage & Commands

In servers, `@mention` the bot or reply to its messages. In DMs, just talk.

| Command | Description |
| --- | --- |
| `/remind` · `/reminders` · `/cancel <id>` | Set / list / cancel reminders |
| `/memory [search]` · `/savememory` | List/search and save memories |
| `/github <check>` | Check PRs, issues, notifications |
| `/persona [switch]` · `/newpersona` | List/switch and create personas |
| `/plugins` | List, enable, or disable plugins |
| `/voice` | Voice provider setup |
| `/lesson` · `/progress` | Start a lesson / show learning progress |
| `/status` | Bot status |
| `/help` | Show all commands and capabilities |

**Claude Code terminal skills** (run in the CLI, not Discord):

| Skill | Description |
| --- | --- |
| `/choomfie:configure <token>` | Set Discord bot token |
| `/choomfie:access` | Manage access policy and allowlist |
| `/choomfie:memory` | View/manage memories |
| `/choomfie:status` | Full config overview |

## OpenAI-Compatible Endpoint

Choomfie can expose a local OpenAI-compatible API (e.g. for a companion app):

```bash
bun packages/core/scripts/api-key.ts issue exampleapp --scopes chat,models,memory,notify
```

Point OpenAI SDK clients at:

```env
OPENAI_API_KEY=sk-choomfie-exampleapp-...
OPENAI_BASE_URL=http://127.0.0.1:4141/v1
OPENAI_MODEL=choomfie-claude-sonnet
```

See [docs/openai-endpoint.md](docs/openai-endpoint.md) for routes and extension endpoints; [docs/openai-endpoint-verification.md](docs/openai-endpoint-verification.md) for verification notes.

## Cost & Session Controls

`choomfie --daemon` cycles Claude sessions automatically when context gets heavy (~120k tokens or 80 turns), capturing a handoff summary first — see [Daemon Mode](CLAUDE.md#daemon-mode-choomfie---daemon).

For a foreground session, use `/compact` or start a fresh Claude Code session once conversation history gets long.

## Architecture

Immortal supervisor over a disposable worker, connected to Claude Code over MCP stdio:

```text
Claude Code ←MCP stdio→ supervisor.ts (immortal)
                          │ Bun IPC
                        worker.ts (disposable) → Discord + plugins + tools
```

**Daemon mode** (`choomfie --daemon`) — Discord-only autonomous operation:

```text
daemon.ts (immortal, Agent SDK) → Claude session (disposable, auto-cycled)
                                 → supervisor.ts → worker.ts → Discord
```

See [docs/supervisor-architecture.md](docs/supervisor-architecture.md) for details.

## Plugins

| Plugin | Description |
| --- | --- |
| **Voice** | Full-duplex voice chat: local STT/TTS, VAD, interruption handling, streaming, multi-speaker. |
| **Browser** | Playwright browsing: navigate, click, type, screenshot, evaluate JS. |
| **Tutor** | Language learning: structured lessons, SRS, quizzes, module tools. |
| **Socials** | YouTube, Reddit, LinkedIn workflows. |

**Voice setup** — `brew install whisper-cpp` (local STT), `pip install kokoro-onnx soundfile` (local TTS). Cloud providers via API keys in the runtime env. See [docs/voice-plugin.md](docs/voice-plugin.md).

## Project Structure

```text
bin/choomfie                # launcher (foreground / --tmux / --daemon)
packages/
  shared/                   # @choomfie/shared — types + utils
  core/                     # server/supervisor/worker/daemon + lib/, skills/, scripts/, test/
plugins/                    # voice/, browser/, tutor/, socials/
docs/
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Discord ignores you | Check `access.json` policy/allowlist, then restart. |
| No owner detected | Owner is auto-detected from Discord app info on startup; re-run once the bot token is set. |
| Bot token not set | Run `/choomfie:configure <token>` from Claude Code, or re-run `./install.sh`. |
| `choomfie legacy` / `choomfie claude-code` don't work | Removed — just run `choomfie`. |

## Docs

- [Discord Setup](docs/discord-setup.md)
- [Supervisor Architecture](docs/supervisor-architecture.md) · [Voice Plugin](docs/voice-plugin.md)
- [Tutor Plugin](docs/tutor-plugin-spec.md) · [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
