# Free brain (`plugins/free`, `@choomfie/apibrain`)

`/brain free` answers each Discord message with whichever free model, or web brain, suits it. Behind it are free API tiers (OpenRouter `:free`, Groq, Gemini, NVIDIA NIM, SambaNova, Cloudflare Workers AI, a local Ollama) and any loaded web brain (Waymond). Failover, quota and cooldowns are handled for you; Claude stays its own brain, untouched.

It is built the same way as web brains:

- a **kit**, `packages/apibrain` (`@choomfie/apibrain`), owns the mechanics: the OpenAI-compatible client, key pools, health, quota, the model catalog, transcripts, the router and the classifier.
- a **plugin**, `plugins/free` (`@choomfie/free`), holds the provider list and the routing policy.

It registers:

- `free`, the router;
- one brain per provider that has a key: `/brain groq`, `/brain gemini`, … to pin a channel to one provider, with `/model` choosing among its free models.

No tools and no instructions, so it costs the Claude session nothing.

## Setup

1. Put keys in the data dir's `.env` (`~/.claude/plugins/data/choomfie-inline/.env`; the worker loads it at startup, so `/restart` after editing). A provider with no key is skipped. `.env.example` in the repo lists every name.
   ```
   GROQ_API_KEY=…
   GROQ_API_KEY_2=…          # a second key you own: pooled, each with its own cooldown and quota
   OPENROUTER_API_KEY=…
   GEMINI_API_KEY=…
   NVIDIA_API_KEY=…
   SAMBANOVA_API_KEY=…
   CLOUDFLARE_API_KEY=…  CLOUDFLARE_ACCOUNT_ID=…
   ```
   Groq + Gemini cover most of it. See [Getting keys](#getting-keys) for where each comes from.
2. `bun run apibrain doctor free` checks each provider:
   - which keys are set;
   - what `/models` lists today;
   - a real `pong` round trip per key and model.

   It then shows how the classifier sorts a few sample messages. `bun run apibrain doctor free groq` checks one provider.
3. Turn on `free` with `/plugins`, then run `/brain free` in a channel. `/brain` with no name shows each provider's state, today's use, and the last few routes.

Three commands, three questions: `/brain` is which system answers (claude, waymond, free, groq, …), `/mode` is what kind of work (Waymond's code, plan, cad, research), `/model` is which model inside that brain (free: `auto` by default).

## Getting keys

None of these needs a card. Limits are as published in November 2026, and they change without notice. `/brain` and the doctor show what you actually get.

| Provider | Env | Where | Free allowance | Watch out for |
|---|---|---|---|---|
| Groq | `GROQ_API_KEY` | console.groq.com → API Keys | ~30 RPM, ~1,000 RPD, small TPM, per model (Groq's own pages disagree; trust the console) | Shared with the voice plugin |
| Gemini | `GEMINI_API_KEY` | aistudio.google.com → Get API key (makes a Cloud project) | Flash / Flash-Lite / Gemma only; limits shown in AI Studio, no longer published (reported: Flash ~20 RPD, Flash-Lite ~500 RPD) | Unpaid prompts may train Google's models and be read by reviewers. Unpaid keys may not serve users in the EEA, UK or Switzerland. 18+. Quota is per project, not per key |
| OpenRouter | `OPENROUTER_API_KEY` | openrouter.ai → Keys | `:free` models, 20 RPM, 50 RPD (1,000 RPD after $10 of lifetime credit) | A negative balance blocks free models; free endpoints have no SLA |
| SambaNova | `SAMBANOVA_API_KEY` | cloud.sambanova.ai → APIs | 20 RPM, 20 RPD per model | A spare, not a main model |
| Cloudflare | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → API Tokens (Workers AI template); the account id is on the dashboard | 10,000 Neurons a day, fails closed past it | Big models spend it fast |
| NVIDIA NIM | `NVIDIA_API_KEY` | build.nvidia.com → any model → Get API key | up to ~40 RPM | The trial terms forbid production use. A bot answering other people is production, so keep it to yourself (`brainAccess: owner`) or leave it off |
| Ollama | — | ollama.com, then `ollama pull <model>` | your machine | Opt-in: `free.providers.ollama.enabled: true` |

Web brains sign in, not key in: `bun run webbrain login <id>` opens the site on its own profile; sign in and close the window ([webbrain.md](webbrain.md)).

More keys for one provider (`_2`, `_3`) must be accounts you legitimately own. Several providers forbid extra free accounts made to multiply limits, so this isn't a way to farm quota.

## How a message is routed

```
message → a member mode, or a web member holding the chat?  → that member (locked)
        → `/model` pin?                                       → that API model, then the others
        → hard rules → zero-shot classifier → keyword rules  → bucket
        → its API targets, then `priority` → first one healthy and under quota answers
```

**The policy: API models float, stateful members lock.**

- **API members share the chat's transcript**, so switching between them loses nothing. Every message is classified and the best healthy API model for it answers. Messages of three words or fewer skip the classifier call.
- **A web member (Waymond) holds work in its own conversation**, so the chat only goes there:
  - on its **first** message (nothing to lose yet);
  - through one of its modes (`/mode cad`);
  - when you click **Hand this to Waymond**, offered under an API answer when the classifier is sure (≥ `suggestAt`, default 0.75) that the message is a job for it. The click resends that message to Waymond, with a recap of what it missed.
- **Once a web member has answered, it holds the chat.** `/model` shows it, and every message goes to it, with no classifier call, until `/model auto`.
- **A holding member that fails never moves silently.** The reply says what went wrong and offers **Retry** and **Answer with free models**; the second answers that message with an API model and releases the chat.
- **`/model` pins** a member (`groq`), a model (`groq:openai/gpt-oss-120b`) or a web member (`waymond`). A pinned API model that can't answer falls back to the other API models, and the reply says who answered. An image the pinned model can't see goes to a vision model for that one message.

- **Buckets** (`plugins/free/buckets.ts`) are kinds of message, each with an ordered target list:

  | Bucket | What goes there |
  |---|---|
  | `chat` | small talk and quick questions |
  | `quality` | analysis and writing |
  | `code` | code answered in the reply |
  | `agentic` | real work: repos, files, CAD, browsing — the web brain |
  | `research` | current or sourced information |
  | `vision` | an attached image |
  | `long` | a very long input |

  The zero-shot prompt is built from each bucket's `description`, so a new bucket needs one table entry. Buckets are internal: they aren't modes.
- **Targets** are strings, `member[:model]`:
  - `groq` uses the provider's models in order;
  - `groq:openai/gpt-oss-120b` pins one model;
  - `waymond` is any registered brain;
  - `@code` splices in another bucket's list.
- **Classifier** (`packages/apibrain/classifier.ts`):
  - **Hard rules, no call:** an image goes to `vision`; a prompt over `longTokens` goes to `long`; a message of three words or fewer goes to `chat`. That last rule is a weak guess (confidence 0.5), so "ok, go on" doesn't pull a chat away from what it was doing.
  - **Zero-shot:** a small fast model (default `groq:llama-3.1-8b-instant`) gets the bucket descriptions, the last two turns and the message. It answers `{"bucket", "confidence"}` within 2.5s.
  - **Keyword fallback:** used when no classifier model is reachable or it answers nonsense.
  - The `Classifier` interface lets an embeddings stage drop in later.
- **Failover:** each target is skipped while it cools down or is at its quota. On failure the next one is tried:

  | Failure | What gets benched |
  |---|---|
  | 429 / rate limit | that key (or that key × model on Groq, Gemini and SambaNova, whose limits are per model), for `retry-after` or a minute |
  | daily quota / out of credits | that key, 6h |
  | rejected key | that key, 6h |
  | retired model | that model, 24h |
  | 5xx or timeout | that model, exponential after the second |
  | web brain failing | that brain, exponential |
  | web brain wants a login | that brain, 1h |

  If nothing answers, the reply says when to try again, or suggests `/brain claude`.

## Context

- **One transcript per chat** (`<data>/apibrain/transcripts.db`, keyed by chat id) holds every turn, whoever answered it. Switching from Groq to Gemini mid-chat keeps the conversation. `/clear` starts a new chat (empty history) and `/resume` brings an old one back, with no extra work.
- **What an API model gets:** the persona (`/persona`), Discord rules and any mode frame, then the rolling summary, then the newest turns that fit its budget, then the message. Budgets per provider: Groq's free TPM is small (6k); Gemini takes more (32k). `contextTokens` caps them all.
- **Compaction:** after a reply, once a chat passes 70% of its budget, the older half is summarized on a cheap target (`summaryTargets`). It runs in the background, at most once per chat every 5 minutes. `/compact` does it now.
- **Attachments:**
  - images go to vision models as data URLs (vision comes from the provider's `/models` where it says so);
  - text and code files are inlined, up to 24k characters;
  - anything else is named but not sent.
- **Web brains keep their own conversation.** When the router switches to one, it gets a short recap of the turns it missed.

## Modes

Modes are kinds of work, so `/mode` in a free chat lists each web member's own modes, labelled `Waymond: …`. `/mode cad` sends the chat to Waymond in cad mode; `/mode off` goes back to plain chat (Waymond still holds the chat until `/model auto`). Because mode flags carry over, plan boards work with `/brain free` too: each task's mode routes to the brain that owns it.

To choose a model instead, use `/model`.

## Config (`config.json` → `free`, all optional)

```jsonc
"free": {
  "strategy": "smart",                    // or "priority": ignore buckets, use `priority` in order
  "priority": ["groq", "gemini", "openrouter", "nvidia", "sambanova", "cloudflare", "ollama"],
  "buckets": { "code": ["openrouter:qwen/…:free", "groq"] },   // replaces that bucket's list
  "classifier": { "type": "zero-shot", "targets": ["groq:llama-3.1-8b-instant"], "suggestAt": 0.75, "longTokens": 6000 },
  "summaryTargets": ["groq:llama-3.3-70b-versatile"],
  "providers": {
    "groq": { "models": ["openai/gpt-oss-120b"], "limits": { "rpm": 30, "rpd": 1000 }, "contextTokens": 6000 },
    "ollama": { "enabled": true, "baseURL": "http://127.0.0.1:11434/v1" },
    "nvidia": { "enabled": false }
  },
  "footer": false,                        // add "-# via Groq · gpt-oss-120b · code" under answers
  "contextTokens": 8000                   // cap on every model's input budget
}
```

- Invalid values fall back to defaults with a warning on stderr. Unknown targets are just unavailable.
- Keys never go here. Changes apply on a worker restart (`/restart`).

## Adding things

- **An API provider** (anything OpenAI-compatible): copy a file in `plugins/free/providers/`, add one line to `providers/index.ts`, then put its key in `.env`. A spec is data: `baseURL`, `keyEnv`, `defaultModels`, optional `limits`, `limitScope`, `contextTokens`, `vision()`, and `isFree()` (OpenRouter's refuses anything not `:free` or zero-priced). A provider that isn't OpenAI-compatible needs a new `protocol` in `packages/apibrain/client.ts`.
- **A model change:** usually nothing to do. Each provider's `/models` is read at startup and every 6h. A configured model that disappears is skipped; if all of them go, the provider uses its largest free listed models. To choose models, set `free.providers.<id>.models`.
- **A web brain** (a new chat website): build it with the web-brain kit ([webbrain.md](webbrain.md), the `new-web-brain` skill), then name its id in a bucket's targets. Give it an id that doesn't clash with an API provider (`gemini-web`, not `gemini`). If two brains share an id, the one already loaded keeps `/brain <id>`.
- **A bucket:** add an entry to `buckets.ts` with a description written for the classifier model.
- **A classifier stage:** implement `Classifier` and pass it to `classifierPipeline`.

## Limits and caveats

- **Free-only:** OpenRouter models are checked at call time as well as at config time. For other providers the key's plan decides, and a key with billing enabled would be billed. Use free-tier keys.
- **In memory:**
  - Cooldowns are in memory, so a restart clears them. The first call finds out again.
  - Daily request counts are saved to `meta/apibrain-usage.json`.
- **Web-member side posts:** a web member's late background results and quick-reply buttons post under that brain's own id, so those turns go straight to it rather than through `free`'s transcript. The member still has them in its own conversation.
- **Plans through `free`:** plan tasks still run in their own threads in the right mode. But the web member starts a fresh conversation in each task thread, instead of the one plan chat that `/brain waymond` moves from task to task. For long plans, pin the channel with `/brain waymond`.
- **Data use:** Gemini's free tier may use prompts for training. NVIDIA NIM's free endpoints are meant for prototyping.
- **Addressed messages only:** a free channel answers only messages addressed to the bot, like any non-Claude brain. Ambient "always-on" participation is on the roadmap.
