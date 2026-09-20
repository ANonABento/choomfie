#!/usr/bin/env bash
# install-launchd.sh — register the Choomfie daemon as a per-user launchd service.
#
# Usage:
#   install-launchd.sh                # install + load service
#   install-launchd.sh --uninstall    # unload + remove
#   install-launchd.sh --status       # show launchctl + running state
#
# After install, the service auto-starts at login and is restarted on crash
# (KeepAlive on non-zero exit). Logs land in ~/Library/Logs/choomfie/.

set -euo pipefail

LABEL="dev.choomfie.daemon"
LEGACY_LABEL="dev.choomfie.local"
USER_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$USER_AGENTS_DIR/${LABEL}.plist"
LEGACY_PLIST="$USER_AGENTS_DIR/${LEGACY_LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/choomfie"

# Resolve the monorepo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")" && pwd)"
CHOOMFIE_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCHER="$CHOOMFIE_DIR/bin/choomfie"

# Remove the pre-consolidation local-mode service if it's still around. Its
# launcher no longer exists, so leaving it loaded just spins on failure.
remove_legacy_service() {
  if [ -f "$LEGACY_PLIST" ]; then
    launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
    rm -f "$LEGACY_PLIST"
    echo "Removed superseded service $LEGACY_LABEL"
  fi
}

if [[ "${1:-}" == "--status" ]]; then
  if launchctl list | grep -q "$LABEL"; then
    echo "launchd: loaded ($LABEL)"
    launchctl list | grep "$LABEL"
  else
    echo "launchd: not loaded"
  fi
  if [ -f "$LEGACY_PLIST" ]; then
    echo "warning: superseded $LEGACY_LABEL plist still present — rerun install to clear it"
  fi
  if [ -f "$LOG_DIR/stdout.log" ]; then
    echo "Recent log lines ($LOG_DIR/stdout.log):"
    tail -n 5 "$LOG_DIR/stdout.log" 2>/dev/null || true
  fi
  exit 0
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  remove_legacy_service
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

# Daemon mode spawns the Claude Code CLI through the Agent SDK, so `claude` has
# to be on the service's PATH. launchd gives the process a minimal environment
# and does NOT read your shell profile, so resolve it now and bake it in.
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ]; then
  echo "Error: 'claude' not found in PATH."
  echo "  The daemon runs Claude Code, so launchd needs to be able to find it."
  echo "  Install the Claude Code CLI, then rerun this script from a shell where"
  echo "  'command -v claude' resolves."
  exit 1
fi
CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"

SERVICE_PATH="$BUN_DIR:$CLAUDE_DIR:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

# Carry a custom data dir through if this shell has one set; otherwise the
# service falls back to the same default every other entry point uses.
DATA_DIR_ENTRY=""
if [ -n "${CHOOMFIE_DATA_DIR:-}" ]; then
  DATA_DIR_ENTRY="        <key>CHOOMFIE_DATA_DIR</key>
        <string>${CHOOMFIE_DATA_DIR}</string>
"
elif [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  DATA_DIR_ENTRY="        <key>CHOOMFIE_DATA_DIR</key>
        <string>${CLAUDE_PLUGIN_DATA}</string>
"
fi

remove_legacy_service
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
        <string>--daemon</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${CHOOMFIE_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${SERVICE_PATH}</string>
        <key>HOME</key>
        <string>${HOME}</string>
${DATA_DIR_ENTRY}    </dict>
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
echo "  Runs: $LAUNCHER --daemon"
echo "  claude: $CLAUDE_BIN"
echo "Logs: $LOG_DIR/stdout.log + stderr.log"
echo "Status: $(basename "$0") --status"
echo "Uninstall: $(basename "$0") --uninstall"
