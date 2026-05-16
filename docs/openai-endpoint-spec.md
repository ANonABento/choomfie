# Choomfie OpenAI-Compatible Endpoint - Implementation Goal

**Status:** implementation-ready spec  
**Owner:** TBD  
**Target version:** Choomfie 0.6.0  
**Last updated:** 2026-05-16  

## Goal

Expose Choomfie as a localhost OpenAI-compatible HTTP endpoint at
`http://127.0.0.1:4141/v1`, so OpenAI SDK clients can use Choomfie's configured
agent backend, app-scoped memory, and Discord notification channel without each
consumer app owning separate LLM credentials.

The first required consumer is ExampleApp. The first production slice is therefore
compatibility with the OpenAI Chat Completions path used by common clients:
`GET /v1/models` and `POST /v1/chat/completions`, including non-streaming and
streaming responses.

This is not a generic provider proxy. The endpoint's product value is:

- one local endpoint for Choomfie's active runtime
- Choomfie's existing user authentication/backends
- app-scoped persistent memory
- Discord notifications back to the Choomfie user
- opt-in skill/tool access through explicit Choomfie extension endpoints

## Research Anchors

Official docs checked on 2026-05-16:

- OpenAI Chat Completions remains a standard compatibility surface, while OpenAI
  recommends Responses for newer feature work.
  https://platform.openai.com/docs/api-reference/chat/create-chat-completion
- Chat Completions streaming returns data-only SSE chunks where
  `choices[0].delta` carries incremental role/content/tool data.
  https://developers.openai.com/api/docs/guides/streaming-responses
- Responses streaming uses semantic event names such as `response.created`,
  `response.output_text.delta`, and `response.completed`; do not reuse Chat
  Completions chunk shapes for `/v1/responses`.
  https://developers.openai.com/api/docs/guides/streaming-responses
- `previous_response_id` is the Responses API mechanism for chaining server-side
  context across turns.
  https://developers.openai.com/api/docs/guides/conversation-state
- `/v1/models` returns `object: "list"` with model objects shaped as
  `{ id, object: "model", created, owned_by }`.
  https://developers.openai.com/api/reference/resources/models
- Embeddings responses are `object: "list"` with `data[].embedding`,
  `data[].index`, `data[].object`, `model`, and `usage`.
  https://developers.openai.com/api/reference/resources/embeddings
- The Claude Agent SDK TypeScript `query()` API returns an async generator of SDK
  messages. Token-level HTTP streaming requires `includePartialMessages: true`
  and translation from SDK partial stream events to OpenAI SSE chunks.
  https://platform.claude.com/docs/en/agent-sdk/typescript

## Compatibility Contract

The endpoint must be compatible enough for standard OpenAI SDKs and UIs, not a
perfect clone of every OpenAI endpoint.

### Must Match

- Route paths and HTTP methods for implemented endpoints.
- Bearer auth header shape: `Authorization: Bearer <token>`.
- JSON success shapes for:
  - `GET /v1/models`
  - `POST /v1/chat/completions`
  - `POST /v1/embeddings`
  - implemented Files and Responses endpoints
- OpenAI-style error envelope:

```json
{
  "error": {
    "message": "human readable message",
    "type": "invalid_request_error",
    "param": "messages",
    "code": "invalid_request"
  }
}
```

- Chat Completions streaming must use `Content-Type: text/event-stream`,
  `data: {json}\n\n` chunks, and terminate with `data: [DONE]\n\n`.
- Request cancellation must abort backend work where the backend supports it.
- Unknown request fields should be ignored unless they conflict with supported
  behavior.

### May Differ

- Token counts may be approximate or zero when the backend does not expose exact
  usage.
- OpenAI-only parameters such as `logprobs`, `seed`, `service_tier`, `store`,
  and `modalities` may be ignored initially.
- Only one choice (`n = 1`) is required for v1.
- `system_fingerprint` may be omitted or set to a Choomfie runtime fingerprint.

### Must Reject Explicitly

- Public bind addresses unless the user deliberately opts in.
- Requests without bearer auth when `require_auth` is true.
- `n > 1`, unsupported modalities, unsupported tool mode, invalid content parts,
  oversized uploads, and unavailable backend features.
- Vision requests when the selected backend cannot handle image input.

## Current Repo Constraints

The implementation must respect these observed repo facts:

- `bin/choomfie` is Hermes-first and starts Hermes gateway; it does not run
  `packages/core/supervisor.ts`.
- `bin/choomfie claude-code` runs the Bun supervisor/worker stack.
- `supervisor.ts` owns MCP stdio and worker lifecycle.
- `worker.ts` owns Discord, loaded plugins, tool handlers, `AppContext`, and
  `MemoryStore`.
- Config is currently JSON via `packages/core/lib/config.ts`; there is no
  Choomfie YAML config parser in core.
- Existing memory tables are Choomfie/global agent memory, not app-scoped K/V.
- Current embedding support in `MemoryStore` is local Ollama-oriented.
- Existing Claude Agent SDK session code lives under `packages/core/daemon/`.

## Architecture Decision

Implement the endpoint as a supervisor-managed HTTP sidecar, with a standalone
entrypoint for Hermes mode.

### Claude Code Mode

`packages/core/supervisor.ts` starts and stops the OpenAI endpoint process when
`openaiEndpoint.enabled` is true. The endpoint process must not own MCP stdio.
It communicates with the supervisor/worker boundary for Choomfie extension
actions that require worker state, such as Discord notify and skill invocation.

### Hermes Mode

`bin/choomfie` must gain an endpoint sidecar path. When enabled, the launcher
starts the same Bun endpoint process before or alongside `hermes gateway start`,
records its PID under the Choomfie state directory, and stops it on
`choomfie stop`/`restart` where possible.

Hermes mode routing order:

1. Probe Hermes' future OpenAI endpoint at `http://127.0.0.1:8642/health`.
2. If available, pass through standard OpenAI paths and keep Choomfie extension
   paths local.
3. If unavailable, use a CLI adapter only for the minimal chat path. Do not claim
   full streaming/tool parity through the CLI fallback.

### Shared Modules

New code should be split so unit tests can exercise protocol logic without
spawning a real backend:

- `packages/core/openai-server.ts` - Bun server entrypoint and lifecycle.
- `packages/core/lib/openai/config.ts` - config defaults, env overrides.
- `packages/core/lib/openai/auth.ts` - key issue/list/revoke/verify.
- `packages/core/lib/openai/types.ts` - request/response types and Zod schemas.
- `packages/core/lib/openai/chat.ts` - Chat Completions adapter.
- `packages/core/lib/openai/sse.ts` - SSE framing helpers.
- `packages/core/lib/openai/agent-sdk-adapter.ts` - Claude Agent SDK translation.
- `packages/core/lib/openai/hermes-adapter.ts` - Hermes probe/pass-through/CLI.
- `packages/core/lib/openai/app-memory.ts` - app-scoped memory table.
- `packages/core/lib/openai/files.ts` - file metadata and content storage.
- `packages/core/lib/openai/embeddings.ts` - embeddings adapter.
- `packages/core/lib/openai/responses.ts` - Responses subset and state store.
- `packages/core/scripts/api-key.ts` - CLI implementation called by `bin/choomfie`.

## Endpoint Catalog

### Tier 1 - Required For ExampleApp

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/health` | none | Unauthenticated; active runtime, backend, version, auth mode, caveats. |
| `GET` | `/v1/models` | `models` or `chat` | OpenAI model list object with configured aliases. |
| `POST` | `/v1/chat/completions` | `chat` | Non-streaming Chat Completions, text-only first. |

### Tier 2 - OpenAI Client Compatibility

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/v1/chat/completions` | `chat` | `stream: true` SSE support. |
| `POST` | `/v1/chat/completions` | `chat` | Frontend-visible tool call round trip. |

Tool calls are not a Phase 1 requirement. The adapter must either support them
correctly or reject requests containing `tools` with a clear 400. Do not fake
tool support by burying tool definitions in prompt text.

### Tier 3 - Choomfie Extensions

These stay under `/v1/choomfie/*` so standard OpenAI clients can ignore them.

| Method | Path | Scope | Notes |
|---|---|---|---|
| `GET` | `/v1/choomfie/memory?key=...` | `memory` | Read app-scoped values for the bearer token's app. |
| `POST` | `/v1/choomfie/memory` | `memory` | Body `{ key, value }`; app is inferred from token. |
| `DELETE` | `/v1/choomfie/memory?key=...` | `memory` | Delete only the caller app's row. |
| `POST` | `/v1/choomfie/notify` | `notify` | Send a Discord DM or configured user channel. Mock in tests. |
| `GET` | `/v1/choomfie/skills` | `skills` | List names/descriptions only. |
| `POST` | `/v1/choomfie/skills/invoke` | `skills` | Invoke an allowlisted tool/skill through the worker boundary. |

### Tier 4 - Broader API Coverage

| Method | Path | Scope | Notes |
|---|---|---|---|
| `POST` | `/v1/embeddings` | `embeddings` | OpenAI response shape; local Ollama default, provider override later. |
| `POST` | `/v1/files` | `files` | Multipart upload; local storage with metadata. |
| `GET` | `/v1/files/{id}` | `files` | Metadata. |
| `GET` | `/v1/files/{id}/content` | `files` | Raw content. |
| `DELETE` | `/v1/files/{id}` | `files` | Delete content and metadata. |
| `POST` | `/v1/responses` | `responses` | Responses subset, non-streaming first. |
| `GET` | `/v1/responses/{id}` | `responses` | Retrieve stored response object. |
| `DELETE` | `/v1/responses/{id}` | `responses` | Delete stored response chain item. |
| `GET` | `/v1/responses/{id}/input_items` | `responses` | Minimal list object for stored inputs. |

### Out Of Scope For 0.6.0

- Realtime WebSocket APIs.
- Assistants v2.
- Fine-tuning.
- Image generation.
- Public multi-user hosting.
- A full OpenAI admin surface.

## Data And Security Decisions

### State Root

Endpoint state lives under the active Choomfie data directory:

- `CHOOMFIE_DATA_DIR` when set.
- Otherwise `CLAUDE_PLUGIN_DATA` when set.
- Otherwise `~/.claude/plugins/data/choomfie-inline`.

Hermes sidecar startup may set `CHOOMFIE_DATA_DIR` explicitly if it needs the
endpoint to share state with Hermes profile data.

### API Keys

Do not store plaintext bearer keys.

Store key metadata in `${DATA_DIR}/openai-api-keys.json` with `0600`
permissions:

```json
{
  "keys": [
    {
      "id": "key_...",
      "prefix": "sk-choomfie-exampleapp",
      "token_hash": "sha256:...",
      "app": "exampleapp",
      "scopes": ["chat", "models", "memory", "notify"],
      "created_at": "2026-05-16T00:00:00.000Z",
      "revoked_at": null,
      "last_used_at": null
    }
  ]
}
```

CLI:

- `choomfie api-key issue <app> --scopes chat,models`
- `choomfie api-key list`
- `choomfie api-key revoke <id-or-prefix>`

The issue command prints the raw token once.

### App Memory

Do not add an `app` column to `core_memory`; that table is compacted and belongs
to Choomfie's own persona/agent memory.

Add a separate SQLite table:

```sql
CREATE TABLE IF NOT EXISTS app_memory (
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (app, key)
);
```

All `/v1/choomfie/memory` operations infer `app` from the bearer key. Request
bodies must not be allowed to override app identity.

### Files

Store files under `${DATA_DIR}/openai-files/{file_id}` and metadata in SQLite.
Enforce:

- max file size from config
- allowed purposes as strings, stored but not semantically trusted
- path traversal rejection
- content hash in metadata
- delete removes both metadata and content

### CORS And Binding

Default bind is `127.0.0.1`. Auth is required by default. CORS defaults to
localhost origins only. If host is not loopback, CORS is disabled unless the
user explicitly configures origins and auth remains required.

## Configuration

Extend `Config` in `packages/core/lib/config.ts` with JSON config. Do not add
YAML parsing to core for this feature.

```json
{
  "openaiEndpoint": {
    "enabled": false,
    "host": "127.0.0.1",
    "port": 4141,
    "allowPublicBind": false,
    "requireAuth": true,
    "corsOrigins": ["http://localhost:*", "http://127.0.0.1:*"],
    "maxConcurrent": 5,
    "requestTimeoutMs": 120000,
    "maxRequestBytes": 10485760,
    "maxFileBytes": 26214400,
    "responseTtlDays": 30,
    "routing": {
      "mode": "claude_code",
      "hermesBaseUrl": "http://127.0.0.1:8642/v1"
    },
    "models": {
      "default": "choomfie-claude-sonnet",
      "aliases": {
        "choomfie-claude-sonnet": {
          "backend": "claude_code",
          "model": "claude-sonnet-4-6"
        },
        "choomfie-claude-code": {
          "backend": "claude_code",
          "model": "claude-opus-4-6"
        },
        "choomfie-local": {
          "backend": "ollama",
          "model": "llama3.1"
        }
      }
    },
    "features": {
      "chat": true,
      "streaming": true,
      "tools": false,
      "responses": false,
      "embeddings": false,
      "files": false,
      "memory": true,
      "notify": true,
      "skills": false
    }
  }
}
```

Environment overrides:

- `CHOOMFIE_OPENAI_ENABLED`
- `CHOOMFIE_OPENAI_HOST`
- `CHOOMFIE_OPENAI_PORT`
- `CHOOMFIE_OPENAI_ALLOW_PUBLIC_BIND`
- `CHOOMFIE_OPENAI_REQUIRE_AUTH`
- `CHOOMFIE_OPENAI_ROUTING_MODE`
- `CHOOMFIE_OPENAI_HERMES_BASE_URL`
- `CHOOMFIE_OPENAI_DEFAULT_MODEL`
- `CHOOMFIE_OPENAI_MAX_CONCURRENT`
- `CHOOMFIE_OPENAI_REQUEST_TIMEOUT_MS`
- `CHOOMFIE_OPENAI_MAX_FILE_BYTES`

## Implementation Phases

### Phase 0 - Protocol Foundation And Config

Build the foundation without a live model dependency.

Steps:

1. Add OpenAI endpoint config types, defaults, and env overrides.
2. Add API key manager with hashed key storage.
3. Add request schemas and OpenAI error helpers.
4. Add `/health` and `GET /v1/models`.
5. Add CLI commands in `bin/choomfie` for `api-key issue|list|revoke`.
6. Add unit tests for config merging, auth, scopes, error envelopes, and model
   list shape.

Verification:

- `bun test packages/core/test/openai-config.test.ts`
- `bun test packages/core/test/openai-auth.test.ts`
- `bun run type-check`
- `choomfie api-key issue exampleapp --scopes chat,models` prints one token and
  stores only a hash.

### Phase 1 - Non-Streaming Chat Completions

Make ExampleApp's basic OpenAI client path work.

Steps:

1. Implement `POST /v1/chat/completions` text-only, non-streaming.
2. Translate OpenAI messages to Claude Agent SDK input for `claude_code` mode.
3. Add an injectable backend interface so tests can use a fake model.
4. Return a valid Chat Completion object with `id`, `object`, `created`, `model`,
   `choices`, and `usage`.
5. Reject unsupported `tools`, `n > 1`, audio, and image content with 400.
6. Start/stop the endpoint in Claude Code mode when enabled.

Verification:

- `curl` with a valid bearer key returns `object: "chat.completion"`.
- OpenAI Node SDK can call `client.chat.completions.create()`.
- Unit tests cover message translation and response shaping.
- Integration test starts the Bun server on port `0` with a fake backend and
  exercises HTTP auth + chat.

### Phase 2 - Chat Streaming

Add real-time SSE for OpenAI-compatible clients.

Steps:

1. Use Claude Agent SDK with `includePartialMessages: true`.
2. Translate SDK partial text events into Chat Completion chunks.
3. Emit initial assistant role chunk, content chunks, final finish chunk, and
   `[DONE]`.
4. Abort SDK query on client disconnect using `AbortController`.
5. Add stream timeout and concurrency accounting.

Verification:

- `curl --no-buffer` receives incremental SSE.
- OpenAI Node SDK async iterator works.
- Tests assert exact SSE framing and `[DONE]`.
- Test client disconnect triggers backend abort.

### Phase 3 - Hermes Mode Sidecar And Routing

Make the endpoint exist in Hermes mode.

Steps:

1. Add sidecar start/stop helpers to `bin/choomfie`.
2. Probe configured Hermes OpenAI-compatible base URL.
3. Pass through implemented standard OpenAI paths when Hermes endpoint is
   available.
4. Add minimal Hermes CLI fallback for non-streaming chat only, clearly reported
   as `hermes_cli_fallback` in `/health`.
5. Ensure `choomfie status` or `choomfie doctor` reports sidecar status.

Verification:

- `choomfie start` with endpoint enabled leaves `127.0.0.1:4141` listening.
- `choomfie stop` stops the sidecar or reports a stale PID cleanup.
- Hermes passthrough tests are skipped unless a Hermes endpoint is reachable.
- CLI fallback test is skipped unless `which hermes` succeeds.

### Phase 4 - App Memory And Notify

Add Choomfie-specific value beyond model proxying.

Steps:

1. Add `app_memory` migration and CRUD helper.
2. Implement `/v1/choomfie/memory` with app inferred from bearer key.
3. Implement `/v1/choomfie/notify` through the worker/Discord boundary.
4. Add `X-Choomfie-Notify-Mode: auto|emit|off` handling for chat metadata, but
   keep server-side notify disabled unless the feature is enabled and scoped.
5. Add response `choomfie` extension metadata for memory writes and notifications
   where applicable.

Verification:

- App A cannot read, overwrite, or delete App B memory.
- Notify integration test mocks the Discord boundary.
- Manual smoke test sends one real DM and records the date/time in the PR notes.

### Phase 5 - Skills And Frontend Tool Calls

Add controlled tool/skill surfaces.

Steps:

1. Implement `GET /v1/choomfie/skills` as names/descriptions only.
2. Implement `POST /v1/choomfie/skills/invoke` through the worker tool map with
   explicit allowlist and app scopes.
3. Design and implement frontend-visible OpenAI tool call translation only if it
   can round-trip correctly:
   - request `tools[]`
   - assistant `tool_calls`
   - client `role: "tool"` result message
   - follow-up model response
4. If Claude Agent SDK cannot expose this cleanly, keep `tools` unsupported in
   0.6.0 and document the limitation.

Verification:

- Skill list filters by app scopes.
- Skill invocation rejects unknown/disallowed tools.
- Tool-call tests use a fake backend that emits deterministic tool calls.
- A real OpenAI SDK tool-call sample either passes or is documented as unsupported
  for 0.6.0.

### Phase 6 - Files And Embeddings

Add the data endpoints expected by broader OpenAI clients.

Steps:

1. Implement files metadata/content storage with limits and cleanup.
2. Implement OpenAI-shaped embeddings using an adapter interface.
3. Use local Ollama embeddings as the first default because the repo already has
   an Ollama embedding provider pattern.
4. Add config hooks for external embedding providers later.
5. Add vision request detection to chat; return 400 unless selected backend
   advertises vision support.

Verification:

- Multipart upload/retrieve/delete round-trips.
- Oversized files fail with OpenAI-style 413/400 error.
- `client.embeddings.create()` returns an OpenAI-shaped response with vector
  data from a fake provider in tests.
- Ollama-backed manual smoke is documented if Ollama is available.

### Phase 7 - Responses API Subset

Implement Responses only after Chat Completions is stable.

Steps:

1. Add SQLite response store with 30-day TTL default.
2. Implement `POST /v1/responses` non-streaming for text input.
3. Support `previous_response_id` by reconstructing stored context.
4. Implement retrieve/delete/input_items subset.
5. Add Responses streaming only if semantic event translation is implemented;
   otherwise reject `stream: true` with a documented 400.

Verification:

- Three-turn `previous_response_id` test preserves context.
- Retrieval returns stored response object.
- TTL cleanup removes expired chains.
- Response streaming is either tested against semantic events or explicitly
  unsupported.

### Phase 8 - ExampleApp Integration And Docs

Wire the first consumer.

Steps:

1. Patch `~/exampleapp` to support `OPENAI_BASE_URL` on the OpenAI
   provider without changing defaults.
2. Add ExampleApp env snippet:

```env
OPENAI_API_KEY=sk-choomfie-exampleapp-...
OPENAI_BASE_URL=http://127.0.0.1:4141/v1
OPENAI_MODEL=choomfie-claude-sonnet
```

3. Add `docs/openai-endpoint.md` as the user-facing quickstart.
4. Update `README.md`.
5. Update `CHANGELOG.md` with a 0.6.0 entry.

Verification:

- ExampleApp résumé parse works end-to-end with Choomfie endpoint.
- Non-Choomfie ExampleApp OpenAI defaults remain unchanged.
- Manual quickstart steps work from a clean shell.

## Testing Matrix

### Unit Tests

- Config defaults and env overrides.
- Bearer key issue/list/revoke/verify, including revoked and wrong scopes.
- OpenAI error envelope.
- Chat request validation.
- Message conversion for system/user/assistant/tool roles.
- Chat response shaping.
- SSE framing.
- App memory isolation.
- File path and size validation.
- Responses context reconstruction.

### Integration Tests

Use Bun's test runner and fake backends wherever possible.

- Start server on random port and call real HTTP.
- Auth required, invalid token, missing scope.
- `/health` unauthenticated.
- `/v1/models` OpenAI list shape.
- Non-streaming chat through fake backend.
- Streaming chat through fake backend.
- App memory persists across server restart.
- Notify mocked at Discord boundary.
- Hermes tests gated on `which hermes` or reachable Hermes endpoint.

### E2E Tests

- OpenAI Node SDK chat completion against local Choomfie fake backend.
- OpenAI Node SDK streaming against local Choomfie fake backend.
- ExampleApp résumé fixture through Choomfie endpoint.
- Optional manual LobeChat/Open WebUI smoke for SSE compatibility.

### Required Verification Before Merge

```bash
bun test
bun run type-check
bun run lint
```

Manual smoke checklist:

- `choomfie api-key issue exampleapp --scopes chat,models,memory,notify`
- `curl http://127.0.0.1:4141/health`
- OpenAI SDK non-streaming chat
- OpenAI SDK streaming chat
- ExampleApp résumé parse
- One real Discord notify smoke, not from automated tests

## Risks And Mitigations

- **Hermes runtime does not run Bun supervisor.** Mitigation: implement explicit
  sidecar management in `bin/choomfie`.
- **Claude Agent SDK may stream message events rather than token events by
  default.** Mitigation: require `includePartialMessages: true` and test partial
  event translation.
- **Frontend-visible tool calls may not map cleanly through Claude Code.**
  Mitigation: reject `tools` until a real adapter is proven.
- **Plaintext local API keys would be high risk.** Mitigation: store only hashes
  and print raw keys once.
- **Existing `core_memory` is not suitable for app K/V.** Mitigation: new
  `app_memory` table.
- **Discord spam from tests.** Mitigation: mock Discord boundary in automated
  tests; manual live-fire only.
- **OpenAI API surface drift.** Mitigation: keep implemented compatibility
  narrow and test against current OpenAI SDK behavior.

## Handoff Prompt

> Implement the Choomfie OpenAI-compatible endpoint per
> `~/choomfie/docs/openai-endpoint-spec.md`.
>
> Start with Phase 0 and Phase 1. Do not implement broad endpoint coverage until
> ExampleApp-critical Chat Completions compatibility is working and tested.
>
> Key constraints:
>
> - Repo: `~/choomfie`
> - Runtime: Bun + TypeScript + bun:sqlite + discord.js +
>   `@anthropic-ai/claude-agent-sdk`
> - Claude Code mode starts through `bin/choomfie claude-code` and uses
>   `packages/core/supervisor.ts`.
> - Hermes mode starts through `bin/choomfie`; it needs an explicit endpoint
>   sidecar because the Bun supervisor is not running there.
> - Store bearer keys hashed, never plaintext.
> - App identity is derived only from the bearer key.
> - Add a separate `app_memory` table; do not mutate `core_memory` for app K/V.
> - Keep automated Discord notify tests mocked.
> - Gate Hermes tests on Hermes availability.
> - If OpenAI `tools` cannot round-trip correctly, reject them clearly for 0.6.0.
>
> Final deliverables:
>
> 1. Choomfie endpoint implementation, tests, docs, and 0.6.0 changelog entry.
> 2. ExampleApp `OPENAI_BASE_URL` patch in `~/exampleapp` without
>    changing defaults.
> 3. `docs/openai-endpoint.md` user quickstart with ExampleApp env snippet.
> 4. Verification notes showing `bun test`, `bun run type-check`, `bun run lint`,
>    OpenAI SDK smoke, ExampleApp smoke, and one manual Discord notify smoke.
