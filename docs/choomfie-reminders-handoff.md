# Handoff: Choomfie Reminders On Hermes

Owner: Alex
Date: 2026-05-13

## Objective

Port the first real Choomfie vertical slice into Hermes mode: reminders.

Hermes mode should preserve Choomfie's reminder UX while using Hermes infrastructure:

- Hermes `cronjob` for scheduling.
- Hermes delivery for Discord/origin-channel/DM delivery.
- Choomfie overlay plugin/skills for normalization and product semantics.
- No core Hermes edits.
- No duplicate TypeScript timer scheduler in Hermes mode.

## Current State

Claude Code mode has mature reminder behavior:

- Slash commands:
  - `/remind`
  - `/reminders`
  - `/cancel <id>`
- Tools:
  - `set_reminder`
  - `list_reminders`
  - `cancel_reminder`
  - `snooze_reminder`
  - `ack_reminder`
- Storage:
  - SQLite `reminders` table in `~/.claude/plugins/data/choomfie-inline/choomfie.db`.
- Runtime:
  - `ReminderScheduler` in `packages/core/lib/reminders.ts`.
  - Long-timeout support beyond JavaScript timer ceiling.
  - Recurring schedules: `hourly`, `daily`, `weekly`, `monthly`, `every Xm/h/d`.
  - Nag mode via `nag_interval`.
  - Ack/snooze buttons via `packages/core/lib/handlers/reminder-buttons.ts`.

Hermes mode implementation in this repo:

- Skill: `hermes-overlay/skills/reminders/SKILL.md`.
- Plugin: `hermes-overlay/plugins/choomfie_reminders`.
- Tools:
  - `choomfie_reminder_plan`
  - `choomfie_reminder_create`
  - `choomfie_reminder_list`
  - `choomfie_reminder_cancel`
  - `choomfie_reminder_snooze`
  - `choomfie_reminder_ack`
- State: `~/.choomfie-hermes/profiles/choomfie/state/choomfie-reminders.json` maps Choomfie numeric ids to Hermes cron job ids, generated script paths, and reminder metadata.
- Delivery jobs use Hermes `cronjob` with `no_agent=True` and a generated profile-local script under `~/.choomfie-hermes/profiles/choomfie/scripts/choomfie-reminders/`. This avoids LLM/tool recursion during reminder delivery and sends the exact reminder text through Hermes delivery.
- Listing reminders reconciles active one-shot Choomfie records against Hermes cron. If Hermes has already removed a delivered one-shot job, Choomfie marks it `fired`, records `last_fired_at`, and removes the generated script.

Current known limits:

- Native Discord slash commands are not used for Hermes reminders because plugin command registration is not available before Hermes slash sync.
- Native Discord buttons are not implemented in the overlay; use text commands such as "ack reminder 3" and "snooze reminder 3 for 1h".
- Nag support is represented in profile-local metadata. There is not yet a Hermes fired-reminder callback in this overlay that can create a separate post-fire nag job.
- DM delivery is only safe when the reminder is created from the target DM/origin context. The overlay does not infer arbitrary DM targets.

Hermes primitives available:

- `cronjob` tool:
  - `action=create|list|update|pause|resume|remove|run`
  - `schedule`: `30m`, `every 2h`, cron expression, or ISO timestamp.
  - `deliver`: omit for current chat/origin when called from the originating conversation, or use explicit targets like `discord:<channel_id>:<thread_id>`.
  - `repeat`: optional repeat count.
  - `skills`: optional skills to load before prompt execution.
  - `no_agent=True` plus `script` for script-only jobs.
- `send_message` tool:
  - `action=list|send`
  - target examples: `discord:#channel`, `discord:<channel_id>`, `discord:<channel_id>:<thread_id>`.

## Product Contract

### Create

When the user asks for a reminder, Choomfie must capture:

- message
- due time
- timezone
- recurrence
- delivery target
- whether ack is required
- snooze options
- nag mode

Default delivery target:

- Originating Discord surface when possible.
- DM only when user asks for DM delivery or origin is unavailable.

Default behavior:

- One-shot reminders should fire once.
- Recurring reminders should use recurring Hermes cron, not repeated one-shots.
- Nag reminders should re-ping until acked if that can be represented safely.

### List

Users should be able to ask what reminders exist and see:

- id
- message
- next run
- recurrence
- delivery target
- nag/ack state when tracked

### Cancel

Users should be able to cancel by id.

Never guess ids. If the id is missing or ambiguous, list first.

### Snooze

Target UX:

- Support common Choomfie snooze options:
  - 30 minutes
  - 1 hour
  - tomorrow
- If Hermes cannot update the exact job safely, create a new one-shot and remove/pause the fired job when appropriate.

### Ack

Target UX:

- Acknowledge fired/nagging reminders so they stop nagging.
- If Hermes cannot track ack state natively, implement profile-local Choomfie state for fired/nagging reminder records.

## Recommended Implementation Shape

### Phase 1: Real Create/List/Cancel Over Hermes Cron

Keep scope narrow. Implement the first useful slice before buttons/nag:

1. Replace or extend `choomfie_reminder_plan` with real reminder tools:
   - `choomfie_reminder_create`
   - `choomfie_reminder_list`
   - `choomfie_reminder_cancel`
2. Use `ctx.dispatch_tool("cronjob", ...)` from the plugin instead of shelling out.
3. Store a small profile-local index under:

```text
~/.choomfie-hermes/profiles/choomfie/state/choomfie-reminders.json
```

The index should map Choomfie reminder ids to Hermes cron job ids and metadata:

```json
{
  "version": 1,
  "next_id": 2,
  "reminders": [
    {
      "id": 1,
      "cron_job_id": "...",
      "message": "check deploy",
      "schedule": "30m",
      "timezone": "America/Toronto",
      "delivery": "origin",
      "recurrence": null,
      "nag_interval": null,
      "created_at": "2026-05-13T00:00:00Z",
      "state": "scheduled"
    }
  ]
}
```

Reason for the Choomfie index:

- Hermes cron ids are opaque.
- Choomfie users expect small numeric reminder ids.
- Listing and canceling should not require parsing arbitrary Hermes cron job names.

Create jobs are script-only Hermes cron jobs. The generated script should be self-contained and print the reminder text:

```python
print("Reminder: <message>")
```

Do not attach `skills=["choomfie-reminders"]` to reminder delivery jobs. Live testing showed that cron-run skill loading did not find the local skill and LLM-driven delivery could recursively call reminder creation tools.

Acceptance:

- Create a one-shot reminder in Hermes mode.
- `choomfie_reminder_list` shows it.
- `choomfie_reminder_cancel` removes the corresponding Hermes cron job and marks Choomfie state canceled.
- Claude Code mode reminder files are untouched.

Implemented in `hermes-overlay/plugins/choomfie_reminders`.

### Phase 2: Recurrence And Timezone Normalization

Add normalization helpers in `hermes-overlay/plugins/choomfie_reminders/tools.py`:

- Normalize schedules accepted by Choomfie:
  - `in 30 min`
  - `30m`
  - `tomorrow at 9am`
  - ISO timestamps
  - `daily`
  - `weekly`
  - `monthly`
  - `every 2h`
- Prefer Hermes-supported schedule strings directly when possible.
- Preserve timezone in metadata even when Hermes schedule stores an absolute value or interval.

Acceptance:

- Recurring `daily` or `every 2h` reminders create interval/cron Hermes jobs.
- Listing clearly marks recurring reminders.
- Invalid timezone or unparseable schedule returns a clear error.

Implemented normalization currently supports `30m`, `in 30 minutes`, `tomorrow at 9am`, ISO timestamps, `daily at 9am`, `weekly on monday at 9am`, `monthly on day 1 at 9am`, and `every 2h`. The live Hermes profile has cron-expression support, so named daily/weekly/monthly reminders are stored as Hermes cron expressions in the Choomfie profile timezone. Other timezone-specific recurring requests should use an interval such as `every 24h` until Hermes exposes per-job timezone handling.

### Phase 3: Snooze/Ack/Nag State

Only after Phase 1/2 works:

1. Add tools:
   - `choomfie_reminder_snooze`
   - `choomfie_reminder_ack`
2. Add state fields:
   - `ack_required`
   - `acknowledged_at`
   - `last_fired_at`
   - `nag_interval`
   - `nag_job_id`
3. Decide nag implementation:
   - Preferred: separate recurring Hermes cron job created only after a reminder fires.
   - Simpler fallback: create nag jobs directly when user requests nag mode, with self-contained prompt and explicit stop instructions.

Important:

- Do not leave orphan nag jobs after ack/cancel.
- List should show nagging reminders separately if state supports it.

Implemented text ack/snooze and local nag metadata. Separate post-fire nag jobs remain deferred until Hermes exposes a stable fired-reminder callback for profile plugins.

### Phase 4: Discord UX

Native plugin slash command registration is not reliable today because Hermes syncs Discord slash commands before plugin commands are available. Do not depend on plugin slash commands.

Options:

1. Agent-mediated UX:
   - User asks naturally: "remind me in 30 minutes to check deploy".
   - Agent calls Choomfie reminder tools.
2. Hermes native command fallback:
   - If Hermes later supports pre-sync plugin commands, add native `/remind`, `/reminders`, `/cancel`.
3. Button UX:
   - Only implement if Hermes exposes a stable interaction/button extension point in the Choomfie profile context.
   - Otherwise keep ack/snooze as text commands: "ack reminder 3", "snooze reminder 3 for 1h".

## Files To Touch

Expected:

- `hermes-overlay/plugins/choomfie_reminders/__init__.py`
- `hermes-overlay/plugins/choomfie_reminders/tools.py`
- `hermes-overlay/plugins/choomfie_reminders/plugin.yaml`
- `hermes-overlay/skills/reminders/SKILL.md`
- `hermes-overlay/docs/feature-parity.md`
- `README.md` if user-facing behavior changes.

Optional:

- `docs/choomfie-hermes-sync-roadmap.md`
- New tests under `tests/` or `packages/core/test/` only if they can run without Hermes internals.

Do not touch:

- Core Hermes source under `~/.hermes/hermes-agent`.
- Claude Code mode reminder scheduler unless preserving compatibility requires docs only.
- Live Choomfie state files except through `bin/choomfie sync` and live validation.

## Test Plan

Static checks:

```bash
bash -n bin/choomfie install.sh hermes-overlay/scripts/*.sh
python3 -m py_compile hermes-overlay/plugins/choomfie_reminders/*.py
git diff --check
```

Plugin discovery:

```bash
HERMES_HOME=~/.choomfie-hermes hermes -p choomfie plugins list
```

Profile sync:

```bash
bin/choomfie sync
bin/choomfie doctor
```

Live gateway:

```bash
bin/choomfie restart
bin/choomfie status
tail -n 120 ~/.choomfie-hermes/profiles/choomfie/logs/gateway.log
```

Manual Hermes-mode reminder checks:

1. DM Choomfie: "remind me in 2 minutes to test Hermes reminders".
2. Confirm it reports a Choomfie reminder id.
3. Ask: "list my reminders".
4. Ask: "cancel reminder <id>".
5. Create another 2-minute reminder and let it fire.
6. Confirm delivery lands in the originating Discord surface.

## Risks

- Hermes cron `deliver=origin` only works when created from the originating conversation. If reminder creation happens outside a gateway session, explicit delivery targets are required.
- Hermes plugin commands are not reliable as native Discord slash commands today.
- Recurrence and timezone semantics may not exactly match Choomfie's TypeScript natural-time parser.
- Ack/snooze buttons may need Hermes-side interaction support that is not available through repo-local plugin APIs.
- Reminder delivery cron jobs are script-only (`no_agent=True`) so they do not rely on current chat history and cannot recursively call Choomfie reminder tools.

## Definition Of Done

- Hermes Choomfie can create/list/cancel one-shot reminders via Choomfie plugin tools.
- Reminder state is profile-local and maps Choomfie ids to Hermes cron job ids.
- The implementation uses Hermes cron/delivery rather than a new scheduler.
- Docs accurately state which reminder features are live and which remain deferred.
- Static validation passes.
- Live gateway restarts cleanly.
- At least one manual reminder is created, listed, canceled, and one is allowed to fire in Discord.

## Live Validation Notes

- Script-only Discord delivery was verified with Hermes cron job `450a7b3d3754`; its output file contained `Reminder: codex script-only discord reminder smoke 2026-05-14-0033`, and `agent.log` recorded delivery to `discord:123456789012345678` via the live adapter.
- The earlier LLM-driven live test (`394441a2268a`) exposed why reminder jobs must not attach `skills=["choomfie-reminders"]`: the cron run could not resolve the local skill and then recursively called `choomfie_reminder_create`.
- Fired one-shot reconciliation was verified with live profile job `627c022b027a`: after removing the Hermes cron job directly, `choomfie_reminder_list` returned zero active reminders and history showed the Choomfie record as `fired`.
- Named recurrence was verified with live profile job `4d1735747089`: `daily at 9am` created Hermes schedule `0 9 * * *`, produced next run `2026-05-14T09:00:00-04:00`, listed correctly, then canceled and left no scheduled jobs.
- The exact user-originated Discord natural-language flow was verified from the allowed `Alex` Discord DM on `2026-05-13`: "remind me in 3 mins to test hermes reminders" created Choomfie id `1` / Hermes job `dd83b3b4771e`, "list my reminders" invoked `choomfie_reminder_list`, "cancel reminder 1" removed the cron job, and "remind me in 30 seconds to test hermes delivery" was retried as the supported minimum `1m`, creating Choomfie id `2` / Hermes job `9a55206feea5`. The job fired at `2026-05-13 22:04:56 EDT`, cron output contained `Reminder: test hermes delivery`, `agent.log` recorded delivery to `discord:123456789012345678` via the live adapter, and reconciliation marked id `2` fired and removed the generated script.

## Handoff Goal Prompt

Use this for the next implementation agent:

```text
You are implementing in ~/choomfie on the existing branch. Follow docs/choomfie-reminders-handoff.md. Build Phase 1 first: real Hermes-mode Choomfie reminder create/list/cancel using repo-local hermes-overlay/plugins/choomfie_reminders and Hermes cronjob dispatch. Do not edit core Hermes. Preserve Claude Code mode reminder behavior. Keep changes minimal and reversible, update docs to match live behavior, run the listed validations, restart Choomfie, and commit/push only after the slice works.
```
