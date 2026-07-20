#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

SYNAPSOR_REFERENCE_EXAMPLE_DIR="examples/support-billing-agent" \
SYNAPSOR_REFERENCE_CONFIG_PATH="examples/support-billing-agent/synapsor.runner.json" \
SYNAPSOR_REFERENCE_TMP_DIR="tmp/support-billing-agent" \
SYNAPSOR_REFERENCE_CONTAINER="synapsor_runner_support_billing_agent" \
SYNAPSOR_REFERENCE_DB="synapsor_support_billing_agent" \
SYNAPSOR_REFERENCE_PORT="55436" \
SYNAPSOR_REFERENCE_EXPECTED_TOOLS="support.inspect_ticket,support.propose_plan_credit,billing.inspect_invoice,billing.propose_late_fee_waiver" \
SYNAPSOR_REFERENCE_EXACT_TOOLS="1" \
SYNAPSOR_REFERENCE_TICKET_ID="SUP-184" \
SYNAPSOR_REFERENCE_REQUIRE_PRINCIPAL_SCOPE="1" \
SYNAPSOR_REFERENCE_REQUIRE_RLS="1" \
SYNAPSOR_REFERENCE_SHADOW_PROOF="1" \
node scripts/smoke-reference-support-billing-app.mjs
