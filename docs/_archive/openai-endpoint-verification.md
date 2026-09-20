# OpenAI Endpoint Verification Notes

Date: 2026-05-16

## Completion Audit

Objective: implement `docs/openai-endpoint-spec.md` for a localhost
OpenAI-compatible Choomfie endpoint, ExampleApp integration, tests, docs,
changelog, and verification notes.

Status: complete for required 0.6.0 deliverables. Optional environment-gated
Hermes pass-through and Ollama embedding smokes are documented below as not
available in this local environment.

| Requirement | Evidence | Status |
|---|---|---|
| Endpoint entrypoint and shared modules | `packages/core/openai-server.ts`, `packages/core/lib/openai/*` | Done |
| `/health`, `/v1/models`, Chat Completions | `packages/core/test/openai-server.test.ts`; health asserts status/runtime/backend/version/auth/features/caveats; models accepts `models` or `chat` scope and rejects wrong scope | Done |
| Non-streaming and streaming OpenAI SDK compatibility | OpenAI Node SDK tests in `openai-server.test.ts` | Done |
| Hashed API key issue/list/revoke | `packages/core/scripts/api-key.ts`, `openai-auth.test.ts` | Done |
| App-scoped memory | `AppMemoryStore`, memory isolation and restart tests | Done |
| Discord notify boundary | `SupervisorIpcNotifier`, mocked notify tests, and real owner DM smoke through the supervised endpoint at `2026-05-16T08:07:22.742Z` | Done |
| Skills list/invoke with allowlist | `SupervisorIpcSkillBridge`, skill allowlist tests | Done |
| Embeddings, files, Responses subset | Route tests and OpenAI SDK embeddings test | Done |
| Hermes sidecar and routing | `bin/choomfie`, Hermes routing tests with fake adapter, real Hermes CLI fallback smoke; Hermes HTTP pass-through endpoint unavailable locally | Done |
| Supervisor-managed endpoint lifecycle | Temp-data supervised smoke: endpoint starts from `config.json`, `/health` responds, worker reaches ready without Discord, stdin shutdown stops the sidecar | Done |
| Localhost-first bind posture and CORS | Public bind is rejected by default; `allowPublicBind: true` still requires auth and explicit CORS origins; local CORS preflight allows `X-Choomfie-Notify-Mode` | Done |
| ExampleApp `OPENAI_BASE_URL` support | `~/exampleapp/apps/web/src/lib/llm/client.ts`; `~/exampleapp/apps/web/src/lib/llm/client.test.ts`; local stub smoke | Done |
| User docs, README, changelog | `docs/openai-endpoint.md`, `README.md`, `CHANGELOG.md` | Done |
| Required `bun test`, type-check, lint | Automated gates below | Done |
| Live Hermes HTTP pass-through smoke | Hermes endpoint not listening on `127.0.0.1:8642`; standard route pass-through covered by local stub | Environment unavailable |
| ExampleApp resume parse through live Choomfie backend | `parseResumeWithLLM` against temporary Choomfie endpoint extracted contact, experience, education, and skills from a sample resume | Done |
| Ollama embeddings smoke | Ollama not installed/listening; adapter contract covered with a local stub | Environment unavailable |

## Prompt-To-Artifact Checklist

- Phase 0 protocol/config: `packages/core/lib/openai/config.ts`,
  `packages/core/lib/openai/auth.ts`, `/health`, `/v1/models`,
  `choomfie api-key issue|list|revoke`, `openai-config.test.ts`,
  `openai-auth.test.ts`, `openai-server.test.ts`.
- Phase 1 non-streaming chat: `POST /v1/chat/completions`,
  `packages/core/lib/openai/chat.ts`, `agent-sdk-adapter.ts`, fake backend
  injection, unsupported request rejection, HTTP integration test, OpenAI SDK
  chat test.
- Phase 2 streaming: `packages/core/lib/openai/sse.ts`, streaming fake backend,
  SSE framing assertions, `[DONE]`, OpenAI SDK async iterator test, abort and
  concurrency accounting tests, streaming request-abort propagation test.
- Phase 3 Hermes: `bin/choomfie` sidecar PID/log management, isolated
  `choomfie start`/`stop` sidecar lifecycle smoke with temp state and
  `HERMES_BIN=true`, `choomfie status` and `doctor` status output, Hermes
  fake-adapter pass-through/CLI fallback tests, and `DefaultHermesAdapter`
  health-probe/pass-through URL mapping test against a local stub. Real Hermes
  CLI fallback smoke passed; Hermes HTTP pass-through remains environment-
  unavailable because no Hermes OpenAI endpoint is listening on `127.0.0.1:8642`.
- Phase 4 memory/notify: `app_memory` SQLite store and route tests for app
  isolation, persistence, scoped notify dispatch, and chat notify metadata.
  Supervisor-managed endpoint startup/shutdown is smoke-tested, and a real
  owner DM notify smoke was delivered through the supervised endpoint.
- Phase 5 skills/tools: `/v1/choomfie/skills` and `/invoke`, supervisor IPC
  bridge, feature gate, scope gate, allowlist rejection. OpenAI `tools[]` are
  rejected and documented as unsupported for 0.6.0.
- Phase 6 files/embeddings: local file metadata/content store, size and path
  validation, SHA-256 content hash metadata, content+metadata delete checks,
  OpenAI-shaped embeddings adapter, fake-provider SDK embeddings test, and
  Ollama adapter HTTP-contract test against a local stub. Live Ollama smoke
  remains blocked by missing Ollama.
- Phase 7 Responses: SQLite response store with TTL, non-streaming create,
  retrieve/delete/input_items, three-turn `previous_response_id` context
  reconstruction, explicit `stream: true` rejection.
- Phase 8 ExampleApp/docs: `~/exampleapp` `OPENAI_BASE_URL` support,
  ExampleApp env snippets in docs and `.env.example`, `docs/openai-endpoint.md`,
  `README.md`, and `CHANGELOG.md`. Live résumé parse through a temporary
  Choomfie endpoint passed.

## Automated Gates

- `bun test packages/core/test/openai-server.test.ts`
  - Result: 34 pass, 0 fail.
- `bun test packages/core/test/openai-auth.test.ts`
  - Result: 5 pass, 0 fail.
- `bun test packages/core/test/openai-config.test.ts`
  - Result: 5 pass, 0 fail.
- `bun run type-check`
  - Result: pass.
- `bun run lint`
  - Result: pass.
- `bun test`
  - Result: 287 pass, 0 fail.
- `bash -n bin/choomfie`
  - Result: pass.
- `pnpm --filter @exampleapp/web exec vitest run src/lib/llm/client.test.ts`
  - Result: 15 pass, 0 fail.
- `pnpm --filter @exampleapp/web type-check`
  - Result: pass.
- `pnpm --filter @exampleapp/web exec eslint src/lib/llm/client.test.ts`
  - Result: pass.

## Local Smoke Checks

- `CHOOMFIE_DATA_DIR=$(mktemp -d) ./bin/choomfie api-key issue exampleapp --scopes chat,models,memory,notify`
  - Result: token printed once, `openai-api-keys.json` created with `0600`,
    raw token absent from the store.
- Standalone endpoint `/health` with a clean temp data dir and
  `CHOOMFIE_OPENAI_PORT=4158`
  - Result: `status: ok`, `runtime: choomfie`, `backend: claude_code`,
    `version: 0.6.0`, auth required.
- Clean-environment quickstart smoke with a temp data dir, env-only endpoint
  enablement, OS-assigned port, and temporary API key
  - Result: `/health` returned `status: ok`, `version: 0.6.0`; authenticated
    `/v1/models` returned `list:3`.
- OpenAI Node SDK live smoke against a temporary Choomfie endpoint and temporary
  `chat,models` API key
  - Result: `client.models.list()` returned 3 models;
    `client.chat.completions.create()` returned `SDK_OK`; streaming async
    iterator returned `STREAM_OK`.
- Supervisor-managed endpoint lifecycle smoke with temp data dir, `config.json`
  enabling the OpenAI endpoint on port `0`, and stdin held open like MCP stdio
  - Result: endpoint logged an OS-assigned port, `/health` returned
    `status: ok`, `runtime: choomfie`, `backend: claude_code`, and
    `auth.required: false`; the worker reported ready without Discord; closing
    stdin logged supervisor shutdown and stopped the sidecar.
- Supervised `/v1/choomfie/notify` real Discord DM smoke with a temp data dir,
  temporary `notify`-scoped API key, profile Discord token mapped to
  `DISCORD_TOKEN` in-memory, and owner seeded from profile access
  - Result: owner DM delivered at `2026-05-16T08:07:22.742Z`; response reported
    `delivered: true`, `mode: owner_dm`.
- `CHOOMFIE_OPENAI_ENABLED=1 ./bin/choomfie doctor`
  - Result: reports `openai endpoint: enabled, not running`; Hermes CLI is
    installed, but no live Hermes OpenAI endpoint is currently listening.
- Hermes CLI fallback through the Choomfie OpenAI endpoint with temp data dir,
  `routing.mode: hermes`, an unavailable Hermes HTTP base URL, and a temporary
  `chat,models` API key
  - Result: `/health` reported `backend: hermes_cli_fallback`; non-streaming
    chat response contained `ENDPOINT_HERMES_OK`.
- Isolated `choomfie start`/`choomfie stop` sidecar lifecycle smoke with temp
  `CHOOMFIE_HERMES_HOME`, temp `CHOOMFIE_DATA_DIR`, `CHOOMFIE_OPENAI_PORT=0`,
  and `HERMES_BIN=true`
  - Result: start created a sidecar PID and reachable `/health`
    (`ok:0.6.0`); stop removed the PID file and stopped the recorded sidecar
    process.
- ExampleApp `OPENAI_BASE_URL` override against a local OpenAI-shaped stub
  - Result: `LLMClient` returned `exampleapp override ok` through
    `/v1/chat/completions`.
- ExampleApp résumé parse end-to-end through live Choomfie endpoint
  - Result: `parseResumeWithLLM` with `OPENAI_BASE_URL` pointed at a temporary
    Choomfie endpoint extracted `Jane Example`, `jane@example.com`, one
    experience, one education entry, and `TypeScript`, `React`, `Node.js`, and
    `SQL` skills from a sample resume.
- ExampleApp OpenAI endpoint unit coverage
  - Result: public OpenAI default remains
    `https://api.openai.com/v1/chat/completions`; `OPENAI_BASE_URL` with a
    trailing slash normalizes to `/v1/chat/completions`.

## Environment-Unavailable Live Checks

- Hermes OpenAI pass-through live smoke
  - Current evidence: `curl http://127.0.0.1:8642/health` cannot connect;
    standard OpenAI route pass-through is covered by a local stub, and real CLI
    fallback is smoke-tested.
- Ollama-backed embeddings manual smoke
  - Current evidence: `ollama` is not on `PATH`, and
    `curl http://127.0.0.1:11434/api/tags` cannot connect.
