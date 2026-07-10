#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

[[ -f "$DEMO_VIDEO_PRIVATE_CLOUD_STATE" ]] || demo_fail "Private Cloud demo state is missing."
[[ -f "$DEMO_VIDEO_PUBLIC_CLOUD_STATE" ]] || demo_fail "Public Cloud demo state is missing."

SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE="$DEMO_VIDEO_PRIVATE_CLOUD_STATE" \
SYNAPSOR_DEMO_CLOUD_PUBLIC_STATE="$DEMO_VIDEO_PUBLIC_CLOUD_STATE" \
SYNAPSOR_DEMO_CLOUD_SCREENSHOT="$DEMO_VIDEO_CLOUD_SCREENSHOT" \
SYNAPSOR_DEMO_CLOUD_CAPTURE_STATE="$DEMO_VIDEO_CLOUD_CAPTURE_STATE" \
  node "$SCRIPT_DIR/capture-cloud-ui.mjs"
