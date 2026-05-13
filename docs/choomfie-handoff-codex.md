# Handoff: Choomfie + Hermes hardening rollout

Owner: Alex
Date: 2026-05-13

## Context snapshot
- Wrapper entrypoint in this repo is at `~/choomfie/bin/choomfie`.
- `choomfie` currently routes:
  - no args / `gateway` -> `hermes gateway start`
  - other args -> generic `hermes <args>` via `hermes_cmd`
- `hermes -p choomfie gateway status --deep` currently shows running service
  `hermes-gateway-choomfie.service`.
- Profile settings in `~/.choomfie-hermes/profiles/choomfie/config.yaml` currently have:
  - `sessions.auto_prune: false`
  - `sessions.retention_days: 90`
  - `compression.enabled: true`, `threshold: 0.5`, `target_ratio: 0.2`, `protect_last_n: 20`
- Recent token burn from `hermes -p choomfie insights --days 1 --source discord`:
  - **4,743,138** total tokens (single-model day), 6 sessions, 322 msgs.
- `hermes -p choomfie tools list` currently shows enabled: `web/browser/terminal/file/code_execution/vision/image_gen/tts/skills/todo/memory/session_search/clarify/delegation/cronjob/messaging/computer_use`.
- Local Choomfie skills: `choomfie-bento`, `choomfie-reminders`, `choomfie-socials-browser`, `choomfie-tutor`.

## What should be implemented

### Phase 1 — Wrapper behavior and UX parity
Goal: make `choomfie` safer/easier by exposing common gateway lifecycle commands without forcing users to remember Hermes invocation.

1. Update `~/choomfie/bin/choomfie` command parsing:
   - Add explicit cases:
     - `stop` => `hermes_cmd gateway stop "$@"` (or if no args and env suggests strict scope maybe keep passthrough)
     - `status` => `hermes_cmd gateway status "$@"`
     - `restart` => `hermes_cmd gateway restart "$@"`
     - `install` => `hermes_cmd gateway install "$@"`
     - `uninstall` => `hermes_cmd gateway uninstall "$@"`
     - `list` => `hermes_cmd gateway list "$@"`
     - `setup` => `hermes_cmd gateway setup "$@"`
     - `migrate-legacy` => `hermes_cmd gateway migrate-legacy "$@"`
   - Keep existing semantics:
     - default/no-arg remains gateway start
     - `gateway` keyword remains start
     - passthrough fallback remains `hermes_cmd "$@"`
   - Add/keep usage text for these commands.

2. Add a safety note for stop scope in the `stop` path (document that `--all`/`--system` can escalate scope).

3. Smoke test:
   - `choomfie status`
   - `hermes -p choomfie gateway status --deep`
   - `choomfie stop --system` (confirm with stop confirmation in test env)
   - `choomfie start`

### Phase 2 — cost control policy (token budget)
Goal: reduce accidental spend and make budget posture obvious.

1. In profile config (`~/.choomfie-hermes/profiles/choomfie/config.yaml`):
   - Set default model to cheaper default (you choose policy target; currently `gpt-5.3-codex-spark`).
   - Add/verify provider/provider aliases for heavy model only when explicitly requested.

2. Add a budget watcher (cron or script) under repo or local profile:
   - Run command:
     - `hermes -p choomfie insights --days 1 --source discord`
   - Parse total tokens and model mix.
   - Alert when daily discord tokens exceed threshold (initial suggested hard stop: **3,000,000/day** and warning at **2,000,000/day**).
   - Optionally auto-send reminders through local cron + Discord if desired.
   - Store last sample in a file for trending.

3. Add a lightweight runbook section in `~/choomfie/README.md`:
   - one-off switch: `hermes -p choomfie chat -q "..." --model gpt-5.5 --provider openai-codex`
   - persistent switch:
     - `hermes -p choomfie config set model.default <model>`
     - `hermes -p choomfie config set model.provider <provider>`
   - clear/budget controls:
     - `/compress`
     - `/new` or `/reset`
     - `hermes -p choomfie sessions prune --older-than 30 --yes`

### Phase 3 — session and hygiene hardening
Goal: avoid session DB growth and keep context quality consistent.

1. Enable pruning default or schedule cron:
   - `~/.choomfie-hermes/profiles/choomfie/config.yaml` → `sessions.auto_prune: true`
   - `sessions.retention_days` to `30` or `45`.
   - runbook command:
     - `hermes -p choomfie sessions prune --older-than 30 --yes`

2. Keep `compression.enabled: true` as-is; add periodic human reminder for long threads:
   - after 200+ message sessions, prefer `/compress` or `/new` on noisy prompts.

### Phase 4 — diagnostic hardening
Goal: reduce repeated warning noise and command misuse loops.

1. Expand `choomfie doctor` checks:
   - flag if `~/.choomfie-hermes/profiles/choomfie/config.yaml` has `sessions.auto_prune: false` and `tools` intentionally limited.
   - flag if gateway profile has no user allowlist or open user access is inadvertently enabled.

2. Standardize wrapper command path in docs to avoid confusion:
   - which commands should be `choomfie ...` vs `hermes ...`.

## Suggested implementation order
1. Edit `bin/choomfie` (small CLI shell changes)
2. Update docs + usage text (`README.md`)
3. Adjust config defaults for sessions
4. Add optional threshold watcher script + cron
5. Validate with dry runs + restart gateway

## Test matrix (must pass)
- `bash -n ~/choomfie/bin/choomfie`
- `choomfie --help`
- `choomfie status`
- `hermes tools list` from installed wrapper env
- `hermes -p choomfie sessions prune --older-than 30 --yes` (on staging copy DB first)
- `hermes -p choomfie insights --days 1 --source discord`
- gateway status/deep before+after changes

## Notes for implementation model (5.5 codex)
- Do not alter core Hermes source for this ticket.
- Focus repo-local changes under `~/choomfie` + `~/.choomfie-hermes/profiles/choomfie`.
- Avoid changing CLI global behavior outside Choomfie docs and wrapper.

## Open items to confirm before execution
1. Target default model for Choomfie routine traffic?
2. Daily token budget threshold for warning vs hard alert?
3. Auto-prune enabled immediately or staged (with manual prune first)?
