#!/usr/bin/env bash
set -euo pipefail

OVERLAY_DIR="${1:?overlay dir required}"
HERMES_HOME="${2:?Hermes home required}"
PROFILE_NAME="${3:?profile name required}"
PROFILE_DIR="$HERMES_HOME/profiles/$PROFILE_NAME"

mkdir -p \
  "$PROFILE_DIR" \
  "$HERMES_HOME/hooks" \
  "$HERMES_HOME/plugins" \
  "$PROFILE_DIR/hooks" \
  "$PROFILE_DIR/plugins"

copy_dir() {
  local src="$1"
  local dst="$2"
  if [ -d "$src" ]; then
    rm -rf "$dst"
    mkdir -p "$dst"
    cp -R "$src"/. "$dst"/
  fi
}

copy_children() {
  local src="$1"
  local dst="$2"
  local child
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    for child in "$src"/*; do
      [ -e "$child" ] || continue
      copy_dir "$child" "$dst/$(basename "$child")"
    done
  fi
}

install_file() {
  local src="$1"
  local dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
}

install_file "$OVERLAY_DIR/distribution.yaml" "$PROFILE_DIR/distribution.yaml"
install_file "$OVERLAY_DIR/SOUL.md" "$PROFILE_DIR/SOUL.md"

if [ ! -f "$PROFILE_DIR/config.yaml" ]; then
  install_file "$OVERLAY_DIR/config.yaml" "$PROFILE_DIR/config.yaml"
fi

if [ ! -f "$PROFILE_DIR/.env" ]; then
  install_file "$OVERLAY_DIR/.env.EXAMPLE" "$PROFILE_DIR/.env.EXAMPLE"
fi

copy_dir "$OVERLAY_DIR/skills" "$PROFILE_DIR/skills"
copy_dir "$OVERLAY_DIR/scripts" "$PROFILE_DIR/scripts"
copy_dir "$OVERLAY_DIR/cron" "$PROFILE_DIR/cron"
copy_children "$OVERLAY_DIR/hooks" "$HERMES_HOME/hooks"
copy_children "$OVERLAY_DIR/hooks" "$PROFILE_DIR/hooks"
copy_children "$OVERLAY_DIR/plugins" "$HERMES_HOME/plugins"
copy_children "$OVERLAY_DIR/plugins" "$PROFILE_DIR/plugins"

echo "Synced Choomfie Hermes overlay to $PROFILE_DIR"
