# Front 7 — Lessons-learned layer (report)

## Answer
Keep the plan.md row format, add two fields (`src`, `hits`). Change the cap: 40 entries / 2 KB doesn't work, because 2048 B ÷ 40 is about 51 B per row and a real row is about 140 B (tested). Use **2,200 chars (~15 rows) per mode**, copying Hermes Agent's MEMORY.md cap. Consolidate when a file passes 80% full. Promote a rule into core once it has `hits ≥ 3`. Replace the fixed 90-day drop with "drop after 90 days with `hits:1` only". Research mode gets 6 core rules (below).

## Lessons format (paste into each `lessons/<mode>.md`)
```
# Lessons — <mode>  (cap 2,200 chars; consolidate at 80%; one row per line)
# date | trigger | what went wrong | rule now | src:<PR/issue/url> | hits:<n>
```
Example (142 chars, matches regex, tested):
`2026-11-08 | code: pytest import fail | ran tests from repo root, pkg not installed | run `pip install -e .` before pytest | src:#102 | hits:1`
Checker regex (tested): `^\d{4}-\d{2}-\d{2} \| [a-z0-9]+: [^|]+ \| [^|]+ \| [^|]+ \| src:[^|]+ \| hits:\d+$`

## Cap and merge/drop rules
1. Cap 2,200 chars per `lessons/<mode>.md`, not counting the header. Reason: Hermes caps MEMORY.md at 2,200 chars (~800 tokens, 8–15 entries) so the system prompt stays bounded. https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
2. Once a file is >80% full, consolidate before adding: merge related rows into one with `replace`, then `add`. This is Hermes' stated best practice. Same URL.
3. If a new lesson matches an existing rule, bump `hits` and update the date. Don't add a duplicate row. (Own design, following Hermes' "consolidate or replace entries".)
4. Promote at `hits ≥ 3`: move the `rule now` into `core/<mode>.md` as a one-liner and delete the row. Reason: Hermes splits short facts ("what") into memory and procedures ("how") into skills. https://hermes-agent.nousresearch.com/docs/guides/tips
5. Drop rows older than 90 days that still have `hits:1`. A one-off that never repeated is noise. Keep older rows if they recur.
6. Don't record anything the agent can rediscover: things it can find in code, docs or the web, raw logs, or temporary paths. Sources: https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/memory · https://code.claude.com/docs/en/best-practices ("Could it find this by reading the code? Would it actually go and look? If both yes, leave it out")
7. A written lesson takes effect from the next session, not the current one (Hermes uses a frozen snapshot at session start). Don't expect a mid-task write to change behaviour. Hermes memory URL.

## Comparison with plan.md default
| Item | plan.md | Recommend | Why |
|---|---|---|---|
| Format | date\|trigger\|wrong\|rule now | keep + `src`, `hits` | `hits` drives promote/drop; `src` meets req. 4 |
| Cap | 40 entries / 2 KB | 2,200 chars (~15 rows) | 40 rows don't fit in 2 KB (51 B each vs ~140 B real; tested) |
| Merge | into core | at hits≥3; consolidate at 80% | matches Hermes; gives a clear trigger |
| Drop | after 90 days | after 90 days only if hits:1 | a fixed age would delete rules that keep recurring |

## Research-mode core rules
- Cite a primary source URL (official docs, spec, source code, paper) for every non-obvious claim. Skip SEO listicles. Reason: it keeps answers auditable. https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
- Check each claim against a supporting quote. If none exists, retract the claim or mark it unverified. Same URL.
- Say "I don't know" or "unknown" rather than guess. Explicitly allowing this reduces hallucination. Same URL.
- For long sources (>20K tokens), pull word-for-word quotes first, then reason only from those quotes. Same URL.
- Record the version and access date for each source. When sources disagree, name the one you trust and why. Reason: plan.md Risks section says "cite page + access date".
- Tag every snippet or command `tested` or `untested`. Only call it `tested` if it was actually run (plan.md req. 5).

## Disagreements and unknowns
- Claude Code auto memory caps MEMORY.md at 200 lines / 25 KB and moves detail into topic files (https://code.claude.com/docs/en/memory). That's much larger than Hermes' cap. I chose Hermes' cap because the lessons file loads with core on every task, and core is already capped at 1,500 tokens.
- Hermes stores skills by the agentskills.io standard (https://hermes-agent.nousresearch.com/docs/user-guide/features/skills). I didn't adopt skills here because core/ref already does that job.
- Reflexion and Generative Agents: the search didn't return the primary papers, so they aren't cited.
- The `hits≥3` and `hits:1 / 90 days` thresholds are my own design. No source tested them.

## Sources (accessed 2026-11-08)
- https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/guides/tips
- https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/best-practices
- https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
