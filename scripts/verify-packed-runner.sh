#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_DIR="$ROOT/apps/runner"
SPEC_PACKAGE_DIR="$ROOT/packages/spec"
TEMP_DIR="$(mktemp -d)"
TARBALL=""
SPEC_TARBALL=""
EXPECTED_VERSION="$(node -e "console.log(require('$PACKAGE_DIR/package.json').version)")"

cleanup() {
  rm -rf "$TEMP_DIR"
  if [[ -n "$TARBALL" && -f "$TARBALL" ]]; then
    rm -f "$TARBALL"
  fi
}
trap cleanup EXIT

cd "$ROOT"
corepack pnpm build:runner-package >/dev/null

cd "$SPEC_PACKAGE_DIR"
SPEC_PACK_OUTPUT="$(corepack pnpm pack --pack-destination "$TEMP_DIR")"
SPEC_PACK_FILE="$(printf "%s\n" "$SPEC_PACK_OUTPUT" | grep -E '\.tgz$' | tail -n 1)"
if [[ -z "$SPEC_PACK_FILE" ]]; then
  echo "Spec pack did not print a tarball filename" >&2
  printf "%s\n" "$SPEC_PACK_OUTPUT" >&2
  exit 1
fi
SPEC_TARBALL="$TEMP_DIR/$(basename "$SPEC_PACK_FILE")"

cd "$PACKAGE_DIR"
PACK_OUTPUT="$(corepack pnpm pack --pack-destination "$TEMP_DIR")"
PACK_FILE="$(printf "%s\n" "$PACK_OUTPUT" | grep -E '\.tgz$' | tail -n 1)"
if [[ -z "$PACK_FILE" ]]; then
  echo "npm pack did not print a tarball filename" >&2
  printf "%s\n" "$PACK_OUTPUT" >&2
  exit 1
fi
TARBALL="$TEMP_DIR/$(basename "$PACK_FILE")"

cd "$TEMP_DIR"
npm init -y >/dev/null
npm install "$SPEC_TARBALL" "$TARBALL" >/dev/null
STORE_PATH="$TEMP_DIR/.synapsor/try/ledger.db"

PACKED_ROOT="$TEMP_DIR/node_modules/@synapsor/runner"
test -f "$PACKED_ROOT/docs/mcp-apps.md"
grep -F "text/html;profile=mcp-app" "$PACKED_ROOT/docs/mcp-apps.md" >/dev/null
test -f "$PACKED_ROOT/docs/alternatives.md"
test -f "$PACKED_ROOT/docs/client-recipes.md"
test -f "$PACKED_ROOT/docs/cursor-plugin.md"
test -f "$PACKED_ROOT/docs/fresh-developer-usability.md"
test -f "$PACKED_ROOT/docs/effect-regression.md"
test -f "$PACKED_ROOT/schemas/effect-fixture.schema.json"
test -f "$PACKED_ROOT/schemas/effect-result.schema.json"
test -f "$PACKED_ROOT/schemas/effect-dataset.schema.json"
test -f "$PACKED_ROOT/schemas/mcp-audit-report.schema.json"
test -f "$PACKED_ROOT/schemas/mcp-audit-candidates.schema.json"
test -f "$PACKED_ROOT/schemas/schema-candidate-review.schema.json"
test -f "$PACKED_ROOT/schemas/schema-candidates.schema.json"
test -f "$PACKED_ROOT/docs/schema-api-candidates.md"
test -f "$PACKED_ROOT/fixtures/effects/dataset.json"
if [[ -e "$PACKED_ROOT/development" ]]; then
  echo "packed runner unexpectedly contains development progress files" >&2
  exit 1
fi

for version_args in "--version" "-v" "version" "synapsor-runner --version"; do
  read -r -a args <<< "$version_args"
  actual="$(npx synapsor-runner "${args[@]}")"
  if [[ "$actual" != "$EXPECTED_VERSION" ]]; then
    echo "packed version invocation '$version_args' returned '$actual', expected '$EXPECTED_VERSION'" >&2
    exit 1
  fi
done

npx synapsor-runner --help >/dev/null
node "$PACKED_ROOT/dist/cli.js" --help > direct-launcher-help.txt
grep -F "synapsor-runner try --prove" direct-launcher-help.txt >/dev/null
if grep -F "synapsor try --prove" direct-launcher-help.txt >/dev/null; then
  echo "packed Runner launcher confused the local binary with the Cloud CLI" >&2
  exit 1
fi
npx synapsor-runner demo --quick --no-interactive > quick.txt
grep -F "Synapsor Runner try" quick.txt >/dev/null
grep -F "Source changed:" quick.txt >/dev/null
grep -F "Guarded commit complete." quick.txt >/dev/null
if grep -F "Extended proof:" quick.txt >/dev/null; then
  echo "packed quick output unexpectedly ran the extended proof" >&2
  exit 1
fi
npx synapsor-runner demo --quick --details > quick-details.txt
grep -F "Extended proof:" quick-details.txt >/dev/null
grep -F "restart-safe retry: yes" quick-details.txt >/dev/null
grep -F "Evidence: ev_wrp_try_INV_3001" quick-details.txt >/dev/null
npx synapsor-runner demo inspect > inspect.txt
grep -F "Synapsor try inspection" inspect.txt >/dev/null
grep -F "synapsor-runner proposals show wrp_try_INV_3001 --store $STORE_PATH" inspect.txt >/dev/null
npx synapsor-runner demo inspect --npx > inspect-npx.txt
grep -F "npx -y -p @synapsor/runner synapsor-runner proposals show wrp_try_INV_3001" inspect-npx.txt >/dev/null
npx synapsor-runner events webhook --url http://127.0.0.1:8788/synapsor/events --kind proposal_created --store ./.synapsor/try/ledger.db --dry-run > events-webhook.txt
grep -F "synapsor.local-event-webhook.v1" events-webhook.txt >/dev/null
grep -F "proposal_created" events-webhook.txt >/dev/null
grep -F "wrp_try_INV_3001" events-webhook.txt >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp --verbose > audit-verbose.txt
grep -F "WRITE_TOOL_ACCEPTS_ARBITRARY_SQL" audit-verbose.txt >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp --format json >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp --format markdown >/dev/null
npx synapsor-runner audit --example dangerous-db-mcp --format sarif > audit.sarif
node --input-type=module - audit.sarif <<'NODE'
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (report.version !== "2.1.0" || report.runs?.[0]?.tool?.driver?.name !== "Synapsor Runner MCP audit") {
  throw new Error("packed audit SARIF has an unexpected shape");
}
NODE
npx synapsor-runner audit generate --example dangerous-db-mcp --output ./audit-candidates >/dev/null
test -f audit-candidates/synapsor.candidate.contract.json
test -f audit-candidates/synapsor.candidate.runner.json
test -f audit-candidates/synapsor.candidate.contract-tests.json
test -f audit-candidates/tool-surface.before.json
test -f audit-candidates/tool-surface.after.json
test -f audit-candidates/REVIEW.md
node --input-type=module - audit-candidates <<'NODE'
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(root, "synapsor.candidate.runner.json"), "utf8"));
const contract = JSON.parse(fs.readFileSync(path.join(root, "synapsor.candidate.contract.json"), "utf8"));
if (config.mode !== "shadow" || Object.keys(config.sources ?? {}).length !== 0) {
  throw new Error("packed audit candidate config is not source-less shadow mode");
}
for (const capability of contract.capabilities.filter((item) => item.kind === "proposal")) {
  if (capability.proposal?.writeback?.mode !== "none") throw new Error("packed proposal candidate carries writeback authority");
}
NODE
if npx synapsor-runner audit generate --example dangerous-db-mcp --output ./audit-candidates >/dev/null 2>&1; then
  echo "packed audit candidate generation unexpectedly overwrote an existing directory" >&2
  exit 1
fi

SAFE_ACTION_PROJECT="$TEMP_DIR/safe action project"
cp -R "$PACKED_ROOT/examples/support-plan-credit" "$SAFE_ACTION_PROJECT"
npx synapsor-runner start \
  --action second_credit \
  --description "Propose one second reviewed plan credit" \
  --based-on support.inspect_customer \
  --project-root "$SAFE_ACTION_PROJECT" > safe-action-start.txt
grep -F "State: disabled scaffold" safe-action-start.txt >/dev/null
grep -F "active Runner tools are unchanged" safe-action-start.txt >/dev/null
test -f "$SAFE_ACTION_PROJECT/synapsor/actions/support.propose_second_credit.ts"
test ! -e "$SAFE_ACTION_PROJECT/.synapsor/active.json"
npx synapsor-runner action validate \
  "$SAFE_ACTION_PROJECT/synapsor/actions/support.propose_plan_credit.ts" \
  --project-root "$SAFE_ACTION_PROJECT" \
  --json > safe-action-validation.json
node --input-type=module - safe-action-validation.json "$SAFE_ACTION_PROJECT" <<'NODE'
import fs from "node:fs";
import path from "node:path";
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const projectRoot = process.argv[3];
if (!result.ok || result.state !== "disabled_draft") throw new Error("packed Safe Action did not validate as a disabled draft");
if (result.active_tools_changed !== false || result.source_database_changed !== false) throw new Error("packed Safe Action validation changed authority or source data");
if (!/^sha256:[a-f0-9]{64}$/.test(result.draft_digest)) throw new Error("packed Safe Action validation omitted its digest");
if (fs.existsSync(path.join(projectRoot, ".synapsor", "active.json"))) throw new Error("packed Safe Action validation created an active artifact");
NODE
npx synapsor-runner action status --project-root "$SAFE_ACTION_PROJECT" --json > safe-action-status.json
node --input-type=module - safe-action-status.json <<'NODE'
import fs from "node:fs";
const status = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!status.ok || status.draft?.state !== "disabled_draft" || status.draft_matches_active !== false) {
  throw new Error("packed Safe Action status did not preserve draft/active separation");
}
NODE
npx synapsor-runner init from-prisma \
  "$PACKED_ROOT/fixtures/generators/prisma/schema.prisma" \
  --output ./prisma-candidates >/dev/null
node --input-type=module - prisma-candidates <<'NODE'
import fs from "node:fs";
import path from "node:path";
const root = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(root, "synapsor.candidate.runner.json"), "utf8"));
const contract = JSON.parse(fs.readFileSync(path.join(root, "synapsor.candidate.contract.json"), "utf8"));
const review = JSON.parse(fs.readFileSync(path.join(root, "generation-review.json"), "utf8"));
if (config.mode !== "shadow" || Object.keys(config.sources ?? {}).length !== 0) {
  throw new Error("packed Prisma candidate config is not source-less shadow mode");
}
if (review.activation !== "blocked_unreviewed" || contract["x-runner-candidate-only"] !== true) {
  throw new Error("packed Prisma candidates are not blocked and unreviewed");
}
for (const capability of contract.capabilities.filter((item) => item.kind === "proposal")) {
  if (capability.proposal?.writeback?.mode !== "none") throw new Error("packed Prisma proposal carries writeback authority");
}
NODE
npx synapsor-runner effect run \
  --dataset "$PACKED_ROOT/fixtures/effects/dataset.json" \
  --results-dir "$PACKED_ROOT/fixtures/effects/results" \
  --format junit > effect-results.xml
grep -F '<testsuite name="synapsor-effect" tests="14" failures="0">' effect-results.xml >/dev/null
if npx synapsor-runner effect run \
  --dataset "$PACKED_ROOT/fixtures/effects/dataset.json" \
  --results-dir "$PACKED_ROOT/fixtures/effects/changed" >/dev/null; then
  echo "packed effect regression unexpectedly accepted the changed result" >&2
  exit 1
fi
SURFACE_FIXTURE="$TEMP_DIR/node_modules/@synapsor/runner/fixtures/contracts/capability-surface-fitness.contract.json"
npx synapsor-runner contract validate "$SURFACE_FIXTURE" > surface-validate.txt
grep -F "contract valid:" surface-validate.txt >/dev/null
npx synapsor-runner contract lint "$SURFACE_FIXTURE" --format json > surface-lint.json
node --input-type=module - surface-lint.json <<'NODE'
import fs from "node:fs";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const codes = new Set(report.issues.map((issue) => issue.code));
for (const code of ["SURFACE_GENERIC_ARGUMENT", "SURFACE_NEAR_DUPLICATE", "SURFACE_OPERATION_NAMING", "SURFACE_TARGET_DENSITY"]) {
  if (!codes.has(code)) throw new Error(`packed lint report missing ${code}`);
}
if (report.ok !== true || report.surface?.total_capabilities !== 9 || report.surface?.density_review_threshold !== 8) {
  throw new Error("packed lint report has unexpected validity or surface summary");
}
NODE
if npx synapsor-runner contract lint "$SURFACE_FIXTURE" --strict > surface-strict.txt; then
  echo "packed surface lint unexpectedly succeeded under --strict" >&2
  exit 1
fi
grep -F "SURFACE_TARGET_DENSITY" surface-strict.txt >/dev/null
npx synapsor-runner recipes init billing.late_fee_waiver --yes --force >/dev/null
npx synapsor-runner up --config ./synapsor.runner.json --store ./.synapsor/try/ledger.db --dry-run > up.txt
grep -F "Synapsor Runner review-mode up" up.txt >/dev/null
grep -F "Serve now: no" up.txt >/dev/null
grep -F "Model-facing tools:" up.txt >/dev/null
grep -F "Next commands:" up.txt >/dev/null
npx synapsor-runner mcp serve-streamable-http --help > streamable-help.txt
grep -F -- "--alias-mode openai" streamable-help.txt >/dev/null
grep -F "billing__inspect_invoice" streamable-help.txt >/dev/null
npx synapsor-runner mcp serve --help > stdio-help.txt
grep -F -- "--alias-mode openai" stdio-help.txt >/dev/null
npx synapsor-runner mcp serve --transport streamable-http --help > unified-help.txt
grep -F -- "--alias-mode openai" unified-help.txt >/dev/null
npx synapsor-runner mcp client-config --client openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db > openai-config.json
grep -F "MCPServerStreamableHttp" openai-config.json >/dev/null
grep -F -- "--alias-mode" openai-config.json >/dev/null
npx synapsor-runner mcp config openai-agents --config ./synapsor.runner.json --store ./.synapsor/local.db > openai-config-positional.json
grep -F "billing__inspect_invoice" openai-config-positional.json >/dev/null
npx synapsor-runner mcp serve-http --help >/dev/null
npx synapsor-runner handler template --list > handler-templates.txt
grep -F "node-fastify" handler-templates.txt >/dev/null
grep -F "IMPORTANT: your app handler owns the final business write." handler-templates.txt >/dev/null
npx synapsor-runner handler template node-fastify --output ./synapsor-writeback-handler.mjs >/dev/null
grep -F "app-owned transaction" ./synapsor-writeback-handler.mjs >/dev/null
grep -F "IMPORTANT: your app handler owns the final business write." ./synapsor-writeback-handler.mjs >/dev/null
npx synapsor-runner handler template command --stdout > command-handler.mjs
grep -F "idempotency" command-handler.mjs >/dev/null
grep -F "duplicate writes" command-handler.mjs >/dev/null
npx synapsor-runner activity search --help >/dev/null
npx synapsor-runner evidence --help >/dev/null
npx synapsor-runner query-audit --help >/dev/null
npx synapsor-runner receipts --help >/dev/null
npx synapsor-runner replay --help >/dev/null
npx synapsor-runner store --help >/dev/null
npx synapsor-runner --help >/dev/null
npx synapsor-runner store stats --store ./.synapsor/try/ledger.db >/dev/null
npx synapsor-runner store prune --store ./.synapsor/try/ledger.db --older-than 0d --dry-run >/dev/null
npx synapsor-runner store reset --store ./.synapsor/try/ledger.db --yes >/dev/null

echo "packed runner verified in $TEMP_DIR"
