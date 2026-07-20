import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { startLocalUiServer } from "./local-ui.js";

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
      expect(html).toContain("csrf-token");
      expect(html).not.toContain("ui-token");
      expect(html).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_secret|should_not_leak/i);

      const reusedBootstrap = await fetch(`${baseUrl}/?token=ui-token`, { redirect: "manual" });
      expect(reusedBootstrap.status).toBe(401);

      const headers = { "x-synapsor-ui-token": "ui-token" };
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
