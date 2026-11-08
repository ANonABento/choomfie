Use this when adding, merging, promoting or dropping a row in `lessons/<mode>.md`.
Covers: row format, checker regex, cap and merge/drop rules, rationale.
Sources: front 7 report (Hermes Agent memory docs, Claude Code docs), accessed 2026-11-08.

## Format
Snippet: untested.
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

## Disagreements and unknowns
- Claude Code auto memory caps MEMORY.md at 200 lines / 25 KB and moves detail into topic files (https://code.claude.com/docs/en/memory). That's much larger than Hermes' cap. I chose Hermes' cap because the lessons file loads with core on every task, and core is already capped at 1,500 tokens.
- Hermes stores skills by the agentskills.io standard (https://hermes-agent.nousresearch.com/docs/user-guide/features/skills). I didn't adopt skills here because core/ref already does that job.
- Reflexion and Generative Agents: the search didn't return the primary papers, so they aren't cited.
- The `hits≥3` and `hits:1 / 90 days` thresholds are my own design. No source tested them.

## Sources
- https://hermes-agent.nousresearch.com/docs/zh-Hans/user-guide/features/memory
- https://hermes-agent.nousresearch.com/docs/guides/tips
- https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what
- https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/best-practices
- https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
