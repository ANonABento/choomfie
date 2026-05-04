#!/usr/bin/env bash
# install-launchd.sh — register Choomfie Local as a per-user launchd service.
#
# Usage:
#   install-launchd.sh                # install + load service
#   install-launchd.sh --uninstall    # unload + remove
#   install-launchd.sh --status       # show launchctl + running state
#
# After install, the service auto-starts at login and is restarted on crash
# (KeepAlive=true). Logs land in ~/Library/Logs/choomfie-local/.

set -euo pipefail

LABEL="dev.choomfie.local"
USER_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$USER_AGENTS_DIR/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/choomfie-local"

# Resolve the monorepo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")" && pwd)"
CHOOMFIE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCHER="$CHOOMFIE_DIR/packages/core/bin/choomfie-local"

if [[ "${1:-}" == "--status" ]]; then
  if launchctl list | grep -q "$LABEL"; then
    echo "launchd: loaded ($LABEL)"
    launchctl list | grep "$LABEL"
  else
    echo "launchd: not loaded"
  fi
  if [ -f "$LOG_DIR/stdout.log" ]; then
    echo "Recent log lines ($LOG_DIR/stdout.log):"
    tail -n 5 "$LOG_DIR/stdout.log" 2>/dev/null || true
  fi
  exit 0
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $PLIST"
  else
    echo "Not installed."
  fi
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: launchd is macOS-only. Use systemd or your OS equivalent on Linux."
  exit 1
fi

if [ ! -x "$LAUNCHER" ]; then
  echo "Error: $LAUNCHER not found or not executable."
  exit 1
fi

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "Error: bun not found in PATH. Install from https://bun.sh."
  exit 1
fi
BUN_DIR="$(dirname "$BUN_BIN")"

mkdir -p "$USER_AGENTS_DIR" "$LOG_DIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${LAUNCHER}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${CHOOMFIE_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${BUN_DIR}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
        <key>CHOOMFIE_LOCAL</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLIST

# Reload — unload-then-load so updates take effect.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed $PLIST"
echo "Logs: $LOG_DIR/stdout.log + stderr.log"
echo "Status: $(basename "$0") --status"
echo "Uninstall: $(basename "$0") --uninstall"
