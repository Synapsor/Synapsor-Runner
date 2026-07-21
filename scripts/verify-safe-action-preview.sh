#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/examples/mcp-postgres-billing/docker-compose.yml"

cleanup() {
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" up -d >/dev/null

ready=0
for _ in $(seq 1 90); do
  if docker exec synapsor_runner_mcp_postgres_billing pg_isready -U synapsor_admin -d synapsor_runner_mcp_billing >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  docker logs synapsor_runner_mcp_postgres_billing >&2 || true
  echo "Postgres fixture did not become ready." >&2
  exit 1
fi

export SYNAPSOR_DATABASE_READ_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55433/synapsor_runner_mcp_billing"
export SYNAPSOR_DATABASE_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55433/synapsor_runner_mcp_billing"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="safe_action_live_verifier"

corepack pnpm --dir "$ROOT" exec tsc -b --pretty false
node "$ROOT/scripts/verify-safe-action-preview.mjs"
