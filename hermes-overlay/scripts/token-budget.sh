#!/usr/bin/env bash
set -euo pipefail

HERMES_HOME="${CHOOMFIE_HERMES_HOME:-$HOME/.choomfie-hermes}"
PROFILE_NAME="${CHOOMFIE_HERMES_PROFILE:-choomfie}"
HERMES_BIN="${HERMES_BIN:-hermes}"
SOURCE="${CHOOMFIE_TOKEN_BUDGET_SOURCE:-discord}"
WARN_THRESHOLD="${CHOOMFIE_TOKEN_WARN_THRESHOLD:-2000000}"
HARD_THRESHOLD="${CHOOMFIE_TOKEN_HARD_THRESHOLD:-3000000}"
STATE_DIR="${CHOOMFIE_TOKEN_BUDGET_STATE:-$HERMES_HOME/profiles/$PROFILE_NAME/state}"
SAMPLE_FILE="$STATE_DIR/token-budget-last-sample.txt"

mkdir -p "$STATE_DIR"

insights_output="$(HERMES_HOME="$HERMES_HOME" "$HERMES_BIN" -p "$PROFILE_NAME" insights --days 1 --source "$SOURCE")"
printf '%s\n' "$insights_output" > "$SAMPLE_FILE"

total_tokens="$(
  printf '%s\n' "$insights_output" |
    awk '
      BEGIN { best = "" }
      {
        line = tolower($0)
        if (line ~ /total/ && line ~ /token/) {
          for (i = 1; i <= NF; i++) {
            token = $i
            gsub(/[^0-9]/, "", token)
            if (token != "" && (best == "" || token + 0 > best + 0)) {
              best = token
            }
          }
        }
      }
      END { print best }
    '
)"

if [ -z "$total_tokens" ]; then
  echo "token-budget: unable to parse total tokens from Hermes insights output" >&2
  exit 2
fi

echo "token-budget: $SOURCE daily tokens=$total_tokens warn=$WARN_THRESHOLD hard=$HARD_THRESHOLD"

if [ "$total_tokens" -ge "$HARD_THRESHOLD" ]; then
  echo "token-budget: hard threshold exceeded" >&2
  exit 2
fi

if [ "$total_tokens" -ge "$WARN_THRESHOLD" ]; then
  echo "token-budget: warning threshold exceeded" >&2
  exit 1
fi
