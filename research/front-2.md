# Front 2 — Coding & debug rules (report)

Tested = run in sandbox on 2026-11-08 (Python 3, Bun 1.4.4 baseline binary from GitHub releases). In each block, the **good** half was executed; the **bad** half is illustrative only, which the tag says. Sources were accessed 2026-11-08.

## Core rules

### Code
1. **Define each fact once; import it everywhere.** Reason: copies drift, and then a fix only lands in one place. https://wiki.c2.com/?DontRepeatYourself
2. **Delete unused config, flags, and code; don't comment them out.** Reason: dead options mislead readers, and git already keeps the history. https://google.github.io/eng-practices/review/reviewer/looking-for.html (see "Functionality", "Complexity")
3. **Let errors propagate in core code; catch, translate, and report them at the boundary (CLI, HTTP handler, main).** Reason: catching in the middle hides failures. https://docs.python.org/3/tutorial/errors.html , https://peps.python.org/pep-0008/#programming-recommendations (bare except)
4. **Before you change behaviour, add a test that fails, then make it pass.** Reason: the test pins the behaviour so it can't come back. https://google.github.io/eng-practices/review/developer/small-cls.html (tests in same CL), https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html
5. **Keep each diff to one self-contained change.** Reason: small diffs get reviewed faster and are easier to bisect and revert. https://google.github.io/eng-practices/review/developer/small-cls.html
6. **Don't add an abstraction, parameter, or layer until a second real caller needs it.** Reason: guessed generality adds complexity that nobody uses. https://martinfowler.com/bliki/Yagni.html , https://google.github.io/eng-practices/review/reviewer/looking-for.html ("over-engineering")
7. **Python: use `None` as the default for mutable arguments.** Reason: a default value is evaluated once and then shared across calls. https://docs.python.org/3/tutorial/controlflow.html#default-argument-values
8. **Python: catch the narrowest exception type you can; never write a bare `except:`.** Reason: a bare except also catches KeyboardInterrupt and SystemExit, and it hides bugs. https://peps.python.org/pep-0008/#programming-recommendations
9. **TS: turn on `strict` and end each discriminated-union switch with a `never` check.** Reason: when someone adds a new variant, the compiler flags every place that doesn't handle it. https://www.typescriptlang.org/tsconfig#strict , https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking
10. **TS: type caught errors as `unknown` and narrow them before use.** Reason: `throw` can throw anything, not only Error objects. https://www.typescriptlang.org/tsconfig#useUnknownInCatchVariables
11. **Bun: read and validate env/config in one module at startup.** Reason: you get one source of truth and bad config fails fast. https://bun.sh/docs/runtime/env
12. **Bun: write tests with `bun:test` and run them with `bun test`; don't add Jest.** Reason: the runner is built in, and an extra dependency is dead config. https://bun.sh/docs/cli/test

### Debug
13. **Reproduce the bug reliably before you change any code.** Reason: if you can't reproduce it, you can't confirm the fix. https://www.debuggingbook.org/html/Intro_Debugging.html (Zeller, *The Debugging Book*), https://www.chiark.greenend.org.uk/~sgtatham/bugs.html
14. **Reduce the reproduction to a minimal failing test, and commit it with the fix.** Reason: a small case isolates the cause, and the committed test stops regressions. https://www.debuggingbook.org/html/DeltaDebugger.html
15. **Bisect history (`git bisect run <test>`) when the bug used to work.** Reason: binary search needs only log₂N steps. https://git-scm.com/docs/git-bisect
16. **Form one hypothesis, test it, and record the result; change one variable at a time.** Reason: if you change several things at once, you can't tell which one mattered. https://www.debuggingbook.org/html/Intro_Debugging.html (scientific method)
17. **Read the full error and stack trace before forming a hypothesis.** Reason: the first frame in your own code is usually where the fault is. https://docs.python.org/3/library/traceback.html

## Reference

### R1 One source of truth — tested (good half, python)
```python
# bad
def fetch(t=30): ...
def retry(t=30): ...        # drifts when someone edits one
# good
DEFAULT_TIMEOUT = 30
def fetch(t=DEFAULT_TIMEOUT): return t
def retry(t=DEFAULT_TIMEOUT): return t
assert fetch() == retry() == 30
```

### R2 No dead config — untested (illustrative diff)
```diff
- # USE_LEGACY_PARSER = False   # kept "just in case"
- if config.get("legacy_parser"): ...   # flag set nowhere
+ (removed; git log has it)
```

### R3 Errors at boundaries — tested (good half, python)
```python
# bad
def parse(s):
    try: return json.loads(s)
    except Exception: return {}      # caller can't tell failure from empty
# good
import json
def parse(s): return json.loads(s)   # core: raise
def main(raw):
    try: return 0, parse(raw)
    except json.JSONDecodeError as e: return 2, str(e)   # boundary: translate
assert main('{"a":1}') == (0, {"a": 1}); assert main('{')[0] == 2
```

### R4 Test pins behaviour — tested (python + bun)
```python
def slug(s): return "-".join(s.lower().split())
assert slug("Hello  World") == "hello-world"   # bad: no test; good: this line
```
```ts
import { test, expect } from "bun:test";
const slug = (s: string) => s.toLowerCase().split(/\s+/).join("-");
test("slug", () => expect(slug("Hello  World")).toBe("hello-world"));
```

### R5 Small diffs — untested (process)
Bad: one PR that renames, refactors, and fixes a bug. Good: three PRs, rename → refactor → fix plus its test. Google suggests ~100 lines as reasonable; 1000 is usually too large (small-cls.html).

### R6 No speculative abstraction — untested (illustrative)
```ts
// bad: one caller, plugin system "for later"
interface Exporter { export(d: Data): void } class ExporterFactory { /* … */ }
// good
function exportCsv(d: Data): string { /* … */ }
```

### R7 Mutable default — tested (good half, python)
```python
# bad: def add(x, acc=[]): acc.append(x); return acc   -> add(1); add(2) == [1, 2]
def add(x, acc=None):
    acc = [] if acc is None else acc
    acc.append(x); return acc
assert add(1) == [1] and add(2) == [2]
```

### R8 Narrow except — untested (pattern; see R3 for a run)
```python
# bad
try: run()
except: pass
# good
try: run()
except FileNotFoundError as e: log.warning("missing %s", e.filename)
```

### R9 Exhaustive switch — tested (bun 1.4.4; note that bun strips types without type-checking — the compile-time guarantee needs `tsc --noEmit`, untested)
```ts
type S = { k: "a" } | { k: "b" };
function f(s: S): number {
  switch (s.k) {
    case "a": return 1;
    case "b": return 2;
    default: { const _x: never = s; return _x; } // bad: omit default → new variant silently returns undefined
  }
}
```

### R10 unknown in catch — tested (bun)
```ts
// bad: catch (e: any) { console.log(e.message) }
try { JSON.parse("{") } catch (e: unknown) {
  if (!(e instanceof SyntaxError)) throw e;
  console.log("ok");
}
```

### R11 Env once — tested (bun)
```ts
// bad: Number(process.env.PORT) scattered across files, unchecked
const PORT = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(PORT)) throw new Error("PORT");
export { PORT };
```

### R12 bun test — tested (see R4 ts block; `bun test` → 1 pass)

### D1 Reproduce → minimal test → bisect — tested (python bisection logic); git commands untested
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
```sh
# untested
git bisect start HEAD v1.2.0
git bisect run bun test tests/repro.test.ts   # exit 0 good, 1-127 bad, 125 skip
git bisect reset
```
Bad: "I added logging in 4 places and changed the timeout, and now it works." Good: a repro script that fails, a one-line hypothesis, one change, and the repro passes.

## Checklist
- [ ] Every constant, config key, and type is defined once (grep for duplicate literals).
- [ ] The diff has no commented-out code, unused flags, or unused imports.
- [ ] try/except or catch only at boundaries; exceptions are narrow; no bare `except:` or `catch {}` that swallows the error.
- [ ] Each behaviour change ships with a test that failed before it.
- [ ] The diff does one thing; a refactor and a fix go in separate commits.
- [ ] No new interface, factory, or option without a second real caller.
- [ ] Python: no mutable defaults. TS: `strict` is on, switches have a `never` check, catch uses `unknown`.
- [ ] Bun: tests run with `bun test`; env is validated in one module; `tsc --noEmit` passes (bun alone does not type-check).
- [ ] Debug: repro exists → minimal failing test → fix → test passes; you can name the root cause in one line.
