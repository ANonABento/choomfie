# Changelog

## 0.6.0 — OpenAI-Compatible Endpoint (2026-05-16)

### Added

- Local OpenAI-compatible endpoint at `http://127.0.0.1:4141/v1`.
- API key issue/list/revoke commands with hash-only key storage.
- OpenAI-shaped models, chat completions, embeddings, files, and Responses subsets.
- Chat Completions streaming with data-only SSE and `[DONE]` termination.
- Choomfie extension routes for app-scoped memory, Discord notify, and skill invocation.
- Claude Code supervisor sidecar lifecycle and Hermes launcher sidecar lifecycle.
- Hermes routing support with standard-route pass-through and non-streaming CLI chat fallback.

## 0.5.0 — Monorepo (2026-04-02)

### Breaking Changes

- Restructured from flat layout to Bun monorepo with workspace packages
- Core infrastructure in `packages/` (shared, core), plugins in `plugins/` (voice, browser, tutor, socials)
- Old `lib/`, `server.ts`, `supervisor.ts`, `worker.ts` moved into `packages/core/`
- Old `skills/` moved to `packages/core/skills/`

### Added

- `@choomfie/shared` — shared types, utilities, time helpers, path resolution
- `@choomfie/core` — MCP server, Discord bridge, memory, reminders, tools
- `@choomfie/voice` — voice plugin (STT/TTS/VAD)
- `@choomfie/browser` — browser plugin (Playwright)
- `@choomfie/tutor` — tutor plugin (FSRS, lessons, Japanese module)
- `@choomfie/socials` — socials plugin (YouTube, Reddit, LinkedIn)
- `PluginContext` type in shared package — minimal context subset for plugins
- `findMonorepoRoot()` — resilient project root resolution
- Explicit workspace package map in plugin loader

### Changed

- Plugins import from `@choomfie/shared` instead of relative `../../lib/` paths
- Plugin interface (`Plugin`, `ToolDef`, `text()`, `err()`) defined in shared package
- Time utilities (`parseNaturalTime`, `formatDuration`, etc.) moved to shared package
- Interaction registries moved to shared package (dispatch stays in core)
- `VERSION` constant reads from root `package.json`
- Entry point is `packages/core/server.ts` (via `bun run start`)
- All docs updated with new `packages/` paths

### Removed

- `plugins/` directory (replaced by `packages/`)
- Duplicate type definitions across packages
- Dead `findMonorepoRoot` argument in boot test

## 0.4.0 — Socials Plugin (2026-03-28)

- LinkedIn integration (17 tools — posts, comments, reactions, scheduling, analytics)
- YouTube OAuth commenting
- Reddit read/write
- Interaction system (buttons, slash commands, modals)
- Structured lessons with `/lesson` and `/progress`

## 0.3.0 — Tutor Plugin (2026-03-26)

- Language learning with FSRS spaced repetition
- Japanese module (JLPT N5-N1, dictionary, kana, furigana)
- Quiz generation, SRS review tools
- 718 JLPT N5 vocabulary cards

## 0.2.0 — Voice & Browser (2026-03-25)

- Voice plugin (Silero VAD, streaming TTS, multi-speaker, interruption handling)
- Browser plugin (Playwright, persistent sessions)
- Supervisor/worker architecture
- Hot-reload via worker restart

## 0.1.0 — Initial Release (2026-03-20)

- Discord bridge via MCP
- Two-tier memory (core + archival)
- Reminders with cron, nag, snooze
- Switchable personas
- GitHub integration
- Permission relay
- Claude Code skills
