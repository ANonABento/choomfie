# Configuration

`config.json` is the single settings source for every mode. Secrets live
separately in `$CLAUDE_DATA_DIR/.env` (`DISCORD_TOKEN`, provider API keys).

## Config (config.json)

```json
{
  "activePersona": "takagi",
  "rateLimitMs": 5000,
  "convoTimeoutMs": 300000,
  "plugins": [],
  "personas": { ... },
  "voice": { "stt": "auto", "tts": "auto" },
  "model": "opus",
  "fallbackModel": "sonnet",
  "daemon": {
    "tokenThreshold": 120000,
    "turnThreshold": 80
  }
}
```

`config.json` is the single settings source for every mode. Secrets live separately in `$CLAUDE_DATA_DIR/.env` (`DISCORD_TOKEN`, provider API keys).

`model` / `fallbackModel` are **top level, not under `daemon`** — they are not daemon-specific. Both optional; omitted means Claude Code's own default. Accepts an alias (`opus`, `sonnet`, `haiku`) or a full model id.

Two readers, one value:
- `--daemon` reads it in `packages/core/daemon.ts` and passes it to the Agent SDK
- foreground and `--tmux` resolve it in `bin/choomfie` (via `packages/core/scripts/resolve-model.ts`) and pass `--model` to the `claude` CLI

They used to live at `daemon.model`, which meant `/model` silently did nothing in foreground mode — you changed it, restarted, and got the old model back. `mergeConfig` migrates the old key forward and drops it, so there is only ever one place to look. `fallbackModel` still only applies to `--daemon`; the CLI has no equivalent.

`effort` (top level, every mode) is the reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. Unset means **`medium`** — measured on a Discord chat at Claude Code's default, over half the output tokens were thinking, small talk included. The daemon passes it to each session; `bin/choomfie` passes `--effort` (read through `scripts/resolve-model.ts effort`). `/config effort high` for heavier work.

`daemon.maxSessions` (default 3) caps how many Claude sessions — one per thread, channel and DM — run at once; idle ones close first ([daemon.md](daemon.md#chats-and-sessions)). In `/config`; takes effect on the next daemon start.

`daemon` otherwise holds the cycling thresholds — read at startup by `packages/core/daemon.ts` and threaded into daemon state, so `packages/core/daemon/` never has to import `lib/`. Changes take effect on the next daemon start.

### Changing settings

`/config` (owner only) lists every adjustable setting with its current value; `/config setting:<key> value:<v>` changes one, and `value:default` restores the built-in. `/model [model] everywhere:true` is a shortcut for `model`, the setting changed most often — it routes through the same `Setting` object (`parseModel`), so the two can't disagree about validation. Without `everywhere`, in daemon mode `/model` sets one chat's model instead ([commands.md](commands.md)).

Settings are declared once in `packages/core/lib/settings.ts` with their parser, bounds, suggestions, and when the change takes effect — add a setting there and `/config` picks it up automatically (Discord caps both the choice list and autocomplete suggestions at 25).

`suggestions` are hints, not an allowlist: `write()` still accepts anything valid, so a model id newer than the file is usable the day it ships. Whatever the user has typed is offered back as the first suggestion when it isn't already in the list — Discord gives no way to submit free text once a suggestion list is showing, so without that a valid-but-unlisted value looks rejected. A test asserts every suggestion a setting offers is one its own validator accepts.

Editing `config.json` by hand still works. `ConfigManager`'s setters are what `/config` calls; **do not add a setter without a caller** — `setRateLimitMs`, `setConvoTimeoutMs` and `setDaemonConfig` sat uncalled for a long time while this file claimed settings were adjustable via tools, and they weren't.

`autoSummarize` exists in `Config` and is read by nothing. It is deliberately absent from `/config` — a switch that does nothing is worse than no switch.

## Brains (`brainChannels`, `brainAccess`)

`brainChannels` maps a channel or thread id to the brain that answers there, written by `/brain set` (absent = `claude`). Threads inherit their parent's entry unless set directly; each thread is its own backend conversation. `brainAccess` (`/config`, default `owner`) decides who a non-Claude brain answers: `owner`, or everyone on the allowlist. Anyone it turns away is answered by Claude as usual. Neither key is ever an access list: whether someone may talk to Choomfie at all is still access.json, checked first.

A brain channel only answers messages addressed to it (DM, @mention, reply). Ambient conversation-mode messages are dropped there, because a web-UI driver can't decide to stay quiet the way Claude does.

## Remote MCP endpoint (`remoteMcp`)

Lets a cloud agent — built for Ambition's Waymond, which only accepts remote MCP servers by URL — call a small allowlisted set of Choomfie tools over streamable HTTP. Code: `packages/core/lib/remote-mcp.ts`, started by the supervisor after stdio connects, or by the daemon. Off by default.

```json
"remoteMcp": {
  "enabled": true,
  "port": 4142,
  "tools": ["choomfie_status", "list_memories", "search_memory", "memory_stats", "list_reminders"]
}
```

- **Loopback only.** A non-loopback `host` is refused; expose it with a tunnel, e.g. `tailscale funnel 4142`, and give the agent `https://<machine>.<tailnet>.ts.net/mcp`.
- **Bearer token** in `<dataDir>/remote-mcp-token` (mode 0600), generated on first start. In Waymond: Integrations → MCP servers → "The server uses a token instead of a sign-in page".
- **The allowlist is the boundary.** Remote calls run with owner authority — an IPC tool call carries no Discord role — so the default is read-only. Tools not listed are neither listed nor callable. Adding `reply`, `save_memory` etc. gives the remote agent that power with no further check on Choomfie's side.
- Stateless: one `Server` + transport per POST, JSON responses, no SSE. Supervisor code, so changes need a full session restart; a bind failure (e.g. port held during a daemon session handoff) is logged and stdio carries on.
