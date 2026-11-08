Use this when writing or reviewing Python, TypeScript or Bun code.
Covers: examples R1–R12 for the code core rules, good/bad halves, each tagged tested/untested.
Sources: front 2 report (Google eng-practices, Python/TS/Bun docs), accessed 2026-11-08.

## R1 One source of truth — tested (good half, python)
```python
## bad
def fetch(t=30): ...
def retry(t=30): ...        # drifts when someone edits one
## good
DEFAULT_TIMEOUT = 30
def fetch(t=DEFAULT_TIMEOUT): return t
def retry(t=DEFAULT_TIMEOUT): return t
assert fetch() == retry() == 30
```

## R2 No dead config — untested (illustrative diff)
```diff
- # USE_LEGACY_PARSER = False   # kept "just in case"
- if config.get("legacy_parser"): ...   # flag set nowhere
+ (removed; git log has it)
```

## R3 Errors at boundaries — tested (good half, python)
```python
## bad
def parse(s):
    try: return json.loads(s)
    except Exception: return {}      # caller can't tell failure from empty
## good
import json
def parse(s): return json.loads(s)   # core: raise
def main(raw):
    try: return 0, parse(raw)
    except json.JSONDecodeError as e: return 2, str(e)   # boundary: translate
assert main('{"a":1}') == (0, {"a": 1}); assert main('{')[0] == 2
```

## R4 Test pins behaviour — tested (python + bun)
```python
def slug(s): return "-".join(s.lower().split())
assert slug("Hello  World") == "hello-world"   # bad: no test; good: this line
```
```ts
import { test, expect } from "bun:test";
const slug = (s: string) => s.toLowerCase().split(/\s+/).join("-");
test("slug", () => expect(slug("Hello  World")).toBe("hello-world"));
```

## R5 Small diffs — untested (process)
Bad: one PR that renames, refactors, and fixes a bug. Good: three PRs, rename → refactor → fix plus its test. Google suggests ~100 lines as reasonable; 1000 is usually too large (small-cls.html).

## R6 No speculative abstraction — untested (illustrative)
```ts
// bad: one caller, plugin system "for later"
interface Exporter { export(d: Data): void } class ExporterFactory { /* … */ }
// good
function exportCsv(d: Data): string { /* … */ }
```

## R7 Mutable default — tested (good half, python)
```python
## bad: def add(x, acc=[]): acc.append(x); return acc   -> add(1); add(2) == [1, 2]
def add(x, acc=None):
    acc = [] if acc is None else acc
    acc.append(x); return acc
assert add(1) == [1] and add(2) == [2]
```

## R8 Narrow except — untested (pattern; see R3 for a run)
```python
## bad
try: run()
except: pass
## good
try: run()
except FileNotFoundError as e: log.warning("missing %s", e.filename)
```

## R9 Exhaustive switch — tested (bun 1.4.4; note that bun strips types without type-checking — the compile-time guarantee needs `tsc --noEmit`, untested)
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

## R10 unknown in catch — tested (bun)
```ts
// bad: catch (e: any) { console.log(e.message) }
try { JSON.parse("{") } catch (e: unknown) {
  if (!(e instanceof SyntaxError)) throw e;
  console.log("ok");
}
```

## R11 Env once — tested (bun)
```ts
// bad: Number(process.env.PORT) scattered across files, unchecked
const PORT = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(PORT)) throw new Error("PORT");
export { PORT };
```

## R12 bun test — tested (see R4 ts block; `bun test` → 1 pass)
