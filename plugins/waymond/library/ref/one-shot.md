Use this when deciding whether to ask or assume, or when checking work before delivering.
Use this when you need the reason or source behind a rule in core/shared.md or core/answer.md.
Use this when a first attempt failed and you want the known failure pattern and its prevention.

# One-shot discipline — reasons and sources
Sources accessed 2026-11-08. Primary sources only.

## Sources
- [P1] Anthropic, Building effective agents — https://www.anthropic.com/engineering/building-effective-agents
- [P2] Anthropic, Claude Code best practices — https://www.anthropic.com/engineering/claude-code-best-practices
- [P3] Anthropic, Prompt engineering: be clear and direct — https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/be-clear-and-direct
- [P4] Anthropic, Reduce hallucinations — https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
- [P5] OpenAI, GPT-4.1 prompting guide (agentic workflows: persistence, tool-calling, planning) — https://cookbook.openai.com/examples/gpt4-1_prompting_guide
- [P6] Huang et al. 2023, Large Language Models Cannot Self-Correct Reasoning Yet — https://arxiv.org/abs/2310.01798
- [P7] Shinn et al. 2023, Reflexion: verbal RL with external feedback — https://arxiv.org/abs/2303.11366
- [P8] Jimenez et al. 2023, SWE-bench — https://arxiv.org/abs/2310.06770
- [P9] Yang et al. 2024, SWE-agent: agent-computer interfaces — https://arxiv.org/abs/2405.15793
- [P10] Kuhn et al. 2022, CLAM: selective clarification for ambiguous questions — https://arxiv.org/abs/2212.07769
- [P11] Google, Engineering practices: small CLs — https://google.github.io/eng-practices/review/developer/small-cls.html
- [P12] Nielsen Norman Group, Inverted pyramid — https://www.nngroup.com/articles/inverted-pyramid/
- [P13] Anthropic, Measuring/reward hacking in Claude 3.7 Sonnet system card (special-casing tests) — https://www.anthropic.com/claude-3-7-sonnet-system-card
- [P14] Lewis et al. 2020, Retrieval-augmented generation — https://arxiv.org/abs/2005.11401
- [P15] Gao et al. 2022, PAL: program-aided language models — https://arxiv.org/abs/2211.10435

## Rule reasons (core/shared.md)
- S1: Agents that keep going instead of yielding finish more tasks; state the guess so the user can correct it cheaply. [P5] (persistence reminder), [P1] (autonomy for open-ended tasks).
- S2: Human checkpoints belong where errors are costly or irreversible. [P1] (guardrails, human review), [P2] (permission for risky actions).
- S3: Clarify selectively — only when ambiguity is real — otherwise asking costs a round trip without improving answers. [P10].
- S4: Agents should gather context with tools before acting; most "questions" are answerable from the repo. [P2] (explore first), [P5] (use tools, don't guess).
- S5: Clear success criteria are the first step of good prompts and tasks. [P3]; [P2] (give a target such as tests).
- S6: Verification against an executable signal (tests, screenshots) is the biggest quality lever. [P2]; [P9].
- S7: Fabricated output is a hallucination; restrict claims to what was observed. [P4].
- S8: Missed explicit constraints are a frequent instruction-following failure; models follow literal instructions closely when checked. [P5], [P3].
- S9: Intrinsic self-correction without external feedback often fails or worsens answers; external feedback works. [P6], [P7].
- S10: Small, focused diffs are reviewed faster and break less. [P11].
- S11: Agents fail on SWE-bench mainly from wrong localization and invented edits; reading/searching first helps. [P8], [P9].
- S12: Models may special-case or edit tests to pass them; forbid it explicitly. [P13], [P2].
- S13: Scope creep makes changes harder to review and riskier. [P11].
- S14: Repeating a failed action loops; reflect on the feedback and change strategy. [P7], [P9].
- S15: Start with the simplest solution and add complexity only when it shows a measurable gain. [P1].
- S16: Grounding in retrieved sources and permitting "I don't know" reduces hallucination. [P4], [P14].

## Rule reasons (core/answer.md)
- A1: Readers scan; most important information first. [P12].
- A2: Be direct and concise; extra text dilutes the answer. [P3], [P12].
- A3: Model knowledge is frozen at training time; retrieval supplies current facts. [P14], [P4].
- A4: Citing the supporting quote/source lets claims be checked. [P4].
- A5: Explicitly allowing uncertainty reduces made-up answers. [P4].
- A6: Answer the dominant interpretation; ask only when needed. [P10].
- A7: Offloading arithmetic to code beats in-head calculation. [P15].
- A8: Specific context in the prompt produces specific output. [P3].

## Common first-try failures → prevention
| Failure | Prevention rule |
|---|---|
| Asks a question the repo answers | S4 |
| Stops to ask on a reversible choice | S1, S3 |
| Says "done" without running anything | S6, S7 |
| Drops one of several requirements | S8 |
| "Reviews" own answer and keeps the bug | S9 |
| Invents API / flag / path | S11, S16 |
| Edits the test to pass | S12 |
| Fixes unrelated things, huge diff | S10, S13 |
| Retries the same failing fix | S14 |
| Over-engineers | S15 |
| Stale fact stated confidently | A3, A5 |
