#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

demo_assert_safe_state_dir

if [[ -f "$DEMO_VIDEO_PRIVATE_CLOUD_STATE" ]]; then
  demo_fail "Disposable Cloud credentials still exist. Run cleanup-cloud.sh before resetting so the Cloud account is not orphaned."
fi

demo_log "Resetting only the disposable support-plan-credit demo."
demo_stop_local_services
rm -rf "$DEMO_VIDEO_STATE_DIR"
mkdir -p "$DEMO_VIDEO_STATE_DIR"
chmod 700 "$DEMO_VIDEO_STATE_DIR"

if [[ "${1:-}" != "--keep-media" ]]; then
  rm -f \
    "$DEMO_VIDEO_MP4" \
    "$DEMO_VIDEO_GIF" \
    "$DEMO_VIDEO_SHORT_MP4" \
    "$DEMO_VIDEO_SHORT_GIF" \
    "$DEMO_VIDEO_SHORT_POSTER"
fi

"$SCRIPT_DIR/seed.sh"
demo_log "Reset complete."
