#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

if [[ ! -f "$DEMO_VIDEO_PRIVATE_CLOUD_STATE" ]]; then
  demo_log "No disposable Cloud workspace remains."
  exit 0
fi

[[ -n "${SYNAPSOR_DEMO_ADMIN_TOKEN:-}" ]] \
  || demo_fail "SYNAPSOR_DEMO_ADMIN_TOKEN is required to delete the disposable Cloud account."

SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE="$DEMO_VIDEO_PRIVATE_CLOUD_STATE" \
  node "$SCRIPT_DIR/cleanup-cloud-workspace.mjs"

demo_log "Disposable Cloud workspace cleanup passed."
