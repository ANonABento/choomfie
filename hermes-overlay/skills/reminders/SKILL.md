---
name: choomfie-reminders
description: Preserve Choomfie reminder UX while using Hermes cron and delivery.
version: 0.1.0
author: ANonABento
license: MIT
metadata:
  hermes:
    tags: [Reminders, Cron, Choomfie]
---

# Choomfie Reminders

## When to Use

Use this skill when creating, listing, acknowledging, snoozing, or canceling reminders.

## Procedure

1. Capture message, due time, timezone, recurrence, delivery target, ack behavior, and nag mode.
2. Use `choomfie_reminder_create` for real reminders. It creates a Hermes script-only `cronjob` and stores a profile-local Choomfie numeric id in `state/choomfie-reminders.json`.
3. Use `choomfie_reminder_list` before canceling if the user does not provide an id or if the id is ambiguous. Never guess ids.
4. Use `choomfie_reminder_cancel` for cancellation. It removes the mapped Hermes cron job and marks Choomfie state canceled.
5. Use `choomfie_reminder_snooze` for text snooze requests such as "snooze reminder 3 for 30m", "1h", or "tomorrow".
6. Use `choomfie_reminder_ack` for text ack requests such as "ack reminder 3". Ack removes any tracked nag job and marks one-shot reminders acknowledged.
7. Use the original Discord channel as the delivery target by leaving `delivery` omitted or set to `origin`. Only set an explicit delivery target when the user asks for another destination.
8. Preserve recurring reminders as recurring Hermes cron jobs, not repeated one-shot local timers.

## Verification

Supported schedules include `30m`, `in 30 minutes`, `tomorrow at 9am`, ISO timestamps, `daily at 9am`, `weekly on monday at 9am`, `monthly on day 1 at 9am`, and `every 2h`. Named daily/weekly/monthly recurrences use Hermes cron expressions in the Choomfie profile timezone. Use interval schedules such as `every 24h` for other timezone-specific recurring requests.

Native Discord reminder buttons are not exposed by this overlay. Use text commands for ack/snooze until Hermes exposes a stable profile-local interaction extension point.
