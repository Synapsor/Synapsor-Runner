#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"
corepack pnpm build:cloud-cli-package
npm pack ./apps/cloud-cli --pack-destination "$TMP" --silent >/dev/null

TARBALL="$(find "$TMP" -maxdepth 1 -name 'synapsor-cli-*.tgz' -print -quit)"
if [[ -z "$TARBALL" ]]; then
  printf 'packed @synapsor/cli tarball was not created\n' >&2
  exit 1
fi

mkdir -p "$TMP/install"
cd "$TMP/install"
npm init -y >/dev/null
npm install "$TARBALL" --ignore-scripts --no-audit --no-fund >/dev/null

VERSION="$(npx --no-install synapsor --version)"
[[ "$VERSION" == "0.1.0-beta.1" ]]
npx --no-install synapsor -v | rg -x '0\.1\.0-beta\.1'
npx --no-install synapsor version | rg -x '0\.1\.0-beta\.1'
npx --no-install synapsor --help | rg -F 'Use synapsor-runner for the local MCP/database safety boundary.'

npx --no-install synapsor contracts init ./contract.json --name packed-check >/dev/null
npx --no-install synapsor contexts create packed_context \
  --contract ./contract.json \
  --binding-source environment \
  --tenant-binding tenant_id \
  --principal-binding principal >/dev/null
npx --no-install synapsor contracts validate ./contract.json >/dev/null

for DSL_FILE in contract.synapsor contract.synapsor.sql; do
  npx --no-install synapsor contracts init "./$DSL_FILE" --name packed-dsl-check >/dev/null
  npx --no-install synapsor contracts validate "./$DSL_FILE" >/dev/null
done

mkdir -p "$TMP/unpacked"
tar -xzf "$TARBALL" -C "$TMP/unpacked"
if rg -n 'workspace:' "$TMP/unpacked/package/package.json"; then
  printf 'packed CLI manifest contains a workspace dependency\n' >&2
  exit 1
fi
if rg -n '/home/|Desktop/C\+\+' "$TMP/unpacked/package/package.json" "$TMP/unpacked/package/dist/cli.js"; then
  printf 'packed CLI contains a workspace dependency or repository-local path\n' >&2
  exit 1
fi
test -s "$TMP/unpacked/package/README.md"
test -s "$TMP/unpacked/package/LICENSE"

printf '@synapsor/cli packed verification: ok (%s)\n' "$VERSION"
