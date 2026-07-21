import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { startLocalUiServer } from "./local-ui.js";
import { compileSafeActionDraft } from "./safe-action.js";

const changeSet = {
  schema_version: "synapsor.change-set.v2",
  proposal_id: "wrp_ui",
  proposal_version: 1,
  action: "billing.waive_late_fee",
  operation: "single_row_update",
  mode: "review_required",
  principal: { id: "support_agent_17", source: "trusted_session" },
  scope: { tenant_id: "acme", business_object: "invoice", object_id: "INV-UI" },
  source: {
    kind: "external_postgres",
    source_id: "src_pg_acme",
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-UI" },
  },
  before: {
    late_fee_cents: 5500,
    waiver_reason: null,
    updated_at: "2026-06-20T14:31:08Z",
  },
  patch: { late_fee_cents: 0, waiver_reason: "customer requested review" },
  after: {
    late_fee_cents: 0,
    waiver_reason: "customer requested review",
    updated_at: "2026-06-20T14:31:08Z",
  },
  guards: {
    tenant: { column: "tenant_id", value: "acme" },
    allowed_columns: ["late_fee_cents", "waiver_reason"],
    expected_version: { column: "updated_at", value: "2026-06-20T14:31:08Z" },
    version_advance: { column: "updated_at", strategy: "database_generated" },
  },
  reversibility: {
    mode: "reviewed_inverse",
    lineage: {
      root_proposal_id: "wrp_ui",
      parent_proposal_id: "wrp_ui",
      reverts_proposal_id: "wrp_ui",
      depth: 1,
    },
  },
  evidence: {
    bundle_id: "ev_ui",
    query_fingerprint: `sha256:${"e".repeat(64)}`,
    items: [{ type: "row", handle: "row://invoices/INV-UI" }],
  },
  approval: { status: "pending", required_role: "support_lead" },
  writeback: { status: "not_applied", mode: "trusted_worker_required" },
  source_database_mutated: false,
  integrity: { proposal_hash: `sha256:${"a".repeat(64)}` },
  created_at: "2026-06-20T14:31:09Z",
};

describe("local UI", () => {
  it("serves a token-protected local approval UI without exposing secrets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        app_postgres: {
          engine: "postgres",
          read_url_env: "SYNAPSOR_DATABASE_READ_URL",
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
          statement_timeout_ms: 3000,
        },
      },
      trusted_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_TENANT_ID",
          principal_env: "SYNAPSOR_PRINCIPAL",
        },
      },
      capabilities: [
        {
          name: "billing.inspect_invoice",
          kind: "read",
          source: "app_postgres",
          target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
          args: { invoice_id: { type: "string", required: true, max_length: 128 } },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
          evidence: "required",
          max_rows: 1,
        },
        {
          name: "billing.propose_invoice_update",
          kind: "proposal",
          source: "app_postgres",
          target: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" },
          args: {
            invoice_id: { type: "string", required: true, max_length: 128 },
            reason: { type: "string", required: true, max_length: 500 },
          },
          lookup: { id_from_arg: "invoice_id" },
          visible_columns: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
          evidence: "required",
          max_rows: 1,
          patch: { late_fee_cents: { fixed: 0 }, waiver_reason: { from_arg: "reason" } },
          allowed_columns: ["late_fee_cents", "waiver_reason"],
          conflict_guard: { column: "updated_at" },
          operation: "update",
          version_advance: { column: "updated_at", strategy: "database_generated" },
          reversibility: { mode: "reviewed_inverse" },
          approval: { mode: "human", required_role: "support_lead" },
        },
      ],
    }, null, 2), "utf8");
    await fs.mkdir(path.join(tempDir, ".synapsor"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".synapsor/onboarding.json"), `${JSON.stringify({
      schema_version: "synapsor.onboarding.v1",
      status: "review_active",
      project: { package_manager: "pnpm", frameworks: ["node"], schema_inputs: [], database_env_names: ["SYNAPSOR_DATABASE_READ_URL"] },
      source: { engine: "postgres", database_url_env: "SYNAPSOR_DATABASE_READ_URL", schema: "public", table: "invoices" },
      trust_scope: { tenant_key: "tenant_id", single_tenant_dev: false, tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
      action: {
        read_capability: "billing.inspect_invoice",
        proposal_capability: "billing.propose_invoice_update",
        visible_fields: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
        kept_out_fields: ["card_token", "internal_risk_score"],
        writeback: "direct_sql",
      },
      safety: { developer_confirmed_activation: true, source_changed_during_onboarding: false },
    }, null, 2)}\n`, "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.db.prepare(`
      INSERT OR REPLACE INTO evidence_bundles (
        evidence_bundle_id,
        proposal_id,
        tenant_id,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "ev_ui",
      "wrp_ui",
      "acme",
      JSON.stringify({
        purpose: "local UI legacy redaction test",
        bearer: "Bearer should_not_leak",
        database_url: "postgresql://reader:reader_secret@localhost:5432/app",
      }),
      "2026-06-20T14:31:10Z",
    );
    store.createShadowStudy({
      study_id: "sst_ui",
      name: "UI shadow study",
      selected_capabilities: ["billing.waive_late_fee"],
    });
    const shadowCase = store.recordShadowCase({
      study_id: "sst_ui",
      request_id: "req-ui-shadow",
      tenant_id: "acme",
      principal: "support_agent_17",
      capability: "billing.waive_late_fee",
      business_object: "invoice",
      object_id: "INV-SHADOW-UI",
      proposed_effect: {
        before: { late_fee_cents: 5500 },
        after: { late_fee_cents: 0 },
        patch: { late_fee_cents: 0 },
      },
      agent_result: "proposed",
      risk_score: 15,
      created_at: "2026-06-20T14:31:11Z",
    });
    store.recordShadowOutcome({
      study_id: "sst_ui",
      request_id: shadowCase.request_id,
      tenant_id: "acme",
      business_object: "invoice",
      object_id: "INV-SHADOW-UI",
      actor: "support_lead_1",
      disposition: "applied",
      actual_effect: shadowCase.proposed_effect,
      occurred_at: "2026-06-20T14:32:00Z",
      source: "support_audit",
    });
    store.close();

    const server = await startLocalUiServer({
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    try {
      const unauthorized = await fetch(`${baseUrl}/api/summary`);
      expect(unauthorized.status).toBe(401);

      const bootstrap = await fetch(`${baseUrl}/?token=ui-token&tour=1`, { redirect: "manual" });
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.get("location")).toBe("/?tour=1");
      expect(bootstrap.headers.get("referrer-policy")).toBe("no-referrer");
      const setCookie = bootstrap.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("synapsor_ui_token=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      const cookie = setCookie.split(";")[0]!;
      const landing = await fetch(`${baseUrl}/?tour=1`, { headers: { cookie } });
      expect(landing.status).toBe(200);
      expect(landing.url).not.toContain("token=");
      expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await landing.text();
      expect(html).toContain("Synapsor Runner Local UI");
      expect(html).toContain("Commit-safe MCP in one loop");
      expect(html).toContain("First safe action");
      expect(html).toContain("Add the action to Cursor");
      expect(html).toContain("Copy Cursor prompt");
      expect(html).toContain("Open in Cursor");
      expect(html).toContain("Waiting for Cursor to create the first exact proposal");
      expect(html).toContain("window.setInterval");
      expect(html).toContain("Data PR");
      expect(html).toContain("Agent requested a change");
      expect(html).toContain("Source database changed:");
      expect(html).toContain("Approval boundary");
      expect(html).toContain("Replay saved what happened");
      expect(html).toContain("Reviewed compensation");
      expect(html).toContain("Apply guarded writeback from a trusted terminal");
      expect(html).toContain("Copy guarded apply command");
      expect(html).toContain("synapsor-runner apply ");
      expect(html).toContain("View raw JSON");
      expect(html).toContain("Shadow studies");
      expect(html).toContain("@media (max-width: 600px)");
      expect(html).toContain(".data-pr-head .kv, .step .kv { grid-template-columns:1fr");
      expect(html).toContain(".grid > * { min-width:0; }");
      expect(html).toContain('actor.setAttribute("aria-label", "Reviewer identity")');
      expect(html).toContain('reason.setAttribute("aria-label", "Reason for approval or rejection")');
      expect(html).toContain("csrf-token");
      expect(html).not.toContain("ui-token");
      expect(html).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_secret|should_not_leak/i);

      const reusedBootstrap = await fetch(`${baseUrl}/?token=ui-token`, { redirect: "manual" });
      expect(reusedBootstrap.status).toBe(401);

      const headers = { "x-synapsor-ui-token": "ui-token" };
      const workbench = await getJson(`${baseUrl}/api/workbench`, headers);
      expect(workbench.stages.map((stage: { name: string }) => stage.name)).toEqual([
        "Project", "Data source", "Trust scope", "Action", "Agent", "Test", "Review",
      ]);
      expect(workbench.stages.find((stage: { name: string }) => stage.name === "Test")).toMatchObject({
        status: "blocked",
      });
      expect(workbench.action).toMatchObject({
        proposal_capability: "billing.propose_invoice_update",
        kept_out_fields: ["card_token", "internal_risk_score"],
        activation_confirmed: true,
      });
      expect(workbench.cursor).toMatchObject({
        state: "not_installed",
        connection_status: "not_verified",
        plugin_scope: "workspace",
        proposal_waiting: false,
        tools: ["billing.inspect_invoice", "billing.propose_invoice_update"],
      });
      expect(workbench.cursor.prompt).toContain("Use /synapsor-protect");
      expect(workbench.cursor.prompt).toContain("disabled TypeScript Safe Action");
      expect(workbench.cursor.prompt_deeplink).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/prompt\?text=/);
      expect(JSON.stringify(workbench)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_secret/i);

      const summary = await getJson(`${baseUrl}/api/summary`, headers);
      expect(summary.setup.sources.app_postgres.read_url_env).toBe("SYNAPSOR_DATABASE_READ_URL");
      expect(summary.doctor.no_raw_sql_exposed).toBe(true);
      expect(JSON.stringify(summary)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_secret/i);

      const tools = await getJson(`${baseUrl}/api/tools`, headers);
      expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "billing.inspect_invoice",
        "billing.propose_invoice_update",
      ]);
      expect(tools.tools[1].reversibility).toEqual({ mode: "reviewed_inverse" });
      expect(JSON.stringify(tools)).not.toMatch(/execute_sql|approve_proposal|commit_proposal/i);

      const shadowStudies = await getJson(`${baseUrl}/api/shadow/studies`, headers);
      expect(shadowStudies.studies[0]).toMatchObject({
        study_id: "sst_ui",
        total_tasks_observed: 1,
        authoritative_outcomes: 1,
      });
      const shadowReport = await getJson(`${baseUrl}/api/shadow/report?study=sst_ui`, headers);
      expect(shadowReport.report).toMatchObject({
        total_tasks_observed: 1,
        tasks_with_authoritative_outcomes: 1,
        exact_agreements: 1,
      });
      expect(JSON.stringify(shadowReport)).not.toMatch(/postgres(?:ql)?:\/\/|reader_secret|should_not_leak/i);

      const proposals = await getJson(`${baseUrl}/api/proposals`, headers);
      expect(proposals.proposals[0]).toMatchObject({
        proposal_id: "wrp_ui",
        state: "pending_review",
        source_database_changed: false,
      });

      const detail = await getJson(`${baseUrl}/api/proposals/wrp_ui`, headers);
      expect(detail.proposal.proposal_id).toBe("wrp_ui");
      expect(detail.review_view.message).toContain("cannot approve or commit");
      expect(detail.review_view.guard_checklist).toMatchObject({
        tenant_guard: { column: "tenant_id", value: "acme" },
        primary_key: { column: "id", value: "INV-UI" },
        conflict_version: { column: "updated_at", value: "2026-06-20T14:31:08Z" },
        idempotency_key: "wrp_ui:INV-UI",
        affected_row_count_required: 1,
      });
      expect(detail.review_view.diff).toMatchObject({
        late_fee_cents: { before: 5500, proposed: 0 },
      });
      expect(detail.review_view.writeback.executor).toBe("sql_update");
      expect(detail.review_view.reversibility).toMatchObject({
        status: "requested",
      });
      expect(detail.review_view.reversibility.message).toContain("unambiguous trusted apply receipt");
      expect(detail.data_pr).toMatchObject({
        schema_version: "synapsor.data-pr.v1",
        business_action: "billing.waive_late_fee",
        source_unchanged_before_approval: true,
        evidence_reference: { bundle_id: "ev_ui" },
        operation_identity: {
          proposal_id: "wrp_ui",
          proposal_hash: `sha256:${"a".repeat(64)}`,
          proposal_version: 1,
        },
      });
      expect(detail.data_pr.exact_diff.late_fee_cents).toEqual({ before: 5500, proposed: 0 });
      expect(JSON.stringify(detail)).toContain("<redacted>");
      expect(JSON.stringify(detail)).not.toMatch(/postgres(?:ql)?:\/\/|reader_secret|should_not_leak/i);

      const missingCsrf = await fetch(`${baseUrl}/api/proposals/wrp_ui/approve`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ confirm: "approve" }),
      });
      expect(missingCsrf.status).toBe(403);

      const approved = await postJson(`${baseUrl}/api/proposals/wrp_ui/approve`, {
        ...headers,
        "x-synapsor-csrf": "csrf-token",
      }, { confirm: "approve", actor: "support_lead_1", reason: "reviewed in local UI" });
      expect(approved.proposal.state).toBe("approved");

      const replay = await getJson(`${baseUrl}/api/replay/wrp_ui`, headers);
      expect(replay.replay.replay_id).toBe("replay_wrp_ui");
      expect(replay.replay.events.map((event: { kind: string }) => event.kind)).toContain("proposal_approved");
    } finally {
      await server.close();
    }
  }, 15_000);

  it("resolves canonical contract capabilities in the workbench and tools API", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-contract-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const contractPath = path.join(tempDir, "support.contract.json");
    await fs.copyFile(path.resolve(process.cwd(), "packages/spec/examples/support-refund.contract.json"), contractPath);
    await fs.writeFile(configPath, `${JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        support_postgres: {
          engine: "postgres",
          read_url_env: "SUPPORT_POSTGRES_READ_URL",
          write_url_env: "SUPPORT_POSTGRES_WRITE_URL",
        },
      },
      contexts: {
        support_agent_context: {
          provider: "environment",
          values: { tenant_id_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
        },
      },
      contracts: ["./support.contract.json"],
    }, null, 2)}\n`, "utf8");
    const server = await startLocalUiServer({ configPath, storePath: path.join(tempDir, ".synapsor/local.db"), token: "contract-token" });
    try {
      const headers = { "x-synapsor-ui-token": "contract-token" };
      const tools = await getJson(`http://${server.host}:${server.port}/api/tools`, headers);
      expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "support.inspect_order",
        "support.propose_refund_review",
      ]);
      const summary = await getJson(`http://${server.host}:${server.port}/api/summary`, headers);
      expect(summary.setup.capabilities).toHaveLength(2);
      expect(summary.doctor.config_ok).toBe(true);
      const workbench = await getJson(`http://${server.host}:${server.port}/api/workbench`, headers);
      expect(workbench.stages.find((stage: { name: string }) => stage.name === "Test")).toMatchObject({
        status: "ready",
        detail: expect.stringContaining("run the reviewed read tool"),
      });
    } finally {
      await server.close();
    }
  });

  it("keeps Safe Action activation behind CSRF, an exact preview digest, and explicit Workbench confirmation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-safe-action-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const contractPath = path.join(tempDir, "synapsor.contract.json");
    const sourcePath = path.join(tempDir, "synapsor/actions/refund.ts");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.copyFile(path.resolve(process.cwd(), "packages/spec/examples/guarded-writeback.contract.json"), contractPath);
    await fs.writeFile(configPath, `${JSON.stringify({
      version: 1,
      mode: "review",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        local_postgres: { engine: "postgres", read_url_env: "SYNAPSOR_DATABASE_READ_URL", write_url_env: "SYNAPSOR_DATABASE_WRITE_URL" },
      },
      contracts: ["./synapsor.contract.json"],
    }, null, 2)}\n`);
    await fs.writeFile(sourcePath, `import { defineCapability } from "@synapsor/runner/authoring";
export default defineCapability({
  name: "billing.propose_refund_order", description: "Propose one reviewed refund.", kind: "proposal",
  context: "local_operator", source: "local_postgres", subject: { resource: "billing_invoices" },
  args: { invoice_id: { type: "string", required: true, max_length: 128 }, amount_cents: { type: "number", required: true, minimum: 1, maximum: 5000 }, reason: { type: "string", required: true, max_length: 500 } },
  lookup: { id_from_arg: "invoice_id" }, visible_fields: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
  kept_out_fields: ["card_token", "internal_risk_score", "customer_email"], evidence: { required: true, query_audit: true }, max_rows: 1,
  proposal: { action: "refund_order", operation: { kind: "update" }, allowed_fields: ["late_fee_cents", "waiver_reason"],
    patch: { late_fee_cents: { from_arg: "amount_cents" }, waiver_reason: { from_arg: "reason" } }, numeric_bounds: { late_fee_cents: { minimum: 1, maximum: 5000 } },
    conflict_guard: { column: "updated_at" }, approval: { mode: "human", required_role: "billing_lead" }, writeback: { mode: "direct_sql" } },
});
`);
    const draft = (await compileSafeActionDraft({ projectRoot: tempDir, sourcePath })).manifest;
    const server = await startLocalUiServer({
      configPath,
      storePath,
      token: "action-token",
      csrfToken: "action-csrf",
      safeActionPreview: async ({ args }) => {
        expect(args).toEqual({ invoice_id: "INV-1", amount_cents: 2500, reason: "reviewed refund" });
        return {
          draft_digest: draft.draft_contract_digest,
          proposal_id: "wrp_safe_action_preview",
          proposal_hash: `sha256:${"9".repeat(64)}`,
          source_database_changed: false,
        };
      },
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    const headers = { "x-synapsor-ui-token": "action-token" };
    const mutationHeaders = { ...headers, "x-synapsor-csrf": "action-csrf" };
    try {
      const landing = await fetch(`${baseUrl}/`, { headers });
      const html = await landing.text();
      expect(html).toContain("Disabled Safe Action draft");
      expect(html).toContain("Preview exact staging Data PR");
      expect(html).toContain("Activate reviewed immutable artifact");
      expect(html).toContain("Activation is not available through MCP or CLI");

      const workbench = await getJson(`${baseUrl}/api/workbench`, headers);
      expect(workbench.safe_action).toMatchObject({
        draft: {
          state: "disabled_draft",
          draft_contract_digest: draft.draft_contract_digest,
          validation: { ok: true, blocking_lint_issues: 0, static_test_summary: { failed: 0 } },
        },
        draft_matches_active: false,
      });
      expect(workbench.cursor).toMatchObject({
        proposal_waiting: true,
        prompt: expect.stringContaining("billing.propose_refund_order"),
      });
      const noCsrf = await fetch(`${baseUrl}/api/actions/preview`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ args: {} }),
      });
      expect(noCsrf.status).toBe(403);
      const earlyActivation = await fetch(`${baseUrl}/api/actions/activate`, {
        method: "POST",
        headers: { ...mutationHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expected_digest: draft.draft_contract_digest, confirmation: `ACTIVATE ${draft.draft_contract_digest}` }),
      });
      expect(earlyActivation.status).toBe(500);
      expect(await earlyActivation.text()).toContain("SAFE_ACTION_EFFECT_PREVIEW_REQUIRED");

      const preview = await postJson(`${baseUrl}/api/actions/preview`, mutationHeaders, {
        args: { invoice_id: "INV-1", amount_cents: 2500, reason: "reviewed refund" },
      });
      expect(preview).toMatchObject({ ok: true, source_database_changed: false, preview: { proposal_id: "wrp_safe_action_preview" } });
      const wrong = await fetch(`${baseUrl}/api/actions/activate`, {
        method: "POST",
        headers: { ...mutationHeaders, "content-type": "application/json" },
        body: JSON.stringify({ expected_digest: draft.draft_contract_digest, confirmation: "ACTIVATE wrong" }),
      });
      expect(wrong.status).toBe(500);
      expect(await wrong.text()).toContain("SAFE_ACTION_CONFIRMATION_REQUIRED");

      const activated = await postJson(`${baseUrl}/api/actions/activate`, mutationHeaders, {
        expected_digest: draft.draft_contract_digest,
        confirmation: `ACTIVATE ${draft.draft_contract_digest}`,
      });
      expect(activated).toMatchObject({ ok: true, reconnect_required: true, tools_list_changed: false, active: { contract_digest: draft.draft_contract_digest } });
      expect(JSON.parse(await fs.readFile(configPath, "utf8")).contracts[0]).toMatch(/^\.\/\.synapsor\/active\//);
    } finally {
      await server.close();
    }
  });

  it("refuses non-localhost binding unless explicitly allowed", async () => {
    await expect(startLocalUiServer({
      host: "0.0.0.0",
      token: "ui-token",
      csrfToken: "csrf-token",
    })).rejects.toThrow(/binds to localhost/);
  });

  it("uses the injected shared-store bridge for review reads and writes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-shared-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review" }), "utf8");
    const sharedStore = new ProposalStore();
    sharedStore.createProposal(changeSet);
    const operations: string[] = [];
    const server = await startLocalUiServer({
      configPath,
      storePath: path.join(tempDir, "must-not-be-opened.db"),
      token: "ui-token",
      csrfToken: "csrf-token",
      storeAccess: async (mode, operation, callback) => {
        operations.push(`${mode}:${operation}`);
        return callback(sharedStore);
      },
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = { "x-synapsor-ui-token": "ui-token" };
      const proposals = await getJson(`${baseUrl}/api/proposals`, headers);
      expect(proposals.proposals).toHaveLength(1);
      const approved = await postJson(`${baseUrl}/api/proposals/wrp_ui/approve`, {
        ...headers,
        "x-synapsor-csrf": "csrf-token",
      }, { confirm: "approve", actor: "shared_reviewer" });
      expect(approved.proposal.state).toBe("approved");
      expect(sharedStore.getProposal("wrp_ui")?.state).toBe("approved");
      expect(operations).toEqual(["read:proposals-list", "write:proposal-approve"]);
      await expect(fs.stat(path.join(tempDir, "must-not-be-opened.db"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      sharedStore.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not let the local UI bypass signed operator identity", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-signed-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      operator_identity: {
        provider: "signed_key",
        operators: {
          alice: { public_key_path: "./alice.pub.pem", roles: ["support_lead"] },
        },
      },
    }), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.close();

    const server = await startLocalUiServer({
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      for (const action of ["approve", "reject"]) {
        const response = await fetch(`${baseUrl}/api/proposals/wrp_ui/${action}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-synapsor-ui-token": "ui-token",
            "x-synapsor-csrf": "csrf-token",
          },
          body: JSON.stringify({ confirm: action, reason: "reviewed" }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          ok: false,
          error: expect.stringContaining("signed operator identity"),
        });
      }
      const persisted = new ProposalStore(storePath);
      try {
        expect(persisted.getProposal("wrp_ui")?.state).toBe("pending_review");
        expect(persisted.approvals("wrp_ui")).toEqual([]);
      } finally {
        persisted.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  return response.json();
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}
