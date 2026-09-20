#!/usr/bin/env bash
# Choomfie installer
# Usage: git clone https://github.com/ANonABento/choomfie.git && cd choomfie && ./install.sh

set -euo pipefail

CHOOMFIE_DIR="$(cd "$(dirname "$0")" && pwd)"
# Must match resolveDataDir() in packages/shared/paths.ts — same names, same order.
CLAUDE_DATA_DIR="${CHOOMFIE_DATA_DIR:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/choomfie-inline}}"
BIN_DIR="${HOME}/.local/bin"

echo "=== Choomfie Installer ==="
echo ""

# --- Check prerequisites ---
missing=()

if ! command -v bun &>/dev/null; then
  missing+=("bun (https://bun.sh — brew install oven-sh/bun/bun)")
fi

if ! command -v curl &>/dev/null; then
  missing+=("curl (used for Discord owner auto-detection)")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites:"
  for m in "${missing[@]}"; do
    echo "  - $m"
  done
  echo ""
  echo "Install the above and re-run this script."
  exit 1
fi

echo "[1/4] Prerequisites OK (bun, curl)"
if ! command -v claude &>/dev/null; then
  echo "  Note: claude CLI not found. Install Claude Code before running 'choomfie'."
fi

# --- Install dependencies ---
echo "[2/4] Installing dependencies..."
(cd "$CHOOMFIE_DIR" && bun install --no-summary)

# --- Install choomfie command ---
echo "[3/4] Installing 'choomfie' command..."
mkdir -p "$BIN_DIR"
chmod +x "$CHOOMFIE_DIR/bin/choomfie"
ln -sf "$CHOOMFIE_DIR/bin/choomfie" "$BIN_DIR/choomfie"
rm -f "$BIN_DIR/choomfie-legacy" "$BIN_DIR/choomfie-claude-code"

echo "[4/4] Configuring Discord token..."
mkdir -p "$CLAUDE_DATA_DIR"
env_file="$CLAUDE_DATA_DIR/.env"
token="${DISCORD_TOKEN:-${DISCORD_BOT_TOKEN:-}}"

if [ -z "$token" ] && [ -f "$env_file" ]; then
  token="$(awk -F= '$1 == "DISCORD_TOKEN" { print substr($0, length($1) + 2); exit }' "$env_file")"
fi

if [ -z "$token" ]; then
  echo ""
  echo "You need a Discord bot token. If you do not have one yet:"
  echo "  1. Go to https://discord.com/developers/applications"
  echo "  2. Create New Application > Bot > Reset Token > Copy"
  echo "  3. Enable MESSAGE CONTENT INTENT under Bot > Privileged Intents"
  echo "  4. Invite bot: OAuth2 > URL Generator > bot scope > Send Messages + Read Message History"
  echo ""
  read -rp "Paste your Discord bot token (or press Enter to skip): " token
fi

if [ -n "$token" ]; then
  tmp="$(mktemp)"
  if [ -f "$env_file" ]; then
    awk -v value="$token" '
      BEGIN { done = 0 }
      $0 ~ "^DISCORD_TOKEN=" { print "DISCORD_TOKEN=" value; done = 1; next }
      { print }
      END { if (!done) print "DISCORD_TOKEN=" value }
    ' "$env_file" > "$tmp"
  else
    printf 'DISCORD_TOKEN=%s\n' "$token" > "$tmp"
  fi
  mv "$tmp" "$env_file"
  chmod 600 "$env_file"
  echo "Discord token saved. Owner will be auto-detected on first startup."
else
  echo "Discord token not configured. Run '/choomfie:configure <token>' from Claude Code once it's running."
fi

# Check if BIN_DIR is in PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  fi

  if [ -n "$SHELL_RC" ]; then
    if ! grep -Fq "export PATH=\"$BIN_DIR:\$PATH\"" "$SHELL_RC"; then
      echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
      echo "  Added $BIN_DIR to PATH in $SHELL_RC"
      echo "  Run: source $SHELL_RC"
    else
      echo "  PATH already configured in $SHELL_RC"
    fi
  else
    echo "  Add $BIN_DIR to your PATH manually"
  fi
fi

# --- Optional: start at login (macOS) ---
# An install-time question rather than a config.json setting: this writes a
# launchd agent and calls launchctl, which the running process has no business
# doing to your machine on its own.
autostart="unsupported"
if [ "$(uname -s)" = "Darwin" ]; then
  autostart="off"
  answer="${CHOOMFIE_AUTOSTART:-}"
  if [ -z "$answer" ] && [ -t 0 ]; then
    echo ""
    read -rp "Start Choomfie automatically at login? [y/N]: " answer
  fi
  case "$answer" in
    [yY] | [yY][eE][sS] | 1 | true)
      echo ""
      # install-launchd.sh reports its own errors; just record the outcome.
      if "$CHOOMFIE_DIR/packages/core/scripts/install-launchd.sh"; then
        autostart="on"
      fi
      ;;
  esac
fi

echo ""
echo "=== Done! ==="
echo ""
echo "Start Choomfie:"
echo "  choomfie            # run through your Claude Code plan"
echo "  choomfie --daemon   # always-on autonomous mode"
echo "  choomfie --tmux     # run in a detached tmux session"
echo ""

case "$autostart" in
  on)  echo "Auto-start is ON — launchd runs 'choomfie --daemon' at login."
       echo "  bun run install:launchd --status | --uninstall" ;;
  off) echo "Auto-start is off. Enable anytime with:"
       echo "  bun run install:launchd" ;;
esac
