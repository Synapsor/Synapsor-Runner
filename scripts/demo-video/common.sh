#!/usr/bin/env bash

set -euo pipefail

DEMO_VIDEO_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_VIDEO_ROOT="$(cd "$DEMO_VIDEO_SCRIPT_DIR/../.." && pwd)"
DEMO_VIDEO_EXAMPLE_DIR="$DEMO_VIDEO_ROOT/examples/support-plan-credit"
DEMO_VIDEO_COMPOSE_FILE="$DEMO_VIDEO_EXAMPLE_DIR/docker-compose.yml"
DEMO_VIDEO_CONFIG="$DEMO_VIDEO_EXAMPLE_DIR/synapsor.runner.json"
DEMO_VIDEO_CONTRACT="$DEMO_VIDEO_EXAMPLE_DIR/synapsor.contract.json"
DEMO_VIDEO_DSL="$DEMO_VIDEO_EXAMPLE_DIR/contract.synapsor.sql"
DEMO_VIDEO_ENV_EXAMPLE="$DEMO_VIDEO_EXAMPLE_DIR/.env.example"
DEMO_VIDEO_STATE_DIR="${SYNAPSOR_DEMO_STATE_DIR:-$DEMO_VIDEO_ROOT/.synapsor/demo-video}"
DEMO_VIDEO_RAW_DIR="$DEMO_VIDEO_STATE_DIR/raw"
DEMO_VIDEO_SANITIZED_DIR="$DEMO_VIDEO_STATE_DIR/sanitized"
DEMO_VIDEO_PRIVATE_DIR="$DEMO_VIDEO_STATE_DIR/private"
DEMO_VIDEO_PUBLISHED_RUNNER_DIR="$DEMO_VIDEO_STATE_DIR/published-runner"
DEMO_VIDEO_RENDER_DIR="$DEMO_VIDEO_STATE_DIR/render"
DEMO_VIDEO_FRAMES_DIR="$DEMO_VIDEO_RENDER_DIR/frames"
DEMO_VIDEO_REVIEW_DIR="$DEMO_VIDEO_RENDER_DIR/review-frames"
DEMO_VIDEO_STORE="$DEMO_VIDEO_STATE_DIR/local.db"
DEMO_VIDEO_RESULTS="$DEMO_VIDEO_STATE_DIR/results.json"
DEMO_VIDEO_PUBLIC_CLOUD_STATE="$DEMO_VIDEO_STATE_DIR/cloud-public.json"
DEMO_VIDEO_PRIVATE_CLOUD_STATE="$DEMO_VIDEO_PRIVATE_DIR/cloud-private.json"
DEMO_VIDEO_CLOUD_SCREENSHOT="$DEMO_VIDEO_RENDER_DIR/cloud-registry.png"
DEMO_VIDEO_CLOUD_CAPTURE_STATE="$DEMO_VIDEO_STATE_DIR/cloud-capture.json"
DEMO_VIDEO_DECK="$DEMO_VIDEO_RENDER_DIR/demo-deck.html"
DEMO_VIDEO_MEDIA_METADATA="$DEMO_VIDEO_STATE_DIR/media-metadata.json"
DEMO_VIDEO_GIF_METADATA="$DEMO_VIDEO_STATE_DIR/gif-metadata.json"
DEMO_VIDEO_OUTPUT_DIR="$DEMO_VIDEO_ROOT/docs/launch/out"
DEMO_VIDEO_MP4="$DEMO_VIDEO_OUTPUT_DIR/synapsor-launch-demo.mp4"
DEMO_VIDEO_GIF="$DEMO_VIDEO_OUTPUT_DIR/synapsor-launch-demo.gif"
DEMO_VIDEO_RUNNER_VERSION="${SYNAPSOR_DEMO_RUNNER_VERSION:-0.1.12}"
DEMO_VIDEO_RUNNER_MODE="${SYNAPSOR_DEMO_RUNNER_MODE:-local}"
DEMO_VIDEO_FPS="${SYNAPSOR_DEMO_CAPTURE_FPS:-8}"
DEMO_VIDEO_DURATION_SECONDS=177
DEMO_VIDEO_FFMPEG_IMAGE="${SYNAPSOR_DEMO_FFMPEG_IMAGE:-jrottenberg/ffmpeg:7.1-alpine@sha256:8ec1ee1f6a0fcd37c97725827b6b7832795c9596e3439b8da56d7700d61ae778}"
DEMO_VIDEO_CONTAINER="synapsor_runner_plan_credit"

export TZ=UTC
export LC_ALL=C

demo_log() {
  printf '[demo-video] %s\n' "$*"
}

demo_fail() {
  printf '[demo-video] ERROR: %s\n' "$*" >&2
  exit 1
}

demo_ensure_dirs() {
  umask 077
  mkdir -p \
    "$DEMO_VIDEO_RAW_DIR" \
    "$DEMO_VIDEO_SANITIZED_DIR" \
    "$DEMO_VIDEO_PRIVATE_DIR" \
    "$DEMO_VIDEO_RENDER_DIR" \
    "$DEMO_VIDEO_FRAMES_DIR" \
    "$DEMO_VIDEO_REVIEW_DIR" \
    "$DEMO_VIDEO_OUTPUT_DIR"
}

demo_assert_safe_state_dir() {
  case "$DEMO_VIDEO_STATE_DIR" in
    "$DEMO_VIDEO_ROOT"/.synapsor/demo-video|/tmp/synapsor-demo-video-*) ;;
    *) demo_fail "Refusing destructive cleanup outside the approved demo state directory: $DEMO_VIDEO_STATE_DIR" ;;
  esac
}

demo_load_synthetic_env() {
  set -a
  # shellcheck disable=SC1090
  . "$DEMO_VIDEO_ENV_EXAMPLE"
  set +a

  [[ "${PLAN_CREDIT_POSTGRES_READ_URL:-}" == postgresql://synapsor_reader:*@127.0.0.1:55438/synapsor_runner_plan_credit ]] \
    || demo_fail "Read URL is not the disposable localhost support-plan-credit database."
  [[ "${PLAN_CREDIT_POSTGRES_WRITE_URL:-}" == postgresql://synapsor_writer:*@127.0.0.1:55438/synapsor_runner_plan_credit ]] \
    || demo_fail "Write URL is not the disposable localhost support-plan-credit database."
  [[ "${SYNAPSOR_TENANT_ID:-}" == "acme" ]] || demo_fail "Unexpected synthetic tenant."
  [[ "${SYNAPSOR_PRINCIPAL:-}" == "local_support_agent" ]] || demo_fail "Unexpected synthetic principal."
}

demo_select_runner() {
  case "$DEMO_VIDEO_RUNNER_MODE" in
    local)
      DEMO_VIDEO_RUNNER=("$DEMO_VIDEO_ROOT/bin/synapsor-runner")
      ;;
    published)
      DEMO_VIDEO_RUNNER=("$DEMO_VIDEO_PUBLISHED_RUNNER_DIR/node_modules/.bin/synapsor-runner")
      ;;
    *)
      demo_fail "SYNAPSOR_DEMO_RUNNER_MODE must be local or published."
      ;;
  esac
}

demo_prepare_runner() {
  if [[ "$DEMO_VIDEO_RUNNER_MODE" != "published" ]]; then
    return 0
  fi
  mkdir -p "$DEMO_VIDEO_PUBLISHED_RUNNER_DIR"
  demo_log "Installing published Runner $DEMO_VIDEO_RUNNER_VERSION into isolated demo state."
  npm_config_loglevel=error npm install \
    --prefix "$DEMO_VIDEO_PUBLISHED_RUNNER_DIR" \
    --no-audit \
    --no-fund \
    --ignore-scripts \
    --package-lock=false \
    "@synapsor/runner@$DEMO_VIDEO_RUNNER_VERSION" >/dev/null
  local installed_version
  installed_version="$(node -p "require('$DEMO_VIDEO_PUBLISHED_RUNNER_DIR/node_modules/@synapsor/runner/package.json').version")"
  [[ "$installed_version" == "$DEMO_VIDEO_RUNNER_VERSION" ]] \
    || demo_fail "Expected published Runner $DEMO_VIDEO_RUNNER_VERSION, installed $installed_version."
  [[ -x "${DEMO_VIDEO_RUNNER[0]}" ]] || demo_fail "Isolated published Runner binary is missing."
}

demo_runner() {
  "${DEMO_VIDEO_RUNNER[@]}" "$@"
}

demo_wait_for_postgres() {
  local attempt
  local consecutive=0
  for attempt in $(seq 1 60); do
    if docker exec "$DEMO_VIDEO_CONTAINER" \
      psql -U synapsor_admin -d synapsor_runner_plan_credit -Atc "SELECT 1" >/dev/null 2>&1; then
      consecutive=$((consecutive + 1))
      if (( consecutive >= 3 )); then
        return 0
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  demo_fail "Disposable Postgres did not become ready."
}

demo_source_row() {
  docker exec "$DEMO_VIDEO_CONTAINER" \
    psql -U synapsor_admin -d synapsor_runner_plan_credit -Atc \
    "SELECT customer_id || '|' || plan_credit_cents || '|' || COALESCE(credit_reason, 'none') FROM public.customers WHERE id='CUS-3001'"
}

demo_assert_source_row() {
  local expected="$1"
  local actual
  actual="$(demo_source_row)"
  [[ "$actual" == "$expected" ]] || demo_fail "Unexpected CUS-3001 state. Expected '$expected', got '$actual'."
}

demo_redact_file() {
  local input="$1"
  local output="$2"
  node "$DEMO_VIDEO_SCRIPT_DIR/redact-output.mjs" "$input" "$output" "$DEMO_VIDEO_ROOT"
}

demo_capture() {
  local name="$1"
  shift
  local raw="$DEMO_VIDEO_RAW_DIR/$name"
  local sanitized="$DEMO_VIDEO_SANITIZED_DIR/$name"
  "$@" >"$raw" 2>&1
  demo_redact_file "$raw" "$sanitized"
}

demo_capture_expected_status() {
  local name="$1"
  local expected_status="$2"
  shift 2
  local raw="$DEMO_VIDEO_RAW_DIR/$name"
  local sanitized="$DEMO_VIDEO_SANITIZED_DIR/$name"
  local status
  set +e
  "$@" >"$raw" 2>&1
  status=$?
  set -e
  demo_redact_file "$raw" "$sanitized"
  [[ "$status" == "$expected_status" ]] \
    || demo_fail "Expected '$name' to exit $expected_status, got $status."
}

demo_ffmpeg() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$DEMO_VIDEO_ROOT:/work" \
    -w /work \
    "$DEMO_VIDEO_FFMPEG_IMAGE" "$@"
}

demo_ffprobe() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --entrypoint ffprobe \
    -v "$DEMO_VIDEO_ROOT:/work" \
    -w /work \
    "$DEMO_VIDEO_FFMPEG_IMAGE" "$@"
}

demo_stop_local_services() {
  docker compose -f "$DEMO_VIDEO_COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}

demo_relpath() {
  local path="$1"
  printf '%s' "${path#"$DEMO_VIDEO_ROOT/"}"
}

demo_select_runner
