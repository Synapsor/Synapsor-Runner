#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNAPSOR_BIN="${SYNAPSOR_BIN:-$ROOT/bin/synapsor-runner}"
ENV_NAME="DATABASE_URL"
ENGINE="auto"
MODE=""
CONFIG="synapsor.runner.json"
STORE="./.synapsor/local.db"
ALLOW_INSECURE_SSL=0

usage() {
  cat <<'USAGE'
Use your own staging Postgres/MySQL with Synapsor Runner.

Usage:
  export DATABASE_URL="<postgres-or-mysql-read-url>"
  ./scripts/use-your-db.sh

Options:
  --env NAME          Environment variable containing the read URL. Default: DATABASE_URL
  --engine ENGINE     auto, postgres, or mysql. Default: auto
  --mode MODE         read_only, shadow, or review. Default: ask interactively
  --config PATH       Generated config path. Default: synapsor.runner.json
  --store PATH        Local proposal/evidence/replay store. Default: ./.synapsor/local.db
  --allow-insecure-ssl
                      For disposable dev DBs only: retry TLS failures with sslmode=no-verify.

This script does not print your database URL. It inspects metadata, opens the
guided config wizard, previews MCP tools, and prints the serve/UI commands.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --engine)
      ENGINE="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG="${2:-}"
      shift 2
      ;;
    --store)
      STORE="${2:-}"
      shift 2
      ;;
    --allow-insecure-ssl)
      ALLOW_INSECURE_SSL=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$ENV_NAME" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
  printf 'Invalid --env value. Use an environment-variable name such as DATABASE_URL.\n' >&2
  exit 2
fi

if [[ -z "${!ENV_NAME:-}" ]]; then
  printf '%s is not set.\n\n' "$ENV_NAME" >&2
  usage >&2
  exit 2
fi

case "$ENGINE" in
  auto|postgres|mysql) ;;
  *)
    printf 'Invalid --engine value: %s\n' "$ENGINE" >&2
    exit 2
    ;;
esac

choose_mode() {
  if [[ -n "$MODE" ]]; then
    case "$MODE" in
      read_only|shadow|review) return 0 ;;
      *)
        printf 'Invalid --mode value: %s\n' "$MODE" >&2
        exit 2
        ;;
    esac
  fi

  if [[ ! -t 0 ]]; then
    MODE="read_only"
    return 0
  fi

  printf 'Choose the first setup mode:\n'
  printf '  1) Read-only semantic tools (recommended first)\n'
  printf '  2) Proposal review tools with guarded writeback setup\n'
  printf '  3) Shadow proposals for comparing against human actions\n'
  printf 'Selection [1]: '
  read -r answer
  case "${answer:-1}" in
    1|read_only) MODE="read_only" ;;
    2|review) MODE="review" ;;
    3|shadow) MODE="shadow" ;;
    *)
      printf 'Invalid selection. Use 1, 2, or 3.\n' >&2
      exit 2
      ;;
  esac
}

with_no_verify_url() {
  local url="$1"
  if [[ "$url" == *"sslmode="* ]]; then
    printf '%s' "$url" | sed -E 's/sslmode=[^&]*/sslmode=no-verify/'
    return 0
  fi
  if [[ "$url" == *"?"* ]]; then
    printf '%s&sslmode=no-verify' "$url"
  else
    printf '%s?sslmode=no-verify' "$url"
  fi
}

run_inspect() {
  local output status current_url retry_url answer
  set +e
  output="$("$SYNAPSOR_BIN" inspect --from-env "$ENV_NAME" --engine "$ENGINE" 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  if [[ "$status" -eq 0 ]]; then return 0; fi

  if ! grep -Eiq 'self-signed certificate|certificate.*chain|unable to verify|TLS certificate verification failed' <<<"$output"; then
    return "$status"
  fi

  if [[ "$ALLOW_INSECURE_SSL" -ne 1 ]]; then
    if [[ -t 0 ]]; then
      printf '\nThe database is reachable, but TLS certificate verification failed.\n'
      printf 'For disposable dev databases only, retry with sslmode=no-verify? [y/N]: '
      read -r answer
      if [[ ! "$answer" =~ ^[Yy](es)?$ ]]; then
        printf 'Stopped. Install the database CA bundle or rerun with --allow-insecure-ssl for disposable dev testing.\n' >&2
        exit "$status"
      fi
    else
      printf '\nTLS verification failed. For disposable dev testing, rerun with --allow-insecure-ssl, or install the database CA bundle.\n' >&2
      exit "$status"
    fi
  fi

  current_url="${!ENV_NAME}"
  retry_url="$(with_no_verify_url "$current_url")"
  export "$ENV_NAME=$retry_url"
  printf '\nRetrying metadata inspection with sslmode=no-verify for this disposable dev run.\n'
  "$SYNAPSOR_BIN" inspect --from-env "$ENV_NAME" --engine "$ENGINE"
}

cd "$ROOT"

printf 'Synapsor Runner own-database setup\n\n'
choose_mode
printf 'Mode: %s\n' "$MODE"
if [[ "$MODE" == "read_only" ]]; then
  printf 'Starting with read-only semantic MCP tools. You can add proposal/writeback later.\n\n'
else
  printf 'Proposal mode will create reviewable changes first. The source DB still stays unchanged until a trusted apply step runs.\n\n'
fi

printf 'Step 1: inspect metadata from %s\n' "$ENV_NAME"
run_inspect

printf '\nStep 2: generate reviewed semantic MCP tools\n'
"$SYNAPSOR_BIN" init --from-env "$ENV_NAME" --engine "$ENGINE" --mode "$MODE" --wizard --output "$CONFIG"

printf '\nStep 3: preview the MCP tool boundary\n'
"$SYNAPSOR_BIN" tools preview --config "$CONFIG" --store "$STORE"

printf '\nNext:\n'
printf '  Serve MCP:\n'
printf '    synapsor-runner mcp serve --config %s --store %s\n' "$CONFIG" "$STORE"
printf '  Open local review UI:\n'
printf '    synapsor-runner ui --open --tour --config %s --store %s\n' "$CONFIG" "$STORE"
