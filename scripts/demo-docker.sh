#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SYNAPSOR_RUNNER_DEMO_IMAGE:-synapsor-runner-local-demo:latest}"
DOCKER_SOCK="${DOCKER_HOST_SOCKET:-/var/run/docker.sock}"

cleanup_generated_artifacts() {
  "$ROOT/scripts/clean-local-generated.sh" --quiet >/dev/null 2>&1 || true
}

echo "Synapsor Runner Docker-only local MCP demo"
echo
echo "This path requires Docker only. It runs the TypeScript runner inside a"
echo "container and uses disposable Docker Postgres/MySQL databases."
echo "No Synapsor Cloud account, API key, hosted workspace, or host Node setup is required."
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the local demo, but the docker command was not found." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but the Docker daemon is not reachable." >&2
  exit 1
fi

if [ ! -S "$DOCKER_SOCK" ]; then
  echo "Docker socket not found at $DOCKER_SOCK." >&2
  echo "Set DOCKER_HOST_SOCKET if your Docker socket lives elsewhere." >&2
  exit 1
fi

echo "Building local demo runner image: $IMAGE"
docker build -f "$ROOT/Dockerfile.local-demo" -t "$IMAGE" "$ROOT"
echo
trap cleanup_generated_artifacts EXIT

node_module_mounts=(
  --mount "type=volume,destination=$ROOT/node_modules"
  --mount "type=volume,destination=$ROOT/apps/runner/node_modules"
  --mount "type=volume,destination=$ROOT/packages/config/node_modules"
  --mount "type=volume,destination=$ROOT/packages/control-plane-client/node_modules"
  --mount "type=volume,destination=$ROOT/packages/mcp-server/node_modules"
  --mount "type=volume,destination=$ROOT/packages/mysql/node_modules"
  --mount "type=volume,destination=$ROOT/packages/postgres/node_modules"
  --mount "type=volume,destination=$ROOT/packages/proposal-store/node_modules"
  --mount "type=volume,destination=$ROOT/packages/protocol/node_modules"
  --mount "type=volume,destination=$ROOT/packages/worker-core/node_modules"
)

echo "Running local MCP proof inside Docker:"
echo "- starts disposable Postgres/MySQL containers"
echo "- exposes semantic MCP tools instead of raw SQL"
echo "- creates evidence-backed proposals without mutating source rows"
echo "- approves locally and applies guarded writeback"
echo "- retries idempotently"
echo "- proves stale-row conflict blocks commit"
echo

docker run --rm \
  --add-host host.docker.internal:host-gateway \
  "${node_module_mounts[@]}" \
  -e CI=1 \
  -e HOME=/tmp/synapsor-demo-home \
  -e COREPACK_HOME=/tmp/synapsor-demo-corepack \
  -e PNPM_HOME=/tmp/synapsor-demo-pnpm-home \
  -e SYNAPSOR_RUNNER_TMP_ROOT=/tmp/synapsor-runner-local-demo \
  -e SYNAPSOR_LOCAL_DB_HOST=host.docker.internal \
  -e XDG_CACHE_HOME=/tmp/synapsor-demo-cache \
  -v "$DOCKER_SOCK:/var/run/docker.sock" \
  -v "$ROOT:$ROOT" \
  -w "$ROOT" \
  "$IMAGE" \
  'mkdir -p "$HOME" "$COREPACK_HOME" "$PNPM_HOME" "$XDG_CACHE_HOME" "$SYNAPSOR_RUNNER_TMP_ROOT" /tmp/synapsor-demo-pnpm-store && corepack pnpm --store-dir=/tmp/synapsor-demo-pnpm-store install --frozen-lockfile && corepack pnpm run test:mcp-local'

echo
echo "Docker-only local demo complete."
echo "The disposable database containers, volumes, and temporary local demo files were torn down by the demo script."
