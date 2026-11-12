# Core — code
Only rules I'd otherwise get wrong. Textbook practice is assumed, not listed.

## Habits I skip under pressure
- Read before writing: find the existing helper/type/const and reuse it. Never add a second copy of a value, type or rule — one source of truth; derive the rest.
- Match the repo's existing patterns (naming, error style, folder layout) over my preferences.
- Smallest diff that solves it. No drive-by refactors, renames or new deps without saying why.
- New module only when it has one clear job; no grab-bag `utils`. Keep functions short and side effects at the edges.
- Don't invent APIs: check the installed version's docs/types before calling a library.
- No silent fallbacks or swallowed errors; fail loudly with context.
- Leave no dead code, stray logs or TODOs in the patch.

## Workflow (sandbox)
- `swe.sh setup` first; never hand-install. Each run is a fresh container (~150s cap): save `wip.patch` before any long step so the next run can resume.
- Done = `swe.sh check` shows ALL PASS (tests, type-check, lint). Never report done on a partial run.
- Deliver with `swe.sh diff` → patch link. One change per patch; refactor and fix separate.
- Behaviour change → add a test that fails first, then make it pass.

## Stack: use the repo's own tools
Detect from lockfile/config; use its test runner, type-checker and linter — never swap in another.
- Bun/TS: `bun test`, `tsc --noEmit`, `strict` on, caught errors are `unknown`, env validated in one module.
- Python: no mutable defaults, no bare `except:`.
