#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

demo_load_synthetic_env
demo_ensure_dirs

docker compose -f "$DEMO_VIDEO_COMPOSE_FILE" up -d >/dev/null
demo_wait_for_postgres

docker exec "$DEMO_VIDEO_CONTAINER" \
  psql -U synapsor_admin -d synapsor_runner_plan_credit -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
UPDATE public.customers
SET plan_credit_cents = 0,
    credit_reason = NULL,
    updated_at = '2026-06-20T14:31:08Z'
WHERE id = 'CUS-3001' AND tenant_id = 'acme';
SQL

demo_assert_source_row "CUS-3001|0|none"

other_tenant_count="$(docker exec "$DEMO_VIDEO_CONTAINER" \
  psql -U synapsor_admin -d synapsor_runner_plan_credit -Atc \
  "SELECT count(*) FROM public.customers WHERE id='CUS-9001' AND tenant_id='otherco'")"
[[ "$other_tenant_count" == "1" ]] || demo_fail "Synthetic cross-tenant guard row is missing."

demo_log "Synthetic support-plan-credit data is ready."
demo_log "CUS-3001 credit: 0 cents"
