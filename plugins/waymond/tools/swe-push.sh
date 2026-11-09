#!/bin/bash
# Waymond code mode: land the work without a human.
#
#   GH_TOKEN=... bash swe-push.sh <branch> "<msg>"   commit /tmp/repo, push the branch over HTTPS, open (or update) its PR
#
# Never pushes to main or the default branch. The token only ever lives in the
# environment; everything printed is scrubbed of it. Kept apart from swe.sh,
# which sandboxes fetch pinned (TOOLS_REF); `swe.sh push` will call this once the pin is bumped.
set -uo pipefail
REPO_DIR=${SWE_REPO_DIR:-/tmp/repo}
say() { printf '%s\n' "$*"; }
# Lands the work without a human: commit, push a branch over HTTPS, open or update its PR.
# The token only ever lives in the environment; output is scrubbed of it.
branch="${1:?branch}"; msg="${2:?message}"; cd "$REPO_DIR" || exit 1
[ -n "${GH_TOKEN:-}" ] || { say "push needs GH_TOKEN (a fine-grained PAT, see README: Letting agents push) - without it, finish with diff"; exit 1; }
unset GIT_TRACE GIT_CURL_VERBOSE GIT_TRACE_CURL
def=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); def=${def#origin/}
if [ "$branch" = main ] || [ "$branch" = master ] || [ "$branch" = "${def:-main}" ]; then
  say "refusing to push to $branch: push a feature branch and open a PR"; exit 1
fi
git check-ref-format --branch "$branch" >/dev/null 2>&1 && [[ "$branch" != -* ]] || { say "not a branch name: $branch"; exit 1; }
scrub() { local s="$1"; printf '%s\n' "${s//"$GH_TOKEN"/***}"; }
out=$(gh auth setup-git 2>&1) || { scrub "$out"; say "gh auth setup-git failed"; exit 1; }
git checkout -q -B "$branch" || exit 1
git add -A
if ! git diff --cached --quiet; then
  git -c user.name="$(git config user.name || echo Waymond)" -c user.email="$(git config user.email || echo waymond@users.noreply.github.com)" \
    -c core.hooksPath=/dev/null commit -q -m "$msg" || exit 1
fi
out=$(git push -q -u origin "HEAD:refs/heads/$branch" 2>&1); rc=$?
[ -n "$out" ] && scrub "$out"
[ $rc -eq 0 ] || { say "push failed"; exit 1; }
if gh pr view "$branch" --json url -q .url >/dev/null 2>&1; then
  out=$(gh pr edit "$branch" --title "$msg" 2>&1); rc=$?; scrub "$out"; say "updated the PR for $branch"
else
  out=$(gh pr create --base "${def:-main}" --head "$branch" --title "$msg" --body "Pushed by Waymond with swe.sh push. Review before merging." 2>&1); rc=$?
  scrub "$out"; say "opened a PR for $branch"
fi
exit $rc
