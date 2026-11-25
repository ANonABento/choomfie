# Web brains (`@choomfie/webbrain`)

A web brain answers Discord messages by driving a chat website in a headless browser, logged in as the owner. Waymond (Ambition) is the first. The kit in `packages/webbrain/` owns everything that isn't the site, so adding one is a single adapter file.

## Writing one

A site is one adapter file in the `webbrains` plugin:

```ts
// plugins/webbrains/sites/<id>.ts → export const myAdapter: SiteAdapter = { … }
// plugins/webbrains/index.ts
export const adapters: SiteAdapter[] = [geminiAdapter, myAdapter];   // `webbrain login <id>` finds them here
export default defineWebBrains("webbrains", adapters);
```

`defineWebBrains` registers each site whose profile has been logged in (`bun run webbrain login <id>`); one never logged in is skipped, and config.json `"webbrain": { "<id>": { "enabled": false } }` turns one off. A site with much more than an adapter (Waymond: tools, approval cards, plan boards) is its own plugin with `defineWebBrain(adapter)` and `export { adapter }`.

`SiteAdapter` (`packages/webbrain/adapter.ts`) has one required method:

- **`turn(page, { text, files }, t)`** — send one message in conversation `t.ref` (undefined → start a new one) and return `{ text, ref, files?, choices?, approvals?, stopped?, background?, lastMessageId?, messageIds? }`. `files` (`{ name, data }`) are posted as attachments (a reply can be files alone, no text): use them for images or documents the answer links inside the site, since those links are dead in Discord (`pageFetchBytes` fetches one through the logged-in page). Call `t.started(ref)` as soon as the conversation id is known. Use `t.human.type()` / `t.human.submit()` for input, `t.log(event, detail)` for what you waited on or skipped (the turn log), `t.progress(line)` for long turns, `t.notice(line)` for something the owner must act on, and check `t.stopRequested()` while waiting. Throw `LoginRequiredError` when the site wants a login, `LayoutChangedError` when a control is missing, and `QuotaReachedError` (re-exported from `@choomfie/shared`) when the site says the daily or weekly allowance is spent: pass `parseResetAt(theSitesWords)` as the reset time so free benches the brain until then instead of counting failures.

Optional: `stop(page, ref)` (called on the same tab while `turn` runs), `readLate(page, ref, afterId, posted)` for background results, `resolveApproval(page, ref, id, approve)`, `framePrompt(content, meta)`, and `modes` — `SiteMode[]` (`id`, `label`, `description`, `frame`) for `/mode`. The chat's mode frame is put in front of every message (sites keep no instructions of ours), and `turn` gets `input.mode` so it can tidy mode replies. A mode with `tasks: true` ends its replies with a task list (`parseTaskList` format); the kit attaches it as `BrainReply.tasks` (plus `taskContext(answer)`, if the adapter has one), and core posts it as run-this-task buttons.

Prefer the site's own JSON endpoints for reading answers (`pageFetch(page, url)` fetches from inside the logged-in page) over scraping rendered text. Then `bun run webbrain login <id>`, `/plugins enable webbrains` (or `/restart` if it's on), and `/brain <id>` in a channel.

## Local tools: running commands on this Mac

A site's model can't run anything here, so an adapter with `localTools: true` lets it ask in text (`packages/webbrain/local-tools.ts`):

- **Owner only.** The guide goes in front of the first owner message of each site conversation (a one-line reminder after that); anyone else's messages get no guide, and a block in the answer is just text.
- **The ask:** a code block whose first line is `#!run`, then the command. The marker is inside the code because sites render markdown and drop a block's language (Gemini shows any unknown one as "Code snippet"). An adapter returns the answer's code blocks read from the page (`TurnResult.codeBlocks`), since `innerText` loses the fences; otherwise the kit reads fences in the text.
- **Look-only commands run at once:** `df`, `du`, `ls`, `ps`, `top -l 1`, `vm_stat`, `sysctl` (reads), `memory_pressure`, `pmset -g`, `diskutil list`, `git status|log|diff|show|branch`, `gh pr list`, … chained only with `&&` or `|` (`head`, `grep`, `wc`, `sort` only after a pipe), no redirects or `$(…)`, nothing naming secrets (`.ssh`, `.env`, tokens, keychain).
- **Anything else waits for you:** a commit, a push, a write, an unknown program. The reply carries a "<Site> wants to run this on your Mac" card with **Run** / **Don't run** (owner-only buttons). On Run the kit runs it, gives the site the output, and posts the site's answer when it comes. The `#!run` block itself isn't posted (the card and the "ran" line show the command): an adapter that returns its text with fenced code blocks gets that for free.
- Commands run in zsh (login shell, so `git` and `gh` are on PATH) from the home folder, 60s each, output clipped to 6,000 characters; up to 3 per answer and 6 rounds per message. The reply ends with `-# 🔧 ran on this Mac: …`.
- Whatever a command prints goes to the site. That's why secrets are never auto-run; approve with that in mind.
- `bun run webbrain log <id> [-n 40]` — what the last turns did, from `<data>/webbrain/<id>/turns.jsonl`: each turn's start (your message, the conversation), its end (time, text, files, code blocks) or error, commands asked / run / declined, and adapter notes (a picture it waited on, an empty answer). The daemon's stderr isn't kept, so this is where to look when a reply was wrong or never came. Rolls over at 5 MB.
- `bun run webbrain doctor <id> --tools` checks a site asks the right way (one real message; nothing is run).

## What the kit does

| | |
|---|---|
| **Tabs** (`tabs.ts`) | One persistent browser per site; one tab per chat. The same chat runs one turn at a time; different chats run side by side. Max 3 tabs (an idle chat's tab is reused, least recently used first; if all are busy, the next waits). The browser closes after 10 min idle. |
| **Launch** (`engine/launch.ts`) | Two engines. **patchright** (default): installed Chrome (bundled Chromium as fallback); headless, it relaunches once with "HeadlessChrome" taken out of the user agent. **cloak**: CloakBrowser, a Chromium with source-level fingerprint patches — needs a license key (`npx cloakbrowser login`, free with an email, **one browser at a time**; more is paid). Per site: config.json `"webbrain": { "<id>": { "engine": "cloak" } }`, else the adapter's `engine`. Each engine has its own profile (`<data>/webbrain/<id>/profile`, `profile-cloak`), so switching means logging in again. Real window size, the machine's locale and timezone, the same every launch — no fingerprint rotation: consistency matters more than randomness for a logged-in account. |
| **Pacing** (`engine/human.ts`) | Short messages typed with jittered key timing; long or multi-line ones pasted (Enter sends in most composers). Submits to one site are spaced ≥1.5s plus jitter across all its tabs. |
| **Discord** (`define.ts`) | Typing indicator; one self-updating status line after 45s; attachments copied under their original names; prompts from non-owners say who is talking; stopped / background answers say so; a turn longer than the wait (`turnTimeoutMs` 15 min, `workTurnTimeoutMs` 45 min for a mode with `repo`/`files`) should come back as `background` so the late watch posts it. `continueAfter(answer, mode)` carries a cut-short answer on (3× at most), late answers included. Files go over as many messages as Discord needs (10 files / ~10 MB each, `fileBatches`). |
| **Chats** | The conversation id is stored on the chat record (`ctx.chats`), so `/resume` and `/clear` work for every web brain. |
| **Late results** (`watch.ts`) | After a `background` answer, polls `readLate` every minute for up to 3h and posts what lands. In memory: a restart drops the watch. |

## Adding a site from a recording

The `new-web-brain` skill (`.claude/skills/new-web-brain/`) walks a Claude Code session through it: `webbrain record`, read the capture, copy `packages/webbrain/template/`, write the adapter, `webbrain doctor` until it passes, enable. For sites with no JSON endpoint to poll, `waitForSettledText` treats the answer as done once its text stops changing and the site's busy marker (a stop button) is gone; pass `hasContent` when an answer can be only a picture or track, and count a picture still loading as busy. `bun run webbrain log <id>` shows what each turn did.

## Owner commands

- **`/compact`** (kit-level, every web brain): asks the site, in its current conversation, for a summary (goal, decisions, facts, open items, code and numbers verbatim); the next message opens a fresh site conversation that starts with it. Until then the old conversation stays bound, so a restart loses nothing. `/clear` drops a pending summary.
- `bun run webbrain sites` — every web brain the plugins provide (any plugin whose `index.ts` exports `adapter`), what its terms say about bots when the adapter records it, and whether its profile is logged in: opened headless at `chatUrl()`, logged in if the site keeps it in the chat rather than sending it to sign in (an adapter can override with `loggedIn(page)`). Sends nothing. A profile the bot has open shows as in use.
- `bun run webbrain setup` — the same list, then the login window for each site that isn't logged in, one at a time.
- `bun run webbrain login <id>` — opens the site headed on its profile; sign in, close the window. Refuses while the profile is open elsewhere (Chrome's `SingletonLock`).
- `bun run webbrain record <id> <url>` — headed, on `<id>`'s profile (so signing in here is the login). You send `Reply with exactly: pong` by hand; it writes `network.jsonl` (fetch/XHR/stream entries with clipped request and response bodies, **no headers**), `controls-*.json` and `aria-*.txt` (selector material, before and after), `urls.txt` and `meta.json` to `<data>/webbrain/<id>/recording/`. That holds account data: it stays in the data dir, never the repo.
- `bun run webbrain doctor <id> [--headed]` — one real round trip through the adapter in a new chat; passes when the answer contains `pong`. Exit code 0/1. Sends a real message.
- `bun run webbrain doctor <id> --tools` — asks "how much free disk space does this Mac have?" with the local-tools guide and passes when the answer asks for a `#!run` command. Nothing is run.
- `bun run webbrain doctor <id> --detect [--engine patchright|cloak|all] [--headed]` — how botty the engine looks, on a throwaway profile (never the logged-in one): our probes (`navigator.webdriver`, Headless in the user agent or client hints, software GPU, plugins, zero-size window, UA vs client-hint platform, contradictory notification permission, `window.chrome`) plus bot.sannysoft.com's failed rows. Exit 1 on any tell.
- `CHOOMFIE_<ID>_HEADED=1` — run that site's browser visibly, for debugging.

A site that kept state in `<data>/<id>/` before the kit (Waymond) has it moved to `<data>/webbrain/<id>/` on first start.

## In the free router

A web brain can also be one of the free brain's members: name its id in a bucket's targets (`free.buckets.agentic: ["<id>", "@code"]`) and `/brain free` hands it the messages that bucket gets, with a recap of turns other models answered. See [free-brain.md](free-brain.md).

## Accounts and terms

Automating a site's web UI is usually against its terms, and an account can be flagged whatever the tooling. Patchright and CloakBrowser lower detection, they don't remove it. Where a site has an official API, use that instead. For every web brain:

- **A spare account**, never one you'd mind losing: not your main Google, OpenAI or X login.
- **Human pace, low volume.** The kit spaces submits and types like a person; don't raise `maxTabs` or loop a site with scripts. `doctor` sends a real message: run it when something changed, not on a timer.
- **Write down what the terms say.** An adapter's `terms: { automation: "forbidden" | "unclear" | "allowed", checked: "YYYY-MM-DD", note }` is shown by `webbrain sites` under the site's line (`⚠️ its terms forbid bots …`). Re-read the terms before enabling a site marked `forbidden`; they change often.
- **Out of quota is normal.** When a site says its free allowance is spent, the adapter throws `QuotaReachedError` and free uses something else until the reset, instead of hammering the site.
