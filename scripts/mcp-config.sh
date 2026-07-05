#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNAPSOR_BIN="${SYNAPSOR_BIN:-$ROOT/bin/synapsor-runner}"
CLIENT="${1:-claude-desktop}"
CONFIG="./examples/reference-support-billing-app/synapsor.runner.json"
STORE="./tmp/reference-support-billing/local.db"

usage() {
  cat <<'USAGE'
Print an MCP client config snippet for Synapsor Runner.

Usage:
  ./scripts/mcp-config.sh [claude-desktop|cursor|vscode|generic]

Default:
  ./scripts/mcp-config.sh claude-desktop

The printed config contains command paths only. It does not contain database
URLs, passwords, write credentials, approval tools, or commit tools.
USAGE
}

if [[ "$CLIENT" == "--help" || "$CLIENT" == "-h" ]]; then
  usage
  exit 0
fi

case "$CLIENT" in
  claude-desktop|cursor|vscode|generic|generic-stdio) ;;
  *)
    echo "Unsupported client: $CLIENT" >&2
    usage >&2
    exit 2
    ;;
esac

cd "$ROOT"
"$SYNAPSOR_BIN" mcp config "$CLIENT" --absolute-paths --config "$CONFIG" --store "$STORE"
