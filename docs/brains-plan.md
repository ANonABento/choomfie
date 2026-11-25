# Brains: routing, context and delegation

How brains pick models, keep context, switch and call each other: the decisions, and what's left. How to use the free brain is in [free-brain.md](free-brain.md); the checklist lives in [roadmap.md](roadmap.md) Phase 15.5.

## Three commands, three questions

| Command | Answers | Default |
|---|---|---|
| `/brain` | which system answers here: `claude`, `waymond`, `free`, `groq`, … (later more web brains, Codex/OpenCode) | — |
| `/mode` | what kind of work: code, plan, cad, research | plain chat |
| `/model` | which model inside that brain (`Brain.models()`) | Claude: configured model · a provider: its best free model · free: `auto` |

Routing buckets (chat, quality, code, …) are internal to `free`; they are not modes.

## Where context lives

Choomfie's chat store (`chats` / `chat_bindings`) is the **index** for every brain: one chat per (location, brain), with its title, mode, model and a pointer to the real conversation.

| Brain | Conversation stored in | Pointer | `/compact` |
|---|---|---|---|
| Claude | Agent SDK session on disk | session id | summary → fresh session seeded with it (auto at ~120k / 80 turns) |
| Waymond (web) | the site (Ambition) | site conversation id | nothing — the site manages it |
| free / a provider brain | `<data>/apibrain/transcripts.db`, keyed by chat id | — | rolling summary past 70% of the budget, or now with `/compact` |
| free, web member | the site, plus a text copy in free's transcript | site conversation id | as Waymond |

`/clear` starts a new chat id for (location, brain); `/resume` re-binds an old one. Nothing is deleted.

**The Discord thread is the one transcript every brain writes to.** That's what lets a handoff work without any backend exporting its history.

## Decisions

1. **Routing: API models float, stateful members lock** (decided). Alternatives weighed:
   - re-route every message;
   - a sticky threshold;
   - route once and lock;
   - start small and step up;
   - suggest but don't switch.

   - **Why this one:** switching between API models loses nothing (one shared transcript), so each message gets the best one. Switching into or out of a web brain loses its work state, so that only happens:
     - on the first message;
     - through a member mode;
     - or by your click ("Hand this to Waymond").
   - **Once a web member has answered, it holds the chat** (`chat.model`) until `/model auto`.
   - **A holding member that fails never moves silently:** Retry · Answer with free models.
   - **One-turn override:** an image the pinned model can't see goes to a vision model.
2. **`/mode` = work modes only** (decided). In `free` it lists the web members' modes; picking one routes to that member.
3. **`/model` belongs to the brain** (decided). Each brain lists its own models; the pick is stored on the chat.
   - Provider brains (`/brain openrouter`) stay, with `/model` over their free models.
   - `free` offers `auto`, any member, or `member:model`.
4. **`/compact` for any brain** with `Brain.compact()`.
5. **`/brain <id>` carries context** (decided, built). The new brain gets this location's latest Discord messages as a one-time chat note with its next message (`lib/handoff.ts`). `carry:false` skips it; `/clear` starts fresh.
   - **Later:** a cheap-model summary instead of the raw excerpt, or Claude's compaction summary when the old brain is Claude.
6. **`ask_brain` → `delegate`** (decided, built). `delegate(to, task, chat_id, …)`.

## Parked: modes rework

Park until the multi-brain and free systems are working and tested. Today a mode is a fixed prompt frame added to every message, which risks context poisoning: it can pull a model off what it's good at. Direction:

- **Global but soft:** a mode works for any brain. It's guidance the model can draw on, not a frame forced onto every turn.
- **Retrieved, not fixed:** mode know-how lives in a store with embeddings (snippets, checklists, examples). Only what's relevant to this message is pulled in. This shares a backend with the memory rework.
- **Benchmarked:** before a mode ships, it's measured against a baseline. Each mode must beat no-mode on its own tasks without regressing general ability. It would use the same benchmark harness as model ranking (proposed, not built yet).

## Proposed: no hardcoded models — discovery and ranking

**Built (Nov 23):** buckets name needs (fast · strong · vision · long · tiny); candidates come from the live lists; each is tried once to learn whether it answers on a free key; the order comes from traits in the listing and the id, plus measured latency. Config can still pin. Details in [free-brain.md](free-brain.md#which-models).

**Still proposed:** replace the name-based guess with evidence:

**What counts as evidence:**

| Signal | Source | Measures | Noise |
|---|---|---|---|
| Errors, latency, limit hits | every call (already recorded by health and quota) | reliability, speed | low |
| Probe benchmark | `apibrain doctor --rank` and a weekly run: a few prompts per bucket with checkable answers (exact answers, code that must pass a test, JSON that must parse), plus a coherence probe (a short multi-turn chat that must stay consistent) | capability, and coherence over turns | low, but narrow |
| Implicit | **Bad:** "Try a bigger model", Retry, Hand off, `/stop`, a quick rephrase of the same ask, "no / wrong / that didn't work". **Good:** the chat moves on, "thanks", a plan task whose CI passed | outcome | high: harder tasks take more turns anyway |

**How the evidence becomes an order:**
- Scores are per **model × bucket**, compared only within a bucket, so a hard code task isn't measured against small talk.
- A bandit (Thompson sampling) keeps mostly using the best and sometimes tries a newcomer, so a new free model earns its place without anyone editing a list.
- The probe benchmark gives a new model a starting score. Real use refines it.
- **Capability vs coherence are kept as separate scores:**
  - **Capability:** solves the task. Probes, CI results, the implicit signals that follow.
  - **Coherence:** stays consistent with the persona and earlier turns. The multi-turn probe, plus a cheap grader over a few sampled real chats now and then.

  A model can be strong at one-shot answers and still drift over a conversation.
- **No 👍/👎 (decided Nov 24):** asking for votes is noise in the chat; implicit signals do the job.
- **Improves with use:** scores live in the data dir. Later they join the memory layer, so preferences ("you like short answers", "this model's code needs fixing for you") travel with you. That needs a separate discussion.

## Proposed: hand off to any agent

Instead of "Hand this to Waymond":
- **Hand off to…** offers one button per agent that could take the job, and you choose.
- **Agents declare what they can do** (`Brain.capabilities`: `agentic`, `image-gen`, `web-search`, …), so no bucket names a brain.
- **Today's lock applies to whoever you pick.** It holds the chat until `/model auto`, and if it fails you get Retry or Answer with free models.

## The classifier

- **Default:** the best models for the need `tiny` from the live lists, models seen thinking first ranked lower (today Groq `qwen3.8-27b`). If none answers within 2.5s, local keyword rules.
- **Next (stage 2):** a Jev-style classifier first — label scores from token probabilities, so its confidence can gate the LLM. See the work list.
- **Cost:** each call spends the classifier provider's daily requests, once per message (messages of three words or fewer skip it).
- **Google has no dedicated classifier model.** Options:
  - Flash-Lite as a zero-shot classifier (reported ~500 RPD free);
  - **`gemini-embedding`** (reported ~1,000 RPD free) as an embeddings classifier: embed each bucket's examples once, then per message one embedding and a nearest match. That's cheaper, faster and steadier than asking a model.
- **Fully local:** the same embeddings classifier on Ollama (`nomic-embed-text` or similar, tens of ms on this Mac). Scored against the Jev classifier on the same labelled set before either becomes the default. Zero-shot stays as the tie-breaker for low-confidence matches.

## Providers

**In:** OpenRouter, Groq, Gemini, NVIDIA NIM, SambaNova, Cloudflare Workers AI, Ollama.

**To add** (one file each, after checking each live):
- **Mistral free mode** (limits only visible after login);
- **Cohere trial** (1,000 calls a month: a spare);
- **LM Studio** (local, OpenAI-compatible, like Ollama);
- **Z.ai GLM Flash** (not in the research pass; verify first).

**Not standing free tiers** (as of Nov 2026):
- **Cerebras:** a $5, 30-day credit after adding a card.
- **GitHub Models:** retired 30 July 2026.
- **Hugging Face:** no included inference credits for free users.
- **DeepSeek API:** paid only.
- **Fireworks, Together, DeepInfra:** one-time signup credit.
- **Amazon Kiro:** IDE-only, and bans automation.

**Terms that matter for a bot answering other people:**
- NVIDIA's trial forbids production use.
- Gemini's unpaid tier trains on prompts, can't serve users in the EEA, UK or Switzerland, and requires 18+.

Both are in [free-brain.md](free-brain.md#getting-keys).

**Key setup:** `bun run apibrain keys` (done Nov 24): lists what's set with a note per provider, opens each key page, takes the key without echoing it, checks it, writes the data dir `.env` (0600).
- **Not through Discord:** a pasted key would pass through Discord's servers.

## Delegation: one agent asking another

Different from routing: routing picks **who answers the user**; delegation is **a tool an agent calls mid-task**.

- **Exists:** `delegate` (`lib/tools/brain-tools.ts`, owner only). Claude can hand Waymond an image job and get the files back. Any registered brain works, `free` included.
- **Next: capabilities.** Optional `Brain.capabilities` (`image-gen`, `web-search`, `code-exec`, `vision`, `long-context`). `delegate`'s description and errors list who can do what, so Claude picks the right brain without being told.
- **Next: Claude offloads cheap work to free.** `delegate to:free` (optionally `model:`) for bulk summarising, translation, first drafts. That saves Claude usage.
- **Escalation, small → big:**
  - **Hard failures** (too large, errors, an unreadable reply) already fail over inside `free`.
  - **Quality failures** ("the fix didn't work") can't be detected reliably. They're the user's call: a `Try a bigger model` button under API answers, re-running that turn on a bigger target with the same transcript.
- **Not planned:** free API models get no tools. They stay cheap chat endpoints; agentic work goes to Waymond, a harness, or Claude.

## Work list

**Done:**
- [x] Routing policy (decision 1), with the Hand-to, Retry and Answer-with-free-models buttons.
- [x] `/mode` in free = members' work modes.
- [x] `/model` per chat for any brain.
- [x] `/compact` for any brain with `compact()`.
- [x] Context carried on `/brain` switch.
- [x] `delegate` rename.

**Done (Nov 23, after the first real test):**
- [x] Call log: every request and routing decision in `apibrain/calls.jsonl`; `bun run apibrain log [--full]`.
- [x] No model ids in code: candidates from live `/models`, newest per family, ranked per need (fast, strong, vision, long, tiny) from size, tier, context, latency and scarce quotas. Buckets name needs.
- [x] Each listed model tried once (`meta/apibrain-models.json`); `limit: 0` = `not_free`, skipped and re-checked weekly. Doctor shows what each bucket routes to now.
- [x] `/restart` from a terminal: a keeper process starts the daemon again.
- [x] `/plugins list|enable|disable` with name autocomplete.
- [x] Image requests count as `agentic` (Waymond is offered).
- [x] API models no longer sign replies with the persona's name.
- [x] Daily quotas reset in the provider's zone (Gemini: Pacific).
- [x] `/status` shows the brain here reporting on itself; Claude's daemon fields are labelled Claude. `/usage` adds the free/API brains' use today (in foreground mode too).

**Done (Nov 24):**
- [x] `bun run apibrain keys` (list, add, setup).
- [x] 11 more providers: Cerebras, Mistral, Cohere, Z.ai, Aion, AxForge, Gonka, Runcrate, and keyless Kilo, LLM7, OVHcloud. Model lists parsed in each one's shape; every one probed.
- [x] Tables rewritten for Discord, and speaker labels cut, on our side for every brain; the "don't sign your name" and "several people" prompt lines removed.
- [x] Tool work that falls to a text model: told so for that turn only, and the reply says Waymond couldn't take it. The log records when a hand-off button was offered.
- [x] **Optimization stage, first pass (Nov 24).** Measured on real calls before cutting anything:
  - Classifier output was the waste: gpt-oss-20b spent 63–136 tokens (mostly hidden reasoning) per one-line JSON. Each model is now remembered as thinking-first or not (from `reasoning_tokens` / a `reasoning` field, kept in `apibrain-models.json`); for the `tiny` need a thinking model ranks below a plain one, so the classifier moved to Groq qwen3.8-27b (13 tokens, ~200 ms). A known thinker still on a one-line job gets `reasoning_effort: low` (gpt-oss-20b: 74 → 32 tokens); a provider that refuses the field (LLM7) is asked again without it and never sent it again.
  - An answer that was all thinking (budget spent before any text) fails over instead of posting nothing; a probe counts it as answering.
  - Probe timeout 30s → 15s (a timeout isn't recorded anyway; it's retried later).
  - `stripThinking` also drops a lone `</think>` prefix and an unclosed `<think>` tail, so stored turns never carry reasoning.
  - Not worth doing yet: the persona system prompt is ~210 tokens and a first answer's whole prompt ~290; per-bucket history would save ~100 tokens a call.
  - Moved to stage 2: a local / probability-scored classifier.
- [x] OpenRouter's free models back (endpoint paths); SambaNova's "payment method required" benches the key a week (`no_credit`); Z.ai's free GLM flash models via `unlistedModels`; a keyless provider's auth error is about the model, not the provider.

**Next, by stage** (order set Nov 24: apibrain stable, then web brains, then harness brains, then agents talking to agents). Each stage has an exit condition; the next starts when it's met.

**Stage 1 — Stabilize apibrain.** Exit: the test checklist passes on the restarted bot and nothing in `apibrain log` surprises.
- [ ] Owner's test pass (routing, tables, labels, Waymond fallback note, `/mode`, `/clear`, `/resume`, `/stop`, `/status`, `/usage`, `/brain <provider>`).
- [x] Commands audit, rest: `/persona` fine (read per turn, a switch restarts the worker); `/memory` — API brains now get core memories (capped 2k chars); `/config` gains `free.providersOff`, `free.footer`. `/stop`, `/clear`, `/resume` are in the owner's test pass.
- [x] Persistent benches: `no_credit` and `auth` key benches outlive a restart (by key fingerprint); `not_free` models already did.

**Stage 2 — Web brains.** Exit: adding a site and keeping it logged in is as easy as `apibrain keys`, and Waymond answers.
- [ ] Waymond: "the message box never appeared" — Ambition's composer redesign; the owner's uncommitted `adapter.ts` targets it. Profile is logged in (`webbrain sites`, Nov 24); verify with the owner's test, then commit.
- [x] `webbrain sites` / `webbrain setup`: every site, logged in or not (headless check, sends nothing), then `login` for the ones that aren't.
- [ ] More web members (Claude.ai, ChatGPT, …) via the `new-web-brain` skill; multi-profile web brains.
- [ ] Web-brain compact: ask the site for a summary, open a new site conversation seeded with it.

**Stage 3 — Harness brains.** Exit: Codex / OpenCode / Gemini CLI each answer as a brain (`/brain codex`) and can be an `agentic` member of free.
- [ ] Harness kit, T3 Code's agent wrappers as reference: process lifecycle, streaming, approvals, files back to Discord.

**Stage 4 — Agents talking to agents.** Exit: any brain can hand work to the right other brain mid-task and get the result back, and the user can hand a chat to any capable brain. (See "Delegation" and "hand off to any agent" above.)
- [ ] `Brain.capabilities` (`agentic`, `image-gen`, `web-search`, `code-exec`, `vision`, `long-context`); `delegate`'s description and errors list who can do what.
- [ ] `delegate` from every brain, not only Claude: Waymond or a harness asking free for a cheap draft, free handing a tool job to Waymond. One call shape, depth-limited (no loops).
- [ ] Claude offloads cheap work: `delegate to:free` with `model:` (summaries, translation, first drafts).
- [ ] "Hand off to…" one button per capable brain, replacing "Hand this to Waymond".
- [ ] Handoff summary by a cheap model (or Claude's compaction summary) instead of the raw excerpt.

**Stage 5 — Classifier.** Exit: the labelled set picks the classifier and threshold by numbers, and the confidence it reports means something.
- [ ] Labelled set: ~60 real messages from `calls.jsonl` with the right bucket; `bun run apibrain eval` scores any classifier on it (accuracy, confusion, latency, tokens).
- [ ] Jev-style classifier: any Simple Jev endpoint (`POST /v1/classifier`, bucket descriptions as `criteria`), which scores each label from token probabilities instead of writing JSON, so its confidence is real. Default the keyless public demo (`simple-jev-demo-api.featherless.ai`, 2 RPS, 2k context, no guarantee); the same API runs locally (`simple-jev` Python server) by changing the URL. Measured Nov 24 on 12 messages: Qwen 4B 11/12 at ~420 ms (0.52 on the one genuinely ambiguous message), Gemma 12B 11/12 at ~800 ms, Qwen 27B 10/12; Groq zero-shot 11/12 but 0.85–1.00 on everything.
- [ ] Pipeline: hard rules → Jev → below the threshold, the zero-shot LLM → keywords. Every stage optional; any failure falls through.
- [ ] Embeddings classifier as the fully local option (Ollama `nomic-embed`, or Gemini embedding), scored on the same set; kept only if it beats or matches Jev.

**Stage 6 — Routing quality and context.** Exit: a bucket's first pick is the best model that answers, by evidence; long chats keep what matters.
- [ ] Ranking from evidence: probe benchmark with checkable answers (`doctor --rank`), implicit signals (retries, hand-offs, rephrasing), bandit ordering.
- [ ] `Try a bigger model` button.
- [ ] More providers: LM Studio (local), GitHub Models (its catalog isn't at `/models`).
- [ ] Compaction: big-context models get the original turns instead of the summary; structured summary (goals, decisions, facts, open questions, code and numbers verbatim); a real token count.

**Later (roadmap only):** always-on / ambient mode, per-channel free defaults, opt-in fallback to Claude when every free provider is limited, non-LLM freemium.
