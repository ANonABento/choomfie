#!/bin/bash
# Waymond code mode: one command per step inside its sandbox (a fresh
# container per run_python, killed after ~150 s, nothing installed persists).
#
#   bash swe.sh setup <owner/repo | git url | x.bundle> [patch|dir ...] clone to /tmp/repo (or start empty if the repo doesn't exist yet),
#                                                         apply earlier patches in order as the base, install deps, list checks
#   bash swe.sh check                                       run the repo's own tests, type-check and lint; prints a summary, exit 1 on failure
#   bash swe.sh diff <out.patch>                            save the change (git diff, including new files)
#   bash swe.sh push [args ...]                             run swe-push.sh with the same arguments (needs GH_TOKEN)
#
# Fetched by URL from the Choomfie repo, so every chat runs the same steps.
set -uo pipefail
REPO_DIR=${SWE_REPO_DIR:-/tmp/repo}
export GIT_TERMINAL_PROMPT=0  # a missing repo must fail, not ask for a password
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
  elif [ -f platformio.ini ]; then
    grep -q '^\[env:native\]' platformio.ini && CHECKS+=("pio test -e native")
    local env; env=$(grep -o '^\[env:[^]]*\]' platformio.ini | sed 's/\[env:\(.*\)\]/\1/' | grep -v '^native$' | head -1)
    [ -n "$env" ] && CHECKS+=("pio run -e $env")
  elif [ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ] || ls tests/test_*.py */test_*.py >/dev/null 2>&1; then
    CHECKS+=("python -m pytest -q")
    grep -q ruff pyproject.toml 2>/dev/null && CHECKS+=("ruff check .")
  elif [ -f Cargo.toml ]; then CHECKS+=("cargo test" "cargo clippy")
  elif [ -f go.mod ]; then CHECKS+=("go test ./..." "go vet ./...")
  elif [ -f Makefile ] && grep -q '^test:' Makefile; then CHECKS+=("make test")
  fi
}

case "${1:-}" in
  setup)
    src="${2:?repo}"; shift 2
    # Earlier-work paths are relative to where setup was run from; setup cd's into the repo below.
    base_args=()
    for arg in "$@"; do [[ "$arg" == /* ]] && base_args+=("$arg") || base_args+=("$PWD/$arg"); done
    # A plan task's repo comes attached as <name>.bundle. Find it even when it's
    # named by its GitHub name or a path that isn't here (the workspace is a volume).
    find_bundle() {
      local b="$1"
      for d in "$PWD" "$HOME" /tmp; do [ -f "$d/$b" ] && { echo "$d/$b"; return; }; done
      find / -maxdepth 6 -name "$b" -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | head -1
    }
    if [[ "$src" == *.bundle && ! -f "$src" ]]; then
      found=$(find_bundle "$(basename "$src")")
      [ -n "$found" ] || { say "can't find $src — it's attached to the task message; ls your working folder for *.bundle"; exit 1; }
      say "using $found"; src="$found"
    elif [[ "$src" != *.bundle && "$src" != http* && "$src" != git@* && ! -f "$src" ]]; then
      found=$(find_bundle "$(basename "$src").bundle")
      [ -n "$found" ] && { say "using the attached $(basename "$found") for $src (its plan branch)"; src="$found"; }
    fi
    # A git bundle (a plan's branch, attached to the task) clones like a remote.
    if [ -f "$src" ]; then src="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
    elif [[ "$src" != http* && "$src" != git@* ]]; then src="https://github.com/$src.git"; fi
    apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq git curl unzip >/dev/null 2>&1
    rm -rf "$REPO_DIR"
    depth=(--depth 1); [ -f "$src" ] && depth=()  # a shallow clone of a bundle fetches no branches
    if ! git clone -q ${depth[@]+"${depth[@]}"} "$src" "$REPO_DIR" 2>/dev/null; then
      if [ -f "$src" ] || git ls-remote "$src" >/dev/null 2>&1; then say "clone failed: $src"; exit 1; fi
      # Not on GitHub yet: a new project. Start an empty repo; the patch becomes its first commit.
      git init -q -b main "$REPO_DIR"; say "new repo: couldn't clone $src, so starting empty. If that repo exists (private?), stop and say so instead."
    fi
    cd "$REPO_DIR"
    # A bundle without HEAD clones with nothing checked out: take its first branch.
    if [ -f "$src" ] && ! git rev-parse -q --verify HEAD >/dev/null; then
      b=$(git bundle list-heads "$src" | awk '$2 ~ /^refs\/heads\// {sub("refs/heads/", "", $2); print $2; exit}')
      [ -n "$b" ] && git checkout -q -b "$b" "origin/$b"
    fi
    git config user.name swe; git config user.email swe@localhost
    git commit -q --allow-empty -m base >/dev/null 2>&1 || true
    # Work in progress from an earlier run (wip.patch), or folders of patches, in order.
    # Left uncommitted: it's this task's own work, so \`diff\` must include it.
    # (A plan's earlier tasks come in the bundle's history instead.)
    for arg in ${base_args[@]+"${base_args[@]}"}; do
      if [ -d "$arg" ]; then files=$(ls "$arg"/*.patch 2>/dev/null | sort -V); else files="$arg"; fi
      [ -n "$files" ] || say "WARNING: no .patch files in $arg"
      for f in $files; do
        [ -e "$f" ] || { say "WARNING: $f not found — earlier work NOT applied. Pass the path as run_python sees it (ls it first)."; continue; }
        [ -s "$f" ] || continue
        if git apply "$f"; then say "restored $f (part of your diff)"; else say "WARNING: $f did not apply"; fi
      done
    done
    if [ -f platformio.ini ]; then pip install -q platformio 2>&1 | tail -1; fi
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
      plat=""
      [[ "$c" == "pio run -e "* ]] && plat=$(awk -v e="[env:${c#pio run -e }]" '$0==e{f=1;next} /^\[/{f=0} f&&/^platform *=/{sub(/^platform *= */,"");print;exit}' platformio.ini)
      if [[ "$c" == "pio run"* ]] && [ "$plat" != native ]; then
        # An embedded toolchain (ESP32: hundreds of MB) can't download inside one sandbox run.
        say "SKIP  $c — the embedded toolchain can't download within a sandbox run; build it on your machine (native tests cover the logic)"
        continue
      fi
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
    git add -A && git diff --cached --binary > "$out"
    say "saved $out:$(git diff --cached --shortstat)"
    git reset -q
    ;;
  push)
    shift
    [ -n "${GH_TOKEN:-}" ] || { say "swe.sh push: GH_TOKEN isn't set — export a GitHub token to push"; exit 1; }
    exec bash "$(dirname "$0")/swe-push.sh" "$@"
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
