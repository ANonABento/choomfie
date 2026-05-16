# OpenAI-Compatible Endpoint

Choomfie can expose a local OpenAI-compatible API at `http://127.0.0.1:4141/v1`.
Use it when another local app should talk to Choomfie's active backend, app-scoped
memory, and notification channel without owning separate model credentials.

## Enable

Edit Choomfie's JSON config under the active data directory:

- `CHOOMFIE_DATA_DIR`, when set
- otherwise `CLAUDE_PLUGIN_DATA`, when set
- otherwise `~/.claude/plugins/data/choomfie-inline`

Example `config.json`:

```json
{
  "openaiEndpoint": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4141,
    "requireAuth": true
  }
}
```

Public bind addresses such as `0.0.0.0` are rejected by default. If you
deliberately opt in with `allowPublicBind: true`, `requireAuth` must remain
enabled.

Then restart Choomfie:

```bash
choomfie restart
```

In Claude Code mode, the supervisor starts the endpoint sidecar. In Hermes mode,
the `choomfie` launcher starts and stops the same Bun endpoint process alongside
the Hermes gateway.

## Issue A Key

```bash
choomfie api-key issue exampleapp --scopes chat,models,memory,notify
```

The raw token is printed once. Choomfie stores only a SHA-256 hash in
`openai-api-keys.json`.

Useful key commands:

```bash
choomfie api-key list
choomfie api-key revoke <id-or-prefix>
```

## OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "http://127.0.0.1:4141/v1",
});

const result = await client.chat.completions.create({
  model: "choomfie-claude-sonnet",
  messages: [{ role: "user", content: "Hello from ExampleApp" }],
});
```

Chat completion responses include a Choomfie extension field:

```json
{
  "choomfie": {
    "notify": {
      "mode": "auto",
      "delivered": false
    }
  }
}
```

Set `X-Choomfie-Notify-Mode: emit` on non-streaming chat completion requests
to ask Choomfie to send the assistant response through its notification bridge.
The bearer key must include both `chat` and `notify` scopes. Accepted modes are
`auto`, `emit`, and `off`.

## ExampleApp Env

```env
OPENAI_API_KEY=sk-choomfie-exampleapp-...
OPENAI_BASE_URL=http://127.0.0.1:4141/v1
OPENAI_MODEL=choomfie-claude-sonnet
```

ExampleApp already appends `/chat/completions` when `OPENAI_BASE_URL` points at an
OpenAI-compatible `/v1` base URL.

## Implemented Routes

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `POST /v1/files`
- `GET /v1/files/{id}`
- `GET /v1/files/{id}/content`
- `DELETE /v1/files/{id}`
- `POST /v1/responses`
- `GET /v1/responses/{id}`
- `DELETE /v1/responses/{id}`
- `GET /v1/responses/{id}/input_items`
- `GET /v1/choomfie/memory?key=...`
- `POST /v1/choomfie/memory`
- `DELETE /v1/choomfie/memory?key=...`
- `POST /v1/choomfie/notify`
- `GET /v1/choomfie/skills`
- `POST /v1/choomfie/skills/invoke`

Unsupported OpenAI tool calls, image content, unsupported modalities, and
`n > 1` are rejected with OpenAI-style error envelopes.
