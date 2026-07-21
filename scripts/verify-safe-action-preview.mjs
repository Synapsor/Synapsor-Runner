import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { startLocalUiServer } from "../apps/runner/dist/local-ui.js";
import { compileSafeActionDraft } from "../apps/runner/dist/safe-action.js";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-safe-action-live-"));
const configPath = path.join(tempDir, "synapsor.runner.json");
const contractPath = path.join(tempDir, "synapsor.contract.json");
const sourcePath = path.join(tempDir, "synapsor", "actions", "billing.propose_safe_waiver.ts");
const storePath = path.join(tempDir, ".synapsor", "local.db");
const execFileAsync = promisify(execFile);
let server;

try {
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.copyFile(path.join(root, "packages/spec/examples/guarded-writeback.contract.json"), contractPath);
  await fs.writeFile(configPath, `${JSON.stringify({
    version: 1,
    mode: "review",
    storage: { sqlite_path: "./.synapsor/local.db" },
    contracts: ["./synapsor.contract.json"],
    sources: {
      local_postgres: {
        engine: "postgres",
        read_url_env: "SYNAPSOR_DATABASE_READ_URL",
        write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
        receipts: { authority: "source_db", provisioning: "precreated" },
      },
    },
  }, null, 2)}\n`);
  await fs.writeFile(sourcePath, `import { defineCapability } from "@synapsor/runner/authoring";

export default defineCapability({
  name: "billing.propose_safe_waiver",
  description: "Propose one exact late-fee waiver for human review.",
  kind: "proposal",
  context: "local_operator",
  source: "local_postgres",
  subject: { resource: "billing_invoices" },
  args: {
    invoice_id: { type: "string", required: true, max_length: 128 },
    waiver_reason: { type: "string", required: true, max_length: 500 },
  },
  lookup: { id_from_arg: "invoice_id" },
  visible_fields: ["id", "tenant_id", "customer_name", "status", "late_fee_cents", "waiver_reason", "updated_at"],
  kept_out_fields: ["internal_risk_score", "card_token"],
  evidence: { required: true, query_audit: true },
  max_rows: 1,
  proposal: {
    action: "billing.safe_waiver",
    operation: { kind: "update", cardinality: "single" },
    allowed_fields: ["late_fee_cents", "waiver_reason"],
    patch: { late_fee_cents: { fixed: 0 }, waiver_reason: { from_arg: "waiver_reason" } },
    conflict_guard: { column: "updated_at" },
    approval: { mode: "human", required_role: "billing_lead" },
    writeback: { mode: "direct_sql" },
  },
});
`);

  const originalTools = loadRuntimeConfigFromFile(configPath).capabilities?.map((item) => item.name) ?? [];
  assert(!originalTools.includes("billing.propose_safe_waiver"), "action was active before draft compilation");
  const draft = (await compileSafeActionDraft({ projectRoot: tempDir, sourcePath })).manifest;
  assert.equal(draft.validation.ok, true, "live verifier action did not pass deterministic validation");
  assert.equal(draft.effect_preview, undefined, "draft unexpectedly contained preview evidence");
  assert.deepEqual(loadRuntimeConfigFromFile(configPath).capabilities?.map((item) => item.name) ?? [], originalTools, "draft compilation changed active tools");

  const before = await queryFixtureInvoice();
  assert(before, "fixture invoice INV-3001 is missing");

  server = await startLocalUiServer({
    configPath,
    storePath,
    token: "safe-action-live-token",
    csrfToken: "safe-action-live-csrf",
  });
  const response = await fetch(`http://${server.host}:${server.port}/api/actions/preview`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-synapsor-ui-token": server.token,
      "x-synapsor-csrf": server.csrfToken,
    },
    body: JSON.stringify({ args: { invoice_id: "INV-3001", waiver_reason: "safe action staging preview" } }),
  });
  const preview = await response.json();
  assert.equal(response.status, 200, `Workbench preview failed: ${JSON.stringify(preview)}`);
  assert.equal(preview.ok, true);
  assert.equal(preview.source_database_changed, false);
  assert.match(preview.preview.proposal_id, /^wrp_/);
  assert.match(preview.preview.proposal_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(preview.preview.draft_contract_digest, draft.draft_contract_digest);

  const afterPreview = await queryFixtureInvoice();
  assert.equal(afterPreview, before, "staging proposal preview changed the source row");

  const activationResponse = await fetch(`http://${server.host}:${server.port}/api/actions/activate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-synapsor-ui-token": server.token,
      "x-synapsor-csrf": server.csrfToken,
    },
    body: JSON.stringify({
      expected_digest: draft.draft_contract_digest,
      confirmation: `ACTIVATE ${draft.draft_contract_digest}`,
    }),
  });
  const activation = await activationResponse.json();
  assert.equal(activationResponse.status, 200, `Workbench activation failed: ${JSON.stringify(activation)}`);
  assert.equal(activation.reconnect_required, true);
  assert.equal(activation.tools_list_changed, false);
  assert.equal(activation.active.contract_digest, draft.draft_contract_digest);

  const activatedTools = loadRuntimeConfigFromFile(configPath).capabilities?.map((item) => item.name) ?? [];
  assert(activatedTools.includes("billing.propose_safe_waiver"), "activated action was absent after runtime reload");
  const afterActivation = await queryFixtureInvoice();
  assert.equal(afterActivation, before, "activation changed the source row");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    draft_digest: draft.draft_contract_digest,
    proposal_id: preview.preview.proposal_id,
    source_database_changed: false,
    active_after_explicit_confirmation: true,
    reconnect_required: true,
  }, null, 2)}\n`);
} finally {
  if (server) await server.close();
  await fs.rm(tempDir, { recursive: true, force: true });
}

async function queryFixtureInvoice() {
  const { stdout } = await execFileAsync("docker", [
    "exec",
    "synapsor_runner_mcp_postgres_billing",
    "psql",
    "-U",
    "synapsor_admin",
    "-d",
    "synapsor_runner_mcp_billing",
    "-At",
    "-F",
    "|",
    "-c",
    "SELECT late_fee_cents, COALESCE(waiver_reason, ''), updated_at::text FROM public.invoices WHERE tenant_id = 'acme' AND id = 'INV-3001'",
  ]);
  return stdout.trim();
}
