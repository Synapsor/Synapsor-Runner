#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SYNAPSOR_RUNNER_DEMO_IMAGE:-synapsor-runner-local-demo:latest}"
QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

say() {
  if [[ "$QUIET" != "1" ]]; then
    printf '%s\n' "$*"
  fi
}

TARGETS=(
  "$ROOT/tmp"
  "$ROOT/.pnpm-store"
  "$ROOT/.synapsor/local.db"
  "$ROOT/.synapsor/mcp"
)

if rm -rf "${TARGETS[@]}" 2>/dev/null; then
  say "Cleaned local generated Synapsor Runner artifacts."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  say "Could not clean local generated artifacts with the current user."
  say "Docker is not available for root-owned cleanup."
  say "Try:"
  say "  sudo rm -rf ./tmp ./.pnpm-store ./.synapsor/local.db ./.synapsor/mcp"
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  say "Could not clean local generated artifacts with the current user."
  say "The local demo image is not available for root-owned cleanup: $IMAGE"
  say "Try:"
  say "  sudo rm -rf ./tmp ./.pnpm-store ./.synapsor/local.db ./.synapsor/mcp"
  exit 1
fi

docker run --rm \
  --user 0:0 \
  --entrypoint sh \
  -v "$ROOT:/work" \
  -w /work \
  "$IMAGE" \
  -c 'rm -rf tmp .pnpm-store .synapsor/local.db .synapsor/mcp'

say "Cleaned root-owned local generated Synapsor Runner artifacts."
