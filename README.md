# Choomfie

A personal Discord agent with two interchangeable runtimes:

- **Hermes mode** (`choomfie`) — always-on Discord gateway as a managed service: sessions, delivery, approvals, cron, skills/plugins, and provider routing via [Hermes Agent](https://github.com/NousResearch/hermes-agent). Best for long-running operation.
- **Claude Code mode** (`choomfie claude-code`) — runs Choomfie directly through your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI plan. Best for Claude Code subscription usage and the mature voice/tutor/social plugin stack.

> Hermes *can* use Anthropic as a provider, but that is not the same as running inside Claude Code. Claude Code mode uses the `claude` CLI directly and bypasses Hermes provider auth entirely.

## Contents

- [Quick Start](#quick-start) · [Which Mode?](#which-mode) · [Lifecycle](#lifecycle)
- [Requirements](#requirements) · [Install](#install)
- [Hermes Mode](#hermes-mode) · [Claude Code Mode](#claude-code-mode)
- [Discord Access](#discord-access) · [Usage & Commands](#usage--commands)
- [OpenAI-Compatible Endpoint](#openai-compatible-endpoint) · [Cost & Session Controls](#cost--session-controls)
- [Architecture](#architecture) · [Plugins](#plugins) · [Memory Migration](#memory-migration)
- [Project Structure](#project-structure) · [Troubleshooting](#troubleshooting) · [Docs](#docs)

## Quick Start

```bash
git clone https://github.com/ANonABento/choomfie.git
cd choomfie
./install.sh          # installs deps, prompts for Discord token, installs CLIs to ~/.local/bin

choomfie              # Hermes mode: sync overlay + start gateway
# or
choomfie claude-code  # Claude Code mode: run via your Claude Code plan
```

## Which Mode?

| Use case | Command |
| --- | --- |
| Always-on Discord bot as a service | `choomfie` |
| Codex / OpenRouter / Anthropic / Nous providers via Hermes | `choomfie` |
| Use your Claude Code plan directly | `choomfie claude-code` |
| Mature voice / tutor / social / plugin behavior | `choomfie claude-code` |
| Quick local session | `choomfie claude` (alias) |

## Lifecycle

There is **no `choomfie end`** — use these:

| Action | Command |
| --- | --- |
| Start gateway | `choomfie` or `choomfie start` |
| Status | `choomfie status` (`--deep` for detail) |
| Restart gateway | `choomfie restart` |
| **Stop gateway** | `choomfie stop` |
| Exit Claude Code mode | quit the CLI (`Ctrl+C` / `/exit`) |
| Wipe stored state | `choomfie reset [scope]` |
| Follow logs | `journalctl --user -u hermes-gateway-choomfie -f` |

`choomfie stop` targets only the Choomfie profile gateway. Hermes flags like `--all` or `--system` broaden the scope — check the target before confirming them. Unknown verbs are forwarded to `hermes` as-is, so `choomfie stop` is the correct way to shut down.

## Requirements

**Common:** [Bun](https://bun.sh) · a Discord bot token ([setup guide](docs/discord-setup.md))

**Hermes mode:** [Hermes Agent](https://github.com/NousResearch/hermes-agent) + at least one inference provider (OpenAI Codex OAuth, Nous Portal, OpenRouter, Anthropic API key, …). Choomfie keeps Hermes state isolated under `~/.choomfie-hermes`.

**Claude Code mode:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) + a signed-in account/plan.

## Install

```bash
git clone https://github.com/ANonABento/choomfie.git
cd choomfie
./install.sh
```

The installer installs Bun deps, prompts for a Discord token, writes Claude Code data under `~/.claude/plugins/data/choomfie-inline`, writes the Hermes profile under `~/.choomfie-hermes/profiles/choomfie`, and installs `choomfie` + `choomfie-claude-code` into `~/.local/bin`. Reload your shell if `~/.local/bin` is not on your `PATH`.

## Hermes Mode

Install Hermes:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc && hermes --version
```

Configure the isolated Choomfie profile:

```bash
cd ~/choomfie
choomfie sync                                                            # sync overlay into Hermes state
cp ~/.choomfie-hermes/profiles/choomfie/.env.EXAMPLE \
   ~/.choomfie-hermes/profiles/choomfie/.env
$EDITOR ~/.choomfie-hermes/profiles/choomfie/.env                        # set DISCORD_BOT_TOKEN + DISCORD_ALLOWED_USERS
HERMES_HOME=~/.choomfie-hermes hermes -p choomfie model                  # pick a provider/model
```

Provider options: **OpenAI Codex** (imports Codex CLI creds), **OpenRouter** (broad routing, pay-per-use), **Anthropic API key** (direct billing), **Nous Portal** (subscription tooling).

Verify, then install and start the service:

```bash
choomfie doctor
choomfie install
choomfie start
```

Update flow:

```bash
hermes update --backup
cd ~/choomfie && git pull && choomfie sync && choomfie doctor && choomfie restart
```

### Pinning the upstream Hermes build

```bash
choomfie hermes-update            # pull upstream to latest + reinstall
choomfie hermes-update --check    # show pin drift + what's new upstream
choomfie hermes-update --pin      # record the installed commit as known-good
choomfie hermes-update --to-pin   # roll back to the pinned commit
```

## Claude Code Mode

Runs Choomfie through Claude Code's native CLI path — independent of Hermes provider auth.

```bash
choomfie claude-code          # foreground session
choomfie claude               # short alias
choomfie claude-code --tmux   # run in tmux
choomfie claude-code --daemon # Discord-only daemon backed by Agent SDK sessions
```

Internally this launches `claude --plugin-dir . --dangerously-load-development-channels server:choomfie`. On first run, if the installer didn't set the token, run `/choomfie:configure <discord-bot-token>`. Data lives under `~/.claude/plugins/data/choomfie-inline`.

## Discord Access

Restrict Choomfie to trusted users. **Never set an open allow-all policy** unless you intend anyone reachable by the bot to drive an agent with tool access.

**Hermes mode** — set in `~/.choomfie-hermes/profiles/choomfie/.env`:

```bash
DISCORD_ALLOWED_USERS=123456789012345678
```

**Claude Code mode** — stored in `~/.claude/plugins/data/choomfie-inline/access.json`. To pair a user:

1. They DM the bot `!pair`, then share the 5-letter code.
2. Run `/choomfie:access pair <code>` in Claude Code.
3. Run `/choomfie:access policy allowlist` to lock down.

## Usage & Commands

In servers, `@mention` the bot or reply to its messages. In DMs, just talk. Command coverage differs by runtime while Hermes parity is still being proven.

**Hermes native commands:**

| Command | Description |
| --- | --- |
| `/status` | Bot status |
| `/help` | Show commands |
| `/personality [name]` | List or switch personality overlays |
| `/plugins` | List, enable, or disable plugins |

In Hermes mode, reminders are natural-language (not slash commands yet) — e.g. *"remind me in 30 minutes to check the deploy"*, *"what reminders do I have?"*, *"cancel reminder 3"*. State lives in `~/.choomfie-hermes/profiles/choomfie/state/choomfie-reminders.json`; delivery uses Hermes script-only cron jobs so reminder text fires without starting a new agent turn.

**Claude Code mode commands:**

| Command | Description |
| --- | --- |
| `/remind` · `/reminders` · `/cancel <id>` | Set / list / cancel reminders |
| `/memory [search]` · `/savememory` | List/search and save memories |
| `/github <check>` | Check PRs, issues, notifications |
| `/persona [switch]` · `/newpersona` | List/switch and create personas |
| `/voice` | Voice provider setup |
| `/lesson` · `/progress` | Start a lesson / show learning progress |

**Claude Code terminal skills** (run in the CLI, not Discord):

| Skill | Description |
| --- | --- |
| `/choomfie:configure <token>` | Set Discord bot token |
| `/choomfie:access` | Manage access policy and allowlist |
| `/choomfie:memory` | View/manage memories |
| `/choomfie:status` | Full config overview |

## OpenAI-Compatible Endpoint

Choomfie can expose a local OpenAI-compatible API (e.g. for ExampleApp):

```bash
choomfie api-key issue exampleapp --scopes chat,models,memory,notify
```

Point OpenAI SDK clients at:

```env
OPENAI_API_KEY=sk-choomfie-exampleapp-...
OPENAI_BASE_URL=http://127.0.0.1:4141/v1
OPENAI_MODEL=choomfie-claude-sonnet
```

See [docs/openai-endpoint.md](docs/openai-endpoint.md) for routes, routing behavior, and extension endpoints; [docs/openai-endpoint-verification.md](docs/openai-endpoint-verification.md) for verification notes.

## Cost & Session Controls

The Hermes overlay defaults routine traffic to `gpt-5.3-codex-spark` via `openai-codex`. Use a heavier model only when needed:

```bash
hermes -p choomfie chat -q "..." --model gpt-5.5 --provider openai-codex   # one-off
hermes -p choomfie config set model.default <model>                        # persistent
hermes -p choomfie config set model.provider <provider>
```

**Token budget** — daily checks warn at 2M tokens/day and hard-stop at 3M (override via `CHOOMFIE_TOKEN_WARN_THRESHOLD` / `CHOOMFIE_TOKEN_HARD_THRESHOLD`):

```bash
choomfie sync
~/.choomfie-hermes/profiles/choomfie/scripts/token-budget.sh
hermes -p choomfie insights --days 1 --source discord
```

Discord sessions use a lean tool profile (web, terminal, file, skills, todo, memory, session_search, clarify, cronjob, messaging) — browser, code execution, vision, image gen, TTS, delegation, and computer-use are off unless re-enabled.

**Session hygiene** — `/compress`, `/new`, `/reset` in chat; auto-prune is on (`retention_days: 30`). Prune manually with:

```bash
hermes -p choomfie sessions prune --older-than 30 --yes
```

For 200+ message sessions, prefer `/compress` or a fresh session.

## Architecture

**Hermes mode** — Hermes owns the long-running infra (gateway, reconnects, sessions, approvals, cron, delivery, provider routing); Choomfie owns the product layer (personality, memory policy, reminder UX, tutor/voice behavior).

```text
Discord → Hermes adapter/gateway/sessions/delivery
        → Choomfie profile (SOUL.md, skills, plugins, hooks)
        → Hermes provider routing + tools
```

**Claude Code mode** — direct CLI path with an immortal supervisor over a disposable worker.

```text
Claude Code ←MCP stdio→ supervisor.ts (immortal)
                          │ Bun IPC
                        worker.ts (disposable) → Discord + plugins + tools
```

**Daemon mode** (`choomfie claude-code --daemon`) — Discord-only autonomous operation.

```text
daemon.ts (immortal, Agent SDK) → Claude session (disposable, auto-cycled)
                                 → supervisor.ts → worker.ts → Discord
```

See [docs/supervisor-architecture.md](docs/supervisor-architecture.md) for details.

## Plugins

Strongest in Claude Code mode today; Hermes equivalents are being ported as overlay skills/plugins.

| Plugin | Description |
| --- | --- |
| **Voice** | Full-duplex voice chat: local STT/TTS, VAD, interruption handling, streaming, multi-speaker. |
| **Browser** | Playwright browsing: navigate, click, type, screenshot, evaluate JS. |
| **Tutor** | Language learning: structured lessons, SRS, quizzes, module tools. |
| **Socials** | YouTube, Reddit, LinkedIn workflows. |

**Voice setup** — `brew install whisper-cpp` (local STT), `pip install kokoro-onnx soundfile` (local TTS). Cloud providers via API keys in the runtime env. See [docs/voice-plugin.md](docs/voice-plugin.md).

## Memory Migration

Hermes mode does not blindly import Claude Code's SQLite memory — export and review first:

```bash
bun packages/core/scripts/hermes-memory.ts export ~/.claude/plugins/data/choomfie-inline/choomfie.db /tmp/choomfie-memory.json
bun packages/core/scripts/hermes-memory.ts draft  /tmp/choomfie-memory.json /tmp/choomfie-memory.md
```

Review the draft before importing into Hermes memory/profile files.

## Project Structure

```text
bin/choomfie               # Hermes-first launcher
bin/choomfie-claude-code   # Claude Code mode launcher
hermes-overlay/            # SOUL.md, config.yaml, skills/, plugins/, hooks/
packages/
  shared/                  # @choomfie/shared — types + utils
  core/                    # server/supervisor/worker/daemon + lib/, skills/, scripts/, test/
plugins/                   # voice/, browser/, tutor/, socials/
docs/
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `choomfie doctor` says Hermes is missing | Install Hermes (see [Hermes Mode](#hermes-mode)) and `source ~/.bashrc`. |
| Hermes runs but Discord ignores you | Set `DISCORD_ALLOWED_USERS` in the profile `.env`, then `choomfie restart`. |
| Hermes has Discord but no model | `HERMES_HOME=~/.choomfie-hermes hermes -p choomfie model`. |
| You want Claude Code plan usage | Use `choomfie claude-code` — do not configure the Hermes Anthropic provider for this. |
| `choomfie legacy` doesn't work | Removed. Use `choomfie claude-code`. |

## Docs

- [Discord Setup](docs/discord-setup.md) · [Hermes Migration](docs/hermes-migration.md)
- [Supervisor Architecture](docs/supervisor-architecture.md) · [Voice Plugin](docs/voice-plugin.md)
- [Tutor Plugin](docs/tutor-plugin-spec.md) · [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
