#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNAPSOR_BIN="${SYNAPSOR_BIN:-$ROOT/bin/synapsor-runner}"
CONFIG="./examples/reference-support-billing-app/synapsor.runner.json"
STORE="./tmp/reference-support-billing/local.db"

usage() {
  cat <<'USAGE'
Open the Synapsor Runner review UI with a populated local demo.

Usage:
  ./scripts/open-demo-ui.sh

The script runs the reference app first when the local proposal store does not
exist yet. Then it opens the browser UI with proposals, evidence, approvals,
writeback receipts, conflicts, and replay already available to inspect.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

cd "$ROOT"

if [[ ! -f "$STORE" ]]; then
  echo "No populated local demo store found."
  echo "Running the reference app first so the UI has proposals, receipts, and replay to inspect."
  echo
  ./scripts/run-reference-app.sh
  echo
fi

echo "Opening Synapsor Runner review UI."
echo "Press Ctrl+C here when you are done."
echo
"$SYNAPSOR_BIN" ui --open --tour --config "$CONFIG" --store "$STORE"
