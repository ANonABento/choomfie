# Web brains (`@choomfie/webbrain`)

A web brain answers Discord messages by driving a chat website in a headless browser, logged in as the owner. Waymond (Ambition) is the first. The kit in `packages/webbrain/` owns everything that isn't the site, so adding one is a single adapter file.

## Writing one

```ts
// plugins/<id>/index.ts
import { defineWebBrain } from "@choomfie/webbrain";
import { myAdapter } from "./adapter.ts";
export { myAdapter as adapter };          // `webbrain login <id>` finds it here
export default defineWebBrain(myAdapter);
```

`SiteAdapter` (`packages/webbrain/adapter.ts`) has one required method:

- **`turn(page, { text, files }, t)`** — send one message in conversation `t.ref` (undefined → start a new one) and return `{ text, ref, files?, choices?, approvals?, stopped?, background?, lastMessageId?, messageIds? }`. `files` (`{ name, data }`) are posted as attachments: use them for images or documents the answer links inside the site, since those links are dead in Discord (`pageFetchBytes` fetches one through the logged-in page). Call `t.started(ref)` as soon as the conversation id is known. Use `t.human.type()` / `t.human.submit()` for input, `t.progress(line)` for long turns, `t.notice(line)` for something the owner must act on, and check `t.stopRequested()` while waiting. Throw `LoginRequiredError` when the site wants a login, `LayoutChangedError` when a control is missing.

Optional: `stop(page, ref)` (called on the same tab while `turn` runs), `readLate(page, ref, afterId, posted)` for background results, `resolveApproval(page, ref, id, approve)`, `framePrompt(content, meta)`.

Prefer the site's own JSON endpoints for reading answers (`pageFetch(page, url)` fetches from inside the logged-in page) over scraping rendered text. Then add the package to `PLUGIN_PACKAGES` in `packages/core/lib/plugins.ts` and the root `package.json` dependencies, run `bun install`, `bun run webbrain login <id>`, enable it with `/plugins`, and `/brain <id>` in a channel.

## What the kit does

| | |
|---|---|
| **Tabs** (`tabs.ts`) | One persistent browser per site; one tab per chat. The same chat runs one turn at a time; different chats run side by side. Max 3 tabs (an idle chat's tab is reused, least recently used first; if all are busy, the next waits). The browser closes after 10 min idle. |
| **Launch** (`engine/launch.ts`) | Two engines. **patchright** (default): installed Chrome (bundled Chromium as fallback); headless, it relaunches once with "HeadlessChrome" taken out of the user agent. **cloak**: CloakBrowser, a Chromium with source-level fingerprint patches — needs a license key (`npx cloakbrowser login`, free with an email, **one browser at a time**; more is paid). Per site: config.json `"webbrain": { "<id>": { "engine": "cloak" } }`, else the adapter's `engine`. Each engine has its own profile (`<data>/webbrain/<id>/profile`, `profile-cloak`), so switching means logging in again. Real window size, the machine's locale and timezone, the same every launch — no fingerprint rotation: consistency matters more than randomness for a logged-in account. |
| **Pacing** (`engine/human.ts`) | Short messages typed with jittered key timing; long or multi-line ones pasted (Enter sends in most composers). Submits to one site are spaced ≥1.5s plus jitter across all its tabs. |
| **Discord** (`define.ts`) | Typing indicator; one self-updating status line after 45s; attachments copied under their original names; prompts from non-owners say who is talking; stopped / background answers say so. |
| **Chats** | The conversation id is stored on the chat record (`ctx.chats`), so `/resume` and `/clear` work for every web brain. |
| **Late results** (`watch.ts`) | After a `background` answer, polls `readLate` every minute for up to 3h and posts what lands. In memory: a restart drops the watch. |

## Adding a site from a recording

The `new-web-brain` skill (`.claude/skills/new-web-brain/`) walks a Claude Code session through it: `webbrain record`, read the capture, copy `packages/webbrain/template/`, write the adapter, `webbrain doctor` until it passes, enable. For sites with no JSON endpoint to poll, `waitForSettledText` treats the answer as done once its text stops changing and the site's busy marker (a stop button) is gone.

## Owner commands

- `bun run webbrain login <id>` — opens the site headed on its profile; sign in, close the window. Refuses while the profile is open elsewhere (Chrome's `SingletonLock`).
- `bun run webbrain record <id> <url>` — headed, on `<id>`'s profile (so signing in here is the login). You send `Reply with exactly: pong` by hand; it writes `network.jsonl` (fetch/XHR/stream entries with clipped request and response bodies, **no headers**), `controls-*.json` and `aria-*.txt` (selector material, before and after), `urls.txt` and `meta.json` to `<data>/webbrain/<id>/recording/`. That holds account data: it stays in the data dir, never the repo.
- `bun run webbrain doctor <id> [--headed]` — one real round trip through the adapter in a new chat; passes when the answer contains `pong`. Exit code 0/1. Sends a real message.
- `bun run webbrain doctor <id> --detect [--engine patchright|cloak|all] [--headed]` — how botty the engine looks, on a throwaway profile (never the logged-in one): our probes (`navigator.webdriver`, Headless in the user agent or client hints, software GPU, plugins, zero-size window, UA vs client-hint platform, contradictory notification permission, `window.chrome`) plus bot.sannysoft.com's failed rows. Exit 1 on any tell.
- `CHOOMFIE_<ID>_HEADED=1` — run that site's browser visibly, for debugging.

A site that kept state in `<data>/<id>/` before the kit (Waymond) has it moved to `<data>/webbrain/<id>/` on first start.

## Caveat

Automating a site's web UI is usually against its terms, and an account can be flagged whatever the tooling. Patchright and CloakBrowser lower detection, they don't remove it. Where a site has an official API, use that instead.
