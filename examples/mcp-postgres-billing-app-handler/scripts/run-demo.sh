#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXAMPLE_DIR="$ROOT/examples/mcp-postgres-billing-app-handler"
COMPOSE_FILE="$EXAMPLE_DIR/docker-compose.yml"
CONFIG="$EXAMPLE_DIR/synapsor.runner.json"
STORE="$ROOT/tmp/billing-app-handler/local.db"
BIN="${SYNAPSOR_RUNNER_BIN:-$ROOT/bin/synapsor-runner}"
HANDLER_LOG="$ROOT/tmp/billing-app-handler/handler.log"

cleanup() {
  if [[ -n "${HANDLER_PID:-}" ]]; then
    kill "$HANDLER_PID" >/dev/null 2>&1 || true
    wait "$HANDLER_PID" >/dev/null 2>&1 || true
  fi
  docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$ROOT/tmp/billing-app-handler"
rm -f "$STORE" "$HANDLER_LOG"

docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1 || true
docker compose -f "$COMPOSE_FILE" up -d >/dev/null

for _ in $(seq 1 90); do
  invoice_count="$(docker exec synapsor_runner_billing_app_handler psql -U synapsor_admin -d synapsor_billing_app_handler -Atc "SELECT count(*) FROM public.invoices" 2>/dev/null || true)"
  if [[ "$invoice_count" == "2" ]]; then
    sleep 1
    invoice_count="$(docker exec synapsor_runner_billing_app_handler psql -U synapsor_admin -d synapsor_billing_app_handler -Atc "SELECT count(*) FROM public.invoices" 2>/dev/null || true)"
    if [[ "$invoice_count" == "2" ]]; then
      break
    fi
  fi
  sleep 1
done
invoice_count="$(docker exec synapsor_runner_billing_app_handler psql -U synapsor_admin -d synapsor_billing_app_handler -Atc "SELECT count(*) FROM public.invoices")"
if [[ "$invoice_count" != "2" ]]; then
  echo "Postgres fixture did not finish seeding invoices." >&2
  exit 1
fi

export BILLING_APP_READ_URL="postgresql://synapsor_reader:synapsor_reader_password@localhost:55437/synapsor_billing_app_handler"
export BILLING_APP_WRITE_URL="postgresql://synapsor_writer:synapsor_writer_password@localhost:55437/synapsor_billing_app_handler"
export BILLING_APP_HANDLER_URL="http://127.0.0.1:8787/synapsor/writeback"
export BILLING_APP_HANDLER_TOKEN="dev-handler-token"
export BILLING_APP_HANDLER_SIGNING_SECRET="dev-handler-signing-secret"
export SYNAPSOR_TENANT_ID="acme"
export SYNAPSOR_PRINCIPAL="local_billing_operator"

node "$EXAMPLE_DIR/app-handler.mjs" >"$HANDLER_LOG" 2>&1 &
HANDLER_PID="$!"

for _ in $(seq 1 90); do
  if node -e "fetch('http://127.0.0.1:8787/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
node -e "fetch('http://127.0.0.1:8787/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

"$BIN" config validate --config "$CONFIG" >/dev/null
"$BIN" tools preview --config "$CONFIG" --store "$STORE" > "$ROOT/tmp/billing-app-handler/tools.txt"
grep -F "billing.propose_account_credit" "$ROOT/tmp/billing-app-handler/tools.txt" >/dev/null
grep -F "execute_sql absent" "$ROOT/tmp/billing-app-handler/tools.txt" >/dev/null

printf '{"invoice_id":"INV-3001","amount_cents":2500,"reason":"support-approved credit"}\n' > "$ROOT/tmp/billing-app-handler/credit-input.json"
"$BIN" propose billing.propose_account_credit \
  --input "$ROOT/tmp/billing-app-handler/credit-input.json" \
  --config "$CONFIG" \
  --store "$STORE" > "$ROOT/tmp/billing-app-handler/propose-credit.txt"
grep -F "Source DB changed:" "$ROOT/tmp/billing-app-handler/propose-credit.txt" >/dev/null
grep -F "no" "$ROOT/tmp/billing-app-handler/propose-credit.txt" >/dev/null

credit_count_before="$(docker exec synapsor_runner_billing_app_handler psql -U synapsor_admin -d synapsor_billing_app_handler -Atc "SELECT count(*) FROM public.account_credits")"
if [[ "$credit_count_before" != "0" ]]; then
  echo "expected no account credits before approval, got $credit_count_before" >&2
  exit 1
fi

"$BIN" proposals approve latest --yes --store "$STORE" >/dev/null
"$BIN" apply latest --config "$CONFIG" --store "$STORE" > "$ROOT/tmp/billing-app-handler/apply-credit.txt"
grep -F "App-owned writeback applied." "$ROOT/tmp/billing-app-handler/apply-credit.txt" >/dev/null
grep -F "source database changed by handler: yes" "$ROOT/tmp/billing-app-handler/apply-credit.txt" >/dev/null

credit_count_after="$(docker exec synapsor_runner_billing_app_handler psql -U synapsor_admin -d synapsor_billing_app_handler -Atc "SELECT count(*) FROM public.account_credits WHERE invoice_id = 'INV-3001' AND amount_cents = 2500")"
if [[ "$credit_count_after" != "1" ]]; then
  echo "expected one inserted account credit, got $credit_count_after" >&2
  exit 1
fi

"$BIN" apply latest --config "$CONFIG" --store "$STORE" > "$ROOT/tmp/billing-app-handler/apply-credit-retry.txt"
grep -F "App-owned writeback already applied." "$ROOT/tmp/billing-app-handler/apply-credit-retry.txt" >/dev/null

"$BIN" replay show latest --store "$STORE" > "$ROOT/tmp/billing-app-handler/replay.txt"
grep -F "billing.propose_account_credit" "$ROOT/tmp/billing-app-handler/replay.txt" >/dev/null

echo "App-owned billing handler demo passed."
echo "Verified: proposal first, source unchanged before approval, account credit inserted by app handler, idempotent retry, replay."
