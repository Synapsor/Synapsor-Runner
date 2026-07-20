#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
EXPECTED_VERSION="${1:-0.1.0}"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

if [[ ! "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Expected a non-prerelease semver version such as 0.1.0, got: $EXPECTED_VERSION" >&2
  exit 1
fi

PUBLISHED_VERSION="$(npm view @synapsor/runner@latest version)"
if [[ "$PUBLISHED_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Expected @synapsor/runner@latest to be $EXPECTED_VERSION, got $PUBLISHED_VERSION" >&2
  echo "Publish/promote the stable package, then rerun this script." >&2
  exit 1
fi

DIST_TAGS="$(npm dist-tag ls @synapsor/runner)"
printf "%s\n" "$DIST_TAGS" | grep -F "latest: $EXPECTED_VERSION" >/dev/null

npm view @synapsor/runner@latest bin license >/dev/null

cd "$TEMP_DIR"

npx -y -p @synapsor/runner@latest synapsor-runner --help >/dev/null
npx -y -p @synapsor/runner@latest synapsor-runner try --prove --yes --no-open > proof.txt
grep -F "late_fee_cents: 5500 -> 0" proof.txt >/dev/null
grep -F "Source changed:" proof.txt >/dev/null
grep -F "Guarded commit complete." proof.txt >/dev/null
grep -F "restart-safe retry: yes" proof.txt >/dev/null
grep -F "changed-intent operation reuse rejected: yes" proof.txt >/dev/null
grep -F "stale apply refused: yes" proof.txt >/dev/null
grep -F "replay changed source: no" proof.txt >/dev/null

npx -y -p @synapsor/runner@latest synapsor-runner audit --example dangerous-db-mcp --format markdown > audit.md
grep -F "execute_sql" audit.md >/dev/null

npx -y -p @synapsor/runner@latest synapsor-runner mcp serve-streamable-http --help > streamable-help.txt
grep -F -- "--alias-mode openai" streamable-help.txt >/dev/null

npx -y -p @synapsor/runner@latest synapsor-runner demo inspect > inspect.txt
grep -F "Synapsor try inspection" inspect.txt >/dev/null

npx -y -p @synapsor/runner@latest synapsor-runner activity search --object invoice:INV-3001 --store ./.synapsor/try/ledger.db >/dev/null
npx -y -p @synapsor/runner@latest synapsor-runner replay show wrp_try_INV_3001 --store ./.synapsor/try/ledger.db >/dev/null

echo "published stable $PUBLISHED_VERSION verified in $TEMP_DIR"
