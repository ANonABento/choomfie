# Choomfie Hermes Sync Roadmap

Owner: Alex
Date: 2026-05-13

## Purpose

This is the high-level parity plan for syncing mature Claude Code mode behavior into Hermes mode without rebuilding Hermes or editing core Hermes source.

Rule of thumb:

- Hermes owns gateway, sessions, delivery, cron, approvals, providers, generic tools, and platform safety.
- Choomfie owns product behavior: reminders UX, tutor flows, memory policy, voice taste, socials/browser workflows, personality defaults, and Discord-facing wording.
- Claude Code mode remains a sidecar/peer runtime for features that are not proven on Hermes yet.

## Current Runtime Split

Hermes mode already has:

- Always-on Discord gateway through Hermes.
- Profile-local Choomfie overlay under `~/.choomfie-hermes/profiles/choomfie`.
- Choomfie SOUL, skills, hooks, and starter plugins.
- Default `choomfie` Hermes personality via `/personality`.
- Lean Discord tool profile and token/session controls.
- Memory export/draft tooling from Claude Code mode SQLite.

Claude Code mode still has stronger:

- Reminder CRUD and interaction UX.
- Tutor engine, lessons, SRS, and progress.
- Voice receive/STT/TTS/VAD/interruption/multi-speaker behavior.
- Memory slash UX and direct SQLite memory operations.
- Persona CRUD and modal creation.
- Choomfie-specific socials/browser workflows.
- Discord buttons/modals/embeds for product flows.

## Priority Order

### 1. Reminders

Why first:

- High user value.
- Smallest bounded vertical slice.
- Maps naturally to Hermes `cronjob` and delivery.
- Unblocks future tutor daily review reminders.

Target:

- Hermes mode can create, list, cancel, snooze, and acknowledge Choomfie-style reminders.
- One-shot and recurring reminders use Hermes cron, not Choomfie's TypeScript timer scheduler.
- Delivery defaults to the originating Discord surface.
- Nag mode and snooze semantics are preserved as much as Hermes allows.

Detailed handoff: [choomfie-reminders-handoff.md](choomfie-reminders-handoff.md)

### 2. Memory UX

Why second:

- Memory continuity is core to Choomfie.
- The export/draft tooling now exists, so this can become operational rather than theoretical.

Target:

- Hermes mode has a clear `/memory` path or agent-mediated memory skill.
- Users can save curated facts/preferences without raw-dumping Claude Code mode rows.
- Choomfie memory policy is documented in the overlay and reinforced by skills.

Likely work:

- Add Choomfie memory skill/tool wrappers around Hermes memory.
- Add import runbook from `packages/core/scripts/hermes-memory.ts`.
- Add tests for categorization and markdown draft handling.

### 3. Tutor Vertical Slice

Why third:

- It is distinctive Choomfie behavior.
- It depends on reminders for daily review and SRS nudges.

Target:

- One language module works end-to-end in Hermes mode.
- Start/resume lesson, answer quiz, correct, retry, and persist progress.
- SRS/buttons can remain deferred until basic session state works.

Likely first slice:

- Japanese or Spanish beginner lesson.
- Store active language/level/progress in profile-local state.
- Use existing TypeScript lesson data as source material, not a long-term runtime dependency unless deliberately made into a sidecar.

### 4. Voice Evaluation

Why later:

- Larger behavior surface.
- Needs real Discord voice E2E testing.
- Hermes has voice-related paths, but parity must be measured against Choomfie's current UX.

Target:

- Decide whether Hermes can own voice, whether Choomfie should remain a voice sidecar, or whether a hybrid is needed.

Evaluation criteria:

- DAVE/E2EE behavior.
- STT latency and accuracy.
- TTS quality and streaming.
- Interruption/barge-in.
- Multi-speaker handling.
- Persona filler behavior.

### 5. Socials/Browser Workflows

Why later:

- Broad and higher-risk because it can post publicly or touch accounts.
- Hermes generic tools may cover much of it.

Target:

- Keep Choomfie-specific approvals, wording, account safety, and Discord reporting.
- Prefer Hermes generic tools unless Choomfie has a distinctive workflow.

## Non-Goals

- Do not port the old TypeScript Discord gateway into Hermes mode.
- Do not keep two schedulers for Hermes reminders.
- Do not advertise Choomfie plugin slash commands as native Discord commands unless Hermes registers plugin commands before Discord slash sync.
- Do not raw-import all old SQLite memory into Hermes.
- Do not edit core Hermes for Choomfie-specific behavior in this repo.

## Handoff Goal Prompt

Use this for the next implementation agent:

```text
You are implementing in ~/choomfie on the existing branch. Follow docs/choomfie-hermes-sync-roadmap.md and start with docs/choomfie-reminders-handoff.md. Implement the reminders vertical slice for Hermes mode using repo-local Choomfie overlay/plugins/scripts/docs only; do not edit core Hermes. Preserve Claude Code mode behavior. Keep changes minimal, reversible, and verified. Commit and push when the reminder slice is clean.
```

## Validation Baseline

Run these after each vertical slice:

```bash
git status -sb
bash -n bin/choomfie install.sh hermes-overlay/scripts/*.sh
python3 -m py_compile hermes-overlay/plugins/choomfie_commands/*.py hermes-overlay/plugins/choomfie_reminders/*.py
bun run type-check
bun run lint
git diff --check
bin/choomfie sync
bin/choomfie doctor
bin/choomfie status
```

If the slice touches live Discord/Hermes behavior, also restart and inspect logs:

```bash
bin/choomfie restart
tail -n 120 ~/.choomfie-hermes/profiles/choomfie/logs/gateway.log
```
