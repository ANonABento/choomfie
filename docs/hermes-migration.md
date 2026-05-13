# Hermes Migration

Choomfie now has a Hermes-first overlay while Claude Code mode remains available as a first-class runtime for the direct Claude Code CLI path.

## Commands

```bash
choomfie              # sync overlay, then start Hermes gateway
choomfie chat         # sync overlay, then open Hermes chat
choomfie doctor       # check Hermes CLI, overlay, profile, and Discord token
choomfie sync         # copy overlay into isolated Hermes state
choomfie claude-code  # start the Claude Code-powered runtime
choomfie claude       # short alias for claude-code
```

Hermes state is isolated under `~/.choomfie-hermes` by default. Override with `CHOOMFIE_HERMES_HOME` if needed.

## Setup

1. Install Hermes separately.
2. Run `choomfie sync`.
3. Copy `~/.choomfie-hermes/profiles/choomfie/.env.EXAMPLE` to `.env`.
4. Set `DISCORD_BOT_TOKEN` and your Hermes model provider keys.
5. Run `choomfie doctor`.
6. Run `choomfie`.

## Memory Migration

Export Claude Code mode Choomfie memory:

```bash
bun packages/core/scripts/hermes-memory.ts export path/to/choomfie.db /tmp/choomfie-memory.json
bun packages/core/scripts/hermes-memory.ts draft /tmp/choomfie-memory.json /tmp/choomfie-memory.md
```

Review the markdown draft before importing into Hermes. The export categorizes rows into profile facts, preferences, relationship context, recurring workflows, and durable long-term notes. It deliberately does not dump every row blindly into Hermes.

## Deferred Until E2E

Voice, full Discord slash command registration, reminder buttons, persona switching, and full tutor SRS/buttons remain strongest in `choomfie claude-code` until live Hermes parity is proven.

See [feature parity](../hermes-overlay/docs/feature-parity.md).
