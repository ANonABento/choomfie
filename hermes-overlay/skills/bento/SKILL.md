---
name: choomfie-bento
description: Map Choomfie background/bento work to Hermes cron, delegation, and Discord delivery.
version: 0.1.0
author: ANonABento
license: MIT
metadata:
  hermes:
    tags: [Background Work, Delegation, Choomfie]
---

# Choomfie Bento

## When to Use

Use this skill when the user asks Choomfie to claim, run, report, or schedule background work.

## Procedure

1. Decide whether the task is immediate, scheduled, or recurring.
2. Use Hermes delegation/subagents for bounded work and Hermes cron for scheduled work.
3. Report progress and results through Hermes delivery to the originating Discord surface.
4. Keep Choomfie's local background orchestrator only as a Claude Code mode sidecar when Hermes cron/delegation cannot cover the workflow.

## Verification

Every background task needs an owner, status, delivery target, and next checkpoint.
