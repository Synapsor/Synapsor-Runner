#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

reuse_results=0
if [[ "${1:-}" == "--from-results" ]]; then
  reuse_results=1
  shift
fi
[[ "$#" -eq 0 ]] || demo_fail "Usage: build-safe-action-video.sh [--from-results]"

cleanup_on_exit() {
  local status=$?
  demo_stop_local_services
  exit "$status"
}
trap cleanup_on_exit EXIT INT TERM

demo_ensure_dirs
if [[ "$reuse_results" -eq 0 ]]; then
  "$SCRIPT_DIR/check-prerequisites.sh"
  "$SCRIPT_DIR/reset.sh" --keep-media
  "$SCRIPT_DIR/run-demo.sh"
else
  [[ -f "$DEMO_VIDEO_RESULTS" ]] || demo_fail "Product results are missing; omit --from-results to create them."
fi

node "$SCRIPT_DIR/render-safe-action-deck.mjs" "$DEMO_VIDEO_RESULTS" "$DEMO_VIDEO_SHORT_DECK"
node "$SCRIPT_DIR/capture-frames.mjs" \
  "$DEMO_VIDEO_SHORT_DECK" \
  "$DEMO_VIDEO_SHORT_FRAMES_DIR" \
  "$DEMO_VIDEO_FPS" \
  "$DEMO_VIDEO_SHORT_DURATION_SECONDS"

frame_count="$(find "$DEMO_VIDEO_SHORT_FRAMES_DIR" -maxdepth 1 -name 'frame-*.jpg' | wc -l)"
expected_count="$((DEMO_VIDEO_FPS * DEMO_VIDEO_SHORT_DURATION_SECONDS))"
[[ "$frame_count" -eq "$expected_count" ]] || demo_fail "Expected $expected_count short-demo frames, got $frame_count."

frames_rel="$(demo_relpath "$DEMO_VIDEO_SHORT_FRAMES_DIR")"
mp4_rel="$(demo_relpath "$DEMO_VIDEO_SHORT_MP4")"
gif_rel="$(demo_relpath "$DEMO_VIDEO_SHORT_GIF")"
poster_rel="$(demo_relpath "$DEMO_VIDEO_SHORT_POSTER")"

demo_ffmpeg -hide_banner -loglevel warning -y \
  -framerate "$DEMO_VIDEO_FPS" \
  -start_number 1 \
  -i "$frames_rel/frame-%03d.jpg" \
  -vf "scale=in_range=pc:out_range=tv,format=yuv420p" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -color_range tv \
  -map_metadata -1 -r 30 -movflags +faststart -an "$mp4_rel"

demo_ffmpeg -hide_banner -loglevel warning -y \
  -t 18 -i "$mp4_rel" \
  -filter_complex "fps=10,scale=960:540:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=144:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  -loop 0 "$gif_rel"

demo_ffmpeg -hide_banner -loglevel warning -y \
  -ss 11 -i "$mp4_rel" -frames:v 1 -update 1 -q:v 2 "$poster_rel"

"$SCRIPT_DIR/verify-safe-action-video.sh"
demo_stop_local_services
trap - EXIT INT TERM
demo_log "Safe Action launch cut rendered. It was not published."
