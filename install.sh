#!/usr/bin/env bash
# Choomfie installer
# Usage: git clone https://github.com/ANonABento/choomfie.git && cd choomfie && ./install.sh

set -euo pipefail

CHOOMFIE_DIR="$(cd "$(dirname "$0")" && pwd)"
HERMES_HOME="${CHOOMFIE_HERMES_HOME:-$HOME/.choomfie-hermes}"
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
if ! command -v hermes &>/dev/null; then
  echo "  Note: hermes CLI not found. Install Hermes before running 'choomfie'."
fi
if ! command -v claude &>/dev/null; then
  echo "  Note: claude CLI not found. Install Claude Code before using 'choomfie claude-code'."
fi

# --- Install dependencies ---
echo "[2/4] Installing dependencies..."
(cd "$CHOOMFIE_DIR" && bun install --no-summary)

# --- Install choomfie command ---
echo "[3/4] Installing 'choomfie' command..."
mkdir -p "$BIN_DIR"
chmod +x "$CHOOMFIE_DIR/bin/choomfie" "$CHOOMFIE_DIR/bin/choomfie-claude-code"
chmod +x "$CHOOMFIE_DIR/hermes-overlay/scripts/"*.sh
ln -sf "$CHOOMFIE_DIR/bin/choomfie" "$BIN_DIR/choomfie"
ln -sf "$CHOOMFIE_DIR/bin/choomfie-claude-code" "$BIN_DIR/choomfie-claude-code"
rm -f "$BIN_DIR/choomfie-legacy"
"$CHOOMFIE_DIR/bin/choomfie" sync >/dev/null || true

echo "[4/4] Configuring Discord token and allowlist..."
"$CHOOMFIE_DIR/bin/choomfie" configure-discord

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

echo ""
echo "=== Done! ==="
echo ""
echo "Start Choomfie:"
echo "  choomfie            # Hermes-backed Discord gateway"
echo "  choomfie doctor     # check Hermes overlay setup"
echo "  choomfie claude-code # Claude Code-powered runtime"
echo ""
echo "Hermes profile state: $HERMES_HOME/profiles/choomfie"
