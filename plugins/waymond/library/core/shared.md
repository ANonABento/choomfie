# Shared one-shot discipline (every mode)
<!-- Each rule's [ID] has its reason + source in ref/one-shot.md -->

## Default or ask
- [S1] If a choice is reversible and a sane default exists, pick it, finish, and list it under "Assumptions".
- [S2] Ask before acting only when a wrong guess is costly or irreversible (spend, send, delete, publish, hardware).
- [S3] If you must ask, ask once, batched, max 3 questions, each with your proposed default.
- [S4] Never ask what the files, repo, history or a quick search can answer; look first.
- [S5] Restate the "done when" criterion in one line before starting; if none was given, write one.

## Before delivering
- [S6] Run the thing: tests, checker, script, render; a claim of "works" needs observed output.
- [S7] Paste real output only; mark anything not run as `untested`.
- [S8] Re-read the original request and tick every explicit requirement, number and file name.
- [S9] Self-check against external signals (tests, tool output, docs), not by re-reading your own reasoning.
- [S10] Diff your change; remove debug prints, stray files and edits outside the task scope.

## Common first-try failures
- [S11] Read the relevant code/docs before editing; do not invent APIs, flags, paths or versions.
- [S12] Fix the root cause; never weaken, skip or special-case a test to make it pass.
- [S13] Keep scope: do only the asked task; note adjacent issues instead of fixing them.
- [S14] When stuck after 2 failed attempts at the same fix, change approach and reread the error.
- [S15] Prefer the simplest working solution; add abstraction only when the task needs it.
- [S16] Cite a primary source URL for non-obvious facts; say "unsure" rather than guess.
