#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

demo_ensure_dirs
[[ -f "$DEMO_VIDEO_RESULTS" ]] || demo_fail "Product results are missing. Run run-demo.sh first."

node "$SCRIPT_DIR/render-deck.mjs" \
  "$DEMO_VIDEO_RESULTS" \
  "$DEMO_VIDEO_CLOUD_SCREENSHOT" \
  "$DEMO_VIDEO_DECK"

demo_log "Title cards and product scenes rendered to $(demo_relpath "$DEMO_VIDEO_DECK")."
