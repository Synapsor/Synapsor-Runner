#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.synapsor/logs"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="$LOG_DIR/try-synapsor-$TIMESTAMP.log"
PORTS=(55433 55434 55435 53307)

say() { printf '%s\n' "$*"; }
fail() {
  say "Demo did not prove the Synapsor boundary."
  say
  say "Failing check: $1"
  say "Full log: $LOG_FILE"
  exit 1
}

require_log() {
  local pattern="$1"
  local message="$2"
  grep -q "$pattern" "$LOG_FILE" || fail "$message"
}

confirm_reset() {
  if [[ "${1:-}" == "--yes" ]]; then return 0; fi
  say "This will remove Synapsor Runner demo containers, volumes, local demo stores, and first-run logs."
  read -r -p "Continue? Type yes: " answer
  [[ "$answer" == "yes" ]]
}

reset_demo() {
  mkdir -p "$LOG_DIR"
  if ! confirm_reset "${1:-}"; then
    say "Reset canceled."
    exit 1
  fi
  {
    docker compose -f "$ROOT/examples/mcp-postgres-billing/docker-compose.yml" down -v --remove-orphans || true
    docker compose -f "$ROOT/examples/mcp-postgres-support/docker-compose.yml" down -v --remove-orphans || true
    docker compose -f "$ROOT/examples/mcp-mysql-orders/docker-compose.yml" down -v --remove-orphans || true
    docker compose -f "$ROOT/examples/postgres-support/docker-compose.yml" down -v --remove-orphans || true
    docker compose -f "$ROOT/examples/mysql-orders/docker-compose.yml" down -v --remove-orphans || true
    docker compose -f "$ROOT/examples/reference-support-billing-app/docker-compose.yml" down -v --remove-orphans || true
    "$ROOT/scripts/clean-local-generated.sh" --quiet
    find "$LOG_DIR" -type f -name 'try-synapsor-*.log' -delete 2>/dev/null || true
  } >"$LOG_FILE" 2>&1
  say "Reset complete."
}

if [[ "${1:-}" == "--reset" ]]; then
  reset_demo "${2:-}"
  exit 0
fi

mkdir -p "$LOG_DIR"
: >"$LOG_FILE"

say "Synapsor Runner first-run demo"
say
say "You are about to see an MCP agent propose a database change without receiving SQL or write credentials."
say "Full logs will be written to: $LOG_FILE"
say

{
  echo "== preflight =="
  command -v bash >/dev/null 2>&1 || exit 11
  command -v docker >/dev/null 2>&1 || exit 12
  docker info >/dev/null 2>&1 || exit 13
  if ! docker compose version >/dev/null 2>&1; then exit 14; fi
  available_kb="$(df -Pk "$ROOT" | awk 'NR == 2 { print $4 }')"
  if [[ -n "$available_kb" && "$available_kb" =~ ^[0-9]+$ ]]; then
    echo "available disk KB: $available_kb"
    if (( available_kb < 1048576 )); then exit 15; fi
  fi
  if [[ -r /proc/meminfo ]]; then
    total_mem_kb="$(awk '/MemTotal/ { print $2 }' /proc/meminfo)"
    echo "total memory KB: ${total_mem_kb:-unknown}"
    if [[ -n "${total_mem_kb:-}" && "$total_mem_kb" =~ ^[0-9]+$ && "$total_mem_kb" -lt 2097152 ]]; then exit 16; fi
  fi
} >>"$LOG_FILE" 2>&1 || {
  case "$?" in
    11) fail "Bash is not available. Install bash, then rerun ./scripts/try-synapsor.sh." ;;
    12) fail "Docker CLI is missing. Install Docker Desktop or Docker Engine, then rerun ./scripts/try-synapsor.sh." ;;
    13) fail "Docker daemon is not reachable. Start Docker Desktop or Docker Engine, then rerun ./scripts/try-synapsor.sh." ;;
    14) fail "Docker Compose is unavailable. Install a Docker version with 'docker compose', then rerun ./scripts/try-synapsor.sh." ;;
    15) fail "Less than 1 GB of free disk space is available. Free space, then rerun ./scripts/try-synapsor.sh." ;;
    16) fail "Less than 2 GB of system memory is available. Close heavy apps or increase Docker memory, then rerun ./scripts/try-synapsor.sh." ;;
    *) fail "Preflight failed." ;;
  esac
}

for port in "${PORTS[@]}"; do
  if (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
    fail "Port $port is already in use. Stop that process, or run ./scripts/try-synapsor.sh --reset."
  fi
done

say "Step 1: MCP tools exposed"
say "  In this fixture, the model sees semantic tools such as billing.inspect_invoice and billing.propose_late_fee_waiver."
say
say "Step 2: Agent inspects business object"
say "Step 3: Agent proposes change"
say "Step 4: Source DB changed: No"
say "Step 5: Human approval outside MCP"
say "Step 6: Trusted runner applies guarded writeback"
say "Step 7: Replay explains what happened"
say "Step 8: Extra safety checks catch stale rows and unsafe tools"
say
say "Running the disposable Docker proof. This can take a few minutes..."

if ! "$ROOT/scripts/demo-docker.sh" >>"$LOG_FILE" 2>&1; then
  fail "The Docker demo command failed. See the log for the raw error and rerun ./scripts/try-synapsor.sh --reset if stale containers remain."
fi

require_log "ACCEPT semantic tools present" "MCP tools list did not show semantic tools."
require_log "ACCEPT execute_sql approval and commit tools absent" "MCP tools list did not prove execute_sql/approval/commit tools were absent."
require_log "ACCEPT proposal created successfully" "Proposal creation was not observed."
require_log "ACCEPT source row unchanged after proposal" "Source row unchanged proof was not observed."
require_log "ACCEPT approval happened outside MCP" "Approval outside MCP was not observed."
require_log "ACCEPT guarded writeback applied" "Guarded writeback apply was not observed."
require_log "ACCEPT stale-row conflict detected" "Stale-row conflict proof was not observed."
require_log "ACCEPT replay export contains applied receipt" "Replay export with applied receipt was not observed."
require_log "Local MCP Postgres and MySQL examples passed" "MCP local smoke did not report success."
require_log "The business state changed after the agent saw it, so Synapsor refused to commit." "Stale-row conflict proof was not observed."
if grep -E "postgres(ql)?://|mysql://|synapsor_reader_password|synapsor_writer_password|root_password|Bearer [A-Za-z0-9._~+/=-]+" "$LOG_FILE" >/dev/null; then
  fail "A database URL, password, or bearer token appeared in the first-run log."
fi

say
say "Success. You saw the Synapsor commit boundary."
say
say "In the included fixture, the model got:"
say "* billing.inspect_invoice"
say "* billing.propose_late_fee_waiver"
say
say "The model did not get:"
say "* execute_sql"
say "* write credentials"
say "* approve/commit tools"
say
say "Next:"
say
say "1. Open proposal UI:"
say "   synapsor ui --tour --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db"
say
say "2. Run the reference app:"
say "   corepack pnpm demo:reference"
say
say "3. Generate MCP client config:"
say "   synapsor mcp config --absolute-paths --config ./examples/mcp-postgres-billing/synapsor.runner.json --store ./.synapsor/local.db"
say
say "4. Use your own staging Postgres/MySQL:"
say "   export DATABASE_URL='<postgres-or-mysql-read-url>'"
say "   synapsor inspect --from-env DATABASE_URL"
say "   synapsor init --wizard --from-env DATABASE_URL"
