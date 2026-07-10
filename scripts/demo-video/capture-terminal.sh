#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

demo_ensure_dirs
"$SCRIPT_DIR/render-title-cards.sh"

node "$SCRIPT_DIR/capture-frames.mjs" \
  "$DEMO_VIDEO_DECK" \
  "$DEMO_VIDEO_FRAMES_DIR" \
  "$DEMO_VIDEO_FPS" \
  "$DEMO_VIDEO_DURATION_SECONDS"

frame_count="$(find "$DEMO_VIDEO_FRAMES_DIR" -maxdepth 1 -name 'frame-*.jpg' | wc -l)"
expected_count="$((DEMO_VIDEO_FPS * DEMO_VIDEO_DURATION_SECONDS))"
[[ "$frame_count" -eq "$expected_count" ]] \
  || demo_fail "Expected $expected_count captured frames, got $frame_count."

demo_log "Captured $frame_count deterministic 1920x1080 frames."
