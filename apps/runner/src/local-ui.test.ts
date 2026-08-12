import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ProposalStore,
  attentionDecisionSubject,
  type OperatorIdentityProof,
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, protocolVersions } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundary,
  loadActivatedExplorationBoundaries,
  writeAutoBoundaryArtifacts,
} from "./auto-boundary.js";
import { initializeGuidedProject } from "./guided-project.js";
import {
  createBoundaryReviewProgress,
  saveBoundaryReviewProgress,
  startLocalUiServer,
} from "./local-ui.js";
import { compileSafeActionDraft } from "./safe-action.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";

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

function freshnessChangeSet(proposalId: string) {
  const dependencyUnsigned = {
    id: "account_eligibility",
    capability: "billing.inspect_account_eligibility",
    source_id: "src_pg_acme",
    engine: "postgres" as const,
    target: {
      schema: "public",
      table: "account_eligibility",
      primary_key: { column: "account_id", value: "ACCT-44" },
      tenant_column: "tenant_id",
    },
    expected_version: { column: "updated_at", value: "2026-07-23 09:00:00.000000Z" },
    evidence: {
      bundle_id: `ev_${proposalId}_support`,
      query_fingerprint: canonicalJsonDigest({ proposalId, dependency: "account_eligibility" }),
    },
  };
  const dependency = {
    ...dependencyUnsigned,
    descriptor_digest: canonicalJsonDigest(dependencyUnsigned),
  };
  const authorityUnsigned = {
    schema_version: protocolVersions.freshnessAuthority,
    required: true as const,
    target: { mode: "exact_guard" as const, member_count: 1 },
    dependencies: [dependency],
  };
  return {
    ...structuredClone(changeSet),
    proposal_id: proposalId,
    scope: { ...changeSet.scope, object_id: `${changeSet.scope.object_id}-${proposalId}` },
    integrity: { proposal_hash: canonicalJsonDigest({ proposalId }) },
    freshness: {
      ...authorityUnsigned,
      dependency_set_digest: canonicalJsonDigest(authorityUnsigned),
    },
  };
}

function freshnessEvaluation(
  input: ReturnType<typeof freshnessChangeSet>,
  result: "fresh" | "stale" | "unavailable",
) {
  const checkedAt = "2026-07-23T18:00:00.000Z";
  const safeCode = result === "fresh"
    ? "FRESHNESS_FRESH"
    : result === "stale"
      ? "FRESHNESS_DEPENDENCY_STALE"
      : "FRESHNESS_TEMPORARILY_UNAVAILABLE";
  const checks = [
    { id: "target", kind: "target" as const, status: result === "unavailable" ? "unavailable" as const : "fresh" as const, safe_code: result === "unavailable" ? safeCode : "FRESHNESS_TARGET_FRESH" },
    { id: "account_eligibility", kind: "supporting" as const, status: result, safe_code: result === "fresh" ? "FRESHNESS_DEPENDENCY_FRESH" : safeCode },
  ];
  const unsigned = {
    schema_version: protocolVersions.freshnessProof,
    proposal_id: input.proposal_id,
    proposal_hash: input.integrity.proposal_hash,
    proposal_version: input.proposal_version,
    dependency_set_digest: input.freshness.dependency_set_digest,
    checked_at: checkedAt,
    valid_until: "2099-07-23T18:00:30.000Z",
    source_adapters: [{ source_id: "src_pg_acme", engine: "postgres" as const }],
    result,
    safe_code: safeCode,
    target_count: 1,
    supporting_count: 1,
    checks,
  };
  return {
    required: true as const,
    status: result,
    safe_code: safeCode,
    target_count: 1,
    supporting_count: 1,
    proof: {
      ...unsigned,
      proof_digest: canonicalJsonDigest(unsigned),
    },
  };
}

describe("local UI", () => {
  it("loads an exact disabled protected draft for the shell-to-Workbench handoff", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-protect-handoff-"));
    const capability = "analytics.weekly_revenue";
    const outputRoot = path.join(tempDir, "synapsor/protected/drafts/analytics__weekly_revenue");
    const dslPath = path.join(outputRoot, "capability.synapsor.sql");
    const digest = `sha256:${"a".repeat(64)}`;
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(dslPath, "CREATE AGENT READ analytics.weekly_revenue\nEND\n", "utf8");
    await fs.writeFile(path.join(outputRoot, "draft.json"), JSON.stringify({
      schema_version: "synapsor.protected-query.v1",
      state: "disabled",
      capability,
      source: "app",
      mode: "aggregate",
      boundary_digest: digest,
      generation_lock_fingerprint: digest,
      contract_digest: digest,
      dsl_path: path.relative(tempDir, dslPath),
      contract_path: "synapsor/protected/drafts/analytics__weekly_revenue/synapsor.contract.json",
      tests_path: "synapsor/protected/drafts/analytics__weekly_revenue/contract-tests.json",
      review_path: "synapsor/protected/drafts/analytics__weekly_revenue/REVIEW.md",
      literal_positions: [],
      converted_arguments: [],
    }, null, 2), "utf8");
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath: path.join(tempDir, "synapsor.runner.json"),
      storePath: path.join(tempDir, ".synapsor/local.db"),
      boundaryRoot: path.join(tempDir, "synapsor/generated"),
      token: "protect-handoff-token",
    });
    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/api/protect/draft?capability_name=${encodeURIComponent(capability)}`,
        { headers: { "x-synapsor-ui-token": "protect-handoff-token" } },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        draft: {
          state: "disabled",
          capability,
          contract_digest: digest,
        },
        dsl: expect.stringContaining("CREATE AGENT READ analytics.weekly_revenue"),
        source_database_changed: false,
      });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("activates the exact reviewed protected capability without typed digest ceremony", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-protect-button-"));
    const inspection = boundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.4",
    });
    const boundaryDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: build.exploration_boundary,
      expectedDigest: boundaryDigest,
      actor: "reviewer@example.test",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      currentInspection: inspection,
    });
    const capability = "analytics.weekly_members";
    const outputRoot = path.join(tempDir, "synapsor/protected/drafts/analytics__weekly_members");
    const dslPath = path.join(outputRoot, "capability.synapsor.sql");
    const contractDigest = `sha256:${"b".repeat(64)}` as const;
    const draftPath = path.join(outputRoot, "draft.json");
    const draft = {
      schema_version: "synapsor.protected-query.v1",
      state: "disabled",
      capability,
      source: "app",
      mode: "aggregate",
      boundary_digest: boundaryDigest,
      generation_lock_fingerprint: build.exploration_boundary.generation_lock_fingerprint,
      contract_digest: contractDigest,
      dsl_path: path.relative(tempDir, dslPath),
      contract_path: "synapsor/protected/drafts/analytics__weekly_members/synapsor.contract.json",
      tests_path: "synapsor/protected/drafts/analytics__weekly_members/contract-tests.json",
      review_path: "synapsor/protected/drafts/analytics__weekly_members/REVIEW.md",
      literal_positions: [],
      converted_arguments: [],
    };
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(dslPath, "CREATE AGENT READ analytics.weekly_members\nEND\n", "utf8");
    await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), "utf8");
    let now = Date.parse("2026-08-02T12:00:00.000Z");
    const activate = vi.fn(async () => ({
      schema_version: "synapsor.protected-query.v1" as const,
      state: "active" as const,
      capability,
      contract_digest: contractDigest,
      contract_path: draft.contract_path,
      config_path: guided.config_path,
      actor: "reviewer@example.test",
      activated_at: "2026-08-02T12:00:01.000Z",
      exploration_disabled: false,
    }));
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath: guided.config_path,
      storePath: guided.store_path,
      boundaryRoot: written.root,
      token: "protect-button-token",
      csrfToken: "protect-button-csrf",
      schemaInspector: async () => inspection,
      protectedQueryActivator: activate,
      now: () => now,
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    const headers = { "x-synapsor-ui-token": "protect-button-token" };
    const mutationHeaders = {
      ...headers,
      "x-synapsor-csrf": "protect-button-csrf",
      "content-type": "application/json",
    };
    const activateRequest = (requestedCapability = capability) => fetch(`${baseUrl}/api/protect/activate`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        capability_name: requestedCapability,
        actor: "reviewer@example.test",
      }),
    });
    const preview = () => fetch(
      `${baseUrl}/api/protect/draft?capability_name=${encodeURIComponent(capability)}`,
      { headers },
    );
    try {
      expect((await activateRequest()).status).toBe(409);

      expect((await preview()).status).toBe(200);
      now += 10 * 60 * 1_000 + 1;
      const expired = await activateRequest();
      expect(expired.status).toBe(409);
      await expect(expired.json()).resolves.toMatchObject({ error_code: "PROTECTED_PREVIEW_EXPIRED" });

      now = Date.parse("2026-08-02T12:00:00.000Z");
      expect((await preview()).status).toBe(200);
      const wrongCapability = await activateRequest("analytics.some_other_capability");
      expect(wrongCapability.status).toBe(409);
      await expect(wrongCapability.json()).resolves.toMatchObject({ error_code: "PROTECTED_PREVIEW_REQUIRED" });

      expect((await preview()).status).toBe(200);
      await fs.writeFile(draftPath, JSON.stringify({
        ...draft,
        contract_digest: `sha256:${"c".repeat(64)}`,
      }, null, 2), "utf8");
      const stale = await activateRequest();
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({
        error_code: "PROTECTED_PREVIEW_STALE",
        error: "This capability changed after review. Review the updated capability before activating it.",
      });

      await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), "utf8");
      expect((await preview()).status).toBe(200);
      const activated = await activateRequest();
      expect(activated.status).toBe(200);
      await expect(activated.json()).resolves.toMatchObject({
        ok: true,
        active: { capability, contract_digest: contractDigest },
        reconnect_required: false,
        tools_list_changed: false,
      });
      expect(activate).toHaveBeenCalledOnce();
      expect(activate).toHaveBeenCalledWith(expect.objectContaining({
        capabilityName: capability,
        expectedDigest: contractDigest,
        operatorConfirmed: true,
        actor: "reviewer@example.test",
      }));

      expect((await activateRequest()).status).toBe(409);
      expect(activate).toHaveBeenCalledOnce();
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("serves redacted Explore evidence and operator SQL without persisting trusted values", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-explore-evidence-ui-"));
    const inspection = boundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.6",
    });
    const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: build.exploration_boundary,
      expectedDigest: digest,
      actor: "evidence-reviewer@example.test",
      confirmation: `ACTIVATE ${digest}`,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      currentInspection: inspection,
    });
    const runtime = await createScopedExploreRuntime({
      projectRoot: tempDir,
      transport: "loopback_workbench",
      env: { DATABASE_URL: "postgresql://fixture.invalid/evidence" },
      inspectDatabaseFn: async () => inspection,
      resolveTrustedScopeFn: async () => ({
        tenant: "tenant-secret-value",
        principal: "",
        tenant_source: "postgres_role_setting",
        tenant_binding: "app.tenant_id",
        principal_source: "not_required",
      }),
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => queries.map(() => [{
          dimension_0: "active",
          measure_0: 12,
          __cohort_size: 12,
        }]),
        close: async () => undefined,
      },
    });
    let queryRef: string;
    try {
      const result = await runtime.explore({
        kind: "aggregate",
        resource: "public.members",
        measures: [{ function: "count" }],
        dimensions: [{ field: "membership_status" }],
        top_n: 10,
      });
      const protect = result.protect as { token?: unknown } | undefined;
      if (typeof protect?.token !== "string") throw new Error("Explore result did not provide a Protect reference.");
      queryRef = protect.token;
    } finally {
      await runtime.close();
    }
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath: guided.config_path,
      storePath: guided.store_path,
      boundaryRoot: written.root,
      token: "explore-evidence-token",
      schemaInspector: async () => inspection,
    });
    try {
      const response = await fetch(
        `http://${server.host}:${server.port}/api/explore/evidence?query_ref=${encodeURIComponent(queryRef)}&include_sql=1`,
        { headers: { "x-synapsor-ui-token": "explore-evidence-token" } },
      );
      expect(response.status).toBe(200);
      const evidence = await response.json();
      expect(evidence).toMatchObject({
        ok: true,
        analysis_reference: queryRef,
        original_question: null,
        model_request: { tool: "app.explore_data" },
        runner_execution: {
          boundary_name: build.exploration_boundary.pack.name,
          boundary_digest: digest,
          role_posture: { status: "verified_before_execution" },
          transaction: "single_read_only_transaction",
        },
        runner_returned: {
          rows_or_groups: 1,
          cells: 2,
          source_database_changed: false,
        },
        compiled_statement: {
          engine: "postgres",
          model_received_sql: false,
          persisted: false,
          statements: [{
            statement: expect.stringContaining("$1"),
            parameter_values: "redacted",
          }],
        },
      });
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toContain("tenant-secret-value");
      expect(serialized).not.toContain("postgresql://fixture.invalid");
      expect(serialized).not.toContain("<trusted-tenant>");
      expect(serialized).not.toContain("<trusted-principal>");

      const historyResponse = await fetch(
        `http://${server.host}:${server.port}/api/explore/history`,
        { headers: { "x-synapsor-ui-token": "explore-evidence-token" } },
      );
      expect(historyResponse.status).toBe(200);
      const history = await historyResponse.json();
      expect(history).toMatchObject({
        ok: true,
        ledger_source: {
          kind: "local_sqlite",
          path: path.resolve(guided.store_path),
        },
        recent: [expect.objectContaining({ query_ref: queryRef, resource: "public.members" })],
        durable: [expect.objectContaining({
          resource: "public.members",
          status: "ok",
          returned_rows_or_groups: 1,
          source_query_executed: true,
        })],
        persisted: {
          model_conversation: false,
          result_values: false,
          trusted_scope_values: false,
          raw_sql: false,
        },
      });
      const historyText = JSON.stringify(history);
      expect(historyText).not.toContain("tenant-secret-value");
      expect(historyText).not.toContain("postgresql://fixture.invalid");
      const auditId = history.durable[0].audit_id;
      const auditResponse = await fetch(
        `http://${server.host}:${server.port}/api/explore/history?audit_id=${auditId}`,
        { headers: { "x-synapsor-ui-token": "explore-evidence-token" } },
      );
      expect(auditResponse.status).toBe(200);
      const audit = await auditResponse.json();
      expect(audit).toMatchObject({
        ok: true,
        audit: {
          audit_id: auditId,
          resource: "public.members",
          status: "ok",
          result_values_persisted: false,
          trusted_scope_values_persisted: false,
          raw_sql_included: false,
          source_database_changed: false,
        },
      });
      expect(JSON.stringify(audit)).not.toContain("tenant-secret-value");

      const evidenceId = history.durable[0].evidence_bundle_id;
      const durableEvidenceResponse = await fetch(
        `http://${server.host}:${server.port}/api/explore/evidence?evidence_id=${encodeURIComponent(evidenceId)}`,
        { headers: { "x-synapsor-ui-token": "explore-evidence-token" } },
      );
      expect(durableEvidenceResponse.status).toBe(200);
      const durableEvidence = await durableEvidenceResponse.json();
      expect(durableEvidence).toMatchObject({
        ok: true,
        ledger_source: { kind: "local_sqlite", path: path.resolve(guided.store_path) },
        evidence: {
          evidence_bundle_id: evidenceId,
          source_table: "public.members",
          result_values_persisted: false,
        },
      });
      expect(JSON.stringify(durableEvidence)).not.toContain("tenant-secret-value");
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

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
      expect(html).toContain("Synapsor Workbench");
      expect(html).not.toMatch(/data[- ]areas?/i);
      expect(html).toContain("Commit-safe MCP in one loop");
      expect(html).toContain("First safe action");
      expect(html).toContain("Connect your agent");
      expect(html).toContain("Cursor, Claude Code, and VS Code");
      expect(html).toContain("Optional Cursor Safe Action helper");
      expect(html).toContain("Copy Cursor prompt");
      expect(html).toContain("Open in Cursor");
      expect(html).toContain("Waiting for a connected MCP client to create the first exact proposal");
      expect(html).toContain("window.setInterval");
      expect(html).toContain("Data PR");
      expect(html).toContain("Agent requested a change");
      expect(html).toContain("Source database changed:");
      expect(html).toContain("Approval boundary");
      expect(html).toContain("Replay saved what happened");
      expect(html).toContain("Reviewed compensation");
      expect(html).toContain("Apply guarded writeback");
      expect(html).toContain("This is a separate trusted-operator decision");
      expect(html).toContain("detailRequestRevision");
      expect(html).toContain("if (requestRevision !== state.detailRequestRevision) return");
      expect(html).toContain("loadDetail(proposalId, result)");
      expect(html).toContain("Ledger timeline");
      expect(html).toContain("synapsor-runner apply ");
      expect(html).toContain("Safe JSON");
      expect(html).toContain("Shadow studies");
      expect(html).toContain("@media (max-width: 600px)");
      expect(html).toContain(".data-pr-head .kv, .step .kv { grid-template-columns:1fr");
      expect(html).toContain(".grid > * { min-width:0; }");
      expect(html).toContain('actor.setAttribute("aria-label", "Reviewer identity")');
      expect(html).toContain('reason.setAttribute("aria-label", "Approval reason")');
      expect(html).toContain("csrf-token");
      expect(html).not.toContain("ui-token");
      expect(html).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|reader_secret|should_not_leak/i);

      const reusedBootstrap = await fetch(`${baseUrl}/?token=ui-token`, { redirect: "manual" });
      expect(reusedBootstrap.status).toBe(401);
      const reopenedBootstrap = await fetch(`${baseUrl}/?token=ui-token`, {
        redirect: "manual",
        headers: { cookie: setCookie.split(";", 1)[0] ?? "" },
      });
      expect(reopenedBootstrap.status).toBe(303);
      expect(reopenedBootstrap.headers.get("location")).toBe("/");
      const protectedBootstrap = await fetch(
        `${baseUrl}/?token=ui-token&view=protect&query_ref=A2&capability=analytics.weekly_orders`,
        {
          redirect: "manual",
          headers: { cookie: setCookie.split(";", 1)[0] ?? "" },
        },
      );
      expect(protectedBootstrap.status).toBe(303);
      expect(protectedBootstrap.headers.get("location")).toBe(
        "/#protect?query_ref=A2&capability=analytics.weekly_orders",
      );
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
      expect(detail.evidence.bundles[0]).not.toHaveProperty("payload");
      expect(detail.evidence.bundles[0]).not.toHaveProperty("items");
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

	      const recoveryUrl = server.reissueBootstrapUrl();
	      expect(recoveryUrl).not.toContain("token=ui-token");
	      const oldHeaderAfterRotation = await fetch(`${baseUrl}/api/summary`, { headers });
	      expect(oldHeaderAfterRotation.status).toBe(401);
	      await expect(oldHeaderAfterRotation.json()).resolves.toMatchObject({
	        error_code: "WORKBENCH_SESSION_INVALID",
	      });
	      const oldCookieAfterRotation = await fetch(`${baseUrl}/api/summary`, {
	        headers: { cookie },
	      });
	      expect(oldCookieAfterRotation.status).toBe(401);
	      const recoveredBootstrap = await fetch(recoveryUrl, { redirect: "manual" });
	      expect(recoveredBootstrap.status).toBe(303);
	      expect(recoveredBootstrap.headers.get("location")).toBe("/");
	      expect(recoveredBootstrap.headers.get("set-cookie")).toContain("HttpOnly");
	      const reusedRecovery = await fetch(recoveryUrl, { redirect: "manual" });
	      expect(reusedRecovery.status).toBe(401);
    } finally {
      await server.close();
    }
  }, 15_000);

  it("renews active Workbench sessions beyond fifteen minutes and reports idle expiry", async () => {
    let nowMs = Date.parse("2026-07-27T10:00:00Z");
    const server = await startLocalUiServer({
      token: "session-idle-token",
      csrfToken: "session-idle-csrf",
      now: () => nowMs,
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    try {
      const bootstrap = await fetch(`${baseUrl}/?token=session-idle-token`, { redirect: "manual" });
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(bootstrap.headers.get("set-cookie")).toContain("Max-Age=28800");

      nowMs += 16 * 60 * 1_000;
      const activeAfterOldLimit = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
      expect(activeAfterOldLimit.status).toBe(200);
      await expect(activeAfterOldLimit.json()).resolves.toMatchObject({
        ok: true,
        status: "active",
        idle_timeout_seconds: 7_200,
        absolute_timeout_seconds: 28_800,
      });

      nowMs += (2 * 60 * 60 * 1_000) - 1;
      expect((await fetch(`${baseUrl}/api/session`, { headers: { cookie } })).status).toBe(200);

      nowMs += 2 * 60 * 60 * 1_000;
      const expired = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
      expect(expired.status).toBe(401);
      await expect(expired.json()).resolves.toMatchObject({
        ok: false,
        error_code: "WORKBENCH_SESSION_EXPIRED",
        saved_review_progress_preserved: true,
        authority_changed: false,
        source_database_changed: false,
        recovery_action: expect.stringContaining("type `r`"),
      });
    } finally {
      await server.close();
    }
  });

  it("enforces the Workbench absolute lifetime despite active requests and rotates recovery credentials", async () => {
    const issuedAt = Date.parse("2026-07-27T10:00:00Z");
    let nowMs = issuedAt;
    const server = await startLocalUiServer({
      token: "session-hard-token",
      csrfToken: "session-hard-csrf",
      now: () => nowMs,
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    try {
      const bootstrap = await fetch(`${baseUrl}/?token=session-hard-token`, { redirect: "manual" });
      const oldCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      for (let hour = 1; hour < 8; hour += 1) {
        nowMs = issuedAt + hour * 60 * 60 * 1_000;
        expect((await fetch(`${baseUrl}/api/session`, { headers: { cookie: oldCookie } })).status).toBe(200);
      }
      nowMs = issuedAt + 8 * 60 * 60 * 1_000;
      const expired = await fetch(`${baseUrl}/api/session`, { headers: { cookie: oldCookie } });
      expect(expired.status).toBe(401);
      await expect(expired.json()).resolves.toMatchObject({
        error_code: "WORKBENCH_SESSION_EXPIRED",
      });

      const recoveryUrl = server.reissueBootstrapUrl();
      const oldSession = await fetch(`${baseUrl}/api/session`, { headers: { cookie: oldCookie } });
      expect(oldSession.status).toBe(401);
      await expect(oldSession.json()).resolves.toMatchObject({
        error_code: "WORKBENCH_SESSION_INVALID",
      });
      const recovered = await fetch(recoveryUrl, { redirect: "manual" });
      expect(recovered.status).toBe(303);
      const newCookie = recovered.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(newCookie).not.toBe(oldCookie);
      expect((await fetch(`${baseUrl}/api/session`, { headers: { cookie: newCookie } })).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("resolves canonical contract capabilities in the workbench and tools API", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-contract-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const contractPath = path.join(tempDir, "support.contract.json");
    const contract = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "packages/spec/examples/support-refund.contract.json"), "utf8"));
    contract.contexts[0].bindings = [
      { name: "tenant_id", source: "environment", key: "SYNAPSOR_TENANT_ID", required: true },
      { name: "principal", source: "environment", key: "SYNAPSOR_PRINCIPAL", required: true },
    ];
    await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
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
      expect(html).toContain("Runner binds this button to the exact reviewed artifact");
      expect(html).not.toContain("Safe Action activation confirmation");

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

  it("guides a disabled action through exact proposal preview and digest activation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-guided-action-"));
    const inspection = guidedActionInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm" as const,
        frameworks: ["nextjs", "prisma"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "public.members": {
            tenant_key: {
              value: "organization_id",
              actor: "reviewer@example.test",
              reason: "The application binds each member to the reviewed gym tenant.",
              decided_at: "2026-07-24T17:00:00.000Z",
            },
            principal_key: {
              value: "assigned_trainer_id",
              actor: "reviewer@example.test",
              reason: "Assigned trainers are the reviewed principal boundary.",
              decided_at: "2026-07-24T17:00:00.000Z",
            },
          },
        },
      },
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({ projectRoot: tempDir, build, runnerVersion: "1.6.4" });
    const boundaryDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: build.exploration_boundary,
      expectedDigest: boundaryDigest,
      actor: "reviewer@example.test",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      currentInspection: inspection,
    });
    let previewDigest = "";
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "guided-action-token",
      csrfToken: "guided-action-csrf",
      schemaInspector: async () => inspection,
      guidedActionPreview: async ({ capabilityName, args }) => {
        expect(capabilityName).toBe("membership.set_loyalty_balance");
        expect(args).toEqual({ member_id: "MEM-1", loyalty_balance: 25 });
        return {
          draft_digest: previewDigest as `sha256:${string}`,
          proposal_id: "wrp_guided_action_preview",
          proposal_hash: `sha256:${"8".repeat(64)}`,
          source_database_changed: false,
        };
      },
    });
    const baseUrl = `http://${server.host}:${server.port}`;
    const headers = { "x-synapsor-ui-token": "guided-action-token" };
    const mutationHeaders = { ...headers, "x-synapsor-csrf": "guided-action-csrf" };
    try {
      const options = await getJson(`${baseUrl}/api/actions/guided`, headers);
      expect(options).toMatchObject({
        ok: true,
        source_database_changed: false,
        options: {
          source: "local_postgres",
          resources: [{
            id: "public.members",
            principal_key: "assigned_trainer_id",
            operation_availability: { update: { available: true } },
          }],
        },
      });
      const created = await postJson(`${baseUrl}/api/actions/guided/draft`, mutationHeaders, {
        action: {
          capability_name: "membership.set_loyalty_balance",
          description: "Propose a reviewed loyalty balance for one assigned member.",
          resource: "public.members",
          operation: "update",
          conflict_column: "version",
          version_advance: "integer_increment",
          approval_role: "membership_reviewer",
          patches: [{
            column: "loyalty_balance",
            value_source: "argument",
            argument_name: "loyalty_balance",
            minimum: 0,
            maximum: 500,
          }],
          confirmed_trusted_scope: true,
        },
      });
      expect(created).toMatchObject({
        ok: true,
        source_database_changed: false,
        draft: { state: "disabled", capability: "membership.set_loyalty_balance" },
      });
      previewDigest = created.draft.contract_digest;
      const preview = await postJson(`${baseUrl}/api/actions/guided/preview`, mutationHeaders, {
        capability_name: "membership.set_loyalty_balance",
        args: { member_id: "MEM-1", loyalty_balance: 25 },
      });
      expect(preview).toMatchObject({
        ok: true,
        source_database_changed: false,
        model_can_approve: false,
        model_can_apply: false,
        preview: { proposal_id: "wrp_guided_action_preview" },
      });
      const activated = await postJson(`${baseUrl}/api/actions/guided/activate`, mutationHeaders, {
        capability_name: "membership.set_loyalty_balance",
        expected_digest: previewDigest,
        confirmation: `ACTIVATE ${previewDigest}`,
        actor: "reviewer@example.test",
      });
      expect(activated).toMatchObject({
        ok: true,
        reconnect_required: true,
        source_database_changed: false,
        active: { capability: "membership.set_loyalty_balance" },
      });
      expect(JSON.parse(await fs.readFile(guided.config_path, "utf8"))).toMatchObject({
        mode: "review",
        proposal_freshness: {
          "membership.set_loyalty_balance": {
            approval: "required",
            dependencies: [],
          },
        },
        sources: {
          local_postgres: {
            read_only: false,
            write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
            receipts: { authority: "runner_ledger" },
          },
        },
      });
      const boundaryLanding = await fetch(`${baseUrl}/`, { headers });
      expect(await boundaryLanding.text()).toContain("Add safe action");
      const activityLanding = await fetch(`${baseUrl}/?surface=activity`, { headers });
      const activityHtml = await activityLanding.text();
      expect(activityHtml).toContain("<h2>Activity</h2>");
      expect(activityHtml).toContain("Lifecycle review");
      expect(activityHtml).toContain("proposal.change_set.approval");
      expect(activityHtml).not.toContain("asRecord(proposal.change_set.approval)");
      const eventStore = new ProposalStore(guided.store_path);
      try {
        expect(eventStore.listAttentionEvents({ capability: "membership.set_loyalty_balance" }))
          .toEqual(expect.arrayContaining([
            expect.objectContaining({
              event_type: "capability.review_required",
              attention_required: true,
              immediate_default: false,
            }),
            expect.objectContaining({
              event_type: "capability.activated",
              attention_required: false,
              immediate_default: false,
            }),
          ]));
      } finally {
        eventStore.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses non-localhost binding unless explicitly allowed", async () => {
    await expect(startLocalUiServer({
      host: "0.0.0.0",
      token: "ui-token",
      csrfToken: "csrf-token",
    })).rejects.toThrow(/binds to localhost/);
  });

  it("requires granular Auto Boundary decision evidence before database revalidation", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-boundary-review-"));
    const boundaryRoot = path.join(tempDir, "synapsor/generated");
    await fs.mkdir(boundaryRoot, { recursive: true });
    await fs.writeFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), `${JSON.stringify({
      schema_version: "synapsor.exploration-boundary.v1",
      activation: "disabled_unreviewed",
      unresolved_decisions: ["public.accounts: confirm tenant key tenant_id"],
    })}\n`, "utf8");
    await fs.writeFile(path.join(boundaryRoot, "generation-review.json"), `${JSON.stringify({
      summary: {
        objects: 1,
        draft_reads: 1,
        blocked_objects: 0,
        sensitive_fields_kept_out: 1,
      },
      unresolved_decisions: ["public.accounts: confirm tenant key tenant_id"],
    })}\n`, "utf8");
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot,
      configPath: path.join(tempDir, "synapsor.runner.json"),
      storePath: path.join(tempDir, ".synapsor/local.db"),
      token: "boundary-review-token",
      csrfToken: "boundary-review-csrf",
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const bootstrap = await fetch(`${baseUrl}/?token=boundary-review-token`, { redirect: "manual" });
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const headers = { cookie };
      const landing = await fetch(`${baseUrl}/`, { headers });
      const html = await landing.text();
      expect(html).toContain("data-review-decision");
      expect(html).not.toContain("I reviewed every listed scope");
      expect(html).toContain('id="deployment-profile"');
      expect(html).toContain("Exact database role posture");
      expect(html).toContain("Anything uncertain stays unavailable");
      expect(html).toContain("Make reusable");

      const activation = await fetch(`${baseUrl}/api/boundary/activate`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-synapsor-csrf": "boundary-review-csrf",
        },
        body: JSON.stringify({
          candidate: { activation: "disabled_unreviewed" },
          expected_digest: `sha256:${"a".repeat(64)}`,
          actor: "reviewer@example.test",
          confirmation: `ACTIVATE sha256:${"a".repeat(64)}`,
        }),
      });
      expect(activation.status).toBe(500);
      await expect(activation.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/every reviewed decision/i),
      });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses Workbench activation until legacy boundary policy is isolated", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-policy-migration-"));
    const inspection = boundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.7",
    });
    const current = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate: build.exploration_boundary,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      actor: "legacy-reviewer",
      revision: 1,
    });
    const {
      boundary_id: _boundaryId,
      review_overrides: _reviewOverrides,
      policy_migration: _policyMigration,
      ...legacy
    } = current;
    await fs.writeFile(
      path.join(tempDir, ".synapsor/boundary-review-progress.json"),
      `${JSON.stringify({
        ...legacy,
        schema_version: "synapsor.boundary-review-progress.v2",
      }, null, 2)}\n`,
    );
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "policy-migration-token",
      csrfToken: "policy-migration-csrf",
      schemaInspector: async () => inspection,
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const bootstrap = await fetch(`${baseUrl}/?token=policy-migration-token`, { redirect: "manual" });
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
      const response = await fetch(`${baseUrl}/api/boundary/activate`, {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "x-synapsor-csrf": "policy-migration-csrf",
        },
        body: JSON.stringify({
          candidate: build.exploration_boundary,
          expected_digest: digest,
          actor: "legacy-reviewer",
          confirmation: `ACTIVATE ${digest}`,
          confirmed_decisions: build.exploration_boundary.unresolved_decisions,
        }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error_code: "BOUNDARY_POLICY_MIGRATION_REQUIRED",
        error: expect.stringMatching(/not yet isolated.*Edit and save.*Rescan/s),
        source_database_changed: false,
      });
      await expect(fs.access(path.join(tempDir, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("activates one conservative development resource and drives a real scoped runtime call in the instant path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-instant-"));
    const inspection = boundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.4",
      instantOnboarding: true,
    });
    const plans: unknown[] = [];
    const previousTenant = process.env.SYNAPSOR_TENANT_ID;
    const previousPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    process.env.SYNAPSOR_TENANT_ID = "acme";
    delete process.env.SYNAPSOR_PRINCIPAL;
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "instant-token",
      csrfToken: "instant-csrf",
      instantOnboarding: true,
      schemaInspector: async () => inspection,
      scopedExploreRuntimeFactory: async () => ({
        boundary: {} as never,
        session_fingerprint: `sha256:${"c".repeat(64)}`,
        describe: async () => ({}),
        explore: async (plan: unknown) => {
          plans.push(plan);
          return {
            schema_version: "synapsor.scoped-explore.result.v1",
            columns: ["count"],
            rows: [{ count: 12 }],
            protect: {
              token: "A2",
              expires_at: "2099-01-01T00:00:00.000Z",
            },
          };
        },
        close: async () => undefined,
      }),
    });
    const headers = {
      "x-synapsor-ui-token": "instant-token",
      "x-synapsor-csrf": "instant-csrf",
    };
    try {
      const boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      expect(boundary.instant_onboarding).toMatchObject({
        available: true,
        eligible: true,
        resource: "public.members",
        requires_principal: false,
        missing_bindings: [],
        first_value: {
          resource: "public.members",
          question: expect.any(String),
          operation: expect.any(String),
          plan: {
            kind: "aggregate",
            resource: "public.members",
            measures: [{ function: "count" }],
          },
        },
        candidate: {
          deployment_profile: "development",
          pack: { resources: [{ id: "public.members", relationships: [] }] },
        },
      });

      const profileOverride = await fetch(`http://${server.host}:${server.port}/api/instant/activate-and-read`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ deployment_profile: "production" }),
      });
      expect(profileOverride.status).toBe(400);
      await expect(profileOverride.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/established by synapsor-runner start/i),
        source_database_changed: false,
      });
      await expect(fs.access(path.join(tempDir, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const activated = await postJson(
        `http://${server.host}:${server.port}/api/instant/activate-and-read`,
        headers,
        {},
      );
      expect(activated).toMatchObject({
        ok: true,
        question: boundary.instant_onboarding.first_value.question,
        operation: boundary.instant_onboarding.first_value.operation,
        plan: boundary.instant_onboarding.first_value.plan,
        first_tool: "app.explore_data",
        resource: "public.members",
        source_database_changed: false,
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
        result: { rows: [{ count: 12 }] },
      });
      expect(plans).toEqual([
        expect.objectContaining({
          kind: "aggregate",
          resource: "public.members",
          measures: [{ function: "count" }],
        }),
      ]);
      const active = JSON.parse(await fs.readFile(
        path.join(tempDir, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(active).toMatchObject({
        pack: { resources: [{ id: "public.members", relationships: [] }] },
        activation: {
          mode: "instant_development",
          launch_context: "start_from_env_local_authoring",
          confirmation_gesture: "activate_and_read",
        },
      });
      expect(active.activation).not.toHaveProperty("profile_assertion");
      expect(JSON.stringify(active)).not.toContain("trainer-7");
      expect(JSON.stringify(active)).not.toContain("acme");
      const reviewBaseline = JSON.parse(await fs.readFile(
        path.join(tempDir, ".synapsor/boundary-review-progress.json"),
        "utf8",
      ));
      expect(reviewBaseline).toMatchObject({
        candidate: {
          pack: {
            resources: [{ id: "public.members", relationships: [] }],
          },
        },
      });
      expect(reviewBaseline.confirmed_decisions).toHaveLength(
        reviewBaseline.confirmations.length,
      );
      const followUp = await postJson(
        `http://${server.host}:${server.port}/api/explore/run`,
        headers,
        {
          plan: {
            kind: "aggregate",
            resource: "public.members",
            measures: [{ function: "count" }],
            top_n: 5,
          },
        },
      );
      expect(followUp).toMatchObject({
        ok: true,
        source_database_changed: false,
        protected_artifact_created: false,
        next_action: expect.stringMatching(/^Ask another bounded question/),
        result: {
          protect: {
            token: "<redacted>",
            query_ref: "A2",
          },
        },
      });
      expect(plans).toHaveLength(2);
      await expect(fs.access(path.join(tempDir, "synapsor/protected")))
        .rejects.toMatchObject({ code: "ENOENT" });
	    } finally {
	      await server.close();
	      if (previousTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID;
	      else process.env.SYNAPSOR_TENANT_ID = previousTenant;
	      if (previousPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL;
	      else process.env.SYNAPSOR_PRINCIPAL = previousPrincipal;
	      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("activates the model-first Quick Start boundary without reading source rows", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-model-first-"));
    const inspection = boundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.6",
      instantOnboarding: true,
    });
    const previousTenant = process.env.SYNAPSOR_TENANT_ID;
    const previousPrincipal = process.env.SYNAPSOR_PRINCIPAL;
    delete process.env.SYNAPSOR_TENANT_ID;
    delete process.env.SYNAPSOR_PRINCIPAL;
    let runtimeCreations = 0;
    let proofGatewayCloses = 0;
    let proofSuppressedGroupingReleased = false;
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "model-first-token",
      csrfToken: "model-first-csrf",
      instantOnboarding: true,
      schemaInspector: async () => inspection,
      resolveTrustedScopeFn: async () => ({
        tenant: "tenant-from-database-role",
        principal: "",
        tenant_source: "postgres_role_setting",
        tenant_binding: "app.tenant_id",
        principal_source: "not_required",
      }),
      scopedExploreRuntimeFactory: async () => {
        runtimeCreations += 1;
        throw new Error("Activation-only Quick Start must not create an Explore runtime.");
      },
      askGatewayFactory: async () => ({
        mode: "authoring",
        listTools: async () => [
          { name: "app.describe_data", description: "Describe", input_schema: {} },
          { name: "app.explore_data", description: "Explore", input_schema: {} },
        ],
        callTool: async (_name, args) => {
          const plan = args.plan as Record<string, unknown>;
          if (Array.isArray(plan.dimensions) && plan.dimensions.length > 0) {
            proofSuppressedGroupingReleased = true;
            return {
              ok: true,
              value: {
                ok: true,
                data: [{ membership_status: "discarded", count: 8 }],
                privacy: { suppressed_groups: 1 },
                source_database_changed: false,
              },
            };
          }
          if (proofSuppressedGroupingReleased && plan.kind === "aggregate") {
            return {
              ok: false,
              value: {
                ok: false,
                error_code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
                details: {
                  reason: "complementary_aggregate_release",
                  source_query_executed: true,
                },
                source_database_changed: false,
              },
              error_code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
            };
          }
          const code = Object.hasOwn(args, "sql")
            || Object.hasOwn(plan, "tenant")
            || Object.hasOwn(plan, "principal")
            || Object.hasOwn(plan, "minimum_cohort_size")
            ? "MCP_TOOL_ARGUMENTS_INVALID"
            : plan.relationship
              ? "EXPLORE_RELATIONSHIP_FORBIDDEN"
              : Array.isArray(plan.select) && plan.select.some((field) =>
                field !== "id" && field !== "membership_status")
                ? "EXPLORE_SCOPE_FORBIDDEN"
                : Number(plan.top_n) > 1
                  ? "EXPLORE_PLAN_INVALID"
                  : "UNEXPECTED_SUCCESS";
          return {
            ok: false,
            value: { ok: false, error_code: code, source_database_changed: false },
            error_code: code,
          };
        },
        close: async () => {
          proofGatewayCloses += 1;
        },
      }),
    });
    const headers = {
      "x-synapsor-ui-token": "model-first-token",
      "x-synapsor-csrf": "model-first-csrf",
    };
    try {
      const activated = await postJson(
        `http://${server.host}:${server.port}/api/instant/activate`,
        headers,
        {
          next_surface: "model",
        },
      );
      expect(activated).toMatchObject({
        ok: true,
        next_surface: "model",
        suggested_question: expect.any(String),
        first_tool: "app.explore_data",
        resource: "public.members",
        source_rows_read: false,
        source_database_changed: false,
        tenant_scope_source: "postgres_role_setting",
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
        next_action: expect.stringContaining("model"),
      });
      expect(runtimeCreations).toBe(0);
      expect(activated).not.toHaveProperty("result");
      const active = JSON.parse(await fs.readFile(
        path.join(tempDir, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(active).toMatchObject({
        pack: { resources: [{ id: "public.members", relationships: [] }] },
        activation: {
          mode: "instant_development",
          launch_context: "start_from_env_local_authoring",
          confirmation_gesture: "activate_for_model",
        },
      });
      expect(active.activation).not.toHaveProperty("profile_assertion");
      expect(JSON.stringify(active)).not.toContain("acme");
      const proof = await postJson(
        `http://${server.host}:${server.port}/api/boundary/prove`,
        headers,
        {},
      );
      expect(proof).toMatchObject({
        ok: true,
        proof: {
          passed: true,
          source_rows_returned: 0,
          source_database_changed: false,
          attacks: expect.arrayContaining([
            expect.objectContaining({ id: "raw_sql", passed: true }),
            expect.objectContaining({ id: "kept_out_field", passed: true }),
            expect.objectContaining({ id: "unreviewed_relationship", passed: true }),
            expect.objectContaining({ id: "suppressed_total_subtraction", passed: true }),
          ]),
        },
        model_can_run_proof: false,
        source_database_changed: false,
      });
      expect(proofGatewayCloses).toBe(1);
      await expect(fs.readFile(path.join(tempDir, String(proof.artifact_path)), "utf8"))
        .resolves.toContain("synapsor.boundary-proof.v1");
      const installed = await postJson(
        `http://${server.host}:${server.port}/api/mcp/install`,
        headers,
        { client: "cursor" },
      );
      expect(installed).toMatchObject({
        ok: true,
        client: "cursor",
        client_name: "Cursor",
        destination: ".cursor/mcp.json",
        tools: ["app.describe_data", "app.explore_data"],
        credentials_in_client_config: false,
        model_can_install: false,
        client_command_detected: expect.any(Boolean),
        tool_boundary_verified: true,
        live_client_session_verified: false,
        connection_state: "configured_not_connected",
        transport_lifecycle: "client_started_stdio",
        source_database_changed: false,
      });
      expect(proofGatewayCloses).toBe(2);
      const cursorConfig = await fs.readFile(path.join(tempDir, ".cursor/mcp.json"), "utf8");
      expect(cursorConfig).not.toContain('"app.describe_data"');
      expect(cursorConfig).toContain("--authoring");
      expect(cursorConfig).not.toContain("DATABASE_URL");
      expect(cursorConfig).not.toContain("tenant-from-database-role");
      await fs.mkdir(path.join(tempDir, ".synapsor/protected"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".synapsor/protected/preserved.txt"),
        "protected capability sentinel\n",
        "utf8",
      );
      const disabled = await postJson(
        `http://${server.host}:${server.port}/api/explore/disable`,
        headers,
        {},
      );
      expect(disabled).toMatchObject({
        ok: true,
        disabled: true,
        protected_capabilities_changed: false,
        message: expect.stringMatching(/Scoped Explore is disabled/i),
      });
      await expect(fs.access(path.join(
        tempDir,
        ".synapsor/exploration-boundary.active.json",
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(
        path.join(tempDir, "synapsor/generated/exploration-boundary.draft.json"),
        "utf8",
      )).resolves.toContain(build.exploration_boundary.pack.name);
      await expect(fs.readFile(
        path.join(tempDir, ".synapsor/protected/preserved.txt"),
        "utf8",
      )).resolves.toBe("protected capability sentinel\n");
    } finally {
      await server.close();
      if (previousTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID;
      else process.env.SYNAPSOR_TENANT_ID = previousTenant;
      if (previousPrincipal === undefined) delete process.env.SYNAPSOR_PRINCIPAL;
      else process.env.SYNAPSOR_PRINCIPAL = previousPrincipal;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resumes persisted full review without re-offering or accepting Quick Start", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-instant-resume-"));
    const inspection = boundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.4",
      instantOnboarding: true,
    });
    await saveBoundaryReviewProgress(tempDir, createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate: build.exploration_boundary,
      confirmedDecisions: [],
      actor: "reviewer@example.test",
      revision: 1,
    }));
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "instant-resume-token",
      csrfToken: "instant-resume-csrf",
      instantOnboarding: true,
      schemaInspector: async () => inspection,
    });
    const headers = {
      "x-synapsor-ui-token": "instant-resume-token",
      "x-synapsor-csrf": "instant-resume-csrf",
    };
    try {
      const boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      expect(boundary).toMatchObject({
        review_progress: { revision: 1 },
        instant_onboarding: {
          available: false,
          eligible: false,
        },
      });
      const instant = await fetch(`http://${server.host}:${server.port}/api/instant/activate-and-read`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(instant.status).toBe(409);
      await expect(instant.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/full boundary review has begun/i),
        source_database_changed: false,
      });
      await expect(fs.access(path.join(tempDir, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("renders an all-blocked Auto Boundary as review-required without offering instant data access", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-all-blocked-"));
    const inspection = boundaryReviewInspection();
    inspection.tables[0]!.primary_key = [];
    inspection.tables[0]!.unique_constraints = [];
    inspection.tables[0]!.indexes = [];
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    expect(build.review.resources).toEqual([
      expect.objectContaining({
        id: "public.members",
        status: "blocked_identifier",
      }),
    ]);
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.5",
      instantOnboarding: true,
    });
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "all-blocked-token",
      csrfToken: "all-blocked-csrf",
      instantOnboarding: true,
    });
    const headers = { "x-synapsor-ui-token": "all-blocked-token" };
    try {
      const landing = await fetch(`http://${server.host}:${server.port}/`, { headers });
      expect(landing.status).toBe(200);
      expect(await landing.text()).toContain("Review security exceptions");

      const boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      expect(boundary).toMatchObject({
        ok: true,
        draft: { pack: { resources: [] } },
        candidate: { pack: { resources: [] } },
        review: {
          summary: { objects: 1, draft_reads: 0, blocked_objects: 1 },
          resources: [{
            id: "public.members",
            status: "blocked_identifier",
          }],
        },
        instant_onboarding: {
          eligible: false,
          candidate: null,
          candidate_digest: null,
          resource: null,
        },
      });

      const instant = await fetch(`http://${server.host}:${server.port}/api/instant/activate-and-read`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-synapsor-csrf": "all-blocked-csrf",
        },
        body: JSON.stringify({ tenant: "acme" }),
      });
      expect(instant.status).toBe(409);
      await expect(instant.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/every inspected resource is blocked/i),
      });
      await expect(fs.access(path.join(tempDir, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves blocked record identity and tenant scope through the Workbench route", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-resolve-scope-"));
    const inspection = boundaryReviewInspection();
    const table = inspection.tables[0]!;
    table.row_level_security = false;
    table.row_level_security_policies = [];
    if (!table.role_posture) throw new Error("fixture role posture is required");
    table.role_posture.row_security_effective_for_current_role = false;
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources).toEqual([]);
    expect(build.review.resources[0]).toMatchObject({
      id: "public.members",
      primary_key: { candidates: ["id"] },
      tenant_key: { candidates: ["tenant_id"] },
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.6",
      instantOnboarding: true,
    });
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "resolve-scope-token",
      csrfToken: "resolve-scope-csrf",
      instantOnboarding: true,
      schemaInspector: async () => inspection,
    });
    const headers = {
      "x-synapsor-ui-token": "resolve-scope-token",
      "x-synapsor-csrf": "resolve-scope-csrf",
    };
    try {
      const initial = await getJson(
        `http://${server.host}:${server.port}/api/boundary`,
        headers,
      );
      expect(initial.review.resources[0]).toMatchObject({
        id: "public.members",
        status: expect.stringMatching(/^blocked_/),
        primary_key: { candidates: ["id"] },
        tenant_key: { candidates: ["tenant_id"] },
      });

      const identity = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        headers,
        {
          kind: "row_identity",
          resource_id: "public.members",
          value: "id",
          actor: "local-workbench-reviewer",
          reason: "The database primary key is the reviewed record identity.",
        },
      );
      expect(identity).toMatchObject({
        ok: true,
        source_database_changed: false,
      });

      const scoped = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        headers,
        {
          kind: "tenant_key",
          resource_id: "public.members",
          value: "tenant_id",
          actor: "local-workbench-reviewer",
          reason: "The application fixes tenant_id outside model arguments.",
        },
      );
      expect(scoped).toMatchObject({
        ok: true,
        candidate: {
          pack: {
            resources: [expect.objectContaining({
              id: "public.members",
              primary_key: "id",
              tenant_key: "tenant_id",
            })],
          },
        },
        source_database_changed: false,
      });
      await expect(fs.access(path.join(tempDir, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reviews a mandatory derived tenant path through the Workbench route", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-derived-scope-"));
    const inspection = derivedBoundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const childReview = build.review.resources.find((resource) =>
      resource.id === "public.order_items")!;
    expect(childReview).toMatchObject({
      status: "blocked_scope",
      tenant_key: { candidates: [] },
      derived_tenant_scope: {
        candidates: [{ path_id: "order_items_order_id_fkey" }],
      },
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.7.0",
      instantOnboarding: true,
    });
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "derived-scope-token",
      csrfToken: "derived-scope-csrf",
      instantOnboarding: true,
      schemaInspector: async () => inspection,
    });
    const headers = {
      "x-synapsor-ui-token": "derived-scope-token",
      "x-synapsor-csrf": "derived-scope-csrf",
    };
    try {
      const scoped = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        headers,
        {
          kind: "tenant_scope_path",
          resource_id: "public.order_items",
          value: "order_items_order_id_fkey",
          actor: "local-workbench-reviewer",
          reason: "Every item belongs to the tenant of its required reviewed order.",
        },
      );
      expect(scoped).toMatchObject({ ok: true, source_database_changed: false });
      const scopedChild = scoped.candidate.pack.resources.find((resource: { id: string }) =>
        resource.id === "public.order_items");
      expect(scopedChild).toMatchObject({
        id: "public.order_items",
        tenant_scope: {
          mode: "derived",
          path_id: "order_items_order_id_fkey",
          ancestor_resource: "public.orders",
          ancestor_column: "tenant_id",
        },
      });
      expect(scopedChild.tenant_key).toBeUndefined();
      await expect(fs.access(path.join(tempDir, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the selected disabled boundary while Workbench resolves scope in two steps", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-resolve-saved-scope-"));
    const inspection = boundaryReviewInspection();
    const blocked = structuredClone(inspection.tables[0]!);
    blocked.name = "manual_scope_orders";
    blocked.primary_key = [];
    blocked.columns.push({
      ...structuredClone(blocked.columns[0]!),
      name: "external_id",
      ordinal_position: blocked.columns.length + 1,
    });
    blocked.unique_constraints = [
      { name: "manual_scope_orders_id_key", columns: ["id"] },
      { name: "manual_scope_orders_external_id_key", columns: ["external_id"] },
    ];
    blocked.indexes = blocked.unique_constraints.map((constraint) => ({
      name: constraint.name,
      columns: constraint.columns,
      unique: true,
    }));
    blocked.row_level_security = false;
    blocked.row_level_security_policies = [];
    if (!blocked.role_posture) throw new Error("fixture role posture is required");
    blocked.role_posture.row_security_effective_for_current_role = false;
    inspection.tables.push(blocked);

    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    expect(build.exploration_boundary.pack.resources.map((resource) => resource.id))
      .toEqual(["public.members"]);
    expect(build.review.resources.find((resource) => resource.id === "public.manual_scope_orders"))
      .toMatchObject({
        status: expect.stringMatching(/^blocked_/),
        primary_key: { candidates: ["id", "external_id"] },
        tenant_key: { candidates: ["tenant_id"] },
      });

    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.6",
      instantOnboarding: true,
    });
    const activeDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: build.exploration_boundary,
      expectedDigest: activeDigest,
      actor: "initial-reviewer@example.test",
      confirmation: `ACTIVATE ${activeDigest}`,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      currentInspection: inspection,
    });
    const activePath = path.join(tempDir, ".synapsor/exploration-boundary.active.json");
    const activeBeforeReview = await fs.readFile(activePath, "utf8");

    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "resolve-saved-scope-token",
      csrfToken: "resolve-saved-scope-csrf",
      instantOnboarding: true,
      schemaInspector: async () => inspection,
    });
    const headers = {
      "x-synapsor-ui-token": "resolve-saved-scope-token",
      "x-synapsor-csrf": "resolve-saved-scope-csrf",
    };
    try {
      let boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      boundary.candidate.pack.name = "retail_reviewed";
      await postJson(`http://${server.host}:${server.port}/api/boundary/progress`, headers, {
        candidate: boundary.candidate,
        confirmed_decisions: [],
        expected_revision: boundary.review_progress?.revision ?? 0,
        actor: "local-workbench-reviewer",
      });
      boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      expect(boundary).toMatchObject({
        candidate: { pack: { name: "retail_reviewed" } },
        boundary_library: {
          selected_name: "retail_reviewed",
          entries: expect.arrayContaining([
            expect.objectContaining({ name: "retail_reviewed", selected: true, active: false }),
            expect.objectContaining({ name: "reviewed_staging", active: true }),
          ]),
        },
      });

      const identity = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        headers,
        {
          kind: "row_identity",
          resource_id: "public.manual_scope_orders",
          value: "id",
          actor: "local-workbench-reviewer",
          reason: "The inspected unique key is the application record identity.",
        },
      );
      expect(identity).toMatchObject({
        ok: true,
        candidate: { pack: { name: "retail_reviewed", resources: [
          expect.objectContaining({ id: "public.members" }),
        ] } },
        review_progress: { revision: expect.any(Number) },
        source_database_changed: false,
      });
      expect(identity.candidate.pack.resources).toHaveLength(1);

      boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      expect(boundary).toMatchObject({
        candidate: { pack: { name: "retail_reviewed" } },
        boundary_library: { selected_name: "retail_reviewed" },
      });

      const scoped = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        headers,
        {
          kind: "tenant_key",
          resource_id: "public.manual_scope_orders",
          value: "tenant_id",
          actor: "local-workbench-reviewer",
          reason: "The application fixes tenant_id outside every model argument.",
        },
      );
      expect(scoped).toMatchObject({
        ok: true,
        candidate: {
          pack: {
            name: "retail_reviewed",
            resources: expect.arrayContaining([
              expect.objectContaining({ id: "public.members" }),
              expect.objectContaining({
                id: "public.manual_scope_orders",
                primary_key: "id",
                tenant_key: "tenant_id",
              }),
            ]),
          },
        },
        source_database_changed: false,
      });
      const reloaded = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      expect(reloaded).toMatchObject({
        candidate: {
          pack: {
            name: "retail_reviewed",
            resources: expect.arrayContaining([
              expect.objectContaining({ id: "public.members" }),
              expect.objectContaining({ id: "public.manual_scope_orders" }),
            ]),
          },
        },
        boundary_library: { selected_name: "retail_reviewed" },
      });
      await expect(fs.readFile(activePath, "utf8")).resolves.toBe(activeBeforeReview);
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("persists reviewed field exceptions and regenerates every managed boundary artifact", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-boundary-regenerate-"));
    const inspection = boundaryReviewInspection();
    inspection.tables[0]!.columns.find((field) => field.name === "membership_status")!.enum_values = [
      "active",
      "paused",
      "cancelled",
    ];
    inspection.tables[0]!.columns.push({
      name: "duration_ms",
      data_type: "integer",
      nullable: false,
      generated: false,
      ordinal_position: inspection.tables[0]!.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    inspection.tables[0]!.suggestions.default_visible_columns.push("duration_ms");
    let currentInspection = inspection;
    const project = {
      root: tempDir,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.4",
    });
    const activeDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    const activeBeforeReview = await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: build.exploration_boundary,
      expectedDigest: activeDigest,
      actor: "initial-reviewer@example.test",
      confirmation: `ACTIVATE ${activeDigest}`,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      currentInspection: inspection,
    });
    await fs.rm(path.join(tempDir, ".synapsor/exploration-locks"), {
      recursive: true,
      force: true,
    });
    await fs.mkdir(path.join(tempDir, ".synapsor/active"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".synapsor/active/protected.contract.json"), "{\"protected\":true}\n", "utf8");
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "boundary-regenerate-token",
      csrfToken: "boundary-regenerate-csrf",
      schemaInspector: async () => currentInspection,
    });
    try {
      const response = await fetch(`http://${server.host}:${server.port}/api/boundary/regenerate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-synapsor-ui-token": "boundary-regenerate-token",
          "x-synapsor-csrf": "boundary-regenerate-csrf",
        },
        body: JSON.stringify({
          kind: "field_exposure",
          resource_id: "public.members",
          field: "trainer_comments",
          exposure: "allow_reviewed_use",
          actor: "reviewer@example.test",
          reason: "This fixture stores a reviewed non-sensitive coaching status.",
        }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        active: activeBeforeReview,
        source_database_changed: false,
        journey: {
          status: "boundary_active",
          authority_active: true,
          recommended_next_action: "Review and activate the disabled boundary revision when ready.",
        },
      });
      await expect(fs.readFile(path.join(written.root, "read-capabilities.synapsor.sql"), "utf8"))
        .resolves.toMatch(/ALLOW READ[^\n]*trainer_comments/);
      await expect(fs.readFile(path.join(tempDir, ".synapsor/review-overrides.json"), "utf8"))
        .resolves.toContain("reviewer@example.test");
      await expect(fs.readFile(
        path.join(tempDir, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      )).resolves.toBe(`${JSON.stringify(activeBeforeReview, null, 2)}\n`);

      const mutationHeaders = {
        "x-synapsor-ui-token": "boundary-regenerate-token",
        "x-synapsor-csrf": "boundary-regenerate-csrf",
      };
      const enumReview = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        mutationHeaders,
        {
          kind: "field_enum",
          resource_id: "public.members",
          field: "membership_status",
          values: ["active", "paused"],
          actor: "owner@example.test",
          reason: "Do not expose the internal cancelled lifecycle state to this agent.",
        },
      );
      expect(enumReview).toMatchObject({
        ok: true,
        draft: {
          pack: {
            resources: [{
              id: "public.members",
              field_enums: { membership_status: ["active", "paused"] },
            }],
          },
        },
        semantic_diff: {
          reviewed_enum_changes: [{
            field: "membership_status",
            before: ["active", "paused", "cancelled"],
            after: ["active", "paused"],
          }],
        },
      });
      expect(JSON.parse(
        await fs.readFile(path.join(tempDir, ".synapsor/review-overrides.json"), "utf8"),
      )).toMatchObject({
        resources: {
          "public.members": {
            field_enums: {
              membership_status: {
                values: ["active", "paused"],
                actor: "owner@example.test",
              },
            },
          },
        },
      });
      const autoBandReview = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        mutationHeaders,
        {
          kind: "auto_band",
          resource_id: "public.members",
          field: "duration_ms",
          definition: {
            field: "duration_ms",
            methods: ["quantile", "equal_width"],
            min_buckets: 3,
            max_buckets: 8,
            min_bucket_width: 100,
            label_style: "ordinal",
          },
          actor: "owner@example.test",
          reason: "Allow bounded duration groups without model-authored edges.",
        },
      );
      expect(autoBandReview).toMatchObject({
        ok: true,
        draft: {
          pack: {
            resources: [{
              id: "public.members",
              auto_bands: [{
                field: "duration_ms",
                methods: ["quantile", "equal_width"],
                min_buckets: 3,
                max_buckets: 8,
                min_bucket_width: 100,
                label_style: "ordinal",
              }],
            }],
          },
        },
        source_database_changed: false,
      });
      expect(JSON.parse(
        await fs.readFile(path.join(tempDir, ".synapsor/review-overrides.json"), "utf8"),
      )).toMatchObject({
        resources: {
          "public.members": {
            auto_bands: {
              duration_ms: {
                actor: "owner@example.test",
                reason: "Allow bounded duration groups without model-authored edges.",
              },
            },
          },
        },
      });
      const resourceMetadata = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        mutationHeaders,
        {
          kind: "resource_metadata",
          resource_id: "public.members",
          label: "Gym members",
          description: "Reviewed membership records for the current tenant.",
          actor: "owner@example.test",
          reason: "Clarify legacy database naming without changing access.",
        },
      );
      expect(resourceMetadata).toMatchObject({
        ok: true,
        draft: {
          pack: {
            resources: [{
              id: "public.members",
              label: "Gym members",
              description: "Reviewed membership records for the current tenant.",
            }],
          },
        },
        source_database_changed: false,
      });
      const fieldMetadata = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        mutationHeaders,
        {
          kind: "field_metadata",
          resource_id: "public.members",
          field: "membership_status",
          label: "Membership state",
          description: "Reviewed active, paused, or cancelled lifecycle state.",
          actor: "owner@example.test",
          reason: "Give the reviewed categorical field a precise business meaning.",
        },
      );
      expect(fieldMetadata).toMatchObject({
        ok: true,
        draft: {
          pack: {
            resources: [{
              id: "public.members",
              label: "Gym members",
              field_metadata: {
                membership_status: {
                  label: "Membership state",
                  description: "Reviewed active, paused, or cancelled lifecycle state.",
                },
              },
            }],
          },
        },
        source_database_changed: false,
      });
      expect(JSON.parse(
        await fs.readFile(path.join(tempDir, ".synapsor/review-overrides.json"), "utf8"),
      )).toMatchObject({
        resources: {
          "public.members": {
            metadata: {
              label: "Gym members",
              actor: "owner@example.test",
            },
            field_metadata: {
              membership_status: {
                label: "Membership state",
                actor: "owner@example.test",
              },
            },
          },
        },
      });
      const cohort = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        mutationHeaders,
        {
          kind: "minimum_cohort",
          resource_id: "public.members",
          value: 1,
          actor: "owner@example.test",
          reason: "This owner-controlled staging fixture may return groups of one.",
        },
      );
      expect(cohort).toMatchObject({
        ok: true,
        draft: {
          pack: {
            resources: [{
              id: "public.members",
              minimum_cohort_size: 1,
              minimum_cohort_overridden: true,
            }],
          },
        },
        source_database_changed: false,
      });
      expect(JSON.parse(
        await fs.readFile(path.join(tempDir, ".synapsor/review-overrides.json"), "utf8"),
      )).toMatchObject({
        resources: {
          "public.members": {
            field_enums: {
              membership_status: {
                values: ["active", "paused"],
                actor: "owner@example.test",
              },
            },
            minimum_cohort: {
              value: 1,
              actor: "owner@example.test",
            },
          },
        },
      });
      await expect(fs.readFile(
        path.join(tempDir, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      )).resolves.toBe(`${JSON.stringify(activeBeforeReview, null, 2)}\n`);
      const wholeBoundaryCohort = await postJson(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        mutationHeaders,
        {
          kind: "minimum_cohort_all",
          value: 3,
          actor: "owner@example.test",
          reason: "Apply one reviewed staging threshold across every included table.",
        },
      );
      expect(wholeBoundaryCohort).toMatchObject({
        ok: true,
        draft: {
          pack: {
            resources: [{
              id: "public.members",
              minimum_cohort_size: 3,
              minimum_cohort_overridden: true,
            }],
          },
        },
        semantic_diff: [{
          resource_id: "public.members",
          minimum_cohort_before: 1,
          minimum_cohort_after: 3,
        }],
        source_database_changed: false,
      });
      const boundaryResponse = await fetch(`http://${server.host}:${server.port}/api/boundary`, {
        headers: { "x-synapsor-ui-token": "boundary-regenerate-token" },
      });
      expect(boundaryResponse.status).toBe(200);
      await expect(boundaryResponse.json()).resolves.toMatchObject({
        instant_onboarding: { available: false, eligible: false },
      });

      currentInspection = structuredClone(inspection);
      currentInspection.tables[0]!.columns.push({
        name: "member_since",
        data_type: "date",
        nullable: false,
        generated: false,
        ordinal_position: currentInspection.tables[0]!.columns.length + 1,
        suggestions: {
          tenant: false,
          conflict: false,
          sensitive: false,
          immutable: false,
          large_or_binary: false,
        },
      });
      const rescan = await postJson(`http://${server.host}:${server.port}/api/project/rescan`, mutationHeaders, {});
      expect(rescan).toMatchObject({
        ok: true,
        diff: { schema_changed: true, source_database_changed: false },
      });
      const applied = await postJson(`http://${server.host}:${server.port}/api/project/rescan/apply`, mutationHeaders, {
        expected_digest: rescan.preview_digest,
        confirmation: `RESCAN ${rescan.preview_digest}`,
      });
      expect(applied).toMatchObject({
        ok: true,
        active: {
          digest: activeBeforeReview.activation.digest,
          activatedAt: activeBeforeReview.activation.activated_at,
        },
        source_database_changed: false,
      });
      await expect(fs.readFile(
        path.join(tempDir, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      )).resolves.toBe(`${JSON.stringify(activeBeforeReview, null, 2)}\n`);
      const reconciledBoundary = await getJson(
        `http://${server.host}:${server.port}/api/boundary`,
        { "x-synapsor-ui-token": "boundary-regenerate-token" },
      );
      expect(reconciledBoundary).toMatchObject({
        candidate: {
          pack: {
            resources: [{
              id: "public.members",
              kept_out_fields: expect.arrayContaining(["member_since"]),
              auto_bands: [expect.objectContaining({ field: "duration_ms" })],
            }],
          },
        },
        boundary_rescan_report: {
          changed: true,
          totals: {
            invalidated_decisions: 0,
            newly_available_fields: 1,
          },
        },
      });

      const otherCandidate = structuredClone(reconciledBoundary.candidate);
      otherCandidate.pack.name = "other_active";
      const otherDigest = explorationBoundaryCandidateDigest(otherCandidate);
      const otherActive = await activateExplorationBoundary({
        projectRoot: tempDir,
        candidate: otherCandidate,
        reviewDraft: otherCandidate,
        expectedDigest: otherDigest,
        actor: "other-reviewer@example.test",
        confirmation: `ACTIVATE ${otherDigest}`,
        confirmedDecisions: otherCandidate.unresolved_decisions,
        currentInspection,
        activeSetMode: "add",
      });
      expect((await loadActivatedExplorationBoundaries(tempDir)).map((boundary) => boundary.pack.name).sort())
        .toEqual(["other_active", "reviewed_staging"]);

      const reset = await postJson(`http://${server.host}:${server.port}/api/project/start-over`, mutationHeaders, {
        confirmation: "START OVER REVIEW",
      });
      expect(reset).toMatchObject({
        ok: true,
        active: null,
        remaining_active_boundaries: ["other_active"],
        source_database_changed: false,
        preserved: expect.arrayContaining(["local ledger", "protected named capabilities", "source database"]),
      });
      expect(await loadActivatedExplorationBoundary(tempDir, { name: "other_active" }))
        .toEqual(otherActive);
      await expect(loadActivatedExplorationBoundary(tempDir, { name: "reviewed_staging" }))
        .rejects.toThrow("not active");
      expect(JSON.parse(await fs.readFile(path.join(tempDir, ".synapsor/review-overrides.json"), "utf8")))
        .toMatchObject({ resources: {} });
      await expect(fs.readFile(path.join(tempDir, ".synapsor/active/protected.contract.json"), "utf8"))
        .resolves.toContain("\"protected\":true");
      const eventStore = new ProposalStore(guided.store_path);
      try {
        const events = eventStore.listAttentionEvents({ limit: 100 });
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            event_type: "sensitive_override_activated",
            severity: "warning",
            attention_required: true,
            immediate_default: false,
          }),
          expect.objectContaining({
            event_type: "schema.drift_detected",
            severity: "critical",
            attention_required: true,
            immediate_default: true,
          }),
          expect.objectContaining({
            event_type: "capability.review_required",
            immediate_default: false,
          }),
        ]));
        const serializedEvents = JSON.stringify(events);
        expect(serializedEvents).not.toContain("trainer_comments");
        expect(serializedEvents).not.toContain("public.members");
        expect(eventStore.listAttentionItems({ status: "open" }).filter((item) =>
          item.event_type === "schema.drift_detected")).toHaveLength(1);
      } finally {
        eventStore.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates, opens, and deletes named Workbench boundary drafts without changing authority", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-boundary-library-"));
    const inspection = relationshipReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.6",
    });
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "boundary-library-token",
      csrfToken: "boundary-library-csrf",
      schemaInspector: async () => inspection,
    });
    const headers = {
      "x-synapsor-ui-token": "boundary-library-token",
      "x-synapsor-csrf": "boundary-library-csrf",
    };
    try {
      const initial = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
      const originalName = initial.candidate.pack.name as string;
      expect(initial.boundary_library).toMatchObject({
        selected_name: originalName,
        entries: [{ name: originalName, selected: true, active: false }],
      });

      const created = await postJson(
        `http://${server.host}:${server.port}/api/boundary/library/create`,
        headers,
        {
          name: "support_analytics",
          resource_id: "public.teams",
          actor: "reviewer@example.test",
        },
      );
      expect(created).toMatchObject({
        candidate: {
          pack: {
            name: "support_analytics",
            resources: [{ id: "public.teams", relationships: [] }],
          },
        },
        boundary_library: {
          selected_name: "support_analytics",
          entries: expect.arrayContaining([
            expect.objectContaining({ name: originalName, selected: false, active: false }),
            expect.objectContaining({ name: "support_analytics", selected: true, active: false }),
          ]),
        },
        authority_changed: false,
        source_database_changed: false,
      });
      await expect(fs.access(path.join(tempDir, ".synapsor/exploration-boundary.active.json")))
        .rejects.toMatchObject({ code: "ENOENT" });

      const opened = await postJson(
        `http://${server.host}:${server.port}/api/boundary/library/switch`,
        headers,
        { name: originalName },
      );
      expect(opened).toMatchObject({
        candidate: { pack: { name: originalName } },
        boundary_library: { selected_name: originalName },
        authority_changed: false,
      });

      const missingConfirmation = await fetch(
        `http://${server.host}:${server.port}/api/boundary/library/delete`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ name: "support_analytics" }),
        },
      );
      expect(missingConfirmation.status).toBe(409);

      const deleted = await postJson(
        `http://${server.host}:${server.port}/api/boundary/library/delete`,
        headers,
        { name: "support_analytics", confirmation: "DELETE support_analytics" },
      );
      expect(deleted).toMatchObject({
        boundary_library: {
          selected_name: originalName,
          entries: [{ name: originalName, selected: true, active: false }],
        },
        authority_changed: false,
        source_database_changed: false,
      });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("reviews and activates a second Workbench boundary against its own generation lock", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-second-boundary-"));
    const inspection = relationshipReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "public.members": {
            fields: {
              membership_status: {
                exposure: "withhold_from_model",
                actor: "first-reviewer@example.test",
                reason: "Keep membership state out of the first boundary only.",
                decided_at: "2026-08-12T12:00:00.000Z",
              },
            },
          },
        },
      },
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.7.0",
    });
    const firstDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: build.exploration_boundary,
      expectedDigest: firstDigest,
      actor: "first-reviewer@example.test",
      confirmation: `ACTIVATE ${firstDigest}`,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      currentInspection: inspection,
    });
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "second-boundary-token",
      csrfToken: "second-boundary-csrf",
      schemaInspector: async () => inspection,
    });
    const headers = {
      "x-synapsor-ui-token": "second-boundary-token",
      "x-synapsor-csrf": "second-boundary-csrf",
    };
    try {
      const created = await postJson(
        `http://${server.host}:${server.port}/api/boundary/library/create`,
        headers,
        {
          name: "teams_only",
          resource_id: "public.teams",
          actor: "second-reviewer@example.test",
        },
      );
      expect(created.candidate.generation_lock_fingerprint)
        .not.toBe(build.exploration_boundary.generation_lock_fingerprint);
      const staged = await postJson(
        `http://${server.host}:${server.port}/api/boundary/progress`,
        headers,
        {
          candidate: created.candidate,
          confirmed_decisions: created.candidate.unresolved_decisions,
          expected_revision: created.review_progress.revision,
          actor: "second-reviewer@example.test",
        },
      );
      const boundary = await getJson(
        `http://${server.host}:${server.port}/api/boundary`,
        headers,
      );
      const preview = await postJson(
        `http://${server.host}:${server.port}/api/boundary/preview`,
        headers,
        {
          candidate: boundary.candidate,
          expected_revision: staged.revision,
          actor: "second-reviewer@example.test",
          confirmed_decisions: boundary.candidate.unresolved_decisions,
        },
      );
      const activated = await postJson(
        `http://${server.host}:${server.port}/api/boundary/activate`,
        headers,
        {
          candidate: preview.candidate,
          expected_digest: preview.digest,
          actor: "second-reviewer@example.test",
          confirmation: `ACTIVATE ${preview.digest}`,
          confirmed_decisions: preview.candidate.unresolved_decisions,
        },
      );
      expect(activated).toMatchObject({
        active_boundary_added: "teams_only",
        active: {
          pack: {
            name: "teams_only",
            resources: [{ id: "public.teams" }],
          },
        },
        source_database_changed: false,
      });
      const active = await loadActivatedExplorationBoundaries(tempDir);
      expect(active.map((boundary) => boundary.pack.name).sort()).toEqual([
        "reviewed_staging",
        "teams_only",
      ]);
      expect(active.find((boundary) => boundary.pack.name === "reviewed_staging")
        ?.pack.resources.find((resource) => resource.id === "public.members")
        ?.model_withheld_fields).toContain("membership_status");
      expect(active.find((boundary) => boundary.pack.name === "teams_only")
        ?.generation_lock_fingerprint).toBe(created.candidate.generation_lock_fingerprint);
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("stages one catalog-proven missing relationship and preserves unrelated review decisions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-relationship-review-"));
    const inspection = relationshipReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.6.4",
    });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "reviewed_members";
    const member = candidate.pack.resources.find((resource) => resource.id === "public.members")!;
    member.relationships = [];
    const staleProgress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate: build.exploration_boundary,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions.slice(0, 1),
      actor: "pre-activation-reviewer@example.test",
      revision: 1,
    });
    await saveBoundaryReviewProgress(tempDir, staleProgress);
    const activeDigest = explorationBoundaryCandidateDigest(candidate);
    const active = await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate,
      expectedDigest: activeDigest,
      actor: "initial-reviewer@example.test",
      confirmation: `ACTIVATE ${activeDigest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });
    const mirrorSelectedCandidate = structuredClone(candidate);
    mirrorSelectedCandidate.pack.name = "secondary_boundary";
    const mirrorSelectedDigest = explorationBoundaryCandidateDigest(mirrorSelectedCandidate);
    await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: mirrorSelectedCandidate,
      reviewDraft: mirrorSelectedCandidate,
      expectedDigest: mirrorSelectedDigest,
      actor: "secondary-reviewer@example.test",
      confirmation: `ACTIVATE ${mirrorSelectedDigest}`,
      confirmedDecisions: mirrorSelectedCandidate.unresolved_decisions,
      currentInspection: inspection,
      activeSetMode: "add",
    });
    const proof = build.exploration_boundary.pack.resources
      .find((resource) => resource.id === "public.members")!
      .relationships.find((relationship) => relationship.id === "members_team_id_fkey")!
      .proof!;
    const retainedProviderKey = "sk-workbench-retained-after-boundary-activation";
    let providerRequests = 0;
    const askTools = [
      {
        name: "app.describe_data",
        description: "Describe active reviewed boundaries.",
        input_schema: {
          type: "object" as const,
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "app.explore_data",
        description: "Run one reviewed plan in one active boundary.",
        input_schema: {
          type: "object" as const,
          properties: { plan: { type: "object" } },
          required: ["plan"],
          additionalProperties: false,
        },
      },
    ];
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "relationship-review-token",
      csrfToken: "relationship-review-csrf",
      schemaInspector: async () => inspection,
      askGatewayFactory: async () => ({
        mode: "authoring",
        listTools: async () => structuredClone(askTools),
        callTool: async () => ({ ok: true, value: { ok: true, source_database_changed: false } }),
        close: async () => undefined,
      }),
      askProviderDependencies: {
        requestJson: async (request) => {
          providerRequests += 1;
          expect(request.headers.authorization).toBe(`Bearer ${retainedProviderKey}`);
          return {
            status: 200,
            body: {
              choices: [{ message: { role: "assistant", content: "The updated reviewed boundaries are available." } }],
            },
          };
        },
      },
    });
    try {
      const url = `http://${server.host}:${server.port}`;
      const mutationHeaders = {
        "x-synapsor-ui-token": "relationship-review-token",
        "x-synapsor-csrf": "relationship-review-csrf",
      };
      const initialAskStatus = await getJson(`${url}/api/ask/status`, mutationHeaders);
      const configuredAsk = await postJson(`${url}/api/ask/configure`, mutationHeaders, {
        provider: "openai",
        model: "gpt-5-mini",
        api_key: retainedProviderKey,
        authority_digest: initialAskStatus.authority_digest,
        egress_acknowledged: true,
      });
      expect(configuredAsk.configuration).toMatchObject({
        credential_source: "session_paste",
        authority_digest: initialAskStatus.authority_digest,
      });
      expect(JSON.stringify(configuredAsk)).not.toContain(retainedProviderKey);
      const withoutCsrf = await fetch(`${url}/api/boundary/review-relationship`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-synapsor-ui-token": "relationship-review-token",
        },
        body: JSON.stringify({}),
      });
      expect(withoutCsrf.status).toBe(403);

      const staged = await postJson(`${url}/api/boundary/review-relationship`, {
        "x-synapsor-ui-token": "relationship-review-token",
        "x-synapsor-csrf": "relationship-review-csrf",
      }, {
        resource: "public.members",
        relationship: "members_team_id_fkey",
        active_boundary_digest: active.activation.digest,
        actor: "relationship-reviewer@example.test",
        confirmation: `REVIEW RELATIONSHIP ${proof.digest}`,
      });
      expect(staged).toMatchObject({
        ok: true,
        source_database_changed: false,
        relationship_review: {
          resource: "public.members",
          relationship: "members_team_id_fkey",
          target_resource: "public.teams",
          path_depth: 1,
          nullable: false,
          proof: {
            source: "database_catalog",
            digest: proof.digest,
          },
        },
      });
      expect(staged.candidate.pack.resources
        .find((resource: { id: string }) => resource.id === "public.members")
        .relationships).toEqual([
        expect.objectContaining({ id: "members_team_id_fkey" }),
      ]);
      const relationshipDecision =
        "public.members: review relationship members_team_id_fkey cardinality and scope on public.teams";
      expect(staged.confirmed_decisions).toContain(relationshipDecision);
      expect(staged.confirmed_decisions).toEqual(expect.arrayContaining(
        active.activation.reviewed_decisions.map((decision) => decision.decision),
      ));
      expect(staged.candidate_digest).not.toBe(active.activation.digest);
	      expect((await loadActivatedExplorationBoundary(tempDir, {
	        name: active.pack.name,
	      })).activation.digest).toBe(active.activation.digest);

	      const preview = await postJson(`${url}/api/boundary/preview`, {
	        "x-synapsor-ui-token": "relationship-review-token",
	        "x-synapsor-csrf": "relationship-review-csrf",
	      }, {
	        candidate: staged.candidate,
	        expected_revision: staged.revision,
	        actor: "relationship-reviewer@example.test",
	        confirmed_decisions: staged.confirmed_decisions,
	      });
	      const activated = await postJson(`${url}/api/boundary/activate`, {
	        "x-synapsor-ui-token": "relationship-review-token",
	        "x-synapsor-csrf": "relationship-review-csrf",
	      }, {
	        candidate: staged.candidate,
	        expected_digest: preview.digest,
	        actor: "relationship-reviewer@example.test",
	        confirmation: `ACTIVATE ${preview.digest}`,
	        confirmed_decisions: staged.confirmed_decisions,
	      });
      expect(activated.active.pack.resources
        .find((resource: { id: string }) => resource.id === "public.members")
        .relationships).toEqual([
        expect.objectContaining({ id: "members_team_id_fkey" }),
      ]);
      expect(activated).toMatchObject({
        ask_provider_session_retained: true,
        ask_conversation_cleared: true,
        ask_authority_refresh_pending: false,
        ask_configuration: {
          provider: "openai",
          model: "gpt-5-mini",
          credential_source: "session_paste",
        },
      });
      expect(activated.ask_configuration.authority_digest)
        .not.toBe(initialAskStatus.authority_digest);
      expect(JSON.stringify(activated)).not.toContain(retainedProviderKey);

      const updatedAskStatus = await getJson(`${url}/api/ask/status`, mutationHeaders);
      expect(updatedAskStatus.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "app.describe_data",
        "app.explore_data",
      ]);
      expect(updatedAskStatus.boundary_catalog).toMatchObject({
        schema_version: "synapsor.boundary-catalog.v1",
        relationship_count: expect.any(Number),
        boundaries: expect.arrayContaining([expect.objectContaining({
          name: activated.active.pack.name,
          relationships: expect.arrayContaining([expect.objectContaining({
            source_table: "public.members",
            target_table: "public.teams",
            cardinality: "many_to_one",
            proven: true,
          })]),
        })]),
      });
      expect(updatedAskStatus.boundary_mermaid).toContain("flowchart LR");
      expect(updatedAskStatus.boundary_mermaid).toContain("PUBLIC_MEMBERS");
      expect(updatedAskStatus.boundary_mermaid).toContain("PUBLIC_TEAMS");
      expect(updatedAskStatus.boundary_diagrams).toEqual(expect.arrayContaining([
        expect.objectContaining({
          boundary_name: activated.active.pack.name,
          digest: activated.active.activation.digest,
          file_name: expect.stringMatching(/\.boundary-diagram\.md$/),
          large: false,
          mermaid: expect.stringContaining("PUBLIC_MEMBERS"),
          markdown: expect.stringContaining("## Mermaid Relationship Diagram"),
        }),
      ]));

      const askResult = await postJson(`${url}/api/ask/run`, mutationHeaders, {
        question: "What access is reviewed now?",
      });
      expect(askResult).toMatchObject({
        ok: true,
        answer: "The updated reviewed boundaries are available.",
        display_answer: "The updated reviewed boundaries are available.",
      });
      expect(providerRequests).toBe(1);
      expect(activated.source_database_changed).toBe(false);
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps MySQL trusted bindings startable after a Workbench review reset", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-mysql-baseline-"));
    const inspection = boundaryReviewInspection();
    inspection.engine = "mysql";
    inspection.server_version = "MySQL 8.4";
    inspection.schemas = ["clinicdb"];
    const table = inspection.tables[0]!;
    table.schema = "clinicdb";
    table.row_level_security = false;
    table.row_level_security_policies = [];
    table.role_posture = {
      ...table.role_posture!,
      row_security_forced: false,
      row_security_effective_for_current_role: false,
    };
    table.columns.push({
      name: "attending",
      data_type: "varchar",
      nullable: false,
      generated: false,
      ordinal_position: table.columns.length + 1,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    });
    table.suggestions.default_visible_columns.push("attending");
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "clinicdb",
    });
    const stalePolicyBaseline = structuredClone(build.policy_baseline);
    expect(stalePolicyBaseline.boundary.pack.resources).toEqual([]);
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({
      projectRoot: tempDir,
      build,
      runnerVersion: "1.7.0",
    });
    const config = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
    config.trusted_context.principal_binding = "attending";
    config.trusted_context.values.principal_env = "SYNAPSOR_PRINCIPAL";
    await fs.writeFile(guided.config_path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "mysql-boundary-token",
      csrfToken: "mysql-boundary-csrf",
      schemaInspector: async () => inspection,
    });
    const headers = {
      "x-synapsor-ui-token": "mysql-boundary-token",
      "x-synapsor-csrf": "mysql-boundary-csrf",
    };
    try {
      await postJson(`http://${server.host}:${server.port}/api/project/start-over`, headers, {
        confirmation: "START OVER REVIEW",
      });
      const baseline = JSON.parse(await fs.readFile(
        path.join(tempDir, ".synapsor/auto-boundary-policy-baseline.json"),
        "utf8",
      ));
      expect(baseline.boundary.pack.resources).toEqual([
        expect.objectContaining({
          id: "clinicdb.members",
          tenant_key: "tenant_id",
          principal_key: "attending",
        }),
      ]);

      const draftPath = path.join(tempDir, "synapsor/generated/exploration-boundary.draft.json");
      const draftBeforeRepair = await fs.readFile(draftPath, "utf8");
      await fs.writeFile(
        path.join(tempDir, ".synapsor/auto-boundary-policy-baseline.json"),
        `${JSON.stringify(stalePolicyBaseline, null, 2)}\n`,
        "utf8",
      );
      const repairPreview = await postJson(
        `http://${server.host}:${server.port}/api/project/rescan`,
        headers,
        {},
      );
      expect(repairPreview).toMatchObject({
        ok: true,
        diff: {
          changed: false,
          authoring_baseline_refreshed: true,
        },
      });
      const repeatedRepairPreview = await postJson(
        `http://${server.host}:${server.port}/api/project/rescan`,
        headers,
        {},
      );
      const { generated_at: _firstGeneratedAt, ...firstStableDiff } = repairPreview.diff;
      const { generated_at: _repeatedGeneratedAt, ...repeatedStableDiff } = repeatedRepairPreview.diff;
      expect(repeatedStableDiff).toEqual(firstStableDiff);
      expect(repeatedRepairPreview.preview_digest).toBe(repairPreview.preview_digest);
      const repaired = await postJson(
        `http://${server.host}:${server.port}/api/project/rescan/apply`,
        headers,
        {
          expected_digest: repairPreview.preview_digest,
          confirmation: `RESCAN ${repairPreview.preview_digest}`,
        },
      );
      expect(repaired).toMatchObject({
        ok: true,
        diff: {
          changed: false,
          authoring_baseline_refreshed: true,
        },
      });
      expect(repaired.message).toMatch(/repaired for CLI and Workbench.*no boundary review is required/i);
      await expect(fs.readFile(draftPath, "utf8")).resolves.toBe(draftBeforeRepair);
      const repairedBaseline = JSON.parse(await fs.readFile(
        path.join(tempDir, ".synapsor/auto-boundary-policy-baseline.json"),
        "utf8",
      ));
      expect(repairedBaseline.boundary.pack.resources).toEqual([
        expect.objectContaining({
          id: "clinicdb.members",
          tenant_key: "tenant_id",
          principal_key: "attending",
        }),
      ]);

      const created = await postJson(
        `http://${server.host}:${server.port}/api/boundary/library/create`,
        headers,
        {
          name: "mysql_members_secondary",
          resource_id: "clinicdb.members",
          actor: "workbench-reviewer",
        },
      );
      expect(created).toMatchObject({
        candidate: {
          pack: {
            name: "mysql_members_secondary",
            resources: [{
              id: "clinicdb.members",
              tenant_key: "tenant_id",
              principal_key: "attending",
            }],
          },
        },
        authority_changed: false,
        source_database_changed: false,
      });
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["public.members", "assigned_agent", "public.charges", "reviewer_id"],
    ["public.charges", "reviewer_id", "public.members", "assigned_agent"],
  ])(
    "preserves unrelated review confirmations when %s then %s are regenerated",
    async (firstResource, firstPrincipal, secondResource, secondPrincipal) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-review-order-"));
      const inspection = multiResourceBoundaryReviewInspection();
      const project = {
        root: tempDir,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      };
      const build = buildAutoBoundary({
        inspection,
        project,
        sourceEnv: "DATABASE_URL",
        inspectedSchema: "public",
      });
      const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
      const guided = await initializeGuidedProject({
        projectRoot: tempDir,
        build,
        runnerVersion: "1.6.4",
      });
      const server = await startLocalUiServer({
        projectRoot: tempDir,
        boundaryRoot: written.root,
        configPath: guided.config_path,
        storePath: guided.store_path,
        token: "review-order-token",
        csrfToken: "review-order-csrf",
        schemaInspector: async () => inspection,
      });
      const headers = {
        "x-synapsor-ui-token": "review-order-token",
        "x-synapsor-csrf": "review-order-csrf",
      };
      try {
        let boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
        const originalDecisions = boundary.review.unresolved_decisions as string[];
        boundary.candidate.pack.name = "service_analytics";
        boundary.candidate.budgets.max_ranked_groups = 200;
        const saved = await postJson(`http://${server.host}:${server.port}/api/boundary/progress`, headers, {
          candidate: boundary.candidate,
          confirmed_decisions: originalDecisions,
          expected_revision: 0,
          actor: "reviewer@example.test",
        });
        expect(saved.revision).toBe(1);
        boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
        expect(boundary.candidate.pack.name).toBe("service_analytics");
        expect(boundary.candidate.budgets.max_ranked_groups).toBe(200);
        const reviewedResources = structuredClone(boundary.candidate.pack.resources);
        expect(reviewedResources).toHaveLength(2);
        const narrowedCandidate = structuredClone(boundary.candidate);
        narrowedCandidate.pack.resources = [reviewedResources[0]];
        const narrowed = await postJson(`http://${server.host}:${server.port}/api/boundary/progress`, headers, {
          candidate: narrowedCandidate,
          confirmed_decisions: [],
          expected_revision: boundary.review_progress.revision,
          actor: "reviewer@example.test",
        });
        const expandedCandidate = structuredClone(narrowedCandidate);
        expandedCandidate.pack.resources = reviewedResources;
        await postJson(`http://${server.host}:${server.port}/api/boundary/progress`, headers, {
          candidate: expandedCandidate,
          confirmed_decisions: originalDecisions,
          expected_revision: narrowed.revision,
          actor: "reviewer@example.test",
        });
        boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
        expect(boundary.candidate.pack.resources.map((resource: { id: string }) => resource.id).sort())
          .toEqual(reviewedResources.map((resource: { id: string }) => resource.id).sort());
        const staleSave = await fetch(`http://${server.host}:${server.port}/api/boundary/progress`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            candidate: boundary.candidate,
            confirmed_decisions: [],
            expected_revision: 0,
            actor: "stale-reviewer@example.test",
          }),
        });
        expect(staleSave.status).toBe(409);
        await expect(staleSave.json()).resolves.toMatchObject({
          ok: false,
          current_revision: boundary.review_progress.revision,
          error: expect.stringMatching(/another Workbench session/i),
        });

        const first = await postJson(`http://${server.host}:${server.port}/api/boundary/regenerate`, headers, {
          kind: "principal_key",
          resource_id: firstResource,
          value: firstPrincipal,
          actor: "reviewer@example.test",
          reason: "This reviewed application ownership column constrains each operator to assigned rows.",
        });
        const firstMissing = `${firstResource}: confirm principal scope ${firstPrincipal}`;
        expect(first.review_progress.outstanding_decisions).toEqual(expect.arrayContaining([
          expect.objectContaining({ decision: firstMissing, resource_id: firstResource }),
        ]));
        expect(first.review_progress.outstanding_decisions).toHaveLength(3);
        expect(first.review_progress.outstanding_decisions.every(
          (decision: { resource_id?: string }) => decision.resource_id === firstResource,
        )).toBe(true);
        expect(first.confirmed_decisions).toHaveLength(originalDecisions.length - 3);
        expect(first.review_progress.invalidated_decisions).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: `resource.${firstResource}.principal_scope`,
            reason: "reviewed_input_changed",
          }),
        ]));

        boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
        await postJson(`http://${server.host}:${server.port}/api/boundary/progress`, headers, {
          candidate: boundary.candidate,
          confirmed_decisions: boundary.review.unresolved_decisions,
          expected_revision: boundary.review_progress.revision,
          actor: "reviewer@example.test",
        });

        const second = await postJson(`http://${server.host}:${server.port}/api/boundary/regenerate`, headers, {
          kind: "principal_key",
          resource_id: secondResource,
          value: secondPrincipal,
          actor: "reviewer@example.test",
          reason: "This reviewed application ownership column constrains each operator to assigned rows.",
        });
        const secondMissing = `${secondResource}: confirm principal scope ${secondPrincipal}`;
        expect(second.review_progress.outstanding_decisions).toEqual(expect.arrayContaining([
          expect.objectContaining({ decision: secondMissing, resource_id: secondResource }),
        ]));
        expect(second.review_progress.outstanding_decisions).toHaveLength(3);
        expect(second.review_progress.outstanding_decisions.every(
          (decision: { resource_id?: string }) => decision.resource_id === secondResource,
        )).toBe(true);
        expect(second.confirmed_decisions).toContain(firstMissing);
        expect(second.confirmed_decisions).not.toContain(secondMissing);

        boundary = await getJson(`http://${server.host}:${server.port}/api/boundary`, headers);
	        const complete = await postJson(`http://${server.host}:${server.port}/api/boundary/progress`, headers, {
	          candidate: boundary.candidate,
	          confirmed_decisions: boundary.review.unresolved_decisions,
	          expected_revision: boundary.review_progress.revision,
	          actor: "reviewer@example.test",
	        });
	        const preview = await postJson(`http://${server.host}:${server.port}/api/boundary/preview`, headers, {
	          candidate: boundary.candidate,
	          expected_revision: complete.revision,
	          actor: "reviewer@example.test",
	          confirmed_decisions: boundary.review.unresolved_decisions,
	        });
	        const unchanged = await postJson(`http://${server.host}:${server.port}/api/boundary/progress`, headers, {
	          candidate: boundary.candidate,
	          confirmed_decisions: boundary.review.unresolved_decisions,
	          expected_revision: complete.revision,
	          actor: "reviewer@example.test",
	        });
	        expect(unchanged).toMatchObject({
	          revision: complete.revision,
	          unchanged: true,
	          source_database_changed: false,
	        });
	        const activated = await postJson(`http://${server.host}:${server.port}/api/boundary/activate`, headers, {
	          candidate: boundary.candidate,
	          expected_digest: preview.digest,
	          actor: "reviewer@example.test",
	          confirmation: `ACTIVATE ${preview.digest}`,
	          confirmed_decisions: boundary.review.unresolved_decisions,
	        });
        expect(activated).toMatchObject({
          ok: true,
          active: { activation: { state: "active" } },
          source_database_changed: false,
        });
        const progress = JSON.parse(
          await fs.readFile(path.join(tempDir, ".synapsor/boundary-review-progress.json"), "utf8"),
        );
	        expect(progress).toMatchObject({
	          schema_version: "synapsor.boundary-review-progress.v3",
	          boundary_id: expect.stringMatching(/^bnd_[a-f0-9]{32}$/),
	          policy_migration: { status: "complete", source: "native" },
	          review_overrides: expect.objectContaining({ resources: expect.any(Object) }),
	          confirmations: expect.arrayContaining([
            expect.objectContaining({
              id: `resource.${firstResource}.principal_scope`,
              actor: "reviewer@example.test",
              status: "confirmed",
            }),
            expect.objectContaining({
              id: `resource.${secondResource}.principal_scope`,
              actor: "reviewer@example.test",
              status: "confirmed",
            }),
          ]),
        });
      } finally {
        await server.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("keeps Workbench trusted scope in memory and out of responses and project files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-trusted-scope-"));
    const inspection = boundaryReviewInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: tempDir,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const written = await writeAutoBoundaryArtifacts({ projectRoot: tempDir, build });
    const guided = await initializeGuidedProject({ projectRoot: tempDir, build, runnerVersion: "1.6.4" });
    const digest = explorationBoundaryCandidateDigest(build.exploration_boundary);
    await activateExplorationBoundary({
      projectRoot: tempDir,
      candidate: build.exploration_boundary,
      expectedDigest: digest,
      actor: "reviewer@example.test",
      confirmation: `ACTIVATE ${digest}`,
      confirmedDecisions: build.exploration_boundary.unresolved_decisions,
      currentInspection: inspection,
    });
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      boundaryRoot: written.root,
      configPath: guided.config_path,
      storePath: guided.store_path,
      token: "trusted-scope-token",
      csrfToken: "trusted-scope-csrf",
    });
    try {
      const response = await postJson(`http://${server.host}:${server.port}/api/explore/trusted-context`, {
        "x-synapsor-ui-token": "trusted-scope-token",
        "x-synapsor-csrf": "trusted-scope-csrf",
      }, {
        tenant: "tenant-memory-only",
        principal: "principal-memory-only",
      });
      expect(response).toMatchObject({
        ok: true,
        configured: true,
        persisted: false,
        source_database_changed: false,
      });
      expect(JSON.stringify(response)).not.toMatch(/tenant-memory-only|principal-memory-only/);
      const projectFiles = await fs.readdir(path.join(tempDir, ".synapsor"));
      for (const file of projectFiles.filter((name) => name.endsWith(".json"))) {
        expect(await fs.readFile(path.join(tempDir, ".synapsor", file), "utf8"))
          .not.toMatch(/tenant-memory-only|principal-memory-only/);
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
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
      const lifecycle = await getJson(`${baseUrl}/api/lifecycle`, headers);
      expect(lifecycle).toMatchObject({
        ok: true,
        returned: 1,
        lifecycles: [
          expect.objectContaining({
            proposal_id: "wrp_ui",
            capability: "billing.waive_late_fee",
          }),
        ],
      });
      const approved = await postJson(`${baseUrl}/api/proposals/wrp_ui/approve`, {
        ...headers,
        "x-synapsor-csrf": "csrf-token",
      }, { confirm: "approve", actor: "shared_reviewer" });
      expect(approved.proposal.state).toBe("approved");
      expect(sharedStore.getProposal("wrp_ui")?.state).toBe("approved");
      expect(operations).toEqual([
        "read:proposals-list",
        "read:lifecycle-list",
        "read:proposal-approve-scope",
        "read:proposal-approve-freshness-read",
        "write:proposal-approve",
      ]);
      await expect(fs.stat(path.join(tempDir, "must-not-be-opened.db"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      sharedStore.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the Human Attention Inbox tenant-scoped and acknowledgement separate from approval", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-attention-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      notifications: {
        enabled: true,
        sinks: [{
          id: "operations",
          type: "jsonl",
          destination: "stdout",
          minimum_severity: "warning",
          delivery: "immediate",
        }],
      },
    }), "utf8");
    const sharedStore = new ProposalStore();
    const acme = structuredClone(changeSet);
    const beta = structuredClone(changeSet);
    beta.proposal_id = "wrp_beta";
    beta.scope = { ...beta.scope, tenant_id: "beta", object_id: "INV-BETA" };
    beta.source.primary_key.value = "INV-BETA";
    beta.guards.tenant.value = "beta";
    beta.reversibility.lineage = {
      root_proposal_id: "wrp_beta",
      parent_proposal_id: "wrp_beta",
      reverts_proposal_id: "wrp_beta",
      depth: 1,
    };
    beta.evidence.bundle_id = "ev_beta";
    beta.integrity.proposal_hash = `sha256:${"b".repeat(64)}`;
    sharedStore.setRunnerState("attention_context", { environment: "staging" });
    sharedStore.createProposal(acme);
    sharedStore.createProposal(beta);
    const attentionItems = sharedStore.listAttentionItems();
    for (const event of sharedStore.listAttentionEvents({ event_type: "proposal.review_required" })) {
      const item = attentionItems.find((candidate) => candidate.attention_key === event.attention_key);
      sharedStore.enqueueNotificationDelivery({
        sink_id: "operations",
        event_id: event.event_id,
        attention_id: item?.attention_id,
      });
    }
    const acmeItem = sharedStore.listAttentionItems({ tenant: "acme" })[0]!;
    const betaItem = sharedStore.listAttentionItems({ tenant: "beta" })[0]!;
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath,
      storePath: path.join(tempDir, "must-not-be-opened.db"),
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile: "staging",
      ledgerScope: { required: true, tenant: "acme", principal: "support_agent_17" },
      storeAccess: async (_mode, _operation, callback) => callback(sharedStore),
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = { "x-synapsor-ui-token": "ui-token" };
      const inbox = await getJson(`${baseUrl}/api/attention?status=open`, headers);
      expect(inbox.attention).toEqual([
        expect.objectContaining({
          attention_id: acmeItem.attention_id,
          occurrence_count: 1,
          latest_event: expect.objectContaining({ proposal_id: "wrp_ui" }),
          acknowledgement_is_approval: false,
        }),
      ]);
      expect(JSON.stringify(inbox)).not.toContain("wrp_beta");
      expect(JSON.stringify(inbox)).not.toContain(betaItem.attention_id);

      const betaResponse = await fetch(`${baseUrl}/api/attention/${betaItem.attention_id}`, { headers });
      expect(betaResponse.status).toBe(404);

      const status = await getJson(`${baseUrl}/api/notifications/status`, headers);
      expect(status).toMatchObject({
        enabled: true,
        sinks: [{ id: "operations", counts: { pending: 1 } }],
        source_database_changed: false,
      });

      const acknowledged = await postJson(
        `${baseUrl}/api/attention/${acmeItem.attention_id}/acknowledge`,
        { ...headers, "x-synapsor-csrf": "csrf-token" },
        { actor: "support_lead_1" },
      );
      expect(acknowledged).toMatchObject({
        attention: { status: "acknowledged" },
        approval_created: false,
        source_database_changed: false,
      });
      expect(sharedStore.getProposal("wrp_ui")?.state).toBe("pending_review");
      expect(sharedStore.approvals("wrp_ui")).toEqual([]);
      const acknowledgedInbox = await getJson(`${baseUrl}/api/attention?status=acknowledged`, headers);
      expect(acknowledgedInbox.attention).toEqual([
        expect.objectContaining({
          attention_id: acmeItem.attention_id,
          status: "acknowledged",
          acknowledgement_is_approval: false,
        }),
      ]);

      const html = await fetch(`${baseUrl}/`, { headers }).then((response) => response.text());
      expect(html).toContain("Human Attention Inbox");
      expect(html).toContain("Acknowledgement only records that you saw this");
      expect(html).toContain("Human attention status");
    } finally {
      await server.close();
      sharedStore.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the trusted-worker console tenant-scoped and binds controls to exact confirmations", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-worker-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const digest = `sha256:${"c".repeat(64)}` as const;
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      sources: {
        app_postgres: {
          engine: "postgres",
          read_url_env: "APP_POSTGRES_READ_URL",
          write_url_env: "APP_POSTGRES_WRITE_URL",
        },
      },
      capabilities: [{
        name: "billing.waive_late_fee",
        kind: "proposal",
        source: "app_postgres",
      }],
      supervised_worker: {
        enabled: true,
        profile: "staging",
        capabilities: [{
          capability: "billing.waive_late_fee",
          contract_digest: digest,
          mode: "supervised_worker",
          concurrency: 1,
          queue_limit: 10,
          rate_limit: { executions: 10, window_seconds: 60 },
          write_url_env: "APP_POSTGRES_WRITE_URL",
          worker_identity: "staging_worker",
        }],
      },
    }), "utf8");
    const sharedStore = new ProposalStore();
    const beta = structuredClone(changeSet);
    beta.proposal_id = "wrp_beta_worker";
    beta.scope = { ...beta.scope, tenant_id: "beta", object_id: "INV-BETA-WORKER" };
    beta.source.primary_key.value = "INV-BETA-WORKER";
    beta.guards.tenant.value = "beta";
    beta.reversibility.lineage = {
      root_proposal_id: beta.proposal_id,
      parent_proposal_id: beta.proposal_id,
      reverts_proposal_id: beta.proposal_id,
      depth: 1,
    };
    beta.evidence.bundle_id = "ev_beta_worker";
    beta.integrity.proposal_hash = `sha256:${"d".repeat(64)}`;
    sharedStore.createProposal(changeSet);
    sharedStore.createProposal(beta);
    sharedStore.approveProposal(changeSet.proposal_id, {
      approver: "support_lead",
      proposal_hash: changeSet.integrity.proposal_hash,
      proposal_version: changeSet.proposal_version,
    });
    sharedStore.approveProposal(beta.proposal_id, {
      approver: "support_lead",
      proposal_hash: beta.integrity.proposal_hash,
      proposal_version: beta.proposal_version,
    });
    sharedStore.enqueueWorkerProposal({
      proposal_id: changeSet.proposal_id,
      execution_mode: "supervised_worker",
      contract_digest: digest,
    });
    sharedStore.enqueueWorkerProposal({
      proposal_id: beta.proposal_id,
      execution_mode: "supervised_worker",
      contract_digest: digest,
    });
    const decisions: Array<{ action: string; proposalId?: string }> = [];
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath,
      storePath: path.join(tempDir, "must-not-be-opened.db"),
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile: "staging",
      ledgerScope: { required: true, tenant: "acme", principal: "support_agent_17" },
      storeAccess: async (_mode, _operation, callback) => callback(sharedStore),
      workerDecision: async (input) => {
        decisions.push({ action: input.action, ...(input.proposalId ? { proposalId: input.proposalId } : {}) });
        if (input.action === "cancel") {
          sharedStore.cancelWorkerItem({
            proposalId: input.proposalId!,
            actor: input.actor ?? "operator_alice",
          });
        } else {
          if (input.action === "dead_letter_requeue" || input.action === "dead_letter_discard") {
            throw new Error("unexpected dead-letter action in this test");
          }
          sharedStore.updateWorkerControl({
            action: input.action,
            ...(input.capability ? { capability: input.capability } : {}),
            ...(input.contractDigest ? { contract_digest: input.contractDigest } : {}),
            actor: input.actor ?? "operator_alice",
            environment: "staging",
          });
        }
        return { code: 0 };
      },
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = { "x-synapsor-ui-token": "ui-token" };
      const worker = await getJson(`${baseUrl}/api/worker`, headers);
      expect(worker).toMatchObject({
        ok: true,
        worker: {
          configured: true,
          enabled: true,
          deployment_profile: "staging",
          summary: { queue_depth: 1 },
          queue: [{
            proposal_id: changeSet.proposal_id,
            capability: changeSet.action,
            status: "queued",
            contract_digest: digest,
            cancel_confirmation: `CANCEL ${changeSet.proposal_id}`,
          }],
          capabilities: [{
            capability: changeSet.action,
            contract_digest: digest,
            writer_posture: {
              reference: "APP_POSTGRES_WRITE_URL",
              separation: "separate_reference",
            },
          }],
          controls_are_model_facing: false,
        },
        source_database_changed: false,
      });
      expect(JSON.stringify(worker)).not.toContain(beta.proposal_id);
      expect(JSON.stringify(worker)).not.toContain("postgresql://");

      const badConfirmation = await fetch(`${baseUrl}/api/worker/control`, {
        method: "POST",
        headers: {
          ...headers,
          "x-synapsor-csrf": "csrf-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "pause", confirm: "pause" }),
      });
      expect(badConfirmation.status).toBe(409);
      expect(await badConfirmation.json()).toMatchObject({
        required_confirmation: "PAUSE WORKER",
        source_database_changed: false,
      });
      expect(decisions).toEqual([]);

      const paused = await postJson(
        `${baseUrl}/api/worker/control`,
        { ...headers, "x-synapsor-csrf": "csrf-token" },
        { action: "pause", confirm: "PAUSE WORKER", actor: "operator_alice" },
      );
      expect(paused).toMatchObject({
        worker: { control: { mode: "paused", revision: 1 }, summary: { queue_depth: 1 } },
        queued_proposals_discarded: 0,
        source_database_changed: false,
      });

      const wrongTenant = await fetch(`${baseUrl}/api/worker/queue/${beta.proposal_id}/cancel`, {
        method: "POST",
        headers: {
          ...headers,
          "x-synapsor-csrf": "csrf-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: `CANCEL ${beta.proposal_id}` }),
      });
      expect(wrongTenant.status).toBe(404);

      const cancelled = await postJson(
        `${baseUrl}/api/worker/queue/${changeSet.proposal_id}/cancel`,
        { ...headers, "x-synapsor-csrf": "csrf-token" },
        {
          confirm: `CANCEL ${changeSet.proposal_id}`,
          actor: "operator_alice",
          reason: "operator cancelled before lease",
        },
      );
      expect(cancelled).toMatchObject({
        worker: {
          summary: { queue_depth: 0 },
          queue: [{ proposal_id: changeSet.proposal_id, status: "cancelled" }],
        },
        source_database_changed: false,
      });
      expect(sharedStore.getWorkerQueueItem(beta.proposal_id)).toMatchObject({ status: "queued" });
      expect(decisions).toEqual([
        { action: "pause" },
        { action: "cancel", proposalId: changeSet.proposal_id },
      ]);

      const html = await fetch(`${baseUrl}/`, { headers }).then((response) => response.text());
      expect(html).toContain("Trusted Worker");
      expect(html).toContain("controls are never MCP tools");
    } finally {
      await server.close();
      sharedStore.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("routes Workbench reconciliation through a redacted live inspection and exact trusted decision", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-reconciliation-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const digest = `sha256:${"e".repeat(64)}` as const;
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      supervised_worker: {
        enabled: true,
        profile: "staging",
        capabilities: [{
          capability: changeSet.action,
          contract_digest: digest,
          mode: "supervised_worker",
          write_url_env: "APP_POSTGRES_WRITE_URL",
        }],
      },
    }), "utf8");
    const sharedStore = new ProposalStore();
    const reconciliationChangeSet = structuredClone(changeSet);
    delete (reconciliationChangeSet as Partial<typeof changeSet>).reversibility;
    sharedStore.createProposal(reconciliationChangeSet);
    sharedStore.approveProposal(changeSet.proposal_id, {
      approver: "support_lead",
      proposal_hash: changeSet.integrity.proposal_hash,
      proposal_version: changeSet.proposal_version,
    });
    sharedStore.enqueueWorkerProposal({
      proposal_id: changeSet.proposal_id,
      execution_mode: "supervised_worker",
      contract_digest: digest,
    });
    const lease = sharedStore.claimWorkerItem({
      workerId: "worker_reconciliation_test",
      executionMode: "supervised_worker",
      capability: changeSet.action,
      contractDigest: digest,
    });
    if (!lease?.lease_id) throw new Error("expected worker lease");
    const job = sharedStore.createWritebackJobFromProposal(changeSet.proposal_id);
    const claim = sharedStore.claimWritebackIntent(job, "worker_reconciliation_test");
    if (claim.decision !== "proceed") throw new Error("expected a new writeback intent");
    sharedStore.markWritebackIntentApplying(claim.intent_id, "worker_reconciliation_test");
    sharedStore.requireWritebackReconciliation(claim.intent_id, "commit acknowledgement missing");
    sharedStore.requireWorkerReconciliation({
      proposalId: changeSet.proposal_id,
      workerId: "worker_reconciliation_test",
      leaseId: lease.lease_id,
      errorCode: "UNKNOWN_TRANSACTION_OUTCOME",
    });
    const decisions: Array<Record<string, unknown>> = [];
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath,
      storePath: path.join(tempDir, "must-not-be-opened.db"),
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile: "staging",
      ledgerScope: { required: true, tenant: "acme", principal: "support_agent_17" },
      storeAccess: async (_mode, _operation, callback) => callback(sharedStore),
      workerReconciliationInspect: async ({ intentId }) => ({
        intent_id: intentId,
        proposal_id: changeSet.proposal_id,
        operation: "single_row_update",
        intent_status: "reconciliation_required",
        reconciliation_reason: "commit acknowledgement missing",
        classification: "matches_proposed",
        supported_outcome: "applied",
        observed_digest: `sha256:${"f".repeat(64)}`,
        expected_fields: ["late_fee_cents", "waiver_reason"],
        observed_fields: ["late_fee_cents", "waiver_reason"],
        member_count: 0,
        member_classifications: {},
        source_database_changed: false,
      }),
      workerReconciliationResolve: async (input) => {
        decisions.push(input);
        return { code: 0 };
      },
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = { "x-synapsor-ui-token": "ui-token" };
      const worker = await getJson(`${baseUrl}/api/worker`, headers);
      expect(worker.worker.queue).toEqual([
        expect.objectContaining({
          proposal_id: changeSet.proposal_id,
          status: "reconciliation_required",
          reconciliation: {
            intent_id: claim.intent_id,
            operation: "single_row_update",
            status: "reconciliation_required",
            reason: "commit acknowledgement missing",
          },
        }),
      ]);

      const inspected = await getJson(
        `${baseUrl}/api/worker/reconciliation/${encodeURIComponent(claim.intent_id)}`,
        headers,
      );
      expect(inspected).toMatchObject({
        reconciliation: {
          intent_id: claim.intent_id,
          proposal_id: changeSet.proposal_id,
          classification: "matches_proposed",
          supported_outcome: "applied",
          expected_fields: ["late_fee_cents", "waiver_reason"],
          source_database_changed: false,
        },
        required_confirmation: `RECONCILE ${claim.intent_id} AS APPLIED`,
        source_database_changed: false,
      });
      const serialized = JSON.stringify(inspected);
      expect(serialized).not.toContain("customer requested review");
      expect(serialized).not.toContain("5500");
      expect(serialized).not.toContain("acme");
      expect(serialized).not.toContain("support_agent_17");

      const mismatched = await fetch(
        `${baseUrl}/api/worker/reconciliation/${encodeURIComponent(claim.intent_id)}/resolve`,
        {
          method: "POST",
          headers: {
            ...headers,
            "x-synapsor-csrf": "csrf-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            outcome: "conflict",
            confirm: `RECONCILE ${claim.intent_id} AS APPLIED`,
            reason: "wrong outcome",
          }),
        },
      );
      expect(mismatched.status).toBe(409);
      expect(decisions).toEqual([]);

      const resolved = await postJson(
        `${baseUrl}/api/worker/reconciliation/${encodeURIComponent(claim.intent_id)}/resolve`,
        { ...headers, "x-synapsor-csrf": "csrf-token" },
        {
          outcome: "applied",
          confirm: `RECONCILE ${claim.intent_id} AS APPLIED`,
          reason: "live source digest proves the reviewed update committed",
          actor: "operator_alice",
          identity_token: "fresh-operator-token",
        },
      );
      expect(resolved).toMatchObject({
        ok: true,
        intent: {
          intent_id: claim.intent_id,
          proposal_id: changeSet.proposal_id,
          operation: "single_row_update",
          status: "reconciliation_required",
        },
        source_database_changed: false,
      });
      expect(JSON.stringify(resolved)).not.toContain("fresh-operator-token");
      expect(decisions).toEqual([{
        intentId: claim.intent_id,
        outcome: "applied",
        reason: "live source digest proves the reviewed update committed",
        actor: "operator_alice",
        identityToken: "fresh-operator-token",
      }]);
    } finally {
      await server.close();
      sharedStore.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("routes production attention acknowledgement through an exact verified operator decision", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-production-attention-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review" }), "utf8");
    const store = new ProposalStore(storePath);
    store.setRunnerState("attention_context", { environment: "production" });
    store.createProposal(changeSet);
    const item = store.listAttentionItems({ status: "open" })[0]!;
    store.close();
    const decisions: string[] = [];
    const server = await startLocalUiServer({
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile: "production",
      attentionAcknowledge: async (input) => {
        expect(input.identityToken).toBe("verified-oidc-token");
        const decisionStore = new ProposalStore(storePath);
        try {
          const current = decisionStore.getAttentionItem(input.attentionId)!;
          const decision = {
            schema_version: "synapsor.operator-decision.v1" as const,
            action: "attention_acknowledge" as const,
            ...attentionDecisionSubject(current),
            subject: "operator_alice",
            issued_at: "2026-07-24T12:00:00.000Z",
          };
          const unsigned = {
            provider: "jwt_oidc" as const,
            verified: true,
            subject: "operator_alice",
            roles: ["runner_operator"],
            key_id: "oidc-key-1",
            algorithm: "RS256",
            issuer: "https://idp.example.test",
            decision,
            decision_hash: canonicalJsonDigest(decision),
            signature: "verified-attestation",
          };
          const identity: OperatorIdentityProof = {
            ...unsigned,
            integrity_hash: canonicalJsonDigest(unsigned),
          };
          decisionStore.acknowledgeAttention({
            attention_id: current.attention_id,
            actor: identity.subject,
            identity,
            require_verified_identity: true,
          });
          decisions.push(current.attention_id);
          return { code: 0 };
        } finally {
          decisionStore.close();
        }
      },
    });
    try {
      const response = await postJson(
        `http://${server.host}:${server.port}/api/attention/${item.attention_id}/acknowledge`,
        {
          "x-synapsor-ui-token": "ui-token",
          "x-synapsor-csrf": "csrf-token",
        },
        {
          actor: "operator_alice",
          identity_token: "verified-oidc-token",
        },
      );
      expect(response).toMatchObject({
        attention: {
          status: "acknowledged",
          acknowledged_by: "operator_alice",
        },
        approval_created: false,
        source_database_changed: false,
      });
      expect(decisions).toEqual([item.attention_id]);
      const verified = new ProposalStore(storePath);
      try {
        expect(verified.getProposal(changeSet.proposal_id)?.state).toBe("pending_review");
        expect(verified.approvals(changeSet.proposal_id)).toEqual([]);
      } finally {
        verified.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "production", deploymentProfile: "production" as const, cloudLinked: false },
    { label: "unknown", deploymentProfile: undefined, cloudLinked: false },
    { label: "Cloud-linked", deploymentProfile: "staging" as const, cloudLinked: true },
  ])("refuses local Workbench approval and apply for $label authority", async ({
    deploymentProfile,
    cloudLinked,
  }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-governance-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      operator_identity: { provider: "dev_env" },
      ...(cloudLinked ? { governance: { mode: "cloud_linked" } } : {}),
    }), "utf8");
    const store = new ProposalStore(storePath);
    const decisionChangeSet = structuredClone(changeSet);
    delete (decisionChangeSet as Partial<typeof changeSet>).reversibility;
    store.createProposal(decisionChangeSet);
    store.close();
    const decisions: string[] = [];
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile,
      proposalApprove: async () => {
        decisions.push("approve");
        return { code: 0 };
      },
      proposalApply: async () => {
        decisions.push("apply");
        return { code: 0 };
      },
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = {
        "content-type": "application/json",
        "x-synapsor-ui-token": "ui-token",
        "x-synapsor-csrf": "csrf-token",
      };
      for (const action of ["approve", "apply"] as const) {
        const response = await fetch(`${baseUrl}/api/proposals/wrp_ui/${action}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            confirm: `${action === "approve" ? "APPROVE" : "APPLY"} ${changeSet.integrity.proposal_hash}`,
            actor: "local-operator",
          }),
        });
        expect(response.status).toBe(403);
        const payload = await response.json() as Record<string, unknown>;
        expect(payload).toMatchObject({
          ok: false,
          source_database_changed: false,
        });
        expect(JSON.stringify(payload)).toMatch(cloudLinked ? /Cloud/i : /production|unknown/i);
      }
      expect(decisions).toEqual([]);
      const persisted = new ProposalStore(storePath);
      try {
        expect(persisted.getProposal("wrp_ui")?.state).toBe("pending_review");
        expect(persisted.approvals("wrp_ui")).toEqual([]);
        expect(persisted.receipts("wrp_ui")).toEqual([]);
      } finally {
        persisted.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists recent lifecycle activity without ids and enforces tenant scope for every handle", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-lifecycle-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review" }), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_ui",
      proposal_id: "wrp_ui",
      tenant_id: "acme",
      payload: { approved_field: "visible", hidden_field: "must-not-reach-workbench" },
      items: [{ type: "row", value: "must-not-reach-workbench" }],
    });
    const other = structuredClone(changeSet);
    other.proposal_id = "wrp_other_tenant";
    other.integrity.proposal_hash = canonicalJsonDigest({ proposal: other.proposal_id });
    other.scope.tenant_id = "other";
    other.scope.object_id = "INV-OTHER";
    other.source.primary_key.value = "INV-OTHER";
    other.evidence.bundle_id = "ev_other";
    other.created_at = "2026-06-20T14:32:09Z";
    store.createProposal(other);
    store.close();

    const server = await startLocalUiServer({
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
      ledgerScope: { tenant: "acme", required: true },
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = { "x-synapsor-ui-token": "ui-token" };
      const recent = await getJson(`${baseUrl}/api/lifecycle`, headers);
      expect(recent).toMatchObject({
        ok: true,
        total_matches: 1,
        returned: 1,
        source_database_changed: false,
      });
      expect(recent.lifecycles[0]).toMatchObject({
        proposal_id: "wrp_ui",
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
      });

      const byEvidence = await getJson(`${baseUrl}/api/lifecycle/${encodeURIComponent("evidence:ev_ui")}`, headers);
      expect(byEvidence.lifecycle.proposal.proposal_id).toBe("wrp_ui");
      expect(byEvidence.lifecycle.evidence.bundles[0]).not.toHaveProperty("payload");
      expect(byEvidence.lifecycle.evidence.bundles[0]).not.toHaveProperty("items");
      expect(JSON.stringify(byEvidence)).not.toContain("must-not-reach-workbench");

      const otherTenant = await fetch(`${baseUrl}/api/lifecycle/${encodeURIComponent("proposal:wrp_other_tenant")}`, { headers });
      expect(otherTenant.status).toBe(404);
      expect(JSON.stringify(await otherTenant.json())).not.toContain("INV-OTHER");

      const filtered = await getJson(`${baseUrl}/api/lifecycle?status=pending_review&object_type=invoice`, headers);
      expect(filtered.returned).toBe(1);
      const invalid = await fetch(`${baseUrl}/api/lifecycle?status=not-a-state`, { headers });
      expect(invalid.status).toBe(400);

      const verified = new ProposalStore(storePath);
      try {
        expect(verified.getProposal("wrp_ui")?.state).toBe("pending_review");
        expect(verified.getProposal("wrp_other_tenant")?.state).toBe("pending_review");
        expect(verified.receipts("wrp_ui")).toEqual([]);
      } finally {
        verified.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps Workbench approval and apply as separate hash-bound operator decisions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-decisions-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      operator_identity: { provider: "dev_env" },
    }), "utf8");
    const store = new ProposalStore(storePath);
    const decisionChangeSet = structuredClone(changeSet);
    delete (decisionChangeSet as Partial<typeof changeSet>).reversibility;
    store.createProposal(decisionChangeSet);
    store.close();
    const decisions: Array<{ kind: string; actor?: string; reason?: string; identityToken?: string }> = [];

    const server = await startLocalUiServer({
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile: "staging",
      proposalApprove: async (input) => {
        decisions.push({ kind: "approve", ...input });
        const decisionStore = new ProposalStore(storePath);
        try {
          const proposal = decisionStore.getProposal(input.proposalId)!;
          decisionStore.approveProposal(input.proposalId, {
            approver: input.actor ?? "reviewer",
            proposal_hash: proposal.proposal_hash,
            proposal_version: proposal.proposal_version,
            reason: input.reason,
          });
        } finally {
          decisionStore.close();
        }
        return { code: 0 };
      },
      proposalApply: async (input) => {
        decisions.push({ kind: "apply", ...input });
        const decisionStore = new ProposalStore(storePath);
        try {
          const job = decisionStore.createWritebackJobFromProposal(input.proposalId);
          decisionStore.recordExecutionReceipt({
            schema_version: protocolVersions.executionReceipt,
            writeback_job_id: job.writeback_job_id,
            proposal_id: input.proposalId,
            runner_id: input.actor ?? "apply-operator",
            status: "applied",
            rows_affected: 1,
            idempotency_key: job.idempotency_key,
            previous_version: "2026-06-20T14:31:08Z",
            new_version: "2026-06-20T14:32:08Z",
            source_database_mutated: true,
            executed_at: "2026-06-20T14:32:08Z",
            receipt_hash: "sha256:workbench-receipt",
          });
        } finally {
          decisionStore.close();
        }
        return { code: 0 };
      },
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = {
        "x-synapsor-ui-token": "ui-token",
        "x-synapsor-csrf": "csrf-token",
      };
      const wrongApproval = await fetch(`${baseUrl}/api/proposals/wrp_ui/approve`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ confirm: "approve", actor: "reviewer_1" }),
      });
      expect(wrongApproval.status).toBe(409);
      expect(decisions).toEqual([]);

      const approval = await postJson(`${baseUrl}/api/proposals/wrp_ui/approve`, headers, {
        confirm: `APPROVE ${changeSet.integrity.proposal_hash}`,
        actor: "reviewer_1",
        reason: "exact effect reviewed",
      });
      expect(approval).toMatchObject({
        ok: true,
        proposal: { state: "approved" },
        source_database_changed: false,
      });
      expect(decisions).toEqual([
        expect.objectContaining({ kind: "approve", actor: "reviewer_1", reason: "exact effect reviewed" }),
      ]);

      const wrongApply = await fetch(`${baseUrl}/api/proposals/wrp_ui/apply`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ confirm: `APPROVE ${changeSet.integrity.proposal_hash}`, actor: "operator_2" }),
      });
      expect(wrongApply.status).toBe(409);
      expect(decisions).toHaveLength(1);

      const applied = await postJson(`${baseUrl}/api/proposals/wrp_ui/apply`, headers, {
        confirm: `APPLY ${changeSet.integrity.proposal_hash}`,
        actor: "operator_2",
        reason: "commit after independent review",
      });
      expect(applied).toMatchObject({
        ok: true,
        proposal: { state: "applied" },
        data_pr: { apply_result: { receipt: { receipt_hash: "sha256:workbench-receipt" } } },
        deployment_profile: "staging",
        source_database_changed: true,
      });
      expect(decisions).toEqual([
        expect.objectContaining({ kind: "approve", actor: "reviewer_1" }),
        expect.objectContaining({ kind: "apply", actor: "operator_2" }),
      ]);
      expect(JSON.stringify(applied.lifecycle)).toContain("sha256:workbench-receipt");
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("binds Workbench approval to the server-selected current freshness proof", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-current-freshness-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "review",
      operator_identity: { provider: "dev_env" },
    }), "utf8");
    const input = freshnessChangeSet("wrp_ui_current_freshness");
    const current = freshnessEvaluation(input, "fresh");
    const store = new ProposalStore(storePath);
    store.createProposal(input);
    store.recordFreshnessProof(current.proof);
    store.close();
    const decisions: Array<{ proposalId: string; freshnessProofDigest?: string }> = [];
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile: "staging",
      proposalApprove: async (decision) => {
        decisions.push(decision);
        const decisionStore = new ProposalStore(storePath);
        try {
          const proposal = decisionStore.getProposal(decision.proposalId)!;
          decisionStore.approveProposal(decision.proposalId, {
            approver: decision.actor ?? "reviewer",
            proposal_hash: proposal.proposal_hash,
            proposal_version: proposal.proposal_version,
            freshness_proof_digest: decision.freshnessProofDigest,
          });
        } finally {
          decisionStore.close();
        }
        return { code: 0 };
      },
    });
    try {
      const response = await fetch(`${`http://${server.host}:${server.port}`}/api/proposals/${input.proposal_id}/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-synapsor-ui-token": "ui-token",
          "x-synapsor-csrf": "csrf-token",
        },
        body: JSON.stringify({
          actor: "reviewer_1",
          confirm: `APPROVE ${input.integrity.proposal_hash}`,
          freshness_proof_digest: canonicalJsonDigest({ attacker_selected: true }),
        }),
      });
      expect(response.status).toBe(200);
      expect(decisions).toEqual([expect.objectContaining({
        proposalId: input.proposal_id,
        freshnessProofDigest: current.proof.proof_digest,
      })]);
      expect(decisions[0]?.freshnessProofDigest).not.toBe(canonicalJsonDigest({ attacker_selected: true }));
      const verified = new ProposalStore(storePath);
      try {
        expect(verified.getProposal(input.proposal_id)?.state).toBe("approved");
        expect(verified.approvals(input.proposal_id)[0]?.freshness_proof_digest).toBe(current.proof.proof_digest);
      } finally {
        verified.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { status: "stale" as const, httpStatus: 409, expectedState: "conflict" },
    { status: "unavailable" as const, httpStatus: 503, expectedState: "pending_review" },
  ])("blocks Workbench approval when mandatory freshness is $status", async ({ status, httpStatus, expectedState }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `synapsor-local-ui-freshness-${status}-`));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review" }), "utf8");
    const input = freshnessChangeSet(`wrp_ui_${status}`);
    const store = new ProposalStore(storePath);
    store.createProposal(input);
    store.close();
    const server = await startLocalUiServer({
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
      freshnessEvaluator: async () => freshnessEvaluation(input, status),
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = { "x-synapsor-ui-token": "ui-token" };
      const shell = await fetch(baseUrl, { headers });
      const shellText = await shell.text();
      expect(shellText).toContain("Check live freshness");
      expect(shellText).toContain("Checking the current source state");
      expect(shellText).toContain("Approval uses the current unexpired freshness proof and checks again only when needed");

      const check = await fetch(`${baseUrl}/api/proposals/${input.proposal_id}/check-freshness`, {
        method: "POST",
        headers: {
          ...headers,
          "x-synapsor-csrf": "csrf-token",
        },
      });
      expect(check.status).toBe(httpStatus);
      const checkPayload = await check.json() as Record<string, unknown>;
      expect(checkPayload).toMatchObject({
        ok: false,
        freshness: {
          required: true,
          status,
          safe_code: status === "stale"
            ? "FRESHNESS_DEPENDENCY_STALE"
            : "FRESHNESS_TEMPORARILY_UNAVAILABLE",
        },
      });

      const approval = await fetch(`${baseUrl}/api/proposals/${input.proposal_id}/approve`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "x-synapsor-csrf": "csrf-token",
        },
        body: JSON.stringify({ confirm: "approve", actor: "reviewer_1" }),
      });
      expect(approval.status).toBe(httpStatus);
      const approvalPayload = await approval.json() as Record<string, unknown>;
      expect(JSON.stringify(approvalPayload)).not.toContain("ACCT-44");
      expect(JSON.stringify(approvalPayload)).not.toContain("tenant_id");

      const verified = new ProposalStore(storePath);
      try {
        expect(verified.getProposal(input.proposal_id)?.state).toBe(expectedState);
        expect(verified.approvals(input.proposal_id)).toEqual([]);
        expect(verified.events(input.proposal_id)).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: "proposal_approval_blocked_freshness" }),
        ]));
      } finally {
        verified.close();
      }
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("explains a trusted approval command freshness failure without changing proposal state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-approval-freshness-exit-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review" }), "utf8");
    const store = new ProposalStore(storePath);
    store.createProposal(changeSet);
    store.close();
    const server = await startLocalUiServer({
      projectRoot: tempDir,
      configPath,
      storePath,
      token: "ui-token",
      csrfToken: "csrf-token",
      deploymentProfile: "staging",
      proposalApprove: async () => ({ code: 4 }),
    });
    try {
      const response = await fetch(`${`http://${server.host}:${server.port}`}/api/proposals/wrp_ui/approve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-synapsor-ui-token": "ui-token",
          "x-synapsor-csrf": "csrf-token",
        },
        body: JSON.stringify({
          actor: "reviewer_1",
          confirm: `APPROVE ${changeSet.integrity.proposal_hash}`,
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error_code: "APPROVAL_FRESHNESS_UNAVAILABLE",
        source_database_changed: false,
      });
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

  it("runs BYOM Ask only through the reviewed Workbench tool surface without persisting authority or secrets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-ask-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const storePath = path.join(tempDir, ".synapsor/local.db");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review" }), "utf8");
    const secret = "sk-workbench-session-only-canary";
    const environmentSecret = "sk-workbench-environment-canary";
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = environmentSecret;
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let closedGateways = 0;
    let providerRequests = 0;
    const tool = {
      name: "billing.propose_late_fee_waiver",
      title: "Propose a late-fee waiver",
      description: "Creates one reviewed proposal and never applies it.",
      input_schema: {
        type: "object",
        properties: {
          invoice_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["invoice_id", "reason"],
        additionalProperties: false,
      },
      metadata: {
        "synapsor.kind": "proposal",
        "synapsor.approval_tool": false,
        "synapsor.commit_tool": false,
      },
    };
    const server = await startLocalUiServer({
      configPath,
      storePath,
      projectRoot: tempDir,
      token: "ask-token",
      csrfToken: "ask-csrf",
      deploymentProfile: "development",
      askGatewayFactory: async () => ({
        listTools: async () => [tool],
        callTool: async (name, args) => {
          toolCalls.push({ name, args });
          return {
            ok: true,
            value: {
            ok: true,
            proposal: {
              proposal_id: "wrp_ask_1",
              state: "pending_review",
            },
            source_database_changed: false,
            },
          };
        },
        close: async () => {
          closedGateways += 1;
        },
      }),
      askProviderDependencies: {
        requestJson: async (input) => {
          providerRequests += 1;
          expect(input.headers.authorization).toBe(`Bearer ${secret}`);
          expect(input.timeoutMs).toBe(90_000);
          if (JSON.stringify(input.body).includes("Simulate provider outage")) {
            throw new Error(`provider unavailable: ${secret}`);
          }
          if (providerRequests === 1) {
            return {
              status: 200,
              body: {
                choices: [{
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                      id: "call_workbench_1",
                      type: "function",
                      function: {
                        name: "billing__propose_late_fee_waiver",
                        arguments: JSON.stringify({
                          invoice_id: "INV-ASK",
                          reason: "reviewed customer request",
                        }),
                      },
                    }],
                  },
                }],
              },
            };
          }
          return {
            status: 200,
            body: {
              choices: [{
                message: {
                  role: "assistant",
                  content: "A proposal was created and still requires operator review.",
                },
              }],
            },
          };
        },
      },
    });
    try {
      const baseUrl = `http://${server.host}:${server.port}`;
      const headers = { "x-synapsor-ui-token": "ask-token" };
      const mutationHeaders = {
        ...headers,
        "x-synapsor-csrf": "ask-csrf",
        "content-type": "application/json",
      };
      const status = await getJson(`${baseUrl}/api/ask/status`, headers);
      expect(status).toMatchObject({
        ok: true,
        available: true,
        profile: "development",
        credential_environment: {
          openai: true,
          anthropic: expect.any(Boolean),
        },
        direct_provider_egress: true,
        synapsor_relay: false,
        persisted_conversation: false,
        session: { configured: false, running: false, history_turns: 0 },
      });
      expect(JSON.stringify(status)).not.toContain(environmentSecret);
      expect(status.tools).toEqual([
        expect.objectContaining({ name: tool.name, kind: "proposal" }),
      ]);

      const missingCsrf = await fetch(`${baseUrl}/api/ask/configure`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missingCsrf.status).toBe(403);

      const configured = await postJson(`${baseUrl}/api/ask/configure`, mutationHeaders, {
        provider: "openai",
        model: "gpt-5-mini",
        api_key: secret,
        request_timeout_seconds: 90,
        authority_digest: status.authority_digest,
        egress_acknowledged: true,
      });
      expect(configured).toMatchObject({
        ok: true,
        configuration: {
          provider: "openai",
          model: "gpt-5-mini",
          credential_source: "session_paste",
          request_timeout_seconds: 90,
          authority_digest: status.authority_digest,
        },
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
        source_database_changed: false,
      });
      expect(JSON.stringify(configured)).not.toContain(secret);

      const result = await postJson(`${baseUrl}/api/ask/run`, mutationHeaders, {
        question: "Waive the reviewed invoice late fee.",
      });
      expect(result).toMatchObject({
        ok: true,
        answer: "A proposal was created and still requires operator review.",
        display_answer: "A proposal was created and still requires operator review.",
        source_database_changed: false,
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
      });
      expect(result.tool_calls).toEqual([
        expect.objectContaining({
          tool: tool.name,
          status: "ok",
          result: expect.objectContaining({
            proposal: {
              proposal_id: "wrp_ask_1",
              state: "pending_review",
            },
            source_database_changed: false,
          }),
        }),
      ]);
      expect(toolCalls).toEqual([{
        name: tool.name,
        args: {
          invoice_id: "INV-ASK",
          reason: "reviewed customer request",
        },
      }]);

      const outage = await fetch(`${baseUrl}/api/ask/run`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ question: "Simulate provider outage." }),
      });
      expect(outage.status).toBe(500);
      const outagePayload = await outage.json();
      expect(outagePayload).toMatchObject({
        ok: false,
        error_code: "ASK_INTERNAL",
        source_database_changed: false,
      });
      expect(JSON.stringify(outagePayload)).not.toContain(secret);

      await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "read_only" }), "utf8");
      const staleConsent = await fetch(`${baseUrl}/api/ask/run`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ question: "Use the changed authority without a new acknowledgement." }),
      });
      expect(staleConsent.status).toBe(409);
      expect(await staleConsent.json()).toMatchObject({
        ok: false,
        error_code: "ASK_AUTHORITY_CHANGED",
        source_database_changed: false,
      });
      expect(providerRequests).toBe(3);

      const cleared = await postJson(`${baseUrl}/api/ask/clear`, mutationHeaders, {});
      expect(cleared).toMatchObject({
        ok: true,
        provider_key_retained: false,
        conversation_retained: false,
      });
      const afterClear = await getJson(`${baseUrl}/api/ask/status`, headers);
      expect(afterClear.session).toEqual({ configured: false, running: false, history_turns: 0 });
      const projectEntries = await fs.readdir(tempDir, { recursive: true });
      const persistedSecretMatches = await Promise.all(projectEntries.map(async (relativePath) => {
        const absolutePath = path.join(tempDir, relativePath);
        const stat = await fs.stat(absolutePath);
        return stat.isFile()
          ? (await fs.readFile(absolutePath)).includes(Buffer.from(secret))
          : false;
      }));
      expect(persistedSecretMatches).not.toContain(true);
      expect(providerRequests).toBe(3);
      expect(closedGateways).toBeGreaterThanOrEqual(4);
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
      if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAIKey;
    }
  });

  it.each([
    { profile: "production" as const, host: "127.0.0.1", allowRemoteBind: false },
    { profile: "unknown" as const, host: "127.0.0.1", allowRemoteBind: false },
    { profile: "development" as const, host: "0.0.0.0", allowRemoteBind: true },
  ])("does not advertise Ask for $profile on $host", async ({ profile, host, allowRemoteBind }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-ui-ask-absent-"));
    const configPath = path.join(tempDir, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review" }), "utf8");
    let gatewayCalls = 0;
    const server = await startLocalUiServer({
      configPath,
      projectRoot: tempDir,
      deploymentProfile: profile,
      host,
      allowRemoteBind,
      token: "ask-token",
      askGatewayFactory: async () => {
        gatewayCalls += 1;
        throw new Error("gateway must not be created");
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/ask/status`, {
        headers: { "x-synapsor-ui-token": "ask-token" },
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        ok: false,
        available: false,
        error_code: "ASK_SURFACE_UNAVAILABLE",
        source_database_changed: false,
      });
      expect(gatewayCalls).toBe(0);
    } finally {
      await server.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body);
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody = await response.text();
  expect(response.status, responseBody).toBe(200);
  return JSON.parse(responseBody);
}

function boundaryReviewInspection(): SchemaInspection {
  const column = (
    name: string,
    dataType: string,
    suggestions: Partial<{
      tenant: boolean;
      conflict: boolean;
      sensitive: boolean;
      immutable: boolean;
      large_or_binary: boolean;
    }> = {},
  ) => ({
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: false,
      large_or_binary: false,
      ...suggestions,
    },
  });
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "app_reader",
    inspected_at: "2026-07-24T17:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    tables: [{
      schema: "public",
      name: "members",
      type: "table",
      writable: true,
      columns: [
        column("id", "uuid", { immutable: true }),
        column("tenant_id", "uuid", { tenant: true, immutable: true }),
        column("membership_status", "text"),
        column("trainer_comments", "text"),
      ],
      primary_key: ["id"],
      unique_constraints: [{ name: "members_pkey", columns: ["id"] }],
      foreign_keys: [],
      indexes: [{ name: "members_pkey", columns: ["id"], unique: true }],
      row_level_security: true,
      row_level_security_policies: [{
        name: "tenant_read",
        command: "SELECT",
        permissive: true,
        roles: ["app_reader"],
        using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
      }],
      role_posture: {
        owner: "app_owner",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
        row_security_forced: false,
        row_security_effective_for_current_role: true,
      },
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: [],
        sensitive_columns: [],
        default_visible_columns: ["id", "tenant_id", "membership_status"],
      },
    }],
  };
}

function derivedBoundaryReviewInspection(): SchemaInspection {
  const inspection = boundaryReviewInspection();
  const orders = structuredClone(inspection.tables[0]!);
  orders.name = "orders";
  orders.unique_constraints = [{ name: "orders_pkey", columns: ["id"] }];
  orders.indexes = [{ name: "orders_pkey", columns: ["id"], unique: true }];

  const orderItems = structuredClone(orders);
  orderItems.name = "order_items";
  orderItems.columns = orderItems.columns.filter((column) => column.name !== "tenant_id");
  const orderId = structuredClone(orderItems.columns.find((column) => column.name === "id")!);
  orderId.name = "order_id";
  orderId.ordinal_position = orderItems.columns.length + 1;
  orderItems.columns.push(orderId);
  orderItems.unique_constraints = [{ name: "order_items_pkey", columns: ["id"] }];
  orderItems.indexes = [{ name: "order_items_pkey", columns: ["id"], unique: true }];
  orderItems.foreign_keys = [{
    name: "order_items_order_id_fkey",
    columns: ["order_id"],
    referenced_schema: "public",
    referenced_table: "orders",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];
  orderItems.row_level_security = false;
  orderItems.row_level_security_policies = [];
  if (!orderItems.role_posture) throw new Error("derived-scope fixture role posture is required");
  orderItems.role_posture.row_security_effective_for_current_role = false;
  orderItems.suggestions.tenant_columns = [];
  orderItems.suggestions.default_visible_columns = orderItems.suggestions.default_visible_columns
    .filter((field) => field !== "tenant_id")
    .concat("order_id");
  inspection.tables = [orderItems, orders];
  return inspection;
}

function relationshipReviewInspection(): SchemaInspection {
  const inspection = boundaryReviewInspection();
  const members = inspection.tables[0]!;
  members.columns.push({
    name: "team_id",
    data_type: "uuid",
    nullable: false,
    generated: false,
    ordinal_position: members.columns.length + 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: true,
      large_or_binary: false,
    },
  });
  members.suggestions.default_visible_columns.push("team_id");
  members.foreign_keys = [{
    name: "members_team_id_fkey",
    columns: ["team_id"],
    referenced_schema: "public",
    referenced_table: "teams",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];
  const teams = structuredClone(members);
  teams.name = "teams";
  teams.columns = [
    structuredClone(members.columns.find((column) => column.name === "id")!),
    structuredClone(members.columns.find((column) => column.name === "tenant_id")!),
    {
      name: "name",
      data_type: "text",
      nullable: false,
      generated: false,
      ordinal_position: 3,
      suggestions: {
        tenant: false,
        conflict: false,
        sensitive: false,
        immutable: false,
        large_or_binary: false,
      },
    },
  ];
  teams.unique_constraints = [{ name: "teams_pkey", columns: ["id"] }];
  teams.foreign_keys = [];
  teams.indexes = [{ name: "teams_pkey", columns: ["id"], unique: true }];
  teams.suggestions = {
    tenant_columns: ["tenant_id"],
    conflict_columns: [],
    sensitive_columns: [],
    default_visible_columns: ["id", "tenant_id", "name"],
  };
  inspection.tables.push(teams);
  return inspection;
}

function multiResourceBoundaryReviewInspection(): SchemaInspection {
  const inspection = boundaryReviewInspection();
  const member = inspection.tables[0]!;
  member.columns.push({
    name: "assigned_agent",
    data_type: "uuid",
    nullable: false,
    generated: false,
    ordinal_position: member.columns.length + 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: false,
      large_or_binary: false,
    },
  });
  const charges = structuredClone(member);
  charges.name = "charges";
  charges.columns = charges.columns.map((column, index) => ({
    ...column,
    name: column.name === "assigned_agent"
      ? "reviewer_id"
      : column.name === "membership_status"
        ? "charge_status"
        : column.name === "trainer_comments"
          ? "card_on_file"
          : column.name,
    ordinal_position: index + 1,
  }));
  charges.row_level_security_policies = [{
    name: "tenant_read",
    command: "SELECT",
    permissive: true,
    roles: ["app_reader"],
    using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
  }];
  inspection.tables.push(charges);
  return inspection;
}

function guidedActionInspection(): SchemaInspection {
  const inspection = boundaryReviewInspection();
  const table = inspection.tables[0]!;
  const makeColumn = (
    name: string,
    dataType: string,
    suggestions: Partial<{
      tenant: boolean;
      conflict: boolean;
      sensitive: boolean;
      immutable: boolean;
      large_or_binary: boolean;
    }> = {},
    enumValues?: string[],
  ) => ({
    name,
    data_type: dataType,
    ...(enumValues ? { enum_values: enumValues } : {}),
    nullable: false,
    generated: false,
    ordinal_position: table.columns.length + 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: false,
      large_or_binary: false,
      ...suggestions,
    },
  });
  table.columns = [
    table.columns[0]!,
    {
      ...table.columns[1]!,
      name: "organization_id",
      suggestions: { ...table.columns[1]!.suggestions, tenant: true },
    },
    makeColumn("assigned_trainer_id", "uuid", { immutable: true }),
    makeColumn("membership_status", "text", {}, ["active", "frozen", "cancelled"]),
    makeColumn("loyalty_balance", "integer"),
    makeColumn("version", "integer", { conflict: true }),
    makeColumn("payment_method", "text", { sensitive: true }),
    makeColumn("medical_notes", "text", { sensitive: true }),
  ];
  table.suggestions = {
    tenant_columns: ["organization_id"],
    conflict_columns: ["version"],
    sensitive_columns: ["payment_method", "medical_notes"],
    default_visible_columns: ["id", "organization_id", "assigned_trainer_id", "membership_status", "loyalty_balance", "version"],
  };
  table.row_level_security_policies = [{
    name: "member_scope",
    command: "SELECT",
    permissive: true,
    roles: ["app_reader"],
    using_expression: "(organization_id = current_setting('app.organization_id')::uuid AND assigned_trainer_id = current_setting('app.principal')::uuid)",
  }];
  table.referenced_by = [];
  table.write_triggers = [];
  return inspection;
}
