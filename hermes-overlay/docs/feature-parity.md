# Choomfie Hermes Feature Parity

Status key: Hermes-owned, Choomfie-owned, sidecar, deferred, retired.

| Capability | Status | Evidence / next step |
| --- | --- | --- |
| Discord gateway, reconnect, typing, sessions, delivery | Hermes-owned | `choomfie` launches `hermes -p choomfie gateway start` with isolated `CHOOMFIE_HERMES_HOME`. |
| Claude Code mode | sidecar/peer runtime | `choomfie claude-code`, `choomfie claude`, and `bin/choomfie-claude-code` expose the direct Claude Code CLI path. |
| Personality/defaults | Choomfie-owned | `SOUL.md`, `config.yaml`, and Choomfie skills are distribution-owned overlay files. |
| `/status` and `/help` | Choomfie-owned on Hermes | `choomfie_commands` plugin exposes status/help tools; full Discord slash registration still needs live Hermes validation. |
| `/memory` | deferred | Export/import tooling exists; curated Hermes memory write path needs a live Hermes memory provider choice. |
| `/personality` / `/persona` | partial | Hermes mode uses native `/personality` plus `agent.personalities`, not the old Claude Code mode persona CRUD store. The default `choomfie` personality is configured; `/persona`, `/newpersona`, and modal CRUD remain Claude Code mode only unless Hermes supports pre-Discord plugin command registration. |
| `/lesson` tutor flow | Choomfie-owned scaffold | Tutor skill and plugin cover start/resume/quiz/correct/retry contract; full SRS/buttons remain strongest in Claude Code mode until ported. |
| `/voice` | sidecar/deferred | Keep Claude Code mode voice until manual Hermes voice evaluation proves DAVE/E2EE, STT/TTS, streaming, interruption, and multi-speaker parity. |
| Reminders | Choomfie-owned on Hermes cron scaffold | Reminder skill and plugin normalize UX to Hermes cron/delivery; live cron creation and buttons need Hermes E2E. |
| Bento/background work | Choomfie-owned workflow | Skill maps claiming/reporting to Hermes cron/delegation/delivery. |
| Browser/socials/GitHub | mixed | Prefer Hermes generic tools; keep Choomfie-specific approvals and Discord UX. |

## Manual E2E Checks

- Start: `choomfie doctor`, then `choomfie`.
- Discord text: DM, server mention, reply, thread reply, typing indicator, safe mentions, and session persistence.
- Slash/command UX: `/status`, `/help`, `/memory`, `/persona`, `/lesson`, `/voice`, reminder create/list/cancel.
- Approvals: trigger a risky command and verify Discord approval UI or Hermes approval fallback.
- Reminders: one-shot, recurring, snooze, ack, nag mode, original-channel delivery, DM fallback.
- Voice: receive, DAVE/E2EE, STT latency/accuracy, TTS quality, streaming, interruption/barge-in, multi-speaker behavior, persona fillers.
