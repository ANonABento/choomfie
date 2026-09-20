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

`daemon` now holds only the cycling thresholds — read at startup by `packages/core/daemon.ts` and threaded into daemon state, so `packages/core/daemon/` never has to import `lib/`. Changes take effect on the next daemon start.

### Changing settings

`/config` (owner only) lists every adjustable setting with its current value; `/config setting:<key> value:<v>` changes one, and `value:default` restores the built-in. `/model [model]` is a shortcut for `model`, the setting changed most often — it routes through the same `Setting` object, so the two can't disagree about validation.

Settings are declared once in `packages/core/lib/settings.ts` with their parser, bounds, suggestions, and when the change takes effect — add a setting there and `/config` picks it up automatically (Discord caps both the choice list and autocomplete suggestions at 25).

`suggestions` are hints, not an allowlist: `write()` still accepts anything valid, so a model id newer than the file is usable the day it ships. Whatever the user has typed is offered back as the first suggestion when it isn't already in the list — Discord gives no way to submit free text once a suggestion list is showing, so without that a valid-but-unlisted value looks rejected. A test asserts every suggestion a setting offers is one its own validator accepts.

Editing `config.json` by hand still works. `ConfigManager`'s setters are what `/config` calls; **do not add a setter without a caller** — `setRateLimitMs`, `setConvoTimeoutMs` and `setDaemonConfig` sat uncalled for a long time while this file claimed settings were adjustable via tools, and they weren't.

`autoSummarize` exists in `Config` and is read by nothing. It is deliberately absent from `/config` — a switch that does nothing is worse than no switch.
