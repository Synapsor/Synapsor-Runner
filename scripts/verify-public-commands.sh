#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

"$ROOT/bin/synapsor-runner" --help >/dev/null
"$ROOT/bin/synapsor-runner" audit --example dangerous-db-mcp >/dev/null
"$ROOT/bin/synapsor-runner" audit --example dangerous-db-mcp --format json >/dev/null
"$ROOT/bin/synapsor-runner" audit --example dangerous-db-mcp --format markdown >/dev/null
"$ROOT/bin/synapsor-runner" activity search --help >/dev/null
"$ROOT/bin/synapsor-runner" evidence --help >/dev/null
"$ROOT/bin/synapsor-runner" query-audit --help >/dev/null
"$ROOT/bin/synapsor-runner" receipts --help >/dev/null
"$ROOT/bin/synapsor-runner" replay --help >/dev/null
"$ROOT/bin/synapsor-runner" proposals --help >/dev/null
"$ROOT/bin/synapsor-runner" store --help >/dev/null
"$ROOT/bin/synapsor-runner" mcp config --help >/dev/null
"$ROOT/bin/synapsor-runner" mcp client-config --help >/dev/null
"$ROOT/bin/synapsor-runner" mcp serve --transport streamable-http --help >/dev/null
"$ROOT/bin/synapsor-runner" handler template --list >/dev/null

cd "$TEMP_DIR"
"$ROOT/bin/synapsor-runner" demo --quick --no-interactive >/dev/null
"$ROOT/bin/synapsor-runner" demo inspect >/dev/null
"$ROOT/bin/synapsor-runner" events webhook \
  --url http://127.0.0.1:8788/synapsor/events \
  --kind proposal_created \
  --store ./.synapsor/quick-demo.db \
  --dry-run > events-webhook.txt
grep -F "synapsor.local-event-webhook.v1" events-webhook.txt >/dev/null
"$ROOT/bin/synapsor-runner" mcp client-config --client openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db >/dev/null
"$ROOT/bin/synapsor-runner" handler template node-fastify --output ./synapsor-writeback-handler.mjs >/dev/null
grep -F "app-owned transaction" ./synapsor-writeback-handler.mjs >/dev/null
"$ROOT/bin/synapsor-runner" activity search --object invoice:INV-3001 --store ./.synapsor/quick-demo.db >/dev/null
"$ROOT/bin/synapsor-runner" store stats --store ./.synapsor/quick-demo.db >/dev/null
"$ROOT/bin/synapsor-runner" store prune --store ./.synapsor/quick-demo.db --older-than 0d --dry-run >/dev/null
"$ROOT/bin/synapsor-runner" store reset --store ./.synapsor/quick-demo.db --yes >/dev/null

echo "public checkout commands verified"
