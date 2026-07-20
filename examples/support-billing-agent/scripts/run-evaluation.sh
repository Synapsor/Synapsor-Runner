#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

OUTPUT_DIR="$ROOT_DIR/tmp/support-billing-agent/evaluation"
STORE_PATH="$OUTPUT_DIR/shadow.db"
REPORT_PATH="$OUTPUT_DIR/shadow-report.json"
EFFECT_PATH="$OUTPUT_DIR/effect-report.json"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

corepack pnpm runner shadow study create \
  --id sst_support_reference \
  --name "Support reference study" \
  --capability billing.propose_late_fee_waiver \
  --store "$STORE_PATH" >/dev/null

corepack pnpm runner shadow case import \
  --study sst_support_reference \
  --input "$ROOT_DIR/examples/support-billing-agent/shadow-study/cases.jsonl" \
  --store "$STORE_PATH" >/dev/null

corepack pnpm runner shadow outcome import \
  --study sst_support_reference \
  --input "$ROOT_DIR/examples/support-billing-agent/shadow-study/outcomes.jsonl" \
  --store "$STORE_PATH" >/dev/null

corepack pnpm runner shadow report \
  --study sst_support_reference \
  --store "$STORE_PATH" \
  --output "$REPORT_PATH" >/dev/null

node --input-type=module - "$REPORT_PATH" <<'NODE'
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expected = {
  total_tasks_observed: 6,
  tasks_with_authoritative_outcomes: 2,
  comparable_tasks: 1,
  exact_agreements: 1,
  human_rejections_no_action: 1,
  policy_denials: 1,
  stale_conflicts: 1,
  unmatched_cases: 1,
  invalid_or_unsafe_scope_attempts: 1,
};
for (const [key, value] of Object.entries(expected)) {
  if (report[key] !== value) throw new Error(`shadow report ${key}=${report[key]}, expected ${value}`);
}
NODE

corepack pnpm runner effect run \
  --dataset "$ROOT_DIR/fixtures/effects/dataset.json" \
  --results-dir "$ROOT_DIR/fixtures/effects/results" \
  --format json \
  --out "$EFFECT_PATH" >/dev/null

printf '%s\n' "Shadow comparison passed: 6 cases, 2 human outcomes, 1 exact agreement, 1 human rejection."
printf '%s\n' "Effect regression passed: the reviewed \$55 waiver effect is unchanged."
