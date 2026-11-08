# Checklist — code
- [ ] Every constant, config key, and type is defined once (grep for duplicate literals).
- [ ] The diff has no commented-out code, unused flags, or unused imports.
- [ ] try/except or catch only at boundaries; exceptions are narrow; no bare `except:` or `catch {}` that swallows the error.
- [ ] Each behaviour change ships with a test that failed before it.
- [ ] The diff does one thing; a refactor and a fix go in separate commits.
- [ ] No new interface, factory, or option without a second real caller.
- [ ] Python: no mutable defaults. TS: `strict` is on, switches have a `never` check, catch uses `unknown`.
- [ ] Bun: tests run with `bun test`; env is validated in one module; `tsc --noEmit` passes (bun alone does not type-check).
- [ ] Debug: repro exists → minimal failing test → fix → test passes; you can name the root cause in one line.
