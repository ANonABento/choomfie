Use this when a task must land in one reply with no clarifying round trip.
Covers: how to state assumptions, scope the deliverable and show evidence.
Sources: plan.md (agent-library), front 1.

## One-shot pattern
- Pick the most likely reading of the request and say so under Assumptions. https://plato.stanford.edu/entries/implicature/ (Grice, maxim of Quality)
- Do the whole task, verify it, then reply with result + evidence. https://google.github.io/eng-practices/review/developer/cl-descriptions.html
- If a step is impossible here (no network, no GPU), mark the affected output `untested` and say why. Source: this library's tested/untested rule, enforced by tools/check_library.py.
