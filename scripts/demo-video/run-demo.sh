#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

demo_load_synthetic_env
demo_ensure_dirs
demo_prepare_runner
demo_wait_for_postgres
demo_assert_source_row "CUS-3001|0|none"

demo_log "Running real support-plan-credit flow with $DEMO_VIDEO_RUNNER_MODE Runner."

demo_capture audit.md demo_runner audit --example dangerous-db-mcp --format markdown
demo_capture tools-preview.txt demo_runner tools preview \
  --config "$DEMO_VIDEO_CONFIG" \
  --store "$DEMO_VIDEO_STORE"
demo_capture inspect.json demo_runner smoke call support.inspect_customer \
  --config "$DEMO_VIDEO_CONFIG" \
  --store "$DEMO_VIDEO_STORE" \
  --json '{"customer_id":"CUS-3001"}'
demo_capture source-before.txt demo_source_row

demo_capture proposal.json demo_runner propose support.propose_plan_credit \
  --config "$DEMO_VIDEO_CONFIG" \
  --store "$DEMO_VIDEO_STORE" \
  --json '{"customer_id":"CUS-3001","credit_cents":10000,"reason":"SLA outage ticket SUP-481"}'
demo_capture source-after-proposal.txt demo_source_row
demo_assert_source_row "CUS-3001|0|none"

demo_capture proposal-before-approval.json demo_runner proposals show latest \
  --store "$DEMO_VIDEO_STORE" \
  --json
proposal_id="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(p.proposal.proposal_id)' "$DEMO_VIDEO_RAW_DIR/proposal-before-approval.json")"
[[ "$proposal_id" == wrp_* ]] || demo_fail "Runner did not return a proposal id."

demo_capture proposal-summary.txt demo_runner proposals show "$proposal_id" \
  --store "$DEMO_VIDEO_STORE"
demo_capture approval.txt demo_runner proposals approve "$proposal_id" --yes \
  --store "$DEMO_VIDEO_STORE"
demo_assert_source_row "CUS-3001|0|none"

demo_capture apply.txt demo_runner apply "$proposal_id" \
  --config "$DEMO_VIDEO_CONFIG" \
  --store "$DEMO_VIDEO_STORE"
demo_capture source-after-apply.txt demo_source_row
demo_assert_source_row "CUS-3001|10000|SLA outage ticket SUP-481"

demo_capture receipts.txt demo_runner receipts list --proposal "$proposal_id" \
  --store "$DEMO_VIDEO_STORE"
demo_capture replay.txt demo_runner replay show --proposal "$proposal_id" \
  --store "$DEMO_VIDEO_STORE"
demo_capture_expected_status apply-retry.txt 1 demo_runner apply "$proposal_id" \
  --config "$DEMO_VIDEO_CONFIG" \
  --store "$DEMO_VIDEO_STORE"
demo_capture proposal-after-apply.json demo_runner proposals show "$proposal_id" \
  --store "$DEMO_VIDEO_STORE" \
  --json

# Prove that a newly approved proposal cannot overwrite a row whose reviewed
# conflict version changed after proposal creation.
demo_capture stale-proposal.json demo_runner propose support.propose_plan_credit \
  --config "$DEMO_VIDEO_CONFIG" \
  --store "$DEMO_VIDEO_STORE" \
  --json '{"customer_id":"CUS-3001","credit_cents":12000,"reason":"Follow-up service review SUP-482"}'
demo_capture stale-proposal-before-apply.json demo_runner proposals show latest \
  --store "$DEMO_VIDEO_STORE" \
  --json
stale_proposal_id="$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(p.proposal.proposal_id)' "$DEMO_VIDEO_RAW_DIR/stale-proposal-before-apply.json")"
[[ "$stale_proposal_id" == wrp_* ]] || demo_fail "Runner did not return the stale-check proposal id."
demo_capture stale-approval.txt demo_runner proposals approve "$stale_proposal_id" --yes \
  --store "$DEMO_VIDEO_STORE"
demo_capture stale-version-bump.txt docker exec "$DEMO_VIDEO_CONTAINER" \
  psql -U synapsor_admin -d synapsor_runner_plan_credit -Atc \
  "UPDATE public.customers SET updated_at = updated_at + interval '5 seconds' WHERE id='CUS-3001' RETURNING id"
demo_capture stale-apply.txt demo_runner apply "$stale_proposal_id" \
  --config "$DEMO_VIDEO_CONFIG" \
  --store "$DEMO_VIDEO_STORE"
demo_capture stale-proposal-after-apply.json demo_runner proposals show "$stale_proposal_id" \
  --store "$DEMO_VIDEO_STORE" \
  --json
demo_capture source-after-stale.txt demo_source_row
demo_assert_source_row "CUS-3001|10000|SLA outage ticket SUP-481"

demo_capture cloud-dry-run.json demo_runner cloud push "$DEMO_VIDEO_CONTRACT" \
  --dry-run \
  --workspace local-preview \
  --name support-plan-credit \
  --json

if [[ -f "$DEMO_VIDEO_PRIVATE_CLOUD_STATE" ]]; then
  cloud_base_url="$(node -e 'const s=require(process.argv[1]); process.stdout.write(s.base_url)' "$DEMO_VIDEO_PRIVATE_CLOUD_STATE")"
  cloud_token="$(node -e 'const s=require(process.argv[1]); process.stdout.write(s.session_token)' "$DEMO_VIDEO_PRIVATE_CLOUD_STATE")"
  cloud_workspace="$(node -e 'const s=require(process.argv[1]); process.stdout.write(s.project_id)' "$DEMO_VIDEO_PRIVATE_CLOUD_STATE")"

  SYNAPSOR_CLOUD_BASE_URL="$cloud_base_url" \
  SYNAPSOR_CLOUD_ACCESS_TOKEN="$cloud_token" \
  SYNAPSOR_WORKSPACE_ID="$cloud_workspace" \
    demo_capture cloud-push.json demo_runner cloud push "$DEMO_VIDEO_CONTRACT" \
      --workspace "$cloud_workspace" \
      --name support-plan-credit \
      --json

  SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE="$DEMO_VIDEO_PRIVATE_CLOUD_STATE" \
  SYNAPSOR_DEMO_CLOUD_PUSH_RESPONSE="$DEMO_VIDEO_RAW_DIR/cloud-push.json" \
  SYNAPSOR_DEMO_CLOUD_PUBLIC_STATE="$DEMO_VIDEO_PUBLIC_CLOUD_STATE" \
  SYNAPSOR_DEMO_CLOUD_BUNDLE="$DEMO_VIDEO_PRIVATE_DIR/support-plan-credit-runner-bundle.zip" \
  SYNAPSOR_DEMO_CONTRACT="$DEMO_VIDEO_CONTRACT" \
    node "$SCRIPT_DIR/fetch-cloud-artifacts.mjs"

  unset cloud_base_url cloud_token cloud_workspace
else
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({complete:false,reason:"cloud workspace not configured"}, null, 2)+"\n", {mode:0o600})' "$DEMO_VIDEO_PUBLIC_CLOUD_STATE"
  demo_log "Cloud workspace is not configured; local product capture is complete, final verification will remain incomplete."
fi

node "$SCRIPT_DIR/build-result.mjs" \
  "$DEMO_VIDEO_STATE_DIR" \
  "$DEMO_VIDEO_RESULTS" \
  "$DEMO_VIDEO_ROOT" \
  "$DEMO_VIDEO_RUNNER_MODE" \
  "$DEMO_VIDEO_RUNNER_VERSION"

if [[ "${SYNAPSOR_DEMO_KEEP_RAW:-0}" != "1" ]]; then
  rm -rf "$DEMO_VIDEO_RAW_DIR"
fi

demo_log "Product flow captured: $DEMO_VIDEO_RESULTS"
demo_log "Proposal: $proposal_id"
demo_log "Stale proposal refused: $stale_proposal_id"
