# Ryuji

Personal AI agent powered by Claude Code CLI. Uses your Max plan — no API key needed.

## Features

- **Discord bot** — chat with Ryuji in your server
- **Terminal REPL** — interactive chat in your terminal
- **Persistent memory** — Letta-inspired core + archival memory (SQLite)
- **Skills system** — extensible tool/skill registry
- **Claude Code CLI** — full agentic capabilities via Agent SDK

## Setup

```bash
npm install
cp .env.example .env
# Add your Discord bot token to .env
```

## Usage

```bash
# Terminal chat
npm run terminal

# Discord bot
npm run discord

# Both
npm run dev
```

## Terminal Commands

- `/memory` — show core memories
- `/remember key=value` — save a memory

## Architecture

```
src/
├── core/agent.ts        # Claude Code CLI wrapper
├── discord/bot.ts       # Discord adapter
├── terminal/repl.ts     # Terminal REPL
├── memory/store.ts      # SQLite memory (core + archival)
├── skills/registry.ts   # Skill/tool system
└── index.ts             # Entry point
```
