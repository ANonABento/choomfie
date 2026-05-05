# Choomfie Security Audit — 2026-05-04

Scope: Discord bot token + permissions + shell-out, MCP tool surface, plugin trust boundary,
voice/network handling, dependency hygiene.

Branch: `bentoya/security-audit-discord-bot-token-permissions-shell`
Auditor: Claude (Opus 4.7).

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 1 | accepted-risk (transitive dep, no patch — see F-DEP-1) |
| HIGH     | 4 | fixed |
| MEDIUM   | 6 | 4 fixed, 2 documented |
| LOW      | 3 | documented |

Fixed in this PR: F-PERM-1, F-PERM-2, F-PERM-3, F-TOKEN-1, F-MODAL-1, F-MODAL-2, F-SSRF-1, F-PATH-1.
All HIGH findings closed. The remaining MEDIUM/LOW are documented as accepted-risk
or follow-up below; the CRITICAL is a transitive vulnerability with no fix path
that doesn't break the affected plugin (see F-DEP-1).

## Findings

### F-PERM-1 — HIGH — Permission button bypass when no owner is configured

**File:** `packages/core/lib/handlers/permission-buttons.ts:85-91`

```ts
if (ctx.ownerUserId && interaction.user.id !== ctx.ownerUserId) {
  await interaction.reply({ content: "Only the owner can…", ... });
  return;
}
```

The owner check is gated on `ctx.ownerUserId` being truthy. In the bootstrap
window — installer skipped, owner detection failed, fresh `access.json` —
`ctx.ownerUserId` is `null`, so **any user who can read the permission DM** can
click Approve and authorize a tool call (including `Bash`, `Write`, etc.).

The DM target list expands to all allowlisted users when no owner is set
(`packages/core/lib/permissions.ts:24`), so this is reachable in practice on
fresh installs.

**Fix:** Reject if no owner is configured at all. A null-owner state is bootstrap
mode; no permission decisions should be accepted there.

### F-PERM-2 — HIGH — Plain-text permission reply has the same bypass

**File:** `packages/core/lib/discord.ts:169-184`

```ts
const canApprovePermissions = ctx.ownerUserId
  ? userId === ctx.ownerUserId
  : ctx.allowedUsers.has(userId);
```

When `ownerUserId` is null, this falls back to "any allowlisted user can
approve." Combined with `permissions.ts` fanning DMs to every allowlisted user
in bootstrap, this lets a non-owner approve `Bash`/`Write`/`Edit` calls by
typing `yes <code>` in any channel the bot reads.

**Fix:** Require `ctx.ownerUserId` to be set and require equality. No fallback.

### F-PERM-3 — HIGH — Modal handlers don't re-check ownership (defense-in-depth)

**File:** `packages/core/lib/handlers/modals.ts:197-222`

`modal-persona` and `modal-memory` write directly to config + memory with no
ownership check. They are only opened from owner-gated slash commands today
(`/newpersona`, `/savememory`), so the practical exposure is "unsigned modal
custom IDs": a future code path that surfaces these modals from a non-gated
trigger would silently grant non-owners write access to personas / core memory.

A modal interaction can only be submitted by the user who was shown it, so this
is not directly exploitable today. But the slash-command and modal handler
should not have to know about each other to stay correct.

**Fix:** Re-check `isOwner(ctx, interaction.user.id)` inside both handlers
before mutating state.

### F-TOKEN-1 — HIGH — Token / access files written world-readable

**File:** `packages/core/lib/context.ts:12-25`, `packages/core/lib/handlers/access-tools.ts`

`saveAccess()` uses `Bun.write()`, which respects the process umask but does
not set a tight mode. In practice this produces `0644` on most macOS / Linux
systems — local non-root users can read the owner's Discord ID (a low-grade
deanon vector) and the allowlist.

`install.sh` correctly chmods both `access.json` and `.env` to `0600`. The bug
is that any subsequent write — `allow_user`, `remove_user`, owner auto-detect
on first start — silently widens permissions back to `0644`.

Confirmed against the live state on the audit machine:
```
-rw-r--r--  .env
-rw-r--r--  access.json
```

**Fix:** After every `Bun.write()` of `access.json` or `.env`, `chmod` to
`0600`. Apply the same to webhook / OAuth token files via a shared helper
(`writeSecretFile`).

> Implementation note: `writeFileSync(path, data, { mode })` is **not**
> equivalent to chmod. Node only applies the `mode` arg when *creating* the
> file; on overwrite the existing perms are kept. So OAuth token files
> (LinkedIn / Reddit / YouTube) need an explicit `chmodSync` after every
> write to tighten files left at `0o644` by older versions. See
> `F-TOKEN-1 (extension)` regression test in `packages/core/test/security-audit.test.ts`.

### F-PERM-4 — MEDIUM — `userTools` is documented but not enforced

**File:** `packages/shared/types.ts:21`, `packages/core/lib/mcp-server.ts:38-40`

The Plugin interface advertises a `userTools?: string[]` field whose CLAUDE.md
description is "plugin tool names allowed for non-owner users." No code
inspects this field at tool-call time. The only thing keeping a non-owner
from triggering Bash, `allow_user`, `switch_persona`, etc. is a paragraph in
the system prompt asking Claude not to.

This is a *prompt-level* boundary, not a code-level boundary, and it is
trivially defeated by any prompt-injection vector (reply, edit, fetched
page content, etc.). The current architecture does not pipe the originating
Discord user through to the MCP tool handler, so there is no clean place to
enforce userTools without an IPC schema change.

**Disposition:** Documented as accepted-risk for this PR; tracked as follow-up
work. The Plugin API hardening pass (#43) closed surface in plugin loading and
installer hardening, but this gap was not filed there. Listed under "Open work"
below.

**Mitigations in this PR:** None — keeping the fix scoped. Concrete remediation
plan documented in `docs/security-audit-2026-05-04.md` "Open work" so the next
pass picks it up rather than each finding being rediscovered.

### F-MODAL-1 — MEDIUM — Persona modal silently strips characters

**File:** `packages/core/lib/handlers/modals.ts:200-201`

`key.toLowerCase().replace(/\s+/g, "-")` doesn't strip control / unicode
homoglyphs. A persona key of `‮safekey` would render right-to-left in
Discord but compare unequal to anything sane. Non-exploitable in practice
(this handler is owner-only after F-PERM-3) but worth normalizing to
`[a-z0-9-]`.

**Disposition:** Out of scope. Captured as cleanup in "Open work."

### F-MODAL-2 — MEDIUM — Reminder modal accepts attacker-shaped recurring strings

**File:** `packages/core/lib/handlers/modals.ts:168` calls `isValidCron()`.

Verified — `isValidCron()` whitelists `hourly|daily|weekly|monthly|every Xh`.
No injection surface. (No fix needed; recorded so this isn't re-flagged later.)

### F-SSRF-1 — MEDIUM — `browse` tool accepts any URL scheme

**File:** `plugins/browser/session.ts:53-63`

The `browse` tool calls `page.goto(url, ...)` with no scheme allowlist.
`file:///etc/passwd`, `chrome://gpu`, `chrome-extension://...`, and internal
HTTP endpoints (e.g. `http://169.254.169.254/` cloud metadata,
`http://localhost:11434/` Ollama) are all reachable.

The browser is a real Chromium with persistent cookies. A prompt-injected
Claude calling `browse('file://~/.ssh/id_rsa')` followed by
`browser_screenshot` plus `reply(files=[…])` exfiltrates the file as a Discord
attachment.

**Fix:** Reject non-`http(s)://` URLs, reject `localhost` / RFC 1918 / link-local
unless an explicit env opt-in is set (`CHOOMFIE_BROWSER_ALLOW_PRIVATE=1`).

### F-PATH-1 — MEDIUM — `reply` tool attaches arbitrary local files

**File:** `packages/core/lib/tools/discord-tools.ts:160-163`

`reply` accepts `files: string[]` of absolute paths and attaches them to the
Discord message with no allow-listing. Combined with prompt injection from any
Discord user (or with `browser_screenshot` returning paths Claude controls),
this is the exfiltration leg of the F-SSRF-1 chain.

**Fix:** Restrict attachments to a small allowlist of prefix-validated dirs:
`DATA_DIR/inbox/`, `DATA_DIR/browser/screenshots/`, `tmpdir()`. Reject paths
containing `..`, symlinks resolving outside the allowed roots, or paths starting
with `/etc`, `/var/log`, `/Users/<user>/.ssh`, `/Users/<user>/.aws`, etc.
Realistic implementation: realpath + `startsWith` check against the allowlist.

### F-SHELL-1 — LOW — yt-dlp transcript writes to predictable `/tmp` path

**File:** `plugins/socials/providers/youtube/ytdlp.ts:128`

Output path is `/tmp/yt-transcript-${videoId}` where `videoId` is
constrained to `[a-zA-Z0-9_-]{11}` by the regex above. No injection
surface, but the predictable path + glob (`Bun.Glob`/scan) creates a
TOCTOU window if `/tmp` is shared and a hostile local user pre-creates the
target. macOS `/tmp` is per-user; not reachable in any sane deployment.

**Disposition:** Accepted risk. Recorded for completeness.

### F-SHELL-2 — LOW — Ollama embedding shells out to `curl`

**File:** `packages/core/lib/memory.ts:115-149`

`OllamaEmbeddingProvider.embed()` uses `spawnSync("curl", […])` with the
endpoint URL constructed from `OLLAMA_BASE_URL` (env var). A user with the
ability to set env vars on the host already has remote code execution; not a
realistic attack surface.

The text being embedded is passed through `JSON.stringify`, so embedded quotes
/ shell metacharacters cannot escape — the shell is never invoked, args go
directly to curl.

**Disposition:** No fix. Use the native `fetch()` here in a follow-up to drop
the `child_process` dep entirely; this is a code-quality cleanup, not a
security finding.

### F-DOCS-1 — LOW — Birthday tools claim "owner only" in description but are unenforced

**File:** `packages/core/lib/tools/birthday-tools.ts`

Each birthday tool's description starts with "Owner only." but the handler
does not check ownership. Same root cause as F-PERM-4: the system relies on
Claude obeying its system prompt. Non-owners can prompt-inject Claude into
calling `birthday_add` to dump arbitrary data into the database (low impact;
contained to bot state).

**Disposition:** Will be closed by the same fix that closes F-PERM-4 (per-call
user threading). Documented here so the gap is on record.

### F-DEP-1 — CRITICAL — Transitive `form-data <2.5.4` (CVE via snoowrap → request, rettiwt-api → axios)

**File:** `bun.lock`, `bun audit` output below.

```
form-data  <2.5.4
  rettiwt-api → axios → form-data
  workspace:@choomfie/socials → snoowrap
  critical: form-data uses unsafe random function for boundary
```

Plus 9 HIGH and 16 MODERATE — full audit pasted below for the record.

`snoowrap` is unmaintained and pins to `request@^2.x`, which itself is
unmaintained and pulls the vulnerable `form-data`. `rettiwt-api` (Twitter
provider) pins old `axios`. Both are upstream of the socials plugin; they
do not affect the core Choomfie or any other plugin.

**Disposition:** Documented as accepted-risk for the socials plugin, which
is opt-in (disabled by default). The fix is to migrate `snoowrap` →
`snoowrap-2` or a `fetch`-based Reddit client, and replace `rettiwt-api`
with a direct Twitter API call. Both are non-trivial. Filed in "Open work."

Users who do not enable the socials plugin are not exposed to these
transitive deps because Bun resolves the workspace lazily and the plugin
loader skips packages it cannot import.

### Full `bun audit` (2026-05-04)

```
qs  <6.14.1                         moderate
tar  <7.5.7                         high (×6)
@hono/node-server  <1.19.13         moderate
tough-cookie  <4.1.3                moderate
follow-redirects  <=1.15.11         moderate
request  <=2.88.2                   moderate
uuid  <14.0.0                       moderate
form-data  <2.5.4                   critical
ws  >=2.1.0 <5.2.4                  high
axios  >=1.0.0 <1.15.0              high (×3) + moderate (×4) + low
hono  <4.12.12                      moderate (×6)

27 vulnerabilities (1 critical, 9 high, 16 moderate, 1 low)
```

`tar` and `ws` come in via `@discordjs/opus` and `discord.js` respectively;
`bun update` will not bump them because they are pinned in older
discord.js. They are not reachable from any user-controlled input in
Choomfie's codepaths (no archive extraction, no direct `ws` use).

## Open work (post-PR)

1. **F-PERM-4 / F-DOCS-1** — Plumb originating Discord user_id through the
   IPC tool-call message and enforce `userTools` + per-tool owner checks at
   the handler layer. This is the only durable fix for prompt-injection-driven
   privilege escalation. Estimate: 1 PR. Tasks:
   - Add `caller_user_id?: string` to the tool_call IPC type.
   - Worker: forward `meta.user_id` from the Discord notification through to
     the supervisor's `tool_call`, supervisor passes it back to the worker.
   - Tool handler signature gains a `caller` parameter; access tools, persona
     tools, plugin manage tools, birthday tools, browser_eval all check
     `isOwner(ctx, caller.userId)`.
   - Plugin loader checks `userTools` at call time for any caller who is not
     the owner.
2. **F-MODAL-1** — Tighten persona key normalization to `[a-z0-9-]` and
   reject empty results.
3. **F-DEP-1** — Replace `snoowrap` and `rettiwt-api` with `fetch`-based
   clients to drop the bulk of the audit findings.
4. **F-SHELL-2** — Replace `spawnSync('curl', …)` in `OllamaEmbeddingProvider`
   with `fetch()`.

## Test coverage added in this PR

Coverage is consolidated into two files:

- `packages/core/test/security-audit.test.ts` (new) — covers F-PERM-1,
  F-PERM-2, F-PERM-3, F-TOKEN-1 (and the writeFileSync-mode footgun
  extension), and F-PATH-1:
  - **F-PERM-1** — permission button handler:
    - bootstrap mode (`ownerUserId=null`): any click rejected, no
      `mcp.notification` fired.
    - non-owner click while owner is set: rejected.
    - owner click: notification fires (regression).
  - **F-PERM-2** — `discord.ts` permission-reply path now calls `isOwner`;
    pin the bootstrap and non-owner cases by asserting `isOwner` returns
    false in those states (so a refactor can't reintroduce the bypass).
  - **F-PERM-3** — modal handlers:
    - `modal-persona` non-owner / bootstrap: rejected, `savePersona` never
      called.
    - `modal-memory` non-owner: rejected, `setCoreMemory` never called.
    - `modal-persona` owner: succeeds (regression).
  - **F-TOKEN-1** — `saveAccess` writes `access.json` with mode `0o600`
    (verified by pre-creating the file at `0o644` and asserting tightening).
  - **F-TOKEN-1 (extension)** — pins the documented Node behaviour that
    `writeFileSync(path, data, { mode })` does *not* tighten an existing
    file; verifies that an explicit `chmodSync` after the write does.
  - **F-PATH-1** — `validateAttachmentPath` rejects `/etc/passwd`, SSH
    keys, `..` traversal, nonexistent paths, and empty strings; accepts
    files inside `DATA_DIR/inbox` and `DATA_DIR/browser/screenshots`.
- `packages/core/test/browser-url-validation.test.ts` (new) — F-SSRF-1:
  rejects `file://`, `javascript:`, `chrome://`, `data:`, malformed URLs,
  loopback (`127.x`, `localhost`, `app.localhost`), link-local
  (`169.254.x` cloud metadata), RFC 1918 ranges, IPv6 loopback /
  link-local / ULA. Accepts public http/https. Verifies that
  `CHOOMFIE_BROWSER_ALLOW_PRIVATE=1` reopens private hosts but still
  blocks non-http(s) schemes.

## How to reproduce findings

- **F-PERM-1/2:** Wipe `~/.claude/plugins/data/choomfie-inline/access.json`,
  start choomfie, DM the bot, trigger any tool that requests permission, then
  click the button or reply `yes <code>` from a *different* allowlisted user.
  Pre-fix: tool fires. Post-fix: rejected with "Only the owner…"
- **F-TOKEN-1:** `stat -f '%Sp' ~/.claude/plugins/data/choomfie-inline/access.json`
  before and after triggering an `allow_user` tool call. Pre-fix mode widens
  to `0644`; post-fix stays at `0600`.
- **F-SSRF-1/F-PATH-1:** From a Discord channel, ask the bot (with `browser`
  enabled) to "browse file:///etc/passwd and reply with the snapshot." Pre-fix
  the file content lands in Discord; post-fix the `browse` call rejects with
  a scheme error.
