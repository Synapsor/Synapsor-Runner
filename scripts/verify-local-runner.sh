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

run demo --quick --no-interactive > quick.txt
grep -F "Synapsor quick demo complete." quick.txt >/dev/null
grep -F "* source DB changed: no" quick.txt >/dev/null
grep -F "synapsor-runner demo inspect" quick.txt >/dev/null
if grep -F "Raw MCP shape" quick.txt >/dev/null; then
  echo "quick concise output unexpectedly printed detailed raw MCP section" >&2
  exit 1
fi

run demo --quick --details > quick-details.txt
grep -F "Raw MCP shape:" quick-details.txt >/dev/null
grep -F "Synapsor shape:" quick-details.txt >/dev/null
grep -F "Trusted context:" quick-details.txt >/dev/null
grep -F "Evidence id: ev_quick_INV_3001" quick-details.txt >/dev/null

run demo inspect > inspect.txt
grep -F "Quick demo inspection" inspect.txt >/dev/null
grep -F "synapsor-runner proposals show latest --store ./.synapsor/quick-demo.db" inspect.txt >/dev/null
grep -F "synapsor-runner evidence show ev_quick_INV_3001 --store ./.synapsor/quick-demo.db" inspect.txt >/dev/null
grep -F "synapsor-runner replay show latest --store ./.synapsor/quick-demo.db" inspect.txt >/dev/null

run demo inspect --npx > inspect-npx.txt
grep -F "npx -y -p @synapsor/runner synapsor-runner proposals show latest" inspect-npx.txt >/dev/null
grep -F "npx -y -p @synapsor/runner synapsor-runner audit --example dangerous-db-mcp" inspect-npx.txt >/dev/null

run events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created --store ./.synapsor/quick-demo.db --dry-run > events-webhook.txt
grep -F "synapsor.local-event-webhook.v1" events-webhook.txt >/dev/null
grep -F "proposal_created" events-webhook.txt >/dev/null
grep -F "wrp_quick_INV_3001" events-webhook.txt >/dev/null

run audit --example dangerous-db-mcp >/dev/null
run mcp serve-streamable-http --help >/dev/null
run mcp serve-http --help >/dev/null
run demo --quick --no-interactive >/dev/null
run recipes init billing.late_fee_waiver --force >/dev/null
run up --config ./synapsor.runner.json --store ./.synapsor/quick-demo.db --dry-run > up.txt
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
