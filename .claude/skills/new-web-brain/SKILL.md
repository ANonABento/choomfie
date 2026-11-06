---
name: new-web-brain
description: Add a chat website (Gemini, a freemium AI app, …) as a Choomfie brain via its web UI, using the @choomfie/webbrain kit — record one message, write the adapter, check it with doctor, enable it. Use when the user wants another site answering in Discord the way Waymond does.
---

# Add a web brain

Goal: `plugins/<id>/` with a small `adapter.ts`, passing `bun run webbrain doctor <id>`. Read `docs/webbrain.md` first; `plugins/waymond/adapter.ts` is the reference adapter (JSON-endpoint style).

Pick `<id>`: lowercase, digits, dashes (`gemini`). It is the brain id, plugin name and profile directory.

## 1. Record (the user does this part)

The recording needs the user at the keyboard: the browser opens visibly and they sign in and send one message by hand. Ask them to run, in this session with the `!` prefix:

```
! bun run webbrain record <id> <https url of the chat page>
```

They sign in, open a fresh chat, press Enter in the terminal, send exactly `Reply with exactly: pong`, wait for the full answer, press Enter again. Signing in here is also the login the brain will use.

The capture lands in `~/.claude/plugins/data/choomfie-inline/webbrain/<id>/recording/`. It holds the user's account data: read it, never copy it into the repo, quote only what you need.

## 2. Read the recording

- `urls.txt` — how the URL changes when a chat starts: the conversation id pattern (`CONVERSATION_RE`) and the new-chat URL.
- `network.jsonl` (`phase: "exchange"` entries) — find the request carrying `pong` in `requestBody` (the send) and the responses carrying the answer. A JSON or stream endpoint that returns the answer is the sturdy way to read it (`pageFetch` from inside the page, like Waymond). Note auth failures' status codes for `LoginRequiredError`.
- `controls-before.json` / `aria-before.txt` — the composer: prefer `aria-label`, `placeholder`, `role`, `data-testid` over classes. `controls-after.json` / `aria-after.txt` — the answer container and any "stop" button visible while generating.

## 3. Scaffold

Copy `packages/webbrain/template/*.tmpl` to `plugins/<id>/` without the `.tmpl` suffix, replacing `__ID__` (id), `__ID_CAMEL__` (camelCase id), `__LABEL__` (display name), `__ORIGIN__` (https origin). Then:

- `packages/core/lib/plugins.ts`: add `<id>: "@choomfie/<id>"` to `PLUGIN_PACKAGES`.
- Root `package.json` dependencies: `"@choomfie/<id>": "workspace:*"`; run `bun install`.

## 4. Write the adapter

Fill every `TODO` in `adapter.ts`. Rules:

- Use `t.human.type` / `t.human.submit` for input, never `fill` + `press` directly — that pacing is the anti-detection layer.
- Call `t.started(ref)` as soon as the conversation id is known.
- Throw `LoginRequiredError` for a logged-out page and `LayoutChangedError` for a missing control, so the owner gets an actionable message.
- If the site has a stop button, implement `stop(page, ref)`; if answers can carry follow-up options, return them as `choices`.
- Keep it to what the recording shows. Don't guess endpoints.

`bun run type-check` must pass.

## 5. Check it

```
bun run webbrain doctor <id>            # add --headed to watch it
```

It sends a real message in a new chat and expects `pong`. Iterate on the adapter until it passes. If the site blocks the automated browser (a captcha, "this browser may not be secure"), stop and tell the user rather than working around it.

## 6. Enable

Tell the user: `/plugins` → enable `<id>` (restarts the worker), then `/brain <id>` in a channel. Add a row for it to `docs/plugins.md`. Remind them, once, that driving a site's web UI is usually against its terms.
