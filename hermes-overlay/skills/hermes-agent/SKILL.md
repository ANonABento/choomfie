---
name: hermes-agent
description: Concise Choomfie-local reference for Hermes Agent setup, configuration, gateway lifecycle, tools, skills, sessions, and troubleshooting.
version: 0.1.0
author: ANonABento
license: MIT
metadata:
  hermes:
    tags: [Hermes, Choomfie, Gateway, Configuration]
---

# Hermes Agent

Use this skill when the user asks how Hermes works or needs help with Hermes setup, profiles, models, providers, tools, skills, gateway, sessions, cron, or troubleshooting.

## Choomfie Runtime Shape

Choomfie runs Hermes through an isolated profile:

```bash
HERMES_HOME=~/.choomfie-hermes hermes -p choomfie ...
```

The `choomfie` wrapper is the preferred lifecycle UX. It syncs the Choomfie overlay and delegates to Hermes:

```bash
choomfie status
choomfie status --deep
choomfie start
choomfie restart
choomfie stop
choomfie chat
choomfie doctor
```

## Common Hermes Commands

```bash
hermes -p choomfie model
hermes -p choomfie config path
hermes -p choomfie config set model.default gpt-5.3-codex-spark
hermes -p choomfie config set model.provider openai-codex
hermes -p choomfie tools list --platform discord
hermes -p choomfie skills list
hermes -p choomfie sessions list --source discord --limit 20
hermes -p choomfie sessions prune --older-than 30 --yes
hermes -p choomfie insights --days 1 --source discord
```

## Troubleshooting Rules

1. Prefer `choomfie ...` for Choomfie gateway lifecycle.
2. Prefer `hermes -p choomfie ...` for direct runtime inspection.
3. Do not use unprofiled Hermes commands when inspecting Choomfie state.
4. Keep explanations short first, then offer deeper detail.
5. If a command changes live gateway state, say what it will affect before running it.
