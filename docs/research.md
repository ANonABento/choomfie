# Research & Design Decisions

## TL;DR

We evaluated Hermes Agent, OpenClaw, Max plan proxies, standalone bots, and the Claude Code plugin system. **Plugin system won** — it's Anthropic's official solution, TOS-compliant, and gives us full Claude Code power. Choomfie is built as a plugin that adds persistent memory and skills.

## Options Evaluated

### 1. Hermes Agent (NousResearch) — Rejected

[github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — 11k+ stars

Self-improving AI agent with Discord, Telegram, Slack, skills, cron, MCP. Very feature-rich.

**Why rejected:** Requires API key. Max plan not supported.

**Borrowed:** Skills system concept, self-improving memory idea.

### 2. OpenClaw — Rejected

Large community, 20+ messaging platforms, 5,400+ skills, voice, multi-agent.

**Why rejected:** Same API key requirement. Forking and replacing the LLM layer is too much work for a personal project.

**Borrowed:** Multi-channel architecture pattern.

### 3. Max Plan API Proxies — Rejected (TOS Risk)

Projects that proxy Max plan credentials as API endpoints:
- `AntonioAEMartins/claude-code-proxy`
- `NYTEMODEONLY/claude-max-proxy`
- `horselock/claude-code-proxy`
- `rynfar/opencode-claude-max-proxy`

**Why rejected:**
- Anthropic TOS Section 3.7 explicitly prohibits automated access except via API keys or "where otherwise explicitly permitted"
- Anthropic has enforced this: server-side blocks (Jan 2026), legal notices to OpenCode, account bans
- Risk of losing Max plan access is not worth it

### 4. Standalone Bot with `claude --print` — Rejected (Gray Area)

Build a Discord bot that shells out to `claude --print`.

**Why rejected:**
- `claude --print` is officially supported for personal scripting
- BUT wrapping it in a multi-user Discord bot is a gray area
- You're effectively re-sharing your subscription through a service layer
- This is exactly what Anthropic has been cracking down on

### 5. Agent SDK with Max Plan — Rejected (Explicitly Prohibited)

Use `@anthropic-ai/claude-agent-sdk` with Max plan OAuth token.

**Why rejected:**
- Agent SDK docs explicitly state: "Please use the API key authentication methods"
- Using Max plan OAuth with Agent SDK violates Consumer TOS
- Anthropic's February 2026 clarification specifically calls this out

### 6. Claude Code Plugin System — CHOSEN

Anthropic's official plugin system (shipped March 2026).

**Why chosen:**
- **Official, first-party** — designed by Anthropic specifically for this use case
- **Requires Max plan** — it's the intended auth method (API keys don't even work)
- **TOS compliant** — it IS the official client
- **Full Claude Code power** — file editing, code execution, MCP servers
- **Extensible** — custom plugins via MCP protocol
- **Security built-in** — allowlists, pairing codes, permission relay

**Trade-offs accepted:**
- Requires Claude Code terminal running (solved with tmux/screen)
- Research preview — API may change
- No daemon mode
- Feature flag issues on some Max plans (#36460)

## Memory: Letta (MemGPT) Inspiration

[github.com/letta-ai/letta](https://github.com/letta-ai/letta) — 13k stars

We borrowed Letta's two-tier memory architecture:
- **Core memory** — always in context (key-value pairs in system prompt)
- **Archival memory** — searchable long-term storage (SQLite with LIKE queries)

This is implemented as MCP tools that Claude can call during plugin sessions, not as a separate service.

## Related Projects

| Project | Stars | Relationship |
|---------|-------|-------------|
| claude-plugins-official | 14.3k | Official Anthropic plugins — our reference implementation |
| Claude-to-IM | 345 | Multi-platform bridge — different approach (Agent SDK, not plugin) |
| claude-code-discord-bot | 68 | Standalone bot — our original approach before pivoting to plugin system |
| claude-mem | 39.8k | Session memory — may integrate as complementary layer |
| Letta/MemGPT | 13k | Memory architecture — our core + archival design comes from here |
