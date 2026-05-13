#!/usr/bin/env bash
# Choomfie installer
# Usage: git clone https://github.com/ANonABento/choomfie.git && cd choomfie && ./install.sh

set -euo pipefail

CHOOMFIE_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$HOME/.claude/plugins/data/choomfie-inline"
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

echo "[1/5] Prerequisites OK (bun, curl)"
if ! command -v hermes &>/dev/null; then
  echo "  Note: hermes CLI not found. Install Hermes before running 'choomfie'."
fi
if ! command -v claude &>/dev/null; then
  echo "  Note: claude CLI not found. Install Claude Code before using 'choomfie claude-code'."
fi

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
  echo "  2. Create New Application > Bot > Reset Token > Copy"
  echo "  3. Enable MESSAGE CONTENT INTENT under Bot > Privileged Intents"
  echo "  4. Invite bot: OAuth2 > URL Generator > bot scope > Send Messages + Read Message History"
  echo ""
  read -rp "Paste your Discord bot token (or press Enter to skip): " token
  if [ -n "$token" ]; then
    echo "DISCORD_TOKEN=$token" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    mkdir -p "$HERMES_HOME/profiles/choomfie"
    {
      echo "DISCORD_BOT_TOKEN=$token"
      echo "DISCORD_ALLOWED_USERS="
      echo "ANTHROPIC_API_KEY="
      echo "OPENAI_API_KEY="
      echo "CHOOMFIE_LEGACY_DB=$DATA_DIR/choomfie.db"
    } > "$HERMES_HOME/profiles/choomfie/.env"
    chmod 600 "$HERMES_HOME/profiles/choomfie/.env"
    echo "[3/5] Token saved"
  else
    echo "[3/5] Skipped — run '/choomfie:configure <token>' later in Claude Code"
  fi
fi

# --- Detect owner ---
echo "[4/5] Detecting bot owner..."
OWNER_ID=""

if [ -f "$DATA_DIR/access.json" ] && grep -q '"owner"' "$DATA_DIR/access.json"; then
  EXISTING_OWNER=$(grep -o '"owner"[[:space:]]*:[[:space:]]*"[^"]*"' "$DATA_DIR/access.json" | cut -d'"' -f4)
  echo "  Owner already set: $EXISTING_OWNER"
  OWNER_ID="$EXISTING_OWNER"
elif [ -f "$ENV_FILE" ] && grep -q "DISCORD_TOKEN=" "$ENV_FILE"; then
  TOKEN=$(grep "DISCORD_TOKEN=" "$ENV_FILE" | cut -d'=' -f2-)
  APP_JSON=$(curl -s -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/oauth2/applications/@me 2>/dev/null || true)
  OWNER_ID=$(echo "$APP_JSON" | grep -o '"owner"[^}]*"id"[^"]*"[^"]*"' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$OWNER_ID" ]; then
    cat > "$DATA_DIR/access.json" <<EOJSON
{
  "policy": "allowlist",
  "owner": "$OWNER_ID",
  "allowed": ["$OWNER_ID"]
}
EOJSON
    chmod 600 "$DATA_DIR/access.json"
    echo "  Owner auto-detected: $OWNER_ID"
  else
    echo "  Could not detect owner — set manually with '/choomfie:access owner <USER_ID>'"
  fi
else
  echo "  No token configured — skipping owner detection"
fi

if [ -n "$OWNER_ID" ] && [ -f "$HERMES_HOME/profiles/choomfie/.env" ]; then
  if grep -q '^DISCORD_ALLOWED_USERS=' "$HERMES_HOME/profiles/choomfie/.env"; then
    sed -i "s/^DISCORD_ALLOWED_USERS=.*/DISCORD_ALLOWED_USERS=$OWNER_ID/" "$HERMES_HOME/profiles/choomfie/.env"
  else
    echo "DISCORD_ALLOWED_USERS=$OWNER_ID" >> "$HERMES_HOME/profiles/choomfie/.env"
  fi
fi

# --- Install choomfie command ---
echo "[5/5] Installing 'choomfie' command..."
mkdir -p "$BIN_DIR"
chmod +x "$CHOOMFIE_DIR/bin/choomfie" "$CHOOMFIE_DIR/bin/choomfie-claude-code"
chmod +x "$CHOOMFIE_DIR/packages/core/bin/choomfie"
chmod +x "$CHOOMFIE_DIR/hermes-overlay/scripts/"*.sh
ln -sf "$CHOOMFIE_DIR/bin/choomfie" "$BIN_DIR/choomfie"
ln -sf "$CHOOMFIE_DIR/bin/choomfie-claude-code" "$BIN_DIR/choomfie-claude-code"
rm -f "$BIN_DIR/choomfie-legacy"
"$CHOOMFIE_DIR/bin/choomfie" sync >/dev/null || true

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
