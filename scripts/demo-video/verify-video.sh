#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

for file in \
  "$DEMO_VIDEO_RESULTS" \
  "$DEMO_VIDEO_CLOUD_CAPTURE_STATE" \
  "$DEMO_VIDEO_CLOUD_SCREENSHOT" \
  "$DEMO_VIDEO_MP4" \
  "$DEMO_VIDEO_GIF" \
  "$DEMO_VIDEO_ROOT/docs/launch/captions.srt"; do
  [[ -s "$file" ]] || demo_fail "Required verification input is missing: $file"
done

[[ ! -f "$DEMO_VIDEO_PRIVATE_CLOUD_STATE" ]] \
  || demo_fail "Private Cloud session state remains after generation."
if docker ps --format '{{.Names}}' | grep -Fxq "$DEMO_VIDEO_CONTAINER"; then
  demo_fail "Disposable Postgres container is still running after generation."
fi

demo_ffprobe -v quiet -print_format json -show_format -show_streams \
  "$(demo_relpath "$DEMO_VIDEO_MP4")" >"$DEMO_VIDEO_MEDIA_METADATA"
demo_ffprobe -v quiet -print_format json -show_format -show_streams \
  "$(demo_relpath "$DEMO_VIDEO_GIF")" >"$DEMO_VIDEO_GIF_METADATA"

rm -rf "$DEMO_VIDEO_REVIEW_DIR"
mkdir -p "$DEMO_VIDEO_REVIEW_DIR"
select_expression="eq(n\,150)+eq(n\,750)+eq(n\,1500)+eq(n\,2250)+eq(n\,3300)+eq(n\,4050)+eq(n\,4800)+eq(n\,5220)"
demo_ffmpeg -hide_banner -loglevel error -y \
  -i "$(demo_relpath "$DEMO_VIDEO_MP4")" \
  -vf "select='$select_expression',scale=960:-2" \
  -fps_mode vfr \
  "$(demo_relpath "$DEMO_VIDEO_REVIEW_DIR")/review-%02d.png"
printf '%s\n' '00:05' '00:25' '00:50' '01:15' '01:50' '02:15' '02:40' '02:54' \
  >"$DEMO_VIDEO_REVIEW_DIR/times.txt"

review_count="$(find "$DEMO_VIDEO_REVIEW_DIR" -maxdepth 1 -name 'review-*.png' | wc -l)"
[[ "$review_count" -eq 8 ]] || demo_fail "Expected 8 representative frames, got $review_count."
unique_reviews="$(sha256sum "$DEMO_VIDEO_REVIEW_DIR"/review-*.png | awk '{print $1}' | sort -u | wc -l)"
[[ "$unique_reviews" -eq 8 ]] || demo_fail "Representative frame extraction contains duplicate/blank scene captures."

set +e
demo_ffmpeg -hide_banner -i "$(demo_relpath "$DEMO_VIDEO_MP4")" \
  -vf "blackdetect=d=1:pix_th=0.01" -an -f null - \
  >"$DEMO_VIDEO_STATE_DIR/blackdetect.txt" 2>&1
black_status=$?
set -e
[[ "$black_status" -eq 0 ]] || demo_fail "FFmpeg black-frame analysis failed."
if grep -q 'black_start:' "$DEMO_VIDEO_STATE_DIR/blackdetect.txt"; then
  demo_fail "Black-frame analysis found a one-second blank interval."
fi

node "$SCRIPT_DIR/verify-media.mjs" \
  "$DEMO_VIDEO_ROOT" \
  "$DEMO_VIDEO_RESULTS" \
  "$DEMO_VIDEO_CLOUD_CAPTURE_STATE" \
  "$DEMO_VIDEO_CLOUD_SCREENSHOT" \
  "$DEMO_VIDEO_MEDIA_METADATA" \
  "$DEMO_VIDEO_GIF_METADATA" \
  "$DEMO_VIDEO_ROOT/docs/launch/captions.srt" \
  "$DEMO_VIDEO_MP4" \
  "$DEMO_VIDEO_GIF" \
  "$DEMO_VIDEO_FRAMES_DIR" \
  >"$DEMO_VIDEO_STATE_DIR/verification.json"

demo_log "Video verification passed."
demo_log "Representative frames: $(demo_relpath "$DEMO_VIDEO_REVIEW_DIR")"
