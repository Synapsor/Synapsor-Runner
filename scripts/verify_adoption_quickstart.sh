#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$ROOT/examples/support-plan-credit"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/synapsor-adoption-quickstart.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

required=(
  "$ROOT/apps/runner/dist/cli.js"
  "$ROOT/packages/spec/dist/cli.js"
  "$ROOT/packages/dsl/dist/cli.js"
  "$EXAMPLE/contract.synapsor"
  "$EXAMPLE/synapsor.contract.json"
  "$EXAMPLE/synapsor.runner.json"
)
for path in "${required[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "Missing required build or example artifact: $path" >&2
    echo "Run: corepack pnpm build" >&2
    exit 1
  fi
done

runner=(node "$ROOT/apps/runner/dist/cli.js")
spec=(node "$ROOT/packages/spec/dist/cli.js")
dsl=(node "$ROOT/packages/dsl/dist/cli.js")

echo "[1/7] Run the no-database quick demo"
(
  cd "$TMP_ROOT"
  "${runner[@]}" demo --quick --no-interactive > quick-demo.txt
)
grep -q "Synapsor quick demo complete" "$TMP_ROOT/quick-demo.txt"
grep -q "source DB changed: no" "$TMP_ROOT/quick-demo.txt"

echo "[2/7] Compile the flagship DSL in strict mode"
"${dsl[@]}" compile "$EXAMPLE/contract.synapsor" \
  --out "$TMP_ROOT/synapsor.contract.json" \
  --strict

echo "[3/7] Validate with the canonical spec and Runner"
"${spec[@]}" validate "$TMP_ROOT/synapsor.contract.json"
"${runner[@]}" contract validate "$TMP_ROOT/synapsor.contract.json"
"${runner[@]}" config validate --config "$EXAMPLE/synapsor.runner.json"

node - "$EXAMPLE/synapsor.contract.json" "$TMP_ROOT/synapsor.contract.json" <<'NODE'
const fs = require("node:fs");
const [expectedPath, actualPath] = process.argv.slice(2);
const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
const actual = JSON.parse(fs.readFileSync(actualPath, "utf8"));
if (JSON.stringify(expected) !== JSON.stringify(actual)) {
  throw new Error("checked-in flagship contract has drifted from contract.synapsor");
}
NODE

echo "[4/7] Preview the model-facing MCP tools"
"${runner[@]}" tools preview \
  --config "$EXAMPLE/synapsor.runner.json" \
  --store "$TMP_ROOT/local.db" > "$TMP_ROOT/tools-preview.txt"
grep -q "support.inspect_customer" "$TMP_ROOT/tools-preview.txt"
grep -q "support.propose_plan_credit" "$TMP_ROOT/tools-preview.txt"
grep -q "PASS execute_sql absent" "$TMP_ROOT/tools-preview.txt"
grep -q "PASS approval tools absent" "$TMP_ROOT/tools-preview.txt"
grep -q "PASS commit tools absent" "$TMP_ROOT/tools-preview.txt"

exposed_tools="$(sed -n '/^Exposed to MCP:/,/^Not exposed to MCP:/p' "$TMP_ROOT/tools-preview.txt")"
if grep -Eiq 'execute_sql|raw_sql|approve|commit|writeback' <<<"$exposed_tools"; then
  echo "Unsafe tool appeared in the MCP-exposed section:" >&2
  printf '%s\n' "$exposed_tools" >&2
  exit 1
fi

echo "[5/7] Prove kept-out fields remain in the reviewed boundary"
node - "$TMP_ROOT/synapsor.contract.json" <<'NODE'
const fs = require("node:fs");
const contract = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const proposal = contract.capabilities.find((item) => item.name === "support.propose_plan_credit");
for (const field of ["card_token", "raw_payment_method", "internal_risk_score", "private_notes"]) {
  if (!proposal?.kept_out_fields?.includes(field)) throw new Error(`missing kept-out field: ${field}`);
  if (proposal?.visible_fields?.includes(field)) throw new Error(`kept-out field is visible: ${field}`);
}
NODE

echo "[6/7] Preview the exact network-free Cloud payload"
"${runner[@]}" cloud push "$TMP_ROOT/synapsor.contract.json" \
  --dry-run \
  --workspace adoption_quickstart \
  --name support-plan-credit \
  --json > "$TMP_ROOT/cloud-push.json"
node - "$TMP_ROOT/cloud-push.json" <<'NODE'
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (result.ok !== true || result.dry_run !== true) throw new Error("Cloud push was not a successful dry run");
if (result.payload?.name !== "support-plan-credit") throw new Error("unexpected Cloud registry name");
if (result.payload?.contract?.kind !== "SynapsorContract") throw new Error("unexpected Cloud contract payload");
if (result.payload?.summary?.proposal_capabilities !== 1) throw new Error("proposal summary drifted");
NODE

echo "[7/7] Verify MCP client JSON templates"
node "$ROOT/scripts/verify-mcp-client-configs.mjs"

echo "Synapsor adoption quickstart verification passed."
