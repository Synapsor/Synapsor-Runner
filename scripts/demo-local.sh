#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Synapsor Runner local MCP demo"
echo
echo "This demo uses disposable Docker Postgres/MySQL databases."
echo "No Synapsor Cloud account, API key, or hosted workspace is required."
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for the local demo, but the docker command was not found." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose is required for the local demo, but 'docker compose' is not available." >&2
  exit 1
fi

if ! command -v corepack >/dev/null 2>&1; then
  echo "Corepack is required so the repository can use its pinned pnpm version." >&2
  exit 1
fi

if [ ! -d "$ROOT/node_modules" ]; then
  echo "Installing dependencies with the pinned pnpm version..."
  corepack pnpm install --frozen-lockfile
  echo
fi

echo "Running local MCP proof:"
echo "- starts disposable Postgres/MySQL containers"
echo "- exposes semantic MCP tools instead of raw SQL"
echo "- creates evidence-backed proposals without mutating source rows"
echo "- approves locally and applies guarded writeback"
echo "- retries idempotently"
echo "- proves stale-row conflict blocks commit"
echo

corepack pnpm test:mcp-local

echo
echo "Local demo complete."
echo "The containers, volumes, and temporary local demo files were torn down by the demo script."
