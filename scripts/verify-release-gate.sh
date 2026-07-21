#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_VERSION="${1:-}"

if [[ -z "$EXPECTED_VERSION" ]]; then
  EXPECTED_VERSION="$(node -e "console.log(require('$ROOT/apps/runner/package.json').version)")"
fi

log() {
  printf '\n== %s ==\n' "$*"
}

run() {
  log "$*"
  "$@"
}

if [[ ! "$EXPECTED_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Expected a semver version, got: $EXPECTED_VERSION" >&2
  exit 1
fi

log "Release gate for @synapsor/runner $EXPECTED_VERSION"

run corepack pnpm --dir "$ROOT" typecheck
run corepack pnpm --dir "$ROOT" exec vitest run \
  apps/runner/src/cli.test.ts \
  packages/proposal-store/src/index.test.ts \
  packages/mcp-server/src/index.test.ts \
  packages/config/src/index.test.ts \
  packages/schema-inspector/src/index.test.ts \
  packages/postgres/src/index.test.ts \
  packages/mysql/src/index.test.ts \
  packages/handler/src/index.test.ts
run corepack pnpm --dir "$ROOT" test:mcp-client-configs
run corepack pnpm --dir "$ROOT" test:first-run

run "$ROOT/scripts/verify-public-commands.sh"
run "$ROOT/scripts/verify-local-runner.sh"
run "$ROOT/scripts/verify-packed-runner.sh"
run "$ROOT/scripts/verify-packed-own-db.sh"
run node "$ROOT/scripts/check-license-content.mjs"

log "No install-looking @synapsor/handler references in public docs/examples"
if grep -R -n "@synapsor/handler" \
  "$ROOT/README.md" \
  "$ROOT/apps/runner/README.md" \
  "$ROOT/docs" \
  "$ROOT/apps/runner/docs" \
  "$ROOT/examples"; then
  echo "Found @synapsor/handler in public docs/examples. Keep handler code as examples/templates, not an installable public package." >&2
  exit 1
fi

log "Runner package dry run"
(cd "$ROOT/apps/runner" && npm pack --dry-run)

run git -C "$ROOT" diff --check

if [[ "${VERIFY_PUBLISHED_ALPHA:-0}" == "1" ]]; then
  run "$ROOT/scripts/verify-published-alpha.sh" "$EXPECTED_VERSION"
else
  log "Skipping published npm alpha check"
  echo "Set VERIFY_PUBLISHED_ALPHA=1 to verify @synapsor/runner@alpha after manual publish."
fi

log "Release gate passed for @synapsor/runner $EXPECTED_VERSION"
