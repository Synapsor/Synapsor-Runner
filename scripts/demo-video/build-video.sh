#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

if [[ "${1:-}" == "--" ]]; then
  shift
fi

local_draft=0
if [[ "${1:-}" == "--local-draft" ]]; then
  shift
  local_draft=1
fi
if [[ "$#" -ne 0 ]]; then
  demo_fail "Usage: build-video.sh [--local-draft]"
fi

cleanup_needed=0
cleanup_on_exit() {
  local status=$?
  set +e
  if [[ "$cleanup_needed" -eq 1 && -f "$DEMO_VIDEO_PRIVATE_CLOUD_STATE" && -n "${SYNAPSOR_DEMO_ADMIN_TOKEN:-}" ]]; then
    "$SCRIPT_DIR/cleanup-cloud.sh" >&2
  fi
  demo_stop_local_services
  exit "$status"
}
trap cleanup_on_exit EXIT INT TERM

"$SCRIPT_DIR/check-prerequisites.sh"
if [[ "$local_draft" -eq 0 ]]; then
  [[ -n "${SYNAPSOR_DEMO_ADMIN_TOKEN:-}" ]] \
    || demo_fail "SYNAPSOR_DEMO_ADMIN_TOKEN is required for the final Cloud-backed video."
fi

"$SCRIPT_DIR/reset.sh"

if [[ "$local_draft" -eq 0 ]]; then
  SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE="$DEMO_VIDEO_PRIVATE_CLOUD_STATE" \
  SYNAPSOR_DEMO_CLOUD_PUBLIC_STATE="$DEMO_VIDEO_PUBLIC_CLOUD_STATE" \
    node "$SCRIPT_DIR/setup-cloud-workspace.mjs"
  cleanup_needed=1
fi

"$SCRIPT_DIR/run-demo.sh"

if [[ "$local_draft" -eq 0 ]]; then
  "$SCRIPT_DIR/capture-cloud-ui.sh"
fi

"$SCRIPT_DIR/capture-terminal.sh"

frames_rel="$(demo_relpath "$DEMO_VIDEO_FRAMES_DIR")"
mp4_rel="$(demo_relpath "$DEMO_VIDEO_MP4")"
gif_rel="$(demo_relpath "$DEMO_VIDEO_GIF")"
demo_log "Encoding 1920x1080 H.264 launch video."
demo_ffmpeg -hide_banner -loglevel warning -y \
  -framerate "$DEMO_VIDEO_FPS" \
  -start_number 1 \
  -i "$frames_rel/frame-%04d.jpg" \
  -vf "scale=in_range=pc:out_range=tv,format=yuv420p" \
  -c:v libx264 \
  -preset medium \
  -crf 20 \
  -pix_fmt yuv420p \
  -color_range tv \
  -map_metadata -1 \
  -r 30 \
  -movflags +faststart \
  -an \
  "$mp4_rel"

demo_log "Encoding the 26-second proposal-boundary teaser GIF."
demo_ffmpeg -hide_banner -loglevel warning -y \
  -ss 70 \
  -t 26 \
  -i "$mp4_rel" \
  -filter_complex "fps=10,scale=960:540:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 \
  "$gif_rel"

if [[ "$local_draft" -eq 1 ]]; then
  demo_log "Local draft encoded. Final verification is intentionally skipped because no real Cloud capture exists."
  cleanup_needed=0
  demo_stop_local_services
  trap - EXIT INT TERM
  exit 0
fi

"$SCRIPT_DIR/cleanup-cloud.sh"
cleanup_needed=0
demo_stop_local_services
trap - EXIT INT TERM

demo_ffprobe -v quiet -print_format json -show_format -show_streams "$mp4_rel" >"$DEMO_VIDEO_MEDIA_METADATA"
demo_ffprobe -v quiet -print_format json -show_format -show_streams "$gif_rel" >"$DEMO_VIDEO_GIF_METADATA"
node "$SCRIPT_DIR/write-asset-manifest.mjs" \
  "$DEMO_VIDEO_ROOT" \
  "$DEMO_VIDEO_RESULTS" \
  "$DEMO_VIDEO_MEDIA_METADATA" \
  "$DEMO_VIDEO_GIF_METADATA" \
  "$DEMO_VIDEO_MP4" \
  "$DEMO_VIDEO_GIF" \
  "$DEMO_VIDEO_ROOT/docs/launch/asset-manifest.md"

"$SCRIPT_DIR/verify-video.sh"
demo_log "Launch assets are rendered and ready for manual review. They were not published."
