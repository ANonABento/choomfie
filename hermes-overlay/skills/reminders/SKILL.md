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

1. Capture message, due time, timezone, recurrence, delivery target, snooze options, ack behavior, and nag mode.
2. Prefer Hermes cron for scheduling and Hermes delivery for origin-channel or DM fallback.
3. Use the original Discord channel as the delivery target unless the user asks for DMs.
4. Preserve recurring reminders as recurring cron jobs, not repeated one-shot local timers.
5. If Hermes cannot represent a requested semantic, explain the gap and use `choomfie claude-code` for that reminder until implemented.

## Verification

Confirm the normalized schedule, timezone, delivery target, and ack/snooze/nag settings before creating the job.
