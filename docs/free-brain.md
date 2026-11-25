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

1. `bun run apibrain keys` shows every provider: key set or not, what its free tier gives and its catch. `bun run apibrain keys setup` walks through the ones without a key: their key page opens, you paste the key (hidden), it's checked against the provider and saved to the data dir's `.env` (0600). `keys add groq` adds one; a second `add` saves `GROQ_API_KEY_2` (pooled, each its own quota). Keys never go in config.json or through Discord. The worker loads `.env` at startup, so `/restart` after adding. Kilo, LLM7 and OVHcloud need no key and are on already.
2. `bun run apibrain doctor free` checks each provider:
   - which keys are set, and how many free chat models `/models` lists today;
   - a real `pong` through each key on its best model;
   - one tiny request to each listed model nobody has tried yet, to learn which really answer on a free key (see [Which models](#which-models)).

   It then shows the routing each bucket gets right now and how the classifier sorts a few sample messages. `bun run apibrain doctor free groq` checks one provider.
3. Turn it on with `/plugins enable free`, then run `/brain free` in a channel. `/brain` with no name (or `/status` there) shows each provider's state, today's use, and the last few routes; `/usage` shows today's use too.
4. To see exactly what was sent: `bun run apibrain log` (below).

## What API models know

The active persona and the owner's core memories (the same "Current Memories" Claude gets, capped at 2,000 characters) go into every answer's system prompt; classifier calls get neither. API models have no tools, so they can't save or change memories.

## Replies on Discord

Fixed on our side, for every brain, not by rules in the prompt (a rule costs tokens on every call and still gets ignored):
- **Tables:** Discord doesn't render markdown tables. A narrow one becomes an aligned code block, a wide one a bullet per row (`packages/core/lib/discord-markdown.ts`).
- **Speaker labels:** some models open with `**Mahiro**:` when given a character. It's cut before the reply is posted or stored, so the next turn doesn't copy it.
- **Tool work answered in text:** when Waymond couldn't take an `agentic` or `research` message, the text model is told (that turn only) it can't make images or run things, and the reply says who couldn't take it.

## Seeing what was sent

A web brain shows its conversation on the site; an API call shows nothing. So every one is written to `<data>/apibrain/calls.jsonl` (rolls over at 5 MB):

- a **route** line per message: the bucket, how it was decided (`rule`, `zero-shot 0.95`, `keywords`), the plan, what was skipped or failed and why, who answered and how long it took;
- a **call** line per HTTP attempt: provider, key number (never the key), model, purpose (`answer`, `classify`, `summary`, `probe`), every message sent (images as a size note), the reply or the error, token counts.

```
bun run apibrain log              # the last 10 messages and their calls
bun run apibrain log 30 --full    # every message sent, word for word
bun run apibrain log --chat d8aa  # one chat (its id prefix, from the log or /status)
```

Three commands, three questions: `/brain` is which system answers (claude, waymond, free, groq, …), `/mode` is what kind of work (Waymond's code, plan, cad, research), `/model` is which model inside that brain (free: `auto` by default).

## Getting keys

None of these needs a card. Limits change without notice: `bun run apibrain keys` has a one-line note per provider, and `/brain` and the doctor show what you actually get.

| Provider | Key | Free allowance | Watch out for |
|---|---|---|---|
| Groq | console.groq.com/keys | ~30 RPM, ~1,000 RPD per model | Shared with the voice plugin |
| Gemini | aistudio.google.com/apikey | Flash, Flash-Lite, Gemma; limits in AI Studio | Unpaid prompts may train Google's models; not for users in the EEA, UK or Switzerland; 18+; quota per project |
| OpenRouter | openrouter.ai/keys | `:free` models, 20 RPM, 50 RPD (1,000 after $10 of lifetime credit) | Free endpoints may log prompts |
| Cerebras | cloud.cerebras.ai | fast, ~30 RPM | Short context on the free tier |
| Mistral | console.mistral.ai/api-keys | every Mistral model on the Experiment plan | Phone check; prompts may train |
| NVIDIA NIM | build.nvidia.com | ~40 RPM | Trial terms forbid production use: keep it to yourself (`brainAccess: owner`) |
| SambaNova | cloud.sambanova.ai/apis | ~20 RPD per model, but new accounts get 402 "payment method required" | Benched for a week while it says so |
| Cloudflare | dash.cloudflare.com/profile/api-tokens (+ `CLOUDFLARE_ACCOUNT_ID`) | 10,000 neurons a day | Big models spend it fast |
| Cohere | dashboard.cohere.com/api-keys | 1,000 calls a month | Trial key: non-commercial only |
| Z.ai | z.ai (API keys) | Older GLM flash models (4.5, 4.6v, 4.7), which `/models` doesn't list (`unlistedModels`); the listed glm-5.3-flash wants a balance | One request at a time |
| Aion Labs | aionlabs.ai/app/api-keys | 20k tokens a day | Roleplay models |
| AxForge | console.axforge.ai/keys | 3M tokens per 30 days, EU, not logged | Bills once you add a balance — don't |
| Gonka | app.gonkabroker.com/signup | ~1M tokens a month | Real (non-VoIP) phone number |
| Runcrate | runcrate.ai/dashboard/api-keys | weekly allowance on five models | Sign up with GitHub (Google sign-up needs a card) |
| Kilo | no key | `:free` models, 200 requests an hour | Free models may log prompts |
| LLM7 | no key | its `turbo` models | Undocumented; may vanish |
| OVHcloud | no key | 2 RPM per model, EU | A key here would be pay-as-you-go, so none is used |
| Ollama | — | your machine | Opt-in: `free.providers.ollama.enabled: true` |

A provider with credit on the account (AxForge, Runcrate, Gonka, Aion) bills past its free allowance. The free brain can't tell a free-tier key from a funded one, so keep those accounts unfunded. Any provider can be turned off with `/config setting:free.providersOff value:kilo,ovh` (it writes `free.providers.<id>.enabled: false`; `/restart` to apply). `/config setting:free.footer` shows which provider and model answered.

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

- **Buckets** (`plugins/free/buckets.ts`) are kinds of message, each naming a **need**, never a model:

  | Bucket | What goes there | Need | Web brains first |
  |---|---|---|---|
  | `chat` | small talk and quick questions | fast | |
  | `quality` | analysis and writing | strong | |
  | `code` | code answered in the reply | strong | |
  | `agentic` | real work: make an image, repos, files, CAD, browsing | strong | waymond |
  | `research` | current or sourced information | strong | waymond |
  | `vision` | an attached image | vision | |
  | `long` | a very long input | long | |

  The zero-shot prompt is built from each bucket's `description`, so a new bucket needs one table entry. Buckets are internal: they aren't modes.
- **Targets** (in `/model` and config pins) are strings, `member[:model]`:
  - `groq` uses the provider's models, best first;
  - `groq:openai/gpt-oss-120b` pins one model;
  - `waymond` is any registered brain;
  - `@code` splices in another bucket's pinned list.
- **Classifier** (`packages/apibrain/classifier.ts`):
  - **Hard rules, no call:** an image goes to `vision`; a prompt over `longTokens` goes to `long`; a message of three words or fewer goes to `chat`. That last rule is a weak guess (confidence 0.5), so "ok, go on" doesn't pull a chat away from what it was doing.
  - **Zero-shot:** the best-ranked models for the need `tiny` (small, quick, plentiful — today Groq's `gpt-oss-20b`) get the bucket descriptions, the last two turns and the message. It answers `{"bucket", "confidence"}` within 2.5s. Each call spends one request of that model's daily allowance.
  - **Keyword fallback:** used when no classifier model is reachable or it answers nonsense.
  - The `Classifier` interface lets an embeddings stage drop in later.
- **Failover:** each target is skipped while it cools down or is at its quota. On failure the next one is tried:

  | Failure | What gets benched |
  |---|---|
  | 429 / rate limit | that key (or that key × model on Groq, Gemini and SambaNova, whose limits are per model), for `retry-after` or a minute |
  | daily quota / out of credits | that key, 6h |
  | rejected key | that key, 6h |
  | account wants a card first (402 payment method required) | that key, 7 days |
  | retired model | that model, 24h |
  | listed but not on the free plan (`limit: 0`, "insufficient balance", a paid model behind sign-in) | that model, 7 days, and remembered |
  | 5xx or timeout | that model, exponential after the second |
  | web brain failing | that brain, exponential |
  | web brain wants a login | that brain, 1h |

  If nothing answers, the reply says when to try again, or suggests `/brain claude`.

## Which models

No model id is written in code: providers rename and retire them every few weeks (Groq dropped `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` in November 2026). Instead (`packages/apibrain/models.ts`):

1. **Candidates** are what each provider's `/models` lists right now (read at startup and every 6h), free ones only, minus anything that isn't a chat model (embedders, speech, image, guard models), keeping the newest version of each family (`gemini-3.8-flash` over `gemini-2.5-flash`).
2. **Does it really answer?** A listing isn't a promise: Gemini lists Pro and other models whose free quota is zero. Each new model gets one tiny request, once, in the background (and in the doctor). The result is kept in `meta/apibrain-models.json`: models that answered are known good; ones refused (`not_free`, gone, or refusing a plain chat request) are skipped and re-checked after 7 days. Real calls update it too.
3. **Ranked per need**, from what the listing and the id say: size (`120b`; `a55b` is a mixture's active part), tier words when there's no size (`lite`/`mini` small, `flash` mid, `pro` big), context, vision, measured latency, and whether the provider's daily allowance is scarce (OpenRouter's 50 a day is kept for what needs it). A model that hasn't answered yet ranks about one size class lower.

   | Need | Prefers |
   |---|---|
   | fast | good enough to chat (~70B), quick, plentiful |
   | strong | the biggest |
   | vision | the strongest that takes images |
   | long | the biggest input budget |
   | tiny | ~20B, fastest — the classifier |

4. A bucket's targets are its web brains, then the best few across providers (at most 3 from one provider), then `priority`.

`/model` lists each provider's models best first with what's known (`~120B · 131k context · ~0.4s`). `bun run apibrain doctor free` shows the routing each bucket gets right now. To override, pin: `free.providers.<id>.models`, `free.buckets.<id>`, `free.classifier.targets`.

Name-based ranking is a starting point. Next: a probe benchmark and implicit signals (retries, hand-offs, rephrasing) refine it ([brains-plan.md](brains-plan.md)).

## Context

- **One transcript per chat** (`<data>/apibrain/transcripts.db`, keyed by chat id) holds every turn, whoever answered it. Switching from Groq to Gemini mid-chat keeps the conversation. `/clear` starts a new chat (empty history) and `/resume` brings an old one back, with no extra work.
- **What an API model gets:** the persona (`/persona`), Discord rules and any mode frame, then the rolling summary, then the newest turns that fit its budget, then the message. Budgets per provider: Groq's free TPM is small (6k); Gemini takes more (32k). `contextTokens` caps them all.
- **Compaction:** after a reply, once a chat passes 70% of its budget, the older half is summarized on a quick model (need `fast`, or `summaryTargets` if pinned). It runs in the background, at most once per chat every 5 minutes. `/compact` does it now.
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
  "priority": ["groq", "gemini", "openrouter"],   // default: every provider, in providers/index.ts order
  "buckets": { "code": ["groq:openai/gpt-oss-120b", "gemini"] },   // pins that bucket (otherwise: by its need, from the live lists)
  "classifier": { "type": "zero-shot", "targets": ["groq:openai/gpt-oss-20b"], "suggestAt": 0.75, "longTokens": 6000 },   // targets: optional pin
  "summaryTargets": ["gemini"],                                     // optional pin
  "providers": {
    "groq": { "models": ["openai/gpt-oss-120b"], "limits": { "rpm": 30, "rpd": 1000 }, "contextTokens": 6000 },
    "ollama": { "enabled": true, "baseURL": "http://127.0.0.1:11434/v1" },
    "nvidia": { "enabled": false }
  },
  "footer": false,                        // add "-# via Groq · gpt-oss-120b · code" under answers (/config free.footer)
  "contextTokens": 8000                   // cap on every model's input budget
}
```

- Invalid values fall back to defaults with a warning on stderr. Unknown targets are just unavailable.
- Keys never go here. Changes apply on a worker restart (`/restart`).

## Adding things

- **An API provider** (anything OpenAI-compatible): copy a file in `plugins/free/providers/`, add one line to `providers/index.ts`, then put its key in `.env`. A spec is data: `baseURL`, `keyEnv`, optional `limits`, `limitScope`, `resetTimeZone`, `contextTokens`, `vision()`, and `isFree()` (OpenRouter's refuses anything not `:free` or zero-priced). No model list: it comes from the provider's `/models`. Only a provider without one (Cloudflare) gives `fallbackModels`. A provider that isn't OpenAI-compatible needs a new `protocol` in `packages/apibrain/client.ts`.
- **A model change:** nothing to do. New models are picked up within 6h, tried once, and ranked; retired ones drop out. To choose models yourself, set `free.providers.<id>.models`.
- **A web brain** (a new chat website): build it with the web-brain kit ([webbrain.md](webbrain.md), the `new-web-brain` skill), then name its id in a bucket's targets. Give it an id that doesn't clash with an API provider (`gemini-web`, not `gemini`). If two brains share an id, the one already loaded keeps `/brain <id>`.
- **A bucket:** add an entry to `buckets.ts` with a description written for the classifier model.
- **A classifier stage:** implement `Classifier` and pass it to `classifierPipeline`.

## Limits and caveats

- **Free-only:** OpenRouter models are checked at call time as well as at config time. For other providers the key's plan decides, and a key with billing enabled would be billed. Use free-tier keys.
- **In memory:**
  - Cooldowns are in memory, so a restart clears them. The first call finds out again.
  - Daily request counts are saved to `meta/apibrain-usage.json`. A day ends at the provider's reset (Gemini: Pacific midnight; others UTC).
  - Which models answer is saved to `meta/apibrain-models.json`.
- **Web-member side posts:** a web member's late background results and quick-reply buttons post under that brain's own id, so those turns go straight to it rather than through `free`'s transcript. The member still has them in its own conversation.
- **Plans through `free`:** plan tasks still run in their own threads in the right mode. But the web member starts a fresh conversation in each task thread, instead of the one plan chat that `/brain waymond` moves from task to task. For long plans, pin the channel with `/brain waymond`.
- **Data use:** Gemini's free tier may use prompts for training. NVIDIA NIM's free endpoints are meant for prototyping.
- **Addressed messages only:** a free channel answers only messages addressed to the bot, like any non-Claude brain. Ambient "always-on" participation is on the roadmap.
