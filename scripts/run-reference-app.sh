#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.synapsor/logs"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="$LOG_DIR/reference-app-$TIMESTAMP.log"
mkdir -p "$LOG_DIR"

if ! "$ROOT/scripts/clean-local-generated.sh" --quiet >>"$LOG_FILE" 2>&1; then
  echo "Reference app demo failed."
  echo "Why it matters: local generated state must be writable before the reference app can create its proposal store."
  echo "Try: inspect $LOG_FILE, then run ./scripts/clean-local-generated.sh"
  exit 1
fi

echo "Synapsor Runner reference app"
echo
echo "This starts a disposable support/billing/orders Postgres app, exposes semantic MCP tools,"
echo "creates a proposal, proves the source DB is unchanged, approves outside MCP,"
echo "applies guarded writeback, exports replay, and proves stale-row conflict."
echo "Full log: $LOG_FILE"
echo

if ! (cd "$ROOT" && corepack pnpm test:reference-app) >"$LOG_FILE" 2>&1; then
  echo "Reference app demo failed."
  echo "Why it matters: this demo should prove proposal, approval, guarded writeback, conflict, and replay."
  echo "Try: inspect $LOG_FILE, then rerun corepack pnpm demo:reference"
  exit 1
fi

echo "Success. Reference app proved:"
echo "* semantic MCP tools"
echo "* source DB unchanged after proposal"
echo "* approval outside MCP"
echo "* guarded trusted writeback"
echo "* stale-row conflict"
echo "* replay export"
echo
echo "Next:"
echo "synapsor-runner ui --open --tour --config ./examples/reference-support-billing-app/synapsor.runner.json --store ./tmp/reference-support-billing/local.db"
