#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

preferred=(
  "packages/dsl/examples/billing-late-fee.synapsor.sql"
  "examples/support-plan-credit/contract.synapsor.sql"
)
legacy=(
  "packages/dsl/examples/billing-late-fee.synapsor"
  "examples/support-plan-credit/contract.synapsor"
)

for path in "${preferred[@]}"; do
  [[ -f "$path" ]] || { echo "missing preferred DSL source: $path" >&2; exit 1; }
done

for path in "${legacy[@]}"; do
  [[ ! -e "$path" ]] || { echo "stale canonical DSL source remains: $path" >&2; exit 1; }
done

stale_refs="$(git grep -n -E 'packages/dsl/examples/billing-late-fee\.synapsor([^.]|$)|examples/support-plan-credit/contract\.synapsor([^.]|$)' -- . ':(exclude).synapsor/**' ':(exclude)scripts/verify-dsl-source-paths.sh' || true)"
if [[ -n "$stale_refs" ]]; then
  echo "stale references to renamed canonical DSL sources:" >&2
  printf '%s\n' "$stale_refs" >&2
  exit 1
fi

grep -F '"*.synapsor.sql": "sql"' .vscode/settings.json >/dev/null
grep -F '"*.synapsor": "sql"' .vscode/settings.json >/dev/null
grep -F '.synapsor/' .gitignore >/dev/null
grep -F './.synapsor/quick-demo.db' README.md >/dev/null

echo "DSL source path check passed: .synapsor.sql preferred, .synapsor compatibility preserved"
