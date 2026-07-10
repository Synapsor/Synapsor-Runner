#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

require_command() {
  command -v "$1" >/dev/null 2>&1 || demo_fail "Missing required command: $1"
}

for command in node npm npx docker google-chrome git sha256sum unzip; do
  require_command "$command"
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 22 )) || demo_fail "Node 22+ is required."

docker info >/dev/null 2>&1 || demo_fail "Docker is not running."

available_kb="$(df -Pk "$DEMO_VIDEO_ROOT" | awk 'NR==2 {print $4}')"
(( available_kb >= 5 * 1024 * 1024 )) || demo_fail "At least 5 GB free disk is required."

for path in \
  "$DEMO_VIDEO_COMPOSE_FILE" \
  "$DEMO_VIDEO_CONFIG" \
  "$DEMO_VIDEO_CONTRACT" \
  "$DEMO_VIDEO_DSL" \
  "$DEMO_VIDEO_ENV_EXAMPLE"; do
  [[ -f "$path" ]] || demo_fail "Missing demo input: $path"
done

docker manifest inspect "$DEMO_VIDEO_FFMPEG_IMAGE" >/dev/null \
  || demo_fail "Pinned FFmpeg image is unavailable: $DEMO_VIDEO_FFMPEG_IMAGE"

if [[ "$DEMO_VIDEO_RUNNER_MODE" == "published" ]]; then
  published_version="$(npm_config_loglevel=error npm view @synapsor/runner@"$DEMO_VIDEO_RUNNER_VERSION" version)"
  [[ "$published_version" == "$DEMO_VIDEO_RUNNER_VERSION" ]] \
    || demo_fail "Published Runner $DEMO_VIDEO_RUNNER_VERSION is unavailable."
else
  [[ -x "$DEMO_VIDEO_ROOT/bin/synapsor-runner" ]] || demo_fail "Local Runner wrapper is missing."
fi

if [[ "${1:-}" == "--require-cloud" ]]; then
  [[ -f "$DEMO_VIDEO_PRIVATE_CLOUD_STATE" ]] \
    || demo_fail "Cloud state is missing. Run setup-cloud-workspace.mjs through the documented private setup command."
fi

demo_log "Prerequisites passed."
demo_log "Runner mode: $DEMO_VIDEO_RUNNER_MODE ($DEMO_VIDEO_RUNNER_VERSION)"
demo_log "Capture: Chrome at ${DEMO_VIDEO_FPS} fps"
demo_log "Encoder: $DEMO_VIDEO_FFMPEG_IMAGE"
demo_log "Free disk: $((available_kb / 1024 / 1024)) GB"
