#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

EXPECTED_VERSION="${1:-}"
if [[ -z "$EXPECTED_VERSION" ]]; then
  EXPECTED_VERSION="$(node -e "console.log(require('$ROOT/apps/runner/package.json').version)")"
fi

PUBLISHED_VERSION="$(npm view @synapsor/runner@alpha version)"
if [[ "$PUBLISHED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Expected @synapsor/runner@alpha to be $EXPECTED_VERSION, got $PUBLISHED_VERSION" >&2
  echo "Publish the prepared package with npm publish --tag alpha, then rerun this script." >&2
  exit 1
fi

npm view @synapsor/runner@alpha bin license >/dev/null

cd "$TEMP_DIR"

npx -y -p @synapsor/runner@alpha synapsor-runner --help >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner try --prove --yes --no-open > proof.txt
grep -F "late_fee_cents: 5500 -> 0" proof.txt >/dev/null
grep -F "Guarded commit complete." proof.txt >/dev/null
grep -F "restart-safe retry: yes" proof.txt >/dev/null
grep -F "stale apply refused: yes" proof.txt >/dev/null
grep -F "replay changed source: no" proof.txt >/dev/null

npx -y -p @synapsor/runner@alpha synapsor-runner demo inspect > inspect.txt
grep -F "Synapsor try inspection" inspect.txt >/dev/null
grep -F "synapsor-runner proposals show wrp_try_INV_3001 --store .synapsor/try/ledger.db" inspect.txt >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner events webhook \
  --url http://127.0.0.1:8788/synapsor/events \
  --kind proposal_created \
  --store ./.synapsor/try/ledger.db \
  --dry-run > events-webhook.txt
grep -F "synapsor.local-event-webhook.v1" events-webhook.txt >/dev/null
grep -F "proposal_created" events-webhook.txt >/dev/null
grep -F "wrp_try_INV_3001" events-webhook.txt >/dev/null

npx -y -p @synapsor/runner@alpha synapsor-runner audit --example dangerous-db-mcp --format markdown >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner mcp serve-streamable-http --help > streamable-help.txt
grep -F -- "--alias-mode openai" streamable-help.txt >/dev/null
grep -F "billing__inspect_invoice" streamable-help.txt >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner mcp serve --help > stdio-help.txt
grep -F -- "--alias-mode openai" stdio-help.txt >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner mcp serve --transport streamable-http --help > unified-help.txt
grep -F -- "--alias-mode openai" unified-help.txt >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner mcp client-config --client openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db > openai-config.json
grep -F "MCPServerStreamableHttp" openai-config.json >/dev/null
grep -F -- "--alias-mode" openai-config.json >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner mcp config openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db > openai-config-positional.json
grep -F "billing__inspect_invoice" openai-config-positional.json >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner mcp serve-http --help >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner handler template --list > handler-templates.txt
grep -F "node-fastify" handler-templates.txt >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner handler template command --stdout > command-handler.mjs
grep -F "idempotency" command-handler.mjs >/dev/null

npx -y -p @synapsor/runner@alpha synapsor-runner activity search --object invoice:INV-3001 --store ./.synapsor/try/ledger.db >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner evidence --help >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner query-audit --help >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner receipts --help >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner replay show wrp_try_INV_3001 --store ./.synapsor/try/ledger.db >/dev/null
npx -y -p @synapsor/runner@alpha synapsor-runner store stats --store ./.synapsor/try/ledger.db >/dev/null

echo "published alpha $PUBLISHED_VERSION verified in $TEMP_DIR"
