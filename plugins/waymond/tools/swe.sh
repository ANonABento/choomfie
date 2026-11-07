#!/bin/bash
# Waymond code mode: one command per step inside its sandbox (a fresh
# container per run_python, killed after ~150 s, nothing installed persists).
#
#   bash swe.sh setup <owner/repo | git url> [wip.patch]   install toolchain, clone to /tmp/repo, install deps, re-apply work in progress
#   bash swe.sh check                                       run the repo's own tests, type-check and lint; prints a summary, exit 1 on failure
#   bash swe.sh diff <out.patch>                            save the change (git diff, including new files)
#
# Fetched by URL from the Choomfie repo, so every chat runs the same steps.
set -uo pipefail
REPO_DIR=/tmp/repo
export PATH="$HOME/.bun/bin:$PATH"

say() { printf '%s\n' "$*"; }

detect_checks() {
  cd "$REPO_DIR" || return
  CHECKS=()
  if [ -f package.json ]; then
    local pm="npm run"; command -v bun >/dev/null && { [ -f bun.lock ] || [ -f bun.lockb ]; } && pm="bun run"
    for s in test type-check typecheck lint; do
      if node -e "process.exit(require('./package.json').scripts?.['$s']?0:1)" 2>/dev/null ||
         bun -e "process.exit(require('./package.json').scripts?.['$s']?0:1)" 2>/dev/null; then
        if [ "$s" = test ] && [ "$pm" = "bun run" ] && grep -q '"test": *"bun test' package.json; then CHECKS+=("bun test"); else CHECKS+=("$pm $s"); fi
      fi
    done
    [ ${#CHECKS[@]} -eq 0 ] && [ "$pm" = "bun run" ] && CHECKS+=("bun test")
  elif [ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ]; then
    CHECKS+=("python -m pytest -q")
    grep -q ruff pyproject.toml 2>/dev/null && CHECKS+=("ruff check .")
  elif [ -f Cargo.toml ]; then CHECKS+=("cargo test" "cargo clippy")
  elif [ -f go.mod ]; then CHECKS+=("go test ./..." "go vet ./...")
  elif [ -f Makefile ] && grep -q '^test:' Makefile; then CHECKS+=("make test")
  fi
}

case "${1:-}" in
  setup)
    src="${2:?repo}"; wip="${3:-}"
    [[ "$src" == http* || "$src" == git@* ]] || src="https://github.com/$src.git"
    apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq git curl unzip >/dev/null 2>&1
    rm -rf "$REPO_DIR"; git clone -q --depth 1 "$src" "$REPO_DIR" || { say "clone failed: $src"; exit 1; }
    cd "$REPO_DIR"
    if [ -f package.json ]; then
      if [ -f bun.lock ] || [ -f bun.lockb ]; then
        command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
        bun install >/dev/null 2>&1 || bun install 2>&1 | tail -5
      else
        command -v node >/dev/null || { apt-get install -y -qq nodejs npm >/dev/null 2>&1; }
        npm ci --silent >/dev/null 2>&1 || npm install --silent 2>&1 | tail -5
      fi
    elif [ -f requirements.txt ]; then pip install -q -r requirements.txt 2>&1 | tail -3
    elif [ -f pyproject.toml ]; then pip install -q -e . 2>&1 | tail -3; pip install -q pytest 2>&1 | tail -1
    fi
    if [ -n "$wip" ] && [ -s "$wip" ]; then git apply "$wip" && say "re-applied $wip" || say "WARNING: $wip did not apply"; fi
    detect_checks
    say "ready: $REPO_DIR @ $(git log -1 --format=%h)"
    say "checks: ${CHECKS[*]:-none found, read the CI config}"
    [ -f CLAUDE.md ] && say "repo notes: CLAUDE.md" ; [ -f AGENTS.md ] && say "repo notes: AGENTS.md"
    ;;
  check)
    detect_checks; cd "$REPO_DIR" || exit 1
    fail=0
    # Failure lines a check prints: failing test names, compiler/linter errors.
    # Only real failure markers (log lines with timestamps would differ every run):
    # bun/jest "(fail) name", "✗ name", pytest "FAILED path::name", tsc "error TS1234", eslint "12:3  error".
    problems() {
      grep -E '^\s*(\(fail\)|✗) |^FAILED |^FAIL |error TS[0-9]+|^\s*[0-9]+:[0-9]+\s+error\s' |
        sed -E 's/\[[0-9.]+ ?m?s\]//g; s/ +$//' | sort -u
    }
    for c in "${CHECKS[@]}"; do
      out=$(timeout 100 bash -c "$c" 2>&1); rc=$?
      if [ $rc -eq 0 ]; then
        say "PASS  $c"
      else
        # Same check on the untouched code: failures that were already there aren't yours to chase.
        git stash push -q -u -m swe-baseline >/dev/null 2>&1
        base=$(timeout 100 bash -c "$c" 2>&1); brc=$?
        git stash pop -q >/dev/null 2>&1
        new=$(comm -13 <(printf '%s\n' "$base" | problems) <(printf '%s\n' "$out" | problems))
        if [ $brc -ne 0 ] && [ -z "$new" ]; then
          say "PASS  $c (its only failures also fail without your change — not yours, ignore them)"
        else
          say "FAIL  $c (exit $rc)"; fail=1
          [ -n "$new" ] && [ $brc -ne 0 ] && { say "      new since your change:"; printf '%s\n' "$new" | head -n 10 | sed 's/^/        /'; }
        fi
      fi
      printf '%s\n' "$out" | tail -n 6 | sed 's/^/      /'
    done
    [ ${#CHECKS[@]} -eq 0 ] && { say "no checks found"; exit 1; }
    exit $fail
    ;;
  diff)
    out="${2:?out.patch}"; cd "$REPO_DIR" || exit 1
    git add -A && git diff --cached > "$out"
    say "saved $out:$(git diff --cached --shortstat)"
    git reset -q
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
