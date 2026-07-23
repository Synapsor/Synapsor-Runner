#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT/apps/runner"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

cd "$ROOT"
corepack pnpm build:runner-package >/dev/null
cd "$ROOT/packages/spec"
corepack pnpm pack --pack-destination "$TEMP_DIR" >/dev/null
cd "$PACKAGE_DIR"
corepack pnpm pack --pack-destination "$TEMP_DIR" >/dev/null

cd "$TEMP_DIR"
npm init -y >/dev/null
npm install ./*.tgz >/dev/null

SYNAPSOR_RUNNER_CLI="$TEMP_DIR/node_modules/@synapsor/runner/dist/cli.js" \
  node "$ROOT/scripts/verify-principal-row-scope.mjs"

echo "Packed Runner trusted principal row-scope verification passed."
