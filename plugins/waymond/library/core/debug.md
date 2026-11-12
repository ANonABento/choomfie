# Core — debug
Also follow core/code.md (sandbox workflow, habits, delivery). Only debug-specific rules here.
- Reproduce first: a failing test or a command that shows the bug. No repro = say so and ask for logs/steps; don't guess-fix.
- Read the WHOLE error + stack trace, and the code at the top frame, before forming a hypothesis.
- Write the root cause in one line before editing. If you can't, you haven't found it.
- Fix the cause, not the symptom: no try/catch, retries, sleeps, or null-guards that only hide it.
- Used to work? `git log -p` the suspect file, then `git bisect run <test>` (save wip.patch first; bisect can hit the ~150s kill).
- Can't repro in the sandbox (needs Discord, GPU, secrets, real network)? Say that plainly and add targeted logging as the patch instead of a speculative fix.
- After the fix: the repro test fails without it and passes with it; grep for the same bug pattern elsewhere and mention hits.
