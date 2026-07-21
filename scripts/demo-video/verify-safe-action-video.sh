#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

for artifact in "$DEMO_VIDEO_SHORT_MP4" "$DEMO_VIDEO_SHORT_GIF" "$DEMO_VIDEO_SHORT_POSTER"; do
  [[ -s "$artifact" ]] || demo_fail "Missing Safe Action media artifact: $artifact"
done

metadata="$(demo_ffprobe -v quiet -print_format json -show_format -show_streams "$(demo_relpath "$DEMO_VIDEO_SHORT_MP4")")"
node -e '
const metadata=JSON.parse(process.argv[1]);
const video=metadata.streams.find((item)=>item.codec_type==="video");
if(!video||video.codec_name!=="h264"||video.width!==1920||video.height!==1080) throw new Error("expected 1920x1080 H.264 video");
if(metadata.streams.some((item)=>item.codec_type==="audio")) throw new Error("short demo must be silent and captioned");
const duration=Number(metadata.format.duration);
if(duration<35.8||duration>36.2) throw new Error(`expected 36-second video, got ${duration}`);
' "$metadata"

node -e '
const r=require(process.argv[1]);
if(r.proposal.source_database_changed!==false) throw new Error("proposal mutated source");
if(r.writeback.rows_affected!==1) throw new Error("expected one applied row");
if(r.stale_conflict.state_after_apply!=="conflict"||r.stale_conflict.source_database_changed!==false) throw new Error("stale conflict proof missing");
if(r.source_state.after_apply.plan_credit_cents!==r.source_state.after_stale_refusal.plan_credit_cents) throw new Error("stale attempt changed business state");
' "$DEMO_VIDEO_RESULTS"

if rg -a -n -i '(SYNAPSOR_DEMO_ADMIN_TOKEN|postgresql://|mysql://|/home/[^ ]+|sandesh|REPLACE_ME|TODO|FIXME)' \
  "$DEMO_VIDEO_SHORT_MP4" "$DEMO_VIDEO_SHORT_GIF" "$DEMO_VIDEO_SHORT_POSTER"; then
  demo_fail "Safe Action media contains a forbidden marker."
fi

demo_log "Safe Action media verification passed: 36 seconds, 1920x1080 H.264, silent captions, recorded safety evidence."
