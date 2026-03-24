#!/usr/bin/env bash
# Choomfie installer
# Usage: git clone https://github.com/ANonABento/choomfie.git && cd choomfie && ./install.sh

set -euo pipefail

CHOOMFIE_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.claude/channels/choomfie"
BIN_DIR="${HOME}/.local/bin"

echo "=== Choomfie Installer ==="
echo ""

# --- Check prerequisites ---
missing=()

if ! command -v claude &>/dev/null; then
  missing+=("claude (Claude Code CLI — https://code.claude.com)")
fi

if ! command -v bun &>/dev/null; then
  missing+=("bun (https://bun.sh — brew install oven-sh/bun/bun)")
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

echo "[1/5] Prerequisites OK (claude, bun)"

# --- Install dependencies ---
echo "[2/5] Installing dependencies..."
(cd "$CHOOMFIE_DIR" && bun install --no-summary)

# --- Discord token ---
mkdir -p "$DATA_DIR"
ENV_FILE="$DATA_DIR/.env"

if [ -f "$ENV_FILE" ] && grep -q "DISCORD_TOKEN=" "$ENV_FILE"; then
  echo "[3/5] Discord token already configured"
else
  echo ""
  echo "You need a Discord bot token. If you don't have one yet:"
  echo "  1. Go to https://discord.com/developers/applications"
  echo "  2. Create New Application → Bot → Reset Token → Copy"
  echo "  3. Enable MESSAGE CONTENT INTENT under Bot → Privileged Intents"
  echo "  4. Invite bot: OAuth2 → URL Generator → bot scope → Send Messages + Read Message History"
  echo ""
  read -rp "Paste your Discord bot token (or press Enter to skip): " token
  if [ -n "$token" ]; then
    echo "DISCORD_TOKEN=$token" > "$ENV_FILE"
    echo "[3/5] Token saved to $ENV_FILE"

    # Auto-detect owner from Discord application info
    echo "  Detecting bot owner..."
    APP_JSON=$(curl -s -H "Authorization: Bot $token" https://discord.com/api/v10/oauth2/applications/@me 2>/dev/null || true)
    OWNER_ID=$(echo "$APP_JSON" | grep -o '"owner"[^}]*"id"[^"]*"[^"]*"' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -n "$OWNER_ID" ]; then
      cat > "$DATA_DIR/access.json" <<EOJSON
{
  "policy": "allowlist",
  "owner": "$OWNER_ID",
  "allowed": ["$OWNER_ID"]
}
EOJSON
      echo "  Owner auto-detected: $OWNER_ID"
    else
      echo "  Could not detect owner — set manually with '/choomfie:access owner <USER_ID>'"
    fi
  else
    echo "[3/5] Skipped — run '/choomfie:configure <token>' later in Claude Code"
  fi
fi

# --- Register MCP server ---
CLAUDE_CONFIG="$HOME/.claude.json"
echo "[4/5] Registering MCP server..."

if [ -f "$CLAUDE_CONFIG" ]; then
  if grep -q '"choomfie"' "$CLAUDE_CONFIG"; then
    echo "  Already registered in $CLAUDE_CONFIG"
  else
    # Use a temp file approach to add the MCP server entry
    echo "  Add this to mcpServers in $CLAUDE_CONFIG:"
    echo ""
    echo "  \"choomfie\": {"
    echo "    \"type\": \"stdio\","
    echo "    \"command\": \"bun\","
    echo "    \"args\": [\"run\", \"--cwd\", \"$CHOOMFIE_DIR\", \"server.ts\"]"
    echo "  }"
    echo ""
    echo "  (Manual step — editing claude.json programmatically is risky)"
  fi
else
  echo "  $CLAUDE_CONFIG not found — it will be created when you first run Claude Code"
  echo "  Then add choomfie to mcpServers (see README for config)"
fi

# --- Install choomfie command ---
echo "[5/5] Installing 'choomfie' command..."
mkdir -p "$BIN_DIR"
chmod +x "$CHOOMFIE_DIR/bin/choomfie"
ln -sf "$CHOOMFIE_DIR/bin/choomfie" "$BIN_DIR/choomfie"

# Check if BIN_DIR is in PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  SHELL_RC=""
  if [ -f "$HOME/.zshrc" ]; then
    SHELL_RC="$HOME/.zshrc"
  elif [ -f "$HOME/.bashrc" ]; then
    SHELL_RC="$HOME/.bashrc"
  fi

  if [ -n "$SHELL_RC" ]; then
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    echo "  Added $BIN_DIR to PATH in $SHELL_RC"
    echo "  Run: source $SHELL_RC"
  else
    echo "  Add $BIN_DIR to your PATH manually"
  fi
fi

echo ""
echo "=== Done! ==="
echo ""
echo "Start Choomfie:"
echo "  choomfie          # normal mode"
echo "  choomfie --tmux   # background mode (survives terminal close)"
echo ""
echo "Owner is auto-detected from your Discord app — no pairing needed!"
echo ""
echo "To add other users:"
echo "  1. They DM the bot '!pair' on Discord"
echo "  2. Run '/choomfie:access pair <code>' in the Claude Code session"
