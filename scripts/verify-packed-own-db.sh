#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT/apps/runner"
TEMP_DIR="$(mktemp -d)"
TARBALL="${SYNAPSOR_RUNNER_TARBALL:-}"
REMOVE_TARBALL=0
COMPOSE_FILE="$ROOT/examples/mcp-postgres-billing/docker-compose.yml"

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

host_postgres_port_ready() {
  node -e '
    const net = require("node:net");
    const socket = net.connect({ host: "127.0.0.1", port: 55433 });
    socket.once("connect", () => socket.end());
    socket.once("error", () => process.exit(1));
    socket.setTimeout(500, () => {
      socket.destroy();
      process.exit(1);
    });
  '
}

cleanup() {
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
  rm -rf "$TEMP_DIR"
  if [[ "$REMOVE_TARBALL" == "1" && -n "$TARBALL" && -f "$TARBALL" ]]; then
    rm -f "$TARBALL"
  fi
}
trap cleanup EXIT

if [[ -n "$TARBALL" ]]; then
  if [[ ! -f "$TARBALL" ]]; then
    echo "SYNAPSOR_RUNNER_TARBALL does not name a file: $TARBALL" >&2
    exit 1
  fi
  TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
else
  cd "$ROOT"
  corepack pnpm build:runner-package >/dev/null

  cd "$PACKAGE_DIR"
  PACK_OUTPUT="$(npm pack --silent)"
  PACK_FILE="$(printf "%s\n" "$PACK_OUTPUT" | grep -E '\.tgz$' | tail -n 1)"
  if [[ -z "$PACK_FILE" ]]; then
    echo "npm pack did not print a tarball filename" >&2
    printf "%s\n" "$PACK_OUTPUT" >&2
    exit 1
  fi
  TARBALL="$PACKAGE_DIR/$PACK_FILE"
  REMOVE_TARBALL=1
fi

docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" up -d >/dev/null

READY=0
for _ in $(seq 1 90); do
  READY_LOGS="$(docker logs synapsor_runner_mcp_postgres_billing 2>&1 | grep -cF "database system is ready to accept connections" || true)"
  if [[ "$READY_LOGS" -ge 2 ]] \
    && docker exec synapsor_runner_mcp_postgres_billing psql -U synapsor_reader -d synapsor_runner_mcp_billing -tAc \
      "SELECT 1 FROM public.invoices LIMIT 1" >/dev/null 2>&1 \
    && host_postgres_port_ready; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  docker logs synapsor_runner_mcp_postgres_billing >&2 || true
  echo "Postgres fixture did not become ready." >&2
  exit 1
fi

cd "$TEMP_DIR"
npm init -y >/dev/null
npm install "$TARBALL" >/dev/null

export DATABASE_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55433/synapsor_runner_mcp_billing"
export SYNAPSOR_DATABASE_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55433/synapsor_runner_mcp_billing"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="packed_own_db_smoke"
PRODUCT_STARTED_MS="$(now_ms)"

npx synapsor-runner onboard db \
  --from-env DATABASE_URL \
  --engine postgres \
  --schema public \
  --table invoices \
  --primary-key id \
  --tenant-column tenant_id \
  --conflict-column updated_at \
  --mode review \
  --visible-columns id,tenant_id,customer_name,status,late_fee_cents,waiver_reason,updated_at \
  --namespace billing \
  --object-name invoice \
  --id-arg invoice_id \
  --patch late_fee_cents=fixed:0,waiver_reason=arg:reason \
  --patch-bounds late_fee_cents=0:5500 \
  --write-url-env SYNAPSOR_DATABASE_WRITE_URL \
  --receipt-mode source_precreated \
  --yes \
  --output synapsor.runner.json > init.out

grep -F "created synapsor.runner.json" init.out >/dev/null
grep -F "created .env.example" init.out >/dev/null
grep -F "created MCP client snippets under .synapsor/mcp" init.out >/dev/null
grep -F "config valid: synapsor.runner.json" init.out >/dev/null
if grep -F "WRITEBACK_DISABLED" init.out >/dev/null; then
  echo "generated review-mode config still warns WRITEBACK_DISABLED" >&2
  cat init.out >&2
  exit 1
fi
test -f synapsor.runner.json
test -f .env.example
test -f .synapsor/mcp/generic-stdio.json

printf '{"invoice_id":"INV-3001"}\n' > smoke-input.json
npx synapsor-runner smoke call billing.inspect_invoice \
  --input smoke-input.json \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db > smoke.out
grep -F "Synapsor smoke call: ok" smoke.out >/dev/null
grep -F "billing.inspect_invoice" smoke.out >/dev/null
grep -F "Source DB changed:" smoke.out >/dev/null
grep -F "no" smoke.out >/dev/null
grep -F "Evidence:" smoke.out >/dev/null

npx synapsor-runner tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db > tools.txt
grep -F "billing.inspect_invoice" tools.txt >/dev/null
grep -F "billing.propose_invoice_update" tools.txt >/dev/null
grep -F "execute_sql absent" tools.txt >/dev/null
grep -F "database_url absent" tools.txt >/dev/null

npx synapsor-runner smoke call billing.propose_invoice_update \
  --json '{"invoice_id":"INV-3001","reason":"packed verifier waiver"}' \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db > proposal.out
FIRST_PROPOSAL_MS="$(now_ms)"
grep -F '"ok": true' proposal.out >/dev/null
grep -F '"state": "review_required"' proposal.out >/dev/null
grep -F '"id": "wrp_' proposal.out >/dev/null

npx synapsor-runner proposals approve latest --yes --store ./.synapsor/local.db > approve.out
grep -F "approved" approve.out >/dev/null

npx synapsor-runner apply latest --config ./synapsor.runner.json --store ./.synapsor/local.db > apply.out
FIRST_RECEIPT_MS="$(now_ms)"
grep -E "Guarded writeback (applied|already applied)" apply.out >/dev/null

docker exec synapsor_runner_mcp_postgres_billing psql -U synapsor_admin -d synapsor_runner_mcp_billing -tAc \
  "SELECT late_fee_cents, waiver_reason FROM public.invoices WHERE id = 'INV-3001'" > invoice-after.txt
grep -F "0|packed verifier waiver" invoice-after.txt >/dev/null

npx synapsor-runner activity search --object invoice:INV-3001 --store ./.synapsor/local.db > activity.txt
grep -F "INV-3001" activity.txt >/dev/null

printf 'packed own-database product timing: first_proposal_ms=%s first_receipt_ms=%s\n' \
  "$((FIRST_PROPOSAL_MS - PRODUCT_STARTED_MS))" \
  "$((FIRST_RECEIPT_MS - PRODUCT_STARTED_MS))"
echo "packed own-database onboarding verified in $TEMP_DIR"
