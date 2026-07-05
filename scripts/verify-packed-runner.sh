#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT/apps/runner"
TEMP_DIR="$(mktemp -d)"
TARBALL=""

cleanup() {
  rm -rf "$TEMP_DIR"
  if [[ -n "$TARBALL" && -f "$TARBALL" ]]; then
    rm -f "$TARBALL"
  fi
}
trap cleanup EXIT

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

cd "$TEMP_DIR"
npm init -y >/dev/null
npm install "$TARBALL" >/dev/null

npx synapsor-runner --help >/dev/null
npx synapsor-runner demo --quick --no-interactive > quick.txt
grep -F "Synapsor quick demo complete." quick.txt >/dev/null
grep -F "* source DB changed: no" quick.txt >/dev/null
if grep -F "Raw MCP shape" quick.txt >/dev/null; then
  echo "packed quick concise output unexpectedly printed detailed raw MCP section" >&2
  exit 1
fi
npx synapsor-runner demo --quick --details > quick-details.txt
grep -F "Raw MCP shape:" quick-details.txt >/dev/null
grep -F "Evidence id: ev_quick_INV_3001" quick-details.txt >/dev/null
npx synapsor-runner demo inspect > inspect.txt
grep -F "Quick demo inspection" inspect.txt >/dev/null
grep -F "synapsor-runner proposals show latest --store ./.synapsor/quick-demo.db" inspect.txt >/dev/null
npx synapsor-runner demo inspect --npx > inspect-npx.txt
grep -F "npx -y -p @synapsor/runner synapsor-runner proposals show latest" inspect-npx.txt >/dev/null
npx synapsor-runner events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created --store ./.synapsor/quick-demo.db --dry-run > events-webhook.txt
grep -F "synapsor.local-event-webhook.v1" events-webhook.txt >/dev/null
grep -F "proposal_created" events-webhook.txt >/dev/null
grep -F "wrp_quick_INV_3001" events-webhook.txt >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp --format json >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp --format markdown >/dev/null
npx synapsor-runner recipes init billing.late_fee_waiver --force >/dev/null
npx synapsor-runner up --config ./synapsor.runner.json --store ./.synapsor/quick-demo.db --dry-run > up.txt
grep -F "Synapsor Runner review-mode up" up.txt >/dev/null
grep -F "Serve now: no" up.txt >/dev/null
grep -F "Model-facing tools:" up.txt >/dev/null
grep -F "Next commands:" up.txt >/dev/null
npx synapsor-runner mcp serve-streamable-http --help > streamable-help.txt
grep -F -- "--alias-mode openai" streamable-help.txt >/dev/null
grep -F "billing__inspect_invoice" streamable-help.txt >/dev/null
npx synapsor-runner mcp serve --help > stdio-help.txt
grep -F -- "--alias-mode openai" stdio-help.txt >/dev/null
npx synapsor-runner mcp serve --transport streamable-http --help > unified-help.txt
grep -F -- "--alias-mode openai" unified-help.txt >/dev/null
npx synapsor-runner mcp client-config --client openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db > openai-config.json
grep -F "MCPServerStreamableHttp" openai-config.json >/dev/null
grep -F -- "--alias-mode" openai-config.json >/dev/null
npx synapsor-runner mcp config openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db > openai-config-positional.json
grep -F "billing__inspect_invoice" openai-config-positional.json >/dev/null
npx synapsor-runner mcp serve-http --help >/dev/null
npx synapsor-runner handler template --list > handler-templates.txt
grep -F "node-fastify" handler-templates.txt >/dev/null
grep -F "IMPORTANT: your app handler owns the final business write." handler-templates.txt >/dev/null
npx synapsor-runner handler template node-fastify --output ./synapsor-writeback-handler.mjs >/dev/null
grep -F "app-owned transaction" ./synapsor-writeback-handler.mjs >/dev/null
grep -F "IMPORTANT: your app handler owns the final business write." ./synapsor-writeback-handler.mjs >/dev/null
npx synapsor-runner handler template command --stdout > command-handler.mjs
grep -F "idempotency" command-handler.mjs >/dev/null
grep -F "duplicate writes" command-handler.mjs >/dev/null
npx synapsor-runner activity search --help >/dev/null
npx synapsor-runner evidence --help >/dev/null
npx synapsor-runner query-audit --help >/dev/null
npx synapsor-runner receipts --help >/dev/null
npx synapsor-runner replay --help >/dev/null
npx synapsor-runner store --help >/dev/null
npx synapsor-runner --help >/dev/null
npx synapsor-runner store stats --store ./.synapsor/quick-demo.db >/dev/null
npx synapsor-runner store prune --store ./.synapsor/quick-demo.db --older-than 0d --dry-run >/dev/null
npx synapsor-runner store reset --store ./.synapsor/quick-demo.db --yes >/dev/null

echo "packed runner verified in $TEMP_DIR"
