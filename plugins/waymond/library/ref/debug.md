Use this when a bug needs reproducing, minimising or bisecting.
Covers: reproduce → minimal test → git bisect walkthrough.
Sources: front 2 report (The Debugging Book, git docs), accessed 2026-11-08.

## D1 Reproduce → minimal test → bisect — tested (python bisection logic); git commands untested
```python
def first_bad(commits, is_bad):          # what git bisect does
    lo, hi = 0, len(commits) - 1
    while lo < hi:
        m = (lo + hi) // 2
        if is_bad(commits[m]): hi = m
        else: lo = m + 1
    return commits[lo]
assert first_bad(list(range(100)), lambda c: c >= 37) == 37
```
Snippet: untested.
```sh
## untested
git bisect start HEAD v1.2.0
git bisect run bun test tests/repro.test.ts   # exit 0 good, 1-127 bad, 125 skip
git bisect reset
```
Bad: "I added logging in 4 places and changed the timeout, and now it works." Good: a repro script that fails, a one-line hypothesis, one change, and the repro passes.
