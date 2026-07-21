#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

run() {
  SYNAPSOR_RUNNER_COMMAND_NAME=synapsor-runner node --no-warnings "$ROOT/apps/runner/dist/runner.mjs" "$@"
}

corepack pnpm --dir "$ROOT" build:runner-package >/dev/null

cd "$TEMP_DIR"
STORE_PATH="$TEMP_DIR/.synapsor/try/ledger.db"

run try --prove --yes --no-open > proof.txt
grep -F "Synapsor Runner try" proof.txt >/dev/null
grep -F "late_fee_cents: 5500 -> 0" proof.txt >/dev/null
grep -F "Source changed:" proof.txt >/dev/null
grep -F "Guarded commit complete." proof.txt >/dev/null
grep -F "restart-safe retry: yes" proof.txt >/dev/null
grep -F "duplicate mutations: 0" proof.txt >/dev/null
grep -F "changed-intent operation reuse rejected: yes" proof.txt >/dev/null
grep -F "stale apply refused: yes" proof.txt >/dev/null
grep -F "replay changed source: no" proof.txt >/dev/null

run demo inspect > inspect.txt
grep -F "Synapsor try inspection" inspect.txt >/dev/null
grep -F "synapsor-runner proposals show wrp_try_INV_3001 --store $STORE_PATH" inspect.txt >/dev/null
grep -F "synapsor-runner evidence show ev_wrp_try_INV_3001 --store $STORE_PATH" inspect.txt >/dev/null
grep -F "synapsor-runner replay show wrp_try_INV_3001 --store $STORE_PATH" inspect.txt >/dev/null

run demo inspect --npx > inspect-npx.txt
grep -F "npx -y -p @synapsor/runner synapsor-runner proposals show wrp_try_INV_3001" inspect-npx.txt >/dev/null
grep -F "npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp" inspect-npx.txt >/dev/null

run events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created --store ./.synapsor/try/ledger.db --dry-run > events-webhook.txt
grep -F "synapsor.local-event-webhook.v1" events-webhook.txt >/dev/null
grep -F "proposal_created" events-webhook.txt >/dev/null
grep -F "wrp_try_INV_3001" events-webhook.txt >/dev/null

run audit --example dangerous-db-mcp >/dev/null
run mcp serve-streamable-http --help >/dev/null
run mcp serve-http --help >/dev/null
run demo --quick --no-interactive >/dev/null
run recipes init billing.late_fee_waiver --force >/dev/null
run up --config ./synapsor.runner.json --store ./.synapsor/try/ledger.db --dry-run > up.txt
grep -F "Synapsor Runner review-mode up" up.txt >/dev/null
grep -F "Serve now: no" up.txt >/dev/null
grep -F "Model-facing tools:" up.txt >/dev/null
grep -F "Next commands:" up.txt >/dev/null
run handler template --list > handler-templates.txt
grep -F "node-fastify" handler-templates.txt >/dev/null
grep -F "IMPORTANT: your app handler owns the final business write." handler-templates.txt >/dev/null
run handler template node-fastify --output ./synapsor-writeback-handler.mjs >/dev/null
grep -F "app-owned transaction" ./synapsor-writeback-handler.mjs >/dev/null
grep -F "IMPORTANT: your app handler owns the final business write." ./synapsor-writeback-handler.mjs >/dev/null
run handler template command --stdout > command-handler.mjs
grep -F "idempotency" command-handler.mjs >/dev/null
grep -F "duplicate writes" command-handler.mjs >/dev/null
run activity search --help >/dev/null
run evidence --help >/dev/null

echo "local runner verified in $TEMP_DIR"
