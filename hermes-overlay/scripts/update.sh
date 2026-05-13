#!/usr/bin/env bash
set -euo pipefail

OVERLAY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$OVERLAY_DIR/.." && pwd)"
exec "$REPO_DIR/bin/choomfie" update
