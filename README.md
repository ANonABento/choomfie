# Choomfie

Choomfie is a personal Discord agent with two first-class runtimes:

- **Hermes mode** (`choomfie`): always-on Discord gateway, persistent service lifecycle, sessions, delivery, approvals, cron, skills/plugins, and provider routing through [Hermes Agent](https://github.com/NousResearch/hermes-agent).
- **Claude Code mode** (`choomfie claude-code`, or `choomfie claude`): direct Claude Code CLI runtime. Use this when you want Choomfie to run through your Claude Code plan/CLI session instead of Hermes provider auth.

The split is intentional. Hermes is the better long-running service substrate. Claude Code mode fills the gap where you want the native Claude Code CLI path, especially for coding-agent behavior and Claude Code subscription usage. In practical terms, Claude Code mode bypasses Hermes' Anthropic provider setup and uses the already-authenticated `claude` CLI session instead.

## Which Mode Should I Use?

| Use case | Command | Why |
| --- | --- | --- |
| Always-on Discord bot | `choomfie` | Runs the Hermes gateway as a service with isolated Choomfie profile state. |
| Use Codex/OpenRouter/Anthropic/API providers through Hermes | `choomfie` | Hermes owns provider routing, sessions, cron, and delivery. |
| Use your Claude Code plan directly | `choomfie claude-code` | Runs through the Claude Code CLI path rather than Hermes' Anthropic provider runtime. |
| Need mature Choomfie voice/tutor/social/plugin behavior while Hermes parity is still evolving | `choomfie claude-code` | Claude Code mode uses the existing Bun/Claude Code worker and plugin stack. |
| Quick local Claude Code session | `choomfie claude` | Short alias for `choomfie claude-code`. |

Important distinction: Hermes can use Anthropic as a provider, but that is not the same as running inside Claude Code. Claude Code mode uses the Claude Code CLI directly; Hermes mode uses Hermes' provider/runtime layer.

## Requirements

Common:

- [Bun](https://bun.sh)
- A Discord bot token ([setup guide](docs/discord-setup.md))

For Hermes mode:

- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- At least one Hermes inference provider:
  - OpenAI Codex OAuth, Nous Portal, OpenRouter, Anthropic API key, etc.
  - This repo keeps Choomfie Hermes state isolated under `~/.choomfie-hermes`.

For Claude Code mode:

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- A signed-in Claude Code account/plan

## Install

```bash
git clone https://github.com/ANonABento/choomfie.git
cd choomfie
./install.sh
```

The installer:

- installs Bun dependencies
- prompts for a Discord bot token
- writes Claude Code mode data under `~/.claude/plugins/data/choomfie-inline`
- writes Hermes profile env under `~/.choomfie-hermes/profiles/choomfie`
- installs `choomfie` and `choomfie-claude-code` into `~/.local/bin`

If `~/.local/bin` is not on your `PATH`, reload your shell after install.

## Hermes Mode Setup

Install Hermes separately:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
hermes --version
```

Sync Choomfie's Hermes overlay:

```bash
cd ~/choomfie
choomfie sync
```

Configure the isolated Choomfie profile:

```bash
cp ~/.choomfie-hermes/profiles/choomfie/.env.EXAMPLE ~/.choomfie-hermes/profiles/choomfie/.env
$EDITOR ~/.choomfie-hermes/profiles/choomfie/.env
```

At minimum, set:

```bash
DISCORD_BOT_TOKEN=...
DISCORD_ALLOWED_USERS=your-discord-user-id
```

Then choose a Hermes model/provider:

```bash
HERMES_HOME=~/.choomfie-hermes hermes -p choomfie model
```

Good provider options:

- **OpenAI Codex**: can import existing Codex CLI credentials and stores a separate Hermes auth session.
- **OpenRouter**: broad model routing, pay-per-use.
- **Anthropic API key**: direct Anthropic billing.
- **Nous Portal**: if you use Nous subscription tooling.

Check the profile:

```bash
choomfie doctor
HERMES_HOME=~/.choomfie-hermes hermes -p choomfie doctor
```

Install and start the gateway service:

```bash
choomfie install
choomfie start
```

Useful Hermes commands:

```bash
choomfie                                      # sync overlay and start gateway service
choomfie status                               # gateway status
choomfie status --deep                        # detailed gateway status
choomfie restart                              # restart gateway service
choomfie stop                                 # stop Choomfie gateway
choomfie chat                                 # open Hermes chat with Choomfie profile
choomfie doctor                               # Choomfie overlay/profile doctor
journalctl --user -u hermes-gateway-choomfie -f
```

`choomfie stop` targets the Choomfie profile gateway. Hermes flags such as `--all` or `--system` can broaden stop scope, so check the target before confirming them.

Update flow:

```bash
hermes update --backup
cd ~/choomfie
git pull
choomfie sync
choomfie doctor
choomfie restart
```

## Hermes Cost And Session Controls

The Choomfie Hermes overlay defaults routine traffic to `gpt-5.3-codex-spark` through `openai-codex`. Use a heavier model only when a task needs it:

```bash
hermes -p choomfie chat -q "..." --model gpt-5.5 --provider openai-codex
```

To switch the default persistently:

```bash
hermes -p choomfie config set model.default <model>
hermes -p choomfie config set model.provider <provider>
```

Daily Discord token budget checks:

```bash
choomfie sync
~/.choomfie-hermes/profiles/choomfie/scripts/token-budget.sh
hermes -p choomfie insights --days 1 --source discord
```

The watcher stores the latest sample at `~/.choomfie-hermes/profiles/choomfie/state/token-budget-last-sample.txt`, warns at 2,000,000 tokens/day, and exits hard at 3,000,000 tokens/day. Override thresholds with `CHOOMFIE_TOKEN_WARN_THRESHOLD` and `CHOOMFIE_TOKEN_HARD_THRESHOLD`.

Session hygiene controls:

```text
/compress
/new
/reset
```

```bash
hermes -p choomfie sessions prune --older-than 30 --yes
```

The overlay enables `sessions.auto_prune: true`, sets `sessions.retention_days: 30`, and keeps compression enabled. For 200+ message sessions or noisy Discord threads, prefer `/compress` or a fresh session before continuing.

## Claude Code Mode Setup

Claude Code mode runs Choomfie through Claude Code's native CLI path:

```bash
choomfie claude-code
```

Short alias:

```bash
choomfie claude
```

This is the mode to use when you want Choomfie to use your Claude Code plan directly. It does not depend on Hermes' Anthropic provider path or Hermes provider auth. Internally it starts Claude Code with Choomfie's local channel/plugin loaded:

```bash
claude --plugin-dir . --dangerously-load-development-channels server:choomfie
```

On first run, configure the Discord token if the installer did not already do it:

```text
/choomfie:configure <discord-bot-token>
```

Claude Code mode options:

```bash
choomfie claude-code          # foreground Claude Code session
choomfie claude-code --tmux   # run in tmux
choomfie claude-code --daemon # Discord-only daemon backed by Agent SDK sessions
```

Claude Code mode data lives under:

```text
~/.claude/plugins/data/choomfie-inline
```

## Discord Access

Choomfie should be restricted to trusted users.

Hermes mode uses:

```bash
DISCORD_ALLOWED_USERS=123456789012345678
```

in:

```text
~/.choomfie-hermes/profiles/choomfie/.env
```

Claude Code mode uses:

```text
~/.claude/plugins/data/choomfie-inline/access.json
```

To pair another user in Claude Code mode:

1. They DM the bot `!pair`.
2. Copy the 5-letter code.
3. Run `/choomfie:access pair <code>` in Claude Code.
4. Run `/choomfie:access policy allowlist` to lock down.

Never set a public/open allow-all policy unless you intentionally want anyone who can reach the bot to interact with an agent that has tool access.

## Usage

In servers, `@mention` the bot or reply to its messages. In DMs, just talk.

### Discord Commands

Available command coverage differs by runtime while Hermes parity is still being proven.

| Command | Description |
| --- | --- |
| `/remind` | Set a reminder |
| `/reminders` | List active reminders |
| `/cancel <id>` | Cancel a reminder |
| `/memory [search]` | List or search memories |
| `/savememory` | Save a memory |
| `/github <check>` | Check PRs, issues, notifications |
| `/status` | Bot status |
| `/persona [switch]` | List or switch personas |
| `/newpersona` | Create a persona |
| `/plugins` | List, enable, or disable plugins |
| `/voice` | Voice provider setup |
| `/lesson` | Start a structured lesson |
| `/progress` | Show learning progress |
| `/help` | Show commands |

### Claude Code Skills

These are terminal slash commands for Claude Code mode:

| Skill | Description |
| --- | --- |
| `/choomfie:configure <token>` | Set Discord bot token |
| `/choomfie:access` | Manage access policy and allowlist |
| `/choomfie:memory` | View/manage memories |
| `/choomfie:status` | Full config overview |

## Architecture

### Hermes Mode

```text
Discord
  -> Hermes Discord adapter / gateway / sessions / delivery
  -> Choomfie Hermes profile, SOUL.md, skills, plugins, hooks
  -> Hermes provider routing and tools
```

Hermes owns the long-running infrastructure: gateway, reconnects, sessions, approvals, cron, delivery, and provider/model routing. Choomfie owns the product layer: personality, defaults, memory policy, reminder UX, tutor behavior, voice preferences, and workflow opinions.

### Claude Code Mode

```text
Claude Code <-- MCP stdio --> supervisor.ts (immortal)
                                  |  Bun IPC
                              worker.ts (disposable)
                                  |
                    Discord + Plugins + Tools
```

Claude Code mode owns the direct Claude Code CLI path. It is useful when you want to use your Claude Code plan/session and the mature Choomfie Bun worker/plugin behavior.

### Daemon Mode

```text
daemon.ts (immortal, Agent SDK)
  -> Claude Session (disposable, auto-cycled)
       -> supervisor.ts -> worker.ts -> Discord
```

Daemon mode is available through Claude Code mode arguments when you want Discord-only autonomous operation.

## Plugins

Plugins are strongest in Claude Code mode today. Hermes equivalents are being ported as overlay skills/plugins where it makes sense.

| Plugin | Description |
| --- | --- |
| **Voice** | Full-duplex voice chat. Local STT/TTS, VAD, interruption handling, streaming, multi-speaker behavior. |
| **Browser** | Playwright browsing: navigate, click, type, screenshot, evaluate JS. |
| **Tutor** | Language learning with structured lessons, SRS, quizzes, and module-specific tools. |
| **Socials** | YouTube, Reddit, LinkedIn workflows. |

### Voice Setup

```bash
# Local STT
brew install whisper-cpp

# Local TTS
pip install kokoro-onnx soundfile
```

Cloud voice providers can be configured with API keys in the relevant runtime env file.

## Memory Migration

Hermes mode does not blindly import Claude Code mode's SQLite memory. Export and review it first:

```bash
bun packages/core/scripts/hermes-memory.ts export ~/.claude/plugins/data/choomfie-inline/choomfie.db /tmp/choomfie-memory.json
bun packages/core/scripts/hermes-memory.ts draft /tmp/choomfie-memory.json /tmp/choomfie-memory.md
```

Review the draft before importing into Hermes memory/profile files.

## Project Structure

```text
package.json
install.sh
bin/
  choomfie                  # Hermes-first launcher
  choomfie-claude-code      # Claude Code mode launcher
hermes-overlay/
  SOUL.md
  config.yaml
  skills/
  plugins/
  hooks/
packages/
  shared/
  core/
    server.ts
    supervisor.ts
    worker.ts
    daemon.ts
    lib/
    skills/
    scripts/
    test/
plugins/
  voice/
  browser/
  tutor/
  socials/
docs/
```

## Troubleshooting

### `choomfie doctor` says Hermes is missing

Install Hermes:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
```

### Hermes starts but Discord ignores me

Set `DISCORD_ALLOWED_USERS` in:

```text
~/.choomfie-hermes/profiles/choomfie/.env
```

Then restart:

```bash
choomfie restart
```

### Hermes has Discord but no model

Run:

```bash
HERMES_HOME=~/.choomfie-hermes hermes -p choomfie model
```

### I want Claude Code plan usage

Use:

```bash
choomfie claude-code
```

That starts the Claude Code CLI runtime. Do not use Hermes Anthropic provider setup for this path.

### The old `choomfie legacy` command does not work

It was removed. Use:

```bash
choomfie claude-code
```

## Docs

- [Discord Setup](docs/discord-setup.md)
- [Hermes Migration](docs/hermes-migration.md)
- [Supervisor Architecture](docs/supervisor-architecture.md)
- [Voice Plugin](docs/voice-plugin.md)
- [Tutor Plugin](docs/tutor-plugin-spec.md)
- [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
