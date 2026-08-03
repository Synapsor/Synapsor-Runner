import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, parseWritebackJob, principalScopeFingerprint, protocolVersions } from "@synapsor-runner/protocol";
import {
  PostgresProposalRuntimeStore,
  PostgresWritebackIntentStore,
  ProposalStore,
  ProposalStoreError,
  attentionDecisionSubject,
  notificationReplayDecisionSubject,
  sharedPostgresRuntimeStoreMigration,
  workerControlDecisionSubject,
  type NotificationDelivery,
  type PostgresRuntimeClient,
  type PostgresRuntimePool,
  type PostgresRuntimeQueryResult,
  type OperatorIdentityProof,
  type WorkerControlTarget,
} from "./index.js";

const changeSet = {
  schema_version: "synapsor.change-set.v1",
  proposal_id: "wrp_123",
  proposal_version: 1,
  action: "billing.waive_late_fee",
  mode: "review_required",
  principal: { id: "support_agent_17", source: "trusted_session" },
  scope: { tenant_id: "acme", business_object: "invoice", object_id: "INV-3001" },
  source: {
    kind: "external_postgres",
    source_id: "src_pg_acme",
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-3001" }
  },
  before: { late_fee_cents: 5500, waiver_reason: null, updated_at: "2026-06-20T14:31:08Z" },
  patch: { late_fee_cents: 0, waiver_reason: "customer requested review" },
  after: { late_fee_cents: 0, waiver_reason: "customer requested review", updated_at: "2026-06-20T14:31:08Z" },
  guards: {
    tenant: { column: "tenant_id", value: "acme" },
    allowed_columns: ["late_fee_cents", "waiver_reason"],
    expected_version: { column: "updated_at", value: "2026-06-20T14:31:08Z" }
  },
  evidence: { bundle_id: "ev_456", query_fingerprint: "sha256:evidence", items: [] },
  approval: { status: "pending", required_role: "support_lead" },
  writeback: { status: "not_applied", mode: "trusted_worker_required" },
  source_database_mutated: false,
  integrity: { proposal_hash: "sha256:proposal" },
  created_at: "2026-06-20T14:31:09Z"
};

const appliedReceipt = {
  schema_version: "synapsor.execution-receipt.v1",
  writeback_job_id: "wbj_123",
  proposal_id: "wrp_123",
  runner_id: "runner_123",
  status: "applied",
  rows_affected: 1,
  idempotency_key: "wrp_123:INV-3001",
  previous_version: "2026-06-20T14:31:08Z",
  new_version: "2026-06-20T14:34:19Z",
  source_database_mutated: true,
  executed_at: "2026-06-20T14:34:19Z",
  receipt_hash: "sha256:receipt"
};

const writebackJob = {
  schema_version: "synapsor.writeback-job.v1",
  writeback_job_id: "wbj_123",
  proposal_id: "wrp_123",
  proposal_version: 1,
  proposal_hash: "sha256:proposal",
  runner_scope: { project_id: "acme-support", source_id: "src_pg_acme" },
  engine: "postgres",
  operation: "single_row_update",
  target: {
    schema: "public",
    table: "invoices",
    primary_key: { column: "id", value: "INV-3001" }
  },
  tenant_guard: { column: "tenant_id", value: "acme" },
  allowed_columns: ["late_fee_cents", "waiver_reason"],
  patch: { late_fee_cents: 0, waiver_reason: "approved support waiver" },
  conflict_guard: { kind: "column", column: "updated_at", expected_value: "2026-06-20T14:31:08Z" },
  idempotency_key: "wrp_123:INV-3001",
  lease: { lease_id: "lease_123", attempt: 1, expires_at: "2026-06-20T14:36:00Z" }
};

const preRefactorLedgerFixture = new URL(
  "../../../development/trusted-core-fixtures/pre-refactor-8989163-ledger.db",
  import.meta.url,
);

function boundedSetWritebackJob() {
  return parseWritebackJob({
    protocol_version: "3.0",
    job_id: "wbj_set_shared",
    proposal_id: "wrp_set_shared",
    approval_id: "sha256:proposal-set-shared",
    source_id: "src_pg_acme",
    engine: "postgres",
    operation: "set_update",
    target: {
      schema: "public",
      table: "invoices",
      primary_key: { column: "id" },
      tenant_guard: { column: "tenant_id", value: "acme" },
    },
    allowed_columns: ["credit_cents"],
    patch: { credit_cents: 500 },
    conflict_guard: { kind: "none" },
    version_advance: { column: "version", strategy: "integer_increment" },
    frozen_set: {
      max_rows: 1,
      row_count: 1,
      aggregate_bounds: [{ column: "credit_cents", measure: "absolute_delta", maximum: 500, actual: 500 }],
      members: [{
        primary_key: { column: "id", value: "INV-1" },
        expected_version: { column: "version", value: 1 },
        before: { id: "INV-1", tenant_id: "acme", version: 1, credit_cents: 0 },
        after: { id: "INV-1", tenant_id: "acme", version: 2, credit_cents: 500 },
        before_digest: "sha256:before-set-shared",
        after_digest: "sha256:after-set-shared",
      }],
      set_digest: "sha256:set-shared",
    },
    idempotency_key: "set-shared-key",
    lease_expires_at: "2026-07-13T12:00:00.000Z",
    attempt_count: 1,
  });
}

function shadowChangeSet() {
  return {
    ...structuredClone(changeSet),
    proposal_id: "wrp_shadow",
    mode: "shadow",
    integrity: { proposal_hash: "sha256:shadow" },
  };
}

function freshnessChangeSet(requiredApprovals = 1, proposalId = changeSet.proposal_id) {
  const objectId = proposalId === changeSet.proposal_id
    ? changeSet.scope.object_id
    : `INV-${proposalId}`;
  const dependencyUnsigned = {
    id: "invoice_eligibility",
    capability: "billing.inspect_invoice",
    source_id: "src_pg_acme",
    engine: "postgres" as const,
    target: {
      schema: "public",
      table: "invoice_eligibility",
      primary_key: { column: "invoice_id", value: "INV-3001" },
      tenant_column: "tenant_id",
    },
    expected_version: { column: "updated_at", value: "2026-06-20T14:30:00Z" },
    evidence: {
      bundle_id: "ev_freshness_invoice",
      query_fingerprint: "sha256:freshness-query",
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
    scope: {
      ...structuredClone(changeSet.scope),
      object_id: objectId,
    },
    source: {
      ...structuredClone(changeSet.source),
      primary_key: {
        ...structuredClone(changeSet.source.primary_key),
        value: objectId,
      },
    },
    integrity: { proposal_hash: `sha256:freshness-${proposalId}` },
    approval: {
      ...structuredClone(changeSet.approval),
      required_approvals: requiredApprovals,
    },
    freshness: {
      ...authorityUnsigned,
      dependency_set_digest: canonicalJsonDigest(authorityUnsigned),
    },
  };
}

function freshnessProofFor(
  input: ReturnType<typeof freshnessChangeSet>,
  result: "fresh" | "stale" | "unavailable" = "fresh",
  checkedAt = new Date().toISOString(),
  staleKind: "target" | "supporting" = "target",
) {
  const checks = result === "unavailable"
    ? [{
        id: "target",
        kind: "target" as const,
        status: "unavailable" as const,
        safe_code: "FRESHNESS_TEMPORARILY_UNAVAILABLE",
      }]
    : [
        {
          id: "target",
          kind: "target" as const,
          status: result === "stale" && staleKind === "target" ? "stale" as const : "fresh" as const,
          safe_code: result === "stale" && staleKind === "target"
            ? "FRESHNESS_TARGET_STALE"
            : "FRESHNESS_TARGET_FRESH",
          expected_version_digest: "sha256:target-expected",
          observed_version_digest: result === "stale" && staleKind === "target"
            ? "sha256:target-observed"
            : "sha256:target-expected",
        },
        {
          id: "invoice_eligibility",
          kind: "supporting" as const,
          status: result === "stale" && staleKind === "supporting" ? "stale" as const : "fresh" as const,
          safe_code: result === "stale" && staleKind === "supporting"
            ? "FRESHNESS_DEPENDENCY_STALE"
            : "FRESHNESS_DEPENDENCY_FRESH",
          expected_version_digest: "sha256:dependency-expected",
          observed_version_digest: result === "stale" && staleKind === "supporting"
            ? "sha256:dependency-observed"
            : "sha256:dependency-expected",
        },
      ];
  const unsigned = {
    schema_version: protocolVersions.freshnessProof,
    proposal_id: input.proposal_id,
    proposal_hash: input.integrity.proposal_hash,
    proposal_version: input.proposal_version,
    dependency_set_digest: input.freshness.dependency_set_digest,
    checked_at: checkedAt,
    valid_until: new Date(Date.parse(checkedAt) + 30_000).toISOString(),
    source_adapters: [{ source_id: "src_pg_acme", engine: "postgres" as const }],
    result,
    safe_code: result === "fresh"
      ? "FRESHNESS_FRESH"
      : result === "stale"
        ? staleKind === "target"
          ? "FRESHNESS_TARGET_STALE"
          : "FRESHNESS_DEPENDENCY_STALE"
        : "FRESHNESS_TEMPORARILY_UNAVAILABLE",
    target_count: 1,
    supporting_count: result === "unavailable" ? 0 : 1,
    checks,
  };
  return {
    ...unsigned,
    proof_digest: canonicalJsonDigest(unsigned),
  };
}

function shadowCaseChangeSet(input: {
  proposalId: string;
  objectId: string;
  amount?: number;
  tenant?: string;
}) {
  const amount = input.amount ?? 0;
  return {
    ...structuredClone(changeSet),
    proposal_id: input.proposalId,
    mode: "shadow",
    scope: {
      ...structuredClone(changeSet.scope),
      tenant_id: input.tenant ?? "acme",
      object_id: input.objectId,
    },
    source: {
      ...structuredClone(changeSet.source),
      primary_key: { column: "id", value: input.objectId },
    },
    before: { late_fee_cents: 5500, waiver_reason: null, updated_at: "2026-06-20T14:31:08Z" },
    patch: { late_fee_cents: amount, waiver_reason: "shadow study" },
    after: { late_fee_cents: amount, waiver_reason: "shadow study", updated_at: "2026-06-20T14:31:08Z" },
    guards: {
      ...structuredClone(changeSet.guards),
      tenant: { column: "tenant_id", value: input.tenant ?? "acme" },
    },
    evidence: {
      ...structuredClone(changeSet.evidence),
      bundle_id: `ev_${input.proposalId}`,
    },
    integrity: { proposal_hash: `sha256:${input.proposalId}` },
  };
}

function operationChangeSet(operation: "single_row_update" | "single_row_insert" | "single_row_delete", suffix: string) {
  const insert = operation === "single_row_insert";
  const deletion = operation === "single_row_delete";
  const proposalId = `wrp_${suffix}`;
  return {
    schema_version: "synapsor.change-set.v2",
    proposal_id: proposalId,
    proposal_version: 1,
    action: `billing.${operation}`,
    operation,
    mode: "review_required",
    principal: { id: "support_agent_17", source: "trusted_session" },
    scope: { tenant_id: "acme", business_object: "credits", object_id: insert ? proposalId : `credit_${suffix}` },
    source: {
      kind: "external_postgres",
      source_id: "src_pg_acme",
      schema: "public",
      table: "credits",
      primary_key: { column: "id", ...(insert ? {} : { value: `credit_${suffix}` }) },
    },
    before: insert ? {} : { id: `credit_${suffix}`, tenant_id: "acme", amount_cents: 100, version: 7 },
    patch: deletion ? {} : { amount_cents: 500 },
    after: deletion ? {} : { id: `credit_${suffix}`, tenant_id: "acme", amount_cents: 500, version: 8 },
    guards: {
      tenant: { column: "tenant_id", value: "acme" },
      allowed_columns: deletion ? [] : ["amount_cents"],
      ...(insert ? {
        deduplication: { components: [
          { column: "tenant_id", value: "acme", source: "trusted_tenant" },
          { column: "request_id", value: proposalId, source: "proposal_id" },
        ] },
      } : {
        expected_version: { column: "version", value: 7 },
        ...(operation === "single_row_update" ? { version_advance: { column: "version", strategy: "integer_increment" } } : {}),
      }),
    },
    evidence: { bundle_id: `ev_${suffix}`, query_fingerprint: "sha256:evidence", items: [] },
    approval: { status: "pending", required_role: "support_lead" },
    writeback: { status: "not_applied", mode: "trusted_worker_required", executor: "sql_update" },
    source_database_mutated: false,
    integrity: { proposal_hash: `sha256:${suffix}` },
    created_at: "2026-07-13T00:00:00Z",
  };
}

function reversibleOperationChangeSet(operation: "single_row_update" | "single_row_insert" | "single_row_delete", suffix: string): any {
  const input = operationChangeSet(operation, suffix) as any;
  input.reversibility = {
    mode: "reviewed_inverse",
    lineage: {
      root_proposal_id: input.proposal_id,
      parent_proposal_id: input.proposal_id,
      reverts_proposal_id: input.proposal_id,
      depth: 1,
    },
  };
  if (operation === "single_row_insert") {
    const identity = `credit_${suffix}`;
    input.source.primary_key.value = identity;
    input.after.id = identity;
    input.guards.deduplication.components.push({ column: "id", value: identity, source: "proposal_id" });
  }
  return input;
}

function verifiedWorkerIdentity(action: "worker_requeue" | "worker_discard", subject = "fleet_operator"): OperatorIdentityProof {
  return {
    provider: "signed_key",
    verified: true,
    subject,
    roles: ["runner_operator"],
    key_id: "fleet-key-1",
    algorithm: "ed25519",
    decision: {
      schema_version: "synapsor.operator-decision.v1",
      action,
      proposal_id: "wrp_123",
      proposal_version: 1,
      proposal_hash: "sha256:proposal",
      subject,
      issued_at: "2026-07-12T00:00:03.000Z",
    },
    decision_hash: `sha256:${action}`,
    signature: `signature-${action}`,
    integrity_hash: `sha256:integrity-${action}`,
  };
}

function verifiedNotificationReplayIdentity(
  delivery: NotificationDelivery,
  reason: string,
  subject = "fleet_operator",
): OperatorIdentityProof {
  const decision = {
    schema_version: "synapsor.operator-decision.v1" as const,
    action: "notification_replay" as const,
    ...notificationReplayDecisionSubject(delivery),
    subject,
    issued_at: "2026-07-24T00:00:03.000Z",
    reason,
  };
  const unsigned = {
    provider: "signed_key" as const,
    verified: true,
    subject,
    roles: ["runner_operator"],
    key_id: "fleet-key-1",
    algorithm: "SHA256",
    decision,
    decision_hash: canonicalJsonDigest(decision),
    signature: "signed-test-proof",
  };
  return { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
}

function verifiedWorkerControlIdentity(
  store: ProposalStore,
  target: WorkerControlTarget,
  subject = "fleet_operator",
): OperatorIdentityProof {
  const decisionSubject = workerControlDecisionSubject(store.workerControlState(), target);
  const action: OperatorIdentityProof["decision"]["action"] = target.action === "pause"
    ? "worker_pause"
    : target.action === "resume"
      ? "worker_resume"
      : target.action === "drain"
        ? "worker_drain"
        : target.action === "capability_enable"
          ? "worker_capability_enable"
          : target.action === "capability_disable"
            ? "worker_capability_disable"
            : "worker_digest_revoke";
  const decision = {
    schema_version: "synapsor.operator-decision.v1" as const,
    action,
    ...decisionSubject,
    subject,
    issued_at: "2026-07-12T00:00:03.000Z",
  };
  const unsigned = {
    provider: "signed_key" as const,
    verified: true,
    subject,
    roles: ["runner_operator"],
    key_id: "fleet-key-1",
    algorithm: "SHA256",
    decision,
    decision_hash: canonicalJsonDigest(decision),
    signature: "signed-test-proof",
  };
  return { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
}

describe("proposal store", () => {
  it("opens and extends the pre-refactor SQLite ledger without migration drift", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-pre-refactor-ledger-"));
    const storePath = path.join(tempDir, "ledger.db");
    await fs.copyFile(preRefactorLedgerFixture, storePath);

    const store = new ProposalStore(storePath);
    try {
      const existing = store.getProposal("wrp_pre_refactor");
      expect(existing).toMatchObject({
        proposal_hash: "sha256:pre-refactor-proposal",
        state: "applied",
        tenant_id: "fixture_tenant",
        source_database_mutated: true,
      });
      expect(store.getEvidenceBundle("ev_pre_refactor")).toMatchObject({
        proposal_id: "wrp_pre_refactor",
        tenant_id: "fixture_tenant",
      });
      expect(store.listQueryAudit({ proposal: "wrp_pre_refactor" })).toHaveLength(1);
      expect(store.approvals("wrp_pre_refactor")).toEqual([
        expect.objectContaining({
          approver: "support_lead_fixture",
          proposal_hash: "sha256:pre-refactor-proposal",
          status: "approved",
        }),
      ]);
      expect(store.receipts("wrp_pre_refactor")).toEqual([
        expect.objectContaining({
          status: "applied",
          receipt: expect.objectContaining({
            receipt_hash: "sha256:pre-refactor-receipt",
          }),
        }),
      ]);
      expect(store.getRunnerState("trusted_core_fixture")).toEqual({
        source_database_contains_real_data: false,
        starting_head: "8989163f324e7e8abaf55696796d1f13d7a6d71b",
      });

      const successor = structuredClone(existing!.change_set);
      successor.proposal_id = "wrp_post_refactor";
      successor.scope.object_id = "INV-POST-REFACTOR";
      successor.source.primary_key.value = "INV-POST-REFACTOR";
      successor.evidence.bundle_id = "ev_post_refactor";
      successor.integrity.proposal_hash = "sha256:post-refactor-proposal";
      successor.created_at = "2026-07-26T00:00:03Z";
      expect(store.createProposal(successor)).toMatchObject({
        proposal_id: "wrp_post_refactor",
        state: "pending_review",
        source_database_mutated: false,
      });
    } finally {
      store.close();
    }

    const reopened = new ProposalStore(storePath);
    try {
      expect(reopened.getProposal("wrp_pre_refactor")?.state).toBe("applied");
      expect(reopened.getProposal("wrp_post_refactor")).toMatchObject({
        proposal_hash: "sha256:post-refactor-proposal",
        state: "pending_review",
      });
    } finally {
      reopened.close();
    }
  });

  it("keeps store methods as non-enumerable own prototype methods", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      ProposalStore.prototype,
      "createProposal",
    );
    expect(descriptor?.enumerable).toBe(false);
    expect(descriptor?.writable).toBe(true);
    expect(descriptor?.configurable).toBe(true);
    expect(typeof descriptor?.value).toBe("function");
    expect(Object.keys(ProposalStore.prototype)).toEqual([]);
  });

  it("creates the parent directory for file-backed stores", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-parent-"));
    const storePath = path.join(tempDir, ".synapsor", "nested", "local.db");
    const store = new ProposalStore(storePath);
    try {
      expect(await fs.stat(storePath)).toBeTruthy();
      if (process.platform !== "win32") {
        expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tightens an existing POSIX store to owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-mode-"));
    const storePath = path.join(tempDir, "local.db");
    await fs.writeFile(storePath, "");
    await fs.chmod(storePath, 0o644);
    const store = new ProposalStore(storePath);
    try {
      expect((await fs.stat(storePath)).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits through short cross-process SQLite writer contention", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-busy-timeout-"));
    const storePath = path.join(tempDir, "local.db");
    const seed = new ProposalStore(storePath);
    seed.close();

    const locker = spawn(process.execPath, [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       process.stdout.write("locked\\n");
       setTimeout(() => { db.exec("COMMIT"); db.close(); }, 300);`,
      storePath,
    ], {
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    locker.stderr.setEncoding("utf8");
    locker.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exit = new Promise<number>((resolve, reject) => {
      locker.once("error", reject);
      locker.once("close", (code) => resolve(code ?? -1));
    });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      locker.stdout.setEncoding("utf8");
      locker.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.includes("locked\n")) resolve();
      });
      locker.once("close", (code) => {
        if (!stdout.includes("locked\n")) reject(new Error(`SQLite lock helper exited ${code}: ${stderr}`));
      });
    });

    try {
      const contender = new ProposalStore(storePath);
      try {
        expect(contender.db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
        expect(contender.createProposal(changeSet).proposal_id).toBe("wrp_123");
      } finally {
        contender.close();
      }
      expect(await exit).toBe(0);
    } finally {
      if (locker.exitCode === null) locker.kill();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("persists exact-replay privacy reservations through shared-ledger round trips", () => {
    const store = new ProposalStore();
    const restored = new ProposalStore();
    const base = {
      scope_fingerprint: `sha256:${"1".repeat(64)}` as const,
      legacy_session_fingerprints: [],
      resource_id: "public.orders",
      requires_differencing: true,
      estimated_response_cells: 4,
      limits: {
        max_queries_per_session: 10,
        rate_limit_per_minute: 10,
        max_extracted_cells_per_session: 100,
        max_differencing_queries: 1,
        max_response_cells: 10,
      },
      now: "2026-08-02T12:00:00.000Z",
    };
    try {
      const first = store.claimExploreBudgetReservation({
        ...base,
        reservation_id: "budget-1",
        variant_fingerprint: `sha256:${"2".repeat(64)}`,
      });
      expect(first).toMatchObject({ allowed: true });
      expect(store.completeExploreBudgetReservation({
        reservation_id: "budget-1",
        result_released: true,
        returned_cells: 2,
        completed_at: "2026-08-02T12:00:01.000Z",
      })).toEqual({ completed: true });

      expect(store.claimExploreBudgetReservation({
        ...base,
        reservation_id: "budget-2",
        variant_fingerprint: `sha256:${"2".repeat(64)}`,
      })).toMatchObject({
        allowed: true,
        variant_already_counted: true,
      });
      expect(store.completeExploreBudgetReservation({
        reservation_id: "budget-2",
        result_released: false,
        returned_cells: 0,
        completed_at: "2026-08-02T12:00:02.000Z",
      })).toEqual({ completed: true });

      expect(restored.importSharedLedgerEntries(store.sharedLedgerEntries())).toMatchObject({ skipped: 0 });
      expect(restored.stats().explore_budget_reservations).toBe(2);
      expect(restored.claimExploreBudgetReservation({
        ...base,
        reservation_id: "budget-3",
        variant_fingerprint: `sha256:${"3".repeat(64)}`,
      })).toMatchObject({
        allowed: false,
        code: "DIFFERENCING_BUDGET_EXHAUSTED",
      });
    } finally {
      restored.close();
      store.close();
    }
  });

  it("does not charge explicit pre-execution refusals as legacy Explore queries", () => {
    const store = new ProposalStore();
    const scopeFingerprint = `sha256:${"4".repeat(64)}` as const;
    const recordedAt = new Date();
    try {
      store.recordQueryAudit({
        source_id: "src_pg_acme",
        query_fingerprint: `sha256:${"5".repeat(64)}`,
        table_name: "public.orders",
        row_count: 0,
        payload: {
          status: "refused_before_source_execution",
          source_execution_started: false,
          source_query_executed: false,
          budget_scope_fingerprint: scopeFingerprint,
          recorded_at: recordedAt.toISOString(),
          normalized_plan: {
            kind: "aggregate",
            resource: "public.orders",
          },
        },
      });

      expect(store.claimExploreBudgetReservation({
        reservation_id: "budget-after-refusal",
        scope_fingerprint: scopeFingerprint,
        legacy_session_fingerprints: [],
        resource_id: "public.orders",
        variant_fingerprint: `sha256:${"6".repeat(64)}`,
        requires_differencing: true,
        estimated_response_cells: 1,
        limits: {
          max_queries_per_session: 1,
          rate_limit_per_minute: 1,
          max_extracted_cells_per_session: 10,
          max_differencing_queries: 1,
          max_response_cells: 10,
        },
        now: new Date(recordedAt.getTime() + 1_000).toISOString(),
      })).toMatchObject({ allowed: true });
    } finally {
      store.close();
    }
  });

  it("blocks active duplicates but permits a successor after conflict", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      const duplicate = structuredClone(changeSet);
      duplicate.proposal_id = "wrp_duplicate";
      duplicate.integrity.proposal_hash = "sha256:duplicate";
      expect(() => store.createProposal(duplicate)).toThrowError(expect.objectContaining({
        code: "PROPOSAL_ALREADY_EXISTS",
      }));

      store.db.prepare("UPDATE proposals SET state = 'conflict' WHERE proposal_id = ?").run("wrp_123");
      const successor = structuredClone(changeSet);
      successor.proposal_id = "wrp_successor";
      successor.integrity.proposal_hash = "sha256:successor";
      successor.created_at = "2026-06-20T14:32:09Z";
      expect(store.createProposal(successor).proposal_id).toBe("wrp_successor");
      expect(store.getProposal("wrp_123")?.state).toBe("conflict");
      expect(store.findActiveProposal({
        tenant_id: "acme",
        action: "billing.waive_late_fee",
        business_object: "invoice",
        object_id: "INV-3001",
      })?.proposal_id).toBe("wrp_successor");
    } finally {
      store.close();
    }
  });

  it("retention never prunes active or retryable proposal state", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      const terminal = structuredClone(changeSet);
      terminal.proposal_id = "wrp_terminal";
      terminal.scope.object_id = "INV-2999";
      terminal.source.primary_key.value = "INV-2999";
      terminal.integrity.proposal_hash = "sha256:terminal";
      store.createProposal(terminal);
      store.db.prepare("UPDATE proposals SET state = 'rejected' WHERE proposal_id = ?").run("wrp_terminal");

      const dryRun = store.pruneBefore("2026-06-21T00:00:00.000Z");
      expect(dryRun.deleted.proposals).toBe(1);
      store.pruneBefore("2026-06-21T00:00:00.000Z", { dryRun: false });
      expect(store.getProposal("wrp_123")?.state).toBe("pending_review");
      expect(store.getProposal("wrp_terminal")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("exports a stable shared-ledger snapshot without raw JSON strings", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_shared",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: { rows: 1 },
        items: [{ type: "row", id: "INV-3001" }],
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_shared",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:query",
        table_name: "public.invoices",
        row_count: 1,
        payload: { redacted_params: ["tenant_id", "id"] },
      });

      const entries = store.sharedLedgerEntries();
      const proposal = entries.find((entry) => entry.entry_key === "proposals:wrp_123");
      const evidence = entries.find((entry) => entry.entry_key === "evidence_bundles:ev_shared");
      const audit = entries.find((entry) => entry.kind === "query_audit");

      expect(proposal).toMatchObject({
        kind: "proposal",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
      });
      expect(proposal?.payload.change_set).toMatchObject({ proposal_id: "wrp_123" });
      expect(evidence?.payload.payload).toEqual({ rows: 1 });
      expect(audit?.payload.payload).toEqual({ redacted_params: ["tenant_id", "id"] });

      const restored = new ProposalStore();
      try {
        expect(restored.importSharedLedgerEntries(entries)).toMatchObject({ imported: entries.length, skipped: 0 });
        expect(restored.getProposal("wrp_123")?.proposal_hash).toBe("sha256:proposal");
        expect(restored.getEvidenceBundle("ev_shared")?.payload).toEqual({ rows: 1 });
        expect(restored.listQueryAudit({ evidence: "ev_shared" })[0]?.payload).toEqual({ redacted_params: ["tenant_id", "id"] });
      } finally {
        restored.close();
      }
    } finally {
      store.close();
    }
  });

  it("records an evidence bundle and its linked query audit atomically", () => {
    const store = new ProposalStore();
    try {
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_atomic",
        tenant_id: "keyed:tenant",
        payload: {
          capability: "app.explore_data",
          source_id: "src_pg",
          query_fingerprint: "sha256:atomic",
          result_values_persisted: false,
        },
        query_audit: [{
          source_id: "src_pg",
          query_fingerprint: "sha256:atomic",
          table_name: "public.sessions",
          row_count: 2,
          payload: {
            capability: "app.explore_data",
            returned_cells: 4,
            result_values_persisted: false,
          },
        }],
      });
      expect(store.getEvidenceBundle("ev_atomic")).toMatchObject({
        evidence_bundle_id: "ev_atomic",
        tenant_id: "keyed:tenant",
      });
      expect(store.listQueryAudit({ evidence: "ev_atomic" })).toHaveLength(1);

      expect(() => store.recordEvidenceBundle({
        evidence_bundle_id: "ev_rollback",
        tenant_id: "keyed:tenant",
        payload: { capability: "app.explore_data" },
        query_audit: [{
          evidence_bundle_id: "ev_other",
          source_id: "src_pg",
          query_fingerprint: "sha256:rollback",
          table_name: "public.sessions",
          row_count: 0,
          payload: { result_values_persisted: false },
        }],
      })).toThrowError(expect.objectContaining({
        code: "EVIDENCE_QUERY_AUDIT_MISMATCH",
      }));
      expect(store.getEvidenceBundle("ev_rollback")).toBeUndefined();
      expect(store.listQueryAudit({ evidence: "ev_rollback" })).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("prints a safe shared Postgres runtime-store migration", () => {
    expect(sharedPostgresRuntimeStoreMigration("synapsor_runner")).toContain("\"synapsor_runner\".ledger_entries");
    expect(sharedPostgresRuntimeStoreMigration("tenant_runtime")).toContain("\"tenant_runtime\".worker_leases");
    expect(() => sharedPostgresRuntimeStoreMigration("bad-schema")).toThrowError(expect.objectContaining({
      code: "INVALID_POSTGRES_IDENTIFIER",
    }));
  });

  it("persists runtime proposal state through a shared Postgres ledger store", async () => {
    const pool = new FakePostgresRuntimePool();
    const first = new PostgresProposalRuntimeStore({
      pool,
      autoMigrate: true,
      lockTimeoutMs: 0,
    });
    const proposal = await first.createProposal(changeSet);
    expect(proposal).toMatchObject({
      proposal_id: "wrp_123",
      state: "pending_review",
      tenant_id: "acme",
      capability: "billing.waive_late_fee",
    });

    await first.recordEvidenceBundle({
      evidence_bundle_id: "ev_pg_runtime",
      proposal_id: "wrp_123",
      tenant_id: "acme",
      capability: "billing.waive_late_fee",
      payload: { capability: "billing.waive_late_fee", source_database_changed: false },
      items: [{ kind: "external_row", visible_row: { id: "INV-3001", late_fee_cents: 5500 } }],
    });
    await first.recordQueryAudit({
      proposal_id: "wrp_123",
      evidence_bundle_id: "ev_pg_runtime",
      source_id: "src_pg_acme",
      query_fingerprint: "sha256:pg-runtime",
      table_name: "public.invoices",
      row_count: 1,
      payload: { statement_template: "SELECT id FROM public.invoices WHERE id = $1 AND tenant_id = $2" },
    });

    const second = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0 });
    expect(await second.getProposal("wrp_123")).toMatchObject({
      proposal_id: "wrp_123",
      state: "pending_review",
    });
    expect(await second.getEvidenceBundle("ev_pg_runtime")).toMatchObject({
      evidence_bundle_id: "ev_pg_runtime",
      proposal_id: "wrp_123",
      tenant_id: "acme",
    });

    const decision = await second.approveProposalByPolicy("wrp_123", {
      policy: "billing_small_auto",
      proposal_hash: "sha256:proposal",
      proposal_version: 1,
      reason: "within aggregate policy",
    });
    expect(decision).toMatchObject({
      approved: true,
      policy: "billing_small_auto",
      proposal: { proposal_id: "wrp_123", state: "approved" },
    });

    const third = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0, closePool: true });
    expect(await third.getProposal("wrp_123")).toMatchObject({
      proposal_id: "wrp_123",
      state: "approved",
    });
    expect(await third.events("wrp_123")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "proposal_created" }),
      expect.objectContaining({ kind: "evidence_recorded" }),
      expect.objectContaining({ kind: "proposal_approved", actor: "policy:billing_small_auto" }),
    ]));
    const replay = await third.replay("wrp_123");
    expect(replay.proposal.state).toBe("approved");
    expect(replay.query_audit).toHaveLength(1);
    await third.close();
    expect(pool.ended).toBe(true);
  });

  it("round-trips coalesced attention and notification delivery through the shared Postgres runtime store", async () => {
    const pool = new FakePostgresRuntimePool();
    const first = new PostgresProposalRuntimeStore({
      pool,
      autoMigrate: true,
      lockTimeoutMs: 0,
    });
    const firstCandidate = operationChangeSet("single_row_update", "shared_attention_first");
    const secondCandidate = operationChangeSet("single_row_update", "shared_attention_second");
    await first.createProposal(firstCandidate);
    await first.createProposal(secondCandidate);

    const reviewEvents = await first.listAttentionEvents({
      event_type: "proposal.review_required",
      tenant: "acme",
    });
    const [attention] = await first.listAttentionItems({
      status: "open",
      tenant: "acme",
    });
    expect(reviewEvents).toHaveLength(2);
    expect(attention).toMatchObject({
      status: "open",
      occurrence_count: 2,
      capability: firstCandidate.action,
    });
    const delivery = await first.enqueueNotificationDelivery({
      sink_id: "shared_operations",
      event_id: reviewEvents[0]!.event_id,
      attention_id: attention!.attention_id,
      now: "2026-07-24T00:00:00.000Z",
    });

    const second = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0 });
    expect(await second.listAttentionItems({ tenant: "acme" })).toEqual([
      expect.objectContaining({
        attention_id: attention!.attention_id,
        occurrence_count: 2,
      }),
    ]);
    expect(await second.listAttentionItems({ tenant: "other" })).toEqual([]);
    expect(await second.listNotificationDeliveries({ sink_id: "shared_operations" })).toEqual([
      expect.objectContaining({
        delivery_id: delivery.delivery_id,
        event_id: reviewEvents[0]!.event_id,
        status: "pending",
      }),
    ]);

    await second.acknowledgeAttention({
      attention_id: attention!.attention_id,
      actor: "shared_operator",
      now: "2026-07-24T00:00:01.000Z",
    });
    const third = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0 });
    expect(await third.getAttentionItem(attention!.attention_id)).toMatchObject({
      status: "acknowledged",
      acknowledged_by: "shared_operator",
    });
    expect(await third.getProposal(firstCandidate.proposal_id)).toMatchObject({
      state: "pending_review",
    });
    expect(await third.approvals(firstCandidate.proposal_id)).toEqual([]);
    expect(await third.receipts(firstCandidate.proposal_id)).toEqual([]);
  });

  it("persists graduated-trust recommendations through the shared Postgres runtime store", async () => {
    const pool = new FakePostgresRuntimePool();
    const first = new PostgresProposalRuntimeStore({ pool, autoMigrate: true, lockTimeoutMs: 0 });
    const pending = await first.createPolicyRecommendation(policyRecommendationInput());
    expect(pending).toMatchObject({
      status: "pending_review",
      tenant_id: "acme",
      capability: "support.propose_plan_credit",
      policy: "small_credit",
    });

    const second = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0 });
    expect(await second.getPolicyRecommendation(pending.recommendation_id)).toEqual(pending);
    expect(await second.listPolicyRecommendations({ tenant: "acme", status: "pending_review" })).toEqual([pending]);
    expect(await second.listPolicyRecommendations({ tenant: "globex" })).toEqual([]);
    const approved = await second.decidePolicyRecommendation(pending.recommendation_id, {
      action: "approve",
      actor: "policy_reviewer",
      reason: "reviewed evidence and ceiling",
      identity: recommendationIdentity(pending, "approve", true, "policy_reviewer"),
      now: "2026-07-14T00:02:00.000Z",
    });
    expect(approved).toMatchObject({ status: "approved", decision: { actor: "policy_reviewer" } });

    const third = new PostgresProposalRuntimeStore({ pool, lockTimeoutMs: 0 });
    const exported = await third.markPolicyRecommendationExported(pending.recommendation_id, {
      actor: "policy_reviewer",
      artifact_digest: canonicalJsonDigest({ policy: "small_credit", max: 3000 }),
      now: "2026-07-14T00:03:00.000Z",
    });
    expect(exported).toMatchObject({ status: "exported", export: { actor: "policy_reviewer" } });
    expect(await first.getPolicyRecommendation(pending.recommendation_id)).toEqual(exported);
    expect([...pool.rows.values()].some((row) => row.kind === "policy_recommendation" && row.tenant_id === "acme")).toBe(true);
  });

  it("persists fleet writeback intents directly before end-of-command ledger sync", async () => {
    const pool = new FakePostgresRuntimePool();
    const store = new PostgresWritebackIntentStore({ pool, autoMigrate: true });
    const normalizedJob = new ProposalStore();
    try {
      normalizedJob.createProposal(changeSet);
      normalizedJob.approveProposal("wrp_123", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
      const job = normalizedJob.recordWritebackJob(writebackJob);
      expect(await store.claimWritebackIntent(job, "runner_a")).toEqual({ decision: "proceed", intent_id: "wbi:wbj_123" });
      expect(pool.rows.get("writeback_intents:wbi:wbj_123")?.payload_json).toMatchObject({ status: "intent_recorded" });
      await store.markWritebackIntentApplying("wbi:wbj_123", "runner_a");
      expect(await store.claimWritebackIntent(job, "runner_b")).toMatchObject({ decision: "reconciliation_required" });
      await store.requireWritebackReconciliation("wbi:wbj_123", "commit acknowledgement missing");
      expect(pool.rows.get("writeback_intents:wbi:wbj_123")?.payload_json).toMatchObject({
        status: "reconciliation_required",
        reconciliation_reason: "commit acknowledgement missing",
      });
      const migrationLock = pool.queries.findIndex((query) => query.includes("synapsor-writeback-intent") && query.includes("migration"));
      const migration = pool.queries.findIndex((query) => query.startsWith("create schema"));
      expect(migrationLock).toBeGreaterThanOrEqual(0);
      expect(migration).toBeGreaterThan(migrationLock);
      expect(pool.queries.filter((query) => query.startsWith("create schema"))).toHaveLength(1);
    } finally {
      normalizedJob.close();
      await store.close();
    }
  });

  it("round-trips protocol-v3 writeback intents through the shared ledger", async () => {
    const pool = new FakePostgresRuntimePool();
    const first = new PostgresWritebackIntentStore({ pool, autoMigrate: true });
    const job = boundedSetWritebackJob();
    try {
      await expect(first.claimWritebackIntent(job, "runner_a")).resolves.toEqual({ decision: "proceed", intent_id: "wbi:wbj_set_shared" });
      await first.markWritebackIntentApplying("wbi:wbj_set_shared", "runner_a");

      const second = new PostgresWritebackIntentStore({ pool, autoMigrate: true });
      try {
        await expect(second.claimWritebackIntent(job, "runner_b")).resolves.toMatchObject({
          decision: "reconciliation_required",
          intent_id: "wbi:wbj_set_shared",
        });
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });

  it("fails closed before copying an over-capacity shared runtime ledger", async () => {
    const pool = new FakePostgresRuntimePool();
    for (let index = 0; index < 101; index += 1) {
      pool.rows.set(`entry:${index}`, {
        entry_id: index + 1,
        entry_key: `entry:${index}`,
        kind: "event",
        proposal_id: null,
        tenant_id: "acme",
        capability: "billing.inspect_invoice",
        payload_json: { index },
        created_at: "2026-07-12T00:00:00.000Z",
      });
    }
    const store = new PostgresProposalRuntimeStore({ pool, maxEntries: 100 });
    await expect(store.getProposal("missing")).rejects.toMatchObject({ code: "POSTGRES_RUNTIME_STORE_CAPACITY_EXCEEDED" });
  });

  it("enforces aggregate policy limits atomically and records human-review fallback", () => {
    const store = new ProposalStore();
    const limits = [
      { kind: "count" as const, max: 2, period: "day" as const, scope: "tenant_policy" as const },
      { kind: "total" as const, field: "credit_cents", max: 5000, period: "day" as const, scope: "tenant_policy" as const },
    ];
    const create = (id: string, objectId: string, credit: number) => {
      const proposal = structuredClone(changeSet) as any;
      proposal.proposal_id = id;
      proposal.scope.object_id = objectId;
      proposal.source.primary_key.value = objectId;
      proposal.patch = { credit_cents: credit };
      proposal.after = { ...proposal.before, credit_cents: credit };
      proposal.guards.allowed_columns = ["credit_cents"];
      proposal.integrity.proposal_hash = `sha256:${id}`;
      store.createProposal(proposal);
      return proposal;
    };
    try {
      const first = create("wrp_limit_1", "INV-LIMIT-1", 2000);
      const second = create("wrp_limit_2", "INV-LIMIT-2", 2500);
      const third = create("wrp_limit_3", "INV-LIMIT-3", 1000);
      expect(store.approveProposalByPolicy(first.proposal_id, {
        policy: "small_credit",
        proposal_hash: first.integrity.proposal_hash,
        proposal_version: 1,
        reason: "qualified",
        limits,
        now: "2026-07-12T01:00:00.000Z",
      }).approved).toBe(true);
      expect(store.approveProposalByPolicy(second.proposal_id, {
        policy: "small_credit",
        proposal_hash: second.integrity.proposal_hash,
        proposal_version: 1,
        reason: "qualified",
        limits,
        now: "2026-07-12T02:00:00.000Z",
      }).approved).toBe(true);

      const deferred = store.approveProposalByPolicy(third.proposal_id, {
        policy: "small_credit",
        proposal_hash: third.integrity.proposal_hash,
        proposal_version: 1,
        reason: "qualified",
        limits,
        now: "2026-07-12T03:00:00.000Z",
      });

      expect(deferred.approved).toBe(false);
      expect(deferred.proposal.state).toBe("pending_review");
      expect(deferred.tripped_limits.map((limit) => limit.kind)).toEqual(["count", "total"]);
      expect(deferred.tripped_limits[0]).toMatchObject({ observed: 2, proposed: 1, projected: 3 });
      expect(deferred.tripped_limits[1]).toMatchObject({ observed: 4500, proposed: 1000, projected: 5500 });
      expect(store.events(third.proposal_id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "policy_auto_approval_deferred",
          actor: "policy:small_credit",
          payload: expect.objectContaining({ fallback: "human_review" }),
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it("persists immutable proposals and append-only events", () => {
    const store = new ProposalStore();
    try {
      const proposal = store.createProposal(changeSet);
      expect(proposal.state).toBe("pending_review");
      expect(proposal.source_database_mutated).toBe(false);
      expect(store.createProposal(changeSet).proposal_hash).toBe("sha256:proposal");
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual(["proposal_created"]);
    } finally {
      store.close();
    }
  });

  it("persists a fail-closed writeback intent across the source mutation boundary", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", {
        approver: "support_lead",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      const job = store.recordWritebackJob(writebackJob);
      const claim = store.claimWritebackIntent(job, "runner_a");
      expect(claim).toEqual({ decision: "proceed", intent_id: "wbi:wbj_123" });
      expect(store.getWritebackIntent("wbi:wbj_123")).toMatchObject({ status: "intent_recorded", operation: "single_row_update" });

      store.markWritebackIntentApplying("wbi:wbj_123", "runner_a");
      expect(store.claimWritebackIntent(job, "runner_b")).toMatchObject({
        decision: "reconciliation_required",
        intent_id: "wbi:wbj_123",
      });

      const result = {
        protocol_version: "1.0" as const,
        job_id: "wbj_123",
        runner_id: "runner_a",
        status: "applied" as const,
        affected_rows: 1,
        result_hash: "sha256:result",
        completed_at: "2026-07-13T01:00:00Z",
      };
      store.completeWritebackIntent("wbi:wbj_123", result);
      expect(store.claimWritebackIntent(job, "runner_b")).toEqual({
        decision: "existing_result",
        intent_id: "wbi:wbj_123",
        result,
      });
      expect(store.sharedLedgerEntries()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "writeback_intent", entry_key: "writeback_intents:wbi:wbj_123" }),
      ]));
    } finally {
      store.close();
    }
  });

  it("requires reconciliation after an incomplete applying intent is restored", () => {
    const first = new ProposalStore();
    const restored = new ProposalStore();
    try {
      first.createProposal(changeSet);
      first.approveProposal("wrp_123", {
        approver: "support_lead",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      const job = first.recordWritebackJob(writebackJob);
      first.claimWritebackIntent(job, "runner_a");
      first.markWritebackIntentApplying("wbi:wbj_123", "runner_a");

      restored.importSharedLedgerEntries(first.sharedLedgerEntries());
      const restoredJob = restored.getWritebackIntent("wbi:wbj_123")?.intent;
      if (!restoredJob) throw new Error("restored intent missing");
      expect(restored.claimWritebackIntent(restoredJob, "runner_b")).toMatchObject({
        decision: "reconciliation_required",
        reason: expect.stringContaining("source mutation boundary"),
      });
    } finally {
      first.close();
      restored.close();
    }
  });

  it("records a signed reconciliation as an immutable terminal receipt", () => {
    const store = new ProposalStore();
    try {
      const change = operationChangeSet("single_row_update", "reconcile");
      store.createProposal(change);
      store.approveProposal(change.proposal_id, {
        approver: "support_lead",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: 1,
      });
      const workerDigest = `sha256:${"f".repeat(64)}` as const;
      store.enqueueWorkerProposal({
        proposal_id: change.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: workerDigest,
      });
      const workerLease = store.claimWorkerItem({
        workerId: "runner_a",
        executionMode: "supervised_worker",
        capability: change.action,
        contractDigest: workerDigest,
      });
      if (!workerLease?.lease_id) throw new Error("expected worker lease");
      const job = store.createWritebackJobFromProposal(change.proposal_id);
      const claim = store.claimWritebackIntent(job, "runner_a");
      if (claim.decision !== "proceed") throw new Error("expected new intent");
      store.markWritebackIntentApplying(claim.intent_id, "runner_a");
      store.requireWritebackReconciliation(claim.intent_id, "commit acknowledgement missing");
      store.requireWorkerReconciliation({
        proposalId: change.proposal_id,
        workerId: "runner_a",
        leaseId: workerLease.lease_id,
        errorCode: "UNKNOWN_TRANSACTION_OUTCOME",
      });

      const identity: OperatorIdentityProof = {
        provider: "signed_key",
        verified: true,
        subject: "fleet_operator",
        roles: ["runner_operator"],
        key_id: "fleet-key-1",
        algorithm: "ed25519",
        decision: {
          schema_version: "synapsor.operator-decision.v1",
          action: "reconcile",
          proposal_id: change.proposal_id,
          proposal_version: 1,
          proposal_hash: change.integrity.proposal_hash,
          subject: "fleet_operator",
          issued_at: "2026-07-13T02:00:00Z",
          reason: "source version proves the reviewed update committed",
        },
        decision_hash: "sha256:decision",
        signature: "signed-proof",
        integrity_hash: "sha256:identity",
      };
      const receipt = {
        schema_version: "synapsor.execution-receipt.v2" as const,
        writeback_job_id: job.writeback_job_id,
        proposal_id: change.proposal_id,
        proposal_hash: change.integrity.proposal_hash,
        approval_id: job.proposal_hash,
        runner_id: "fleet_operator",
        operation: "single_row_update" as const,
        receipt_authority: "runner_ledger" as const,
        status: "applied" as const,
        target: {
          source_id: job.runner_scope.source_id,
          schema: job.target.schema,
          table: job.target.table,
          identity: [{ column: "id", value: "credit_reconcile" }],
        },
        rows_affected: 0,
        idempotency_key: job.idempotency_key,
        after_digest: "sha256:observed",
        source_database_mutated: true,
        safe_outcome_code: "RECONCILED_APPLIED",
        executed_at: "2026-07-13T02:00:00Z",
        receipt_hash: "sha256:reconciled",
        reconciliation: { intent_id: claim.intent_id, reason: "source version proves the reviewed update committed" },
      };

      const resolved = store.reconcileWritebackIntent({
        intent_id: claim.intent_id,
        receipt,
        actor: "fleet_operator",
        reason: "source version proves the reviewed update committed",
        observation: { classification: "matches_proposed", observed_digest: "sha256:observed" },
        identity,
        require_verified_identity: true,
      });
      expect(resolved).toMatchObject({ status: "applied", result: { status: "applied" } });
      expect(store.getProposal(change.proposal_id)).toMatchObject({ state: "applied", source_database_mutated: true });
      expect(store.receipts(change.proposal_id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: "applied", receipt: expect.objectContaining({ receipt_hash: "sha256:reconciled" }) }),
      ]));
      expect(store.getWorkerQueueItem(change.proposal_id)).toMatchObject({
        status: "completed",
        terminal_outcome: "applied",
      });
      expect(store.events(change.proposal_id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "writeback_reconciled", actor: "fleet_operator" }),
        expect.objectContaining({ kind: "writeback_worker_reconciled", actor: "fleet_operator" }),
      ]));
      expect(() => store.reconcileWritebackIntent({
        intent_id: claim.intent_id,
        receipt,
        actor: "fleet_operator",
        reason: "try to rewrite history",
        observation: {},
        identity,
        require_verified_identity: true,
      })).toThrow(/is applied/i);
    } finally {
      store.close();
    }
  });

  it("derives tenant and capability operational counters from durable records", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
      const job = store.createWritebackJobFromProposal("wrp_123");
      store.recordExecutionReceipt({
        ...appliedReceipt,
        writeback_job_id: job.writeback_job_id,
        idempotency_key: job.idempotency_key,
      });

      expect(store.operationalMetrics()).toEqual([{
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
        proposals: 1,
        approvals: 1,
        rejections: 0,
        applies: 1,
        conflicts: 0,
        failures: 0,
        revert_proposals: 0,
        revert_applies: 0,
      }]);
      expect(store.operationalMetrics({ tenant: "other" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("derives bounded freshness counters from durable proof and writeback events", () => {
    const store = new ProposalStore();
    try {
      const applyBlocked = freshnessChangeSet(1, "wrp_freshness_apply_metrics");
      store.createProposal(applyBlocked);
      const fresh = store.recordFreshnessProof(freshnessProofFor(applyBlocked));
      store.approveProposal(applyBlocked.proposal_id, {
        approver: "support_lead",
        proposal_hash: applyBlocked.integrity.proposal_hash,
        proposal_version: applyBlocked.proposal_version,
        freshness_proof_digest: fresh.proof_digest,
      });
      const job = store.createWritebackJobFromProposal(applyBlocked.proposal_id);
      store.recordExecutionReceipt({
        ...appliedReceipt,
        writeback_job_id: job.writeback_job_id,
        proposal_id: applyBlocked.proposal_id,
        idempotency_key: job.idempotency_key,
        status: "conflict",
        rows_affected: 0,
        source_database_mutated: false,
        safe_error_code: "FRESHNESS_DEPENDENCY_STALE",
        receipt_hash: "sha256:freshness-apply-blocked",
      });

      const unavailable = freshnessChangeSet(1, "wrp_freshness_unavailable_metrics");
      store.createProposal(unavailable);
      const unavailableProof = store.recordFreshnessProof(freshnessProofFor(unavailable, "unavailable"));
      store.recordFreshnessApprovalBlocked(unavailable.proposal_id, {
        proof_digest: unavailableProof.proof_digest,
        safe_code: unavailableProof.safe_code,
        actor: "support_lead",
      });

      const staleTarget = freshnessChangeSet(1, "wrp_freshness_target_metrics");
      store.createProposal(staleTarget);
      store.recordFreshnessProof(freshnessProofFor(staleTarget, "stale"));

      const staleSupporting = freshnessChangeSet(1, "wrp_freshness_support_metrics");
      store.createProposal(staleSupporting);
      store.recordFreshnessProof(freshnessProofFor(
        staleSupporting,
        "stale",
        new Date().toISOString(),
        "supporting",
      ));

      expect(store.fleetEventMetrics()).toEqual([expect.objectContaining({
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
        freshness_checks: 4,
        freshness_fresh: 1,
        freshness_stale_target: 1,
        freshness_stale_supporting: 1,
        freshness_unavailable: 1,
        freshness_unsupported: 0,
        freshness_approval_blocked: 1,
        freshness_apply_blocked: 1,
      })]);
      expect(store.fleetEventMetrics({ tenant: "other" })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("preserves immutable principal row scope in generated writeback jobs", () => {
    const store = new ProposalStore();
    try {
      const scoped: any = structuredClone(changeSet);
      const material = {
        column: "assigned_to",
        binding: "principal",
        provider: "environment" as const,
        value: "support_agent_17",
      };
      scoped.guards.principal_scope = {
        schema_version: protocolVersions.principalScope,
        ...material,
        value_fingerprint: principalScopeFingerprint(material),
      };
      store.createProposal(scoped);
      store.approveProposal(scoped.proposal_id, {
        approver: "support_lead",
        proposal_hash: scoped.integrity.proposal_hash,
        proposal_version: scoped.proposal_version,
      });
      const job: any = store.createWritebackJobFromProposal(scoped.proposal_id);
      expect(job.principal_scope).toEqual(scoped.guards.principal_scope);
      expect(parseWritebackJob(job).target.principal_scope).toEqual(scoped.guards.principal_scope);
    } finally {
      store.close();
    }
  });

  it("requires an immutable fresh proof for freshness-bound approval", () => {
    const store = new ProposalStore();
    try {
      const change = freshnessChangeSet();
      store.createProposal(change);
      expect(() => store.approveProposal(change.proposal_id, {
        approver: "support_lead",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: 1,
      })).toThrowError(expect.objectContaining({ code: "FRESHNESS_PROOF_REQUIRED" }));

      const proof = store.recordFreshnessProof(freshnessProofFor(change));
      const approved = store.approveProposal(change.proposal_id, {
        approver: "support_lead",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: 1,
        freshness_proof_digest: proof.proof_digest,
      });
      expect(approved.state).toBe("approved");
      expect(store.latestFreshnessProof(change.proposal_id)).toEqual(proof);
      expect(store.approvals(change.proposal_id)).toEqual([
        expect.objectContaining({ freshness_proof_digest: proof.proof_digest }),
      ]);
      expect(store.events(change.proposal_id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal_freshness_checked",
          payload: { proof },
        }),
        expect.objectContaining({
          kind: "proposal_approved",
          payload: expect.objectContaining({ freshness_proof_digest: proof.proof_digest }),
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it("preserves freshness proofs and approval bindings through shared-ledger restore", () => {
    const source = new ProposalStore();
    const restored = new ProposalStore();
    try {
      const change = freshnessChangeSet(1, "wrp_freshness_shared_restore");
      source.createProposal(change);
      const proof = source.recordFreshnessProof(freshnessProofFor(change));
      source.approveProposal(change.proposal_id, {
        approver: "support_lead",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: change.proposal_version,
        freshness_proof_digest: proof.proof_digest,
      });

      const entries = source.sharedLedgerEntries();
      expect(restored.importSharedLedgerEntries(entries)).toMatchObject({
        imported: entries.length,
        skipped: 0,
      });
      expect(restored.latestFreshnessProof(change.proposal_id)).toEqual(proof);
      expect(restored.approvals(change.proposal_id)).toEqual([
        expect.objectContaining({
          approver: "support_lead",
          freshness_proof_digest: proof.proof_digest,
        }),
      ]);
      const replay = restored.replay(change.proposal_id);
      expect(replay.approvals).toEqual([
        expect.objectContaining({ freshness_proof_digest: proof.proof_digest }),
      ]);
      expect(replay.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "proposal_freshness_checked",
          payload: { proof },
        }),
        expect.objectContaining({
          kind: "proposal_approved",
          payload: expect.objectContaining({ freshness_proof_digest: proof.proof_digest }),
        }),
      ]));
      expect(restored.createWritebackJobFromProposal(change.proposal_id)).toMatchObject({
        proposal_id: change.proposal_id,
        freshness: change.freshness,
      });
    } finally {
      source.close();
      restored.close();
    }
  });

  it("rejects tampered, unavailable, and expired freshness proofs", () => {
    const store = new ProposalStore();
    try {
      const change = freshnessChangeSet();
      store.createProposal(change);
      const tampered = freshnessProofFor(change);
      tampered.safe_code = "FRESHNESS_TAMPERED";
      expect(() => store.recordFreshnessProof(tampered)).toThrow();

      const unavailable = store.recordFreshnessProof(freshnessProofFor(change, "unavailable"));
      expect(store.getProposal(change.proposal_id)?.state).toBe("pending_review");
      expect(() => store.approveProposal(change.proposal_id, {
        approver: "support_lead",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: 1,
        freshness_proof_digest: unavailable.proof_digest,
      })).toThrowError(expect.objectContaining({ code: "FRESHNESS_NOT_VERIFIED" }));

      const expired = store.recordFreshnessProof(freshnessProofFor(
        change,
        "fresh",
        "2026-01-01T00:00:00.000Z",
      ));
      expect(() => store.approveProposal(change.proposal_id, {
        approver: "support_lead",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: 1,
        freshness_proof_digest: expired.proof_digest,
      })).toThrowError(expect.objectContaining({ code: "FRESHNESS_PROOF_EXPIRED" }));
    } finally {
      store.close();
    }
  });

  it("blocks a later quorum approval permanently when freshness drifts", () => {
    const store = new ProposalStore();
    try {
      const change = freshnessChangeSet(2);
      store.createProposal(change);
      const firstProof = store.recordFreshnessProof(freshnessProofFor(change));
      expect(store.approveProposal(change.proposal_id, {
        approver: "reviewer_a",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: 1,
        freshness_proof_digest: firstProof.proof_digest,
      }).state).toBe("pending_review");

      const staleProof = store.recordFreshnessProof(freshnessProofFor(change, "stale"));
      expect(staleProof.result).toBe("stale");
      expect(store.getProposal(change.proposal_id)?.state).toBe("conflict");
      expect(store.approvals(change.proposal_id)).toHaveLength(1);

      const restoredValueProof = store.recordFreshnessProof(freshnessProofFor(change, "fresh"));
      expect(restoredValueProof.result).toBe("fresh");
      expect(() => store.approveProposal(change.proposal_id, {
        approver: "reviewer_b",
        proposal_hash: change.integrity.proposal_hash,
        proposal_version: 1,
        freshness_proof_digest: restoredValueProof.proof_digest,
      })).toThrowError(expect.objectContaining({ code: "PROPOSAL_NOT_PENDING_REVIEW" }));
      expect(store.approvals(change.proposal_id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("requires distinct reviewers to satisfy a portable approval quorum", () => {
    const store = new ProposalStore();
    try {
      const quorumChangeSet = structuredClone(changeSet);
      (quorumChangeSet.approval as typeof quorumChangeSet.approval & { required_approvals: number }).required_approvals = 2;
      store.createProposal(quorumChangeSet);

      const first = store.approveProposal("wrp_123", {
        approver: "reviewer_a",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      expect(first.state).toBe("pending_review");
      expect(store.approvalProgress("wrp_123")).toEqual({
        approved: 1,
        required: 2,
        remaining: 1,
        rejected: false,
        complete: false,
      });
      expect(() => store.createWritebackJobFromProposal("wrp_123")).toThrowError(expect.objectContaining({
        code: "PROPOSAL_NOT_APPROVED",
      }));
      expect(() => store.approveProposal("wrp_123", {
        approver: "reviewer_a",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      })).toThrowError(expect.objectContaining({ code: "APPROVER_ALREADY_COUNTED" }));

      const second = store.approveProposal("wrp_123", {
        approver: "reviewer_b",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      expect(second.state).toBe("approved");
      expect(store.approvalProgress("wrp_123")).toMatchObject({ approved: 2, required: 2, remaining: 0, complete: true });
      expect(store.createWritebackJobFromProposal("wrp_123").proposal_id).toBe("wrp_123");
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual(expect.arrayContaining([
        "proposal_approval_recorded",
        "proposal_approved",
      ]));
    } finally {
      store.close();
    }
  });

  it("defers policy auto-approval for multi-reviewer quorum and preserves rejection", () => {
    const store = new ProposalStore();
    try {
      const quorumChangeSet = structuredClone(changeSet);
      (quorumChangeSet.approval as typeof quorumChangeSet.approval & { required_approvals: number }).required_approvals = 2;
      store.createProposal(quorumChangeSet);

      const policy = store.approveProposalByPolicy("wrp_123", {
        policy: "small_credit",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
        reason: "qualified",
      });
      expect(policy.approved).toBe(false);
      expect(policy.proposal.state).toBe("pending_review");
      expect(store.approvals("wrp_123")).toEqual([]);

      store.approveProposal("wrp_123", {
        approver: "reviewer_a",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      const rejected = store.rejectProposal("wrp_123", {
        actor: "reviewer_b",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
        reason: "insufficient evidence",
      });
      expect(rejected.state).toBe("rejected");
      expect(store.approvalProgress("wrp_123")).toMatchObject({ approved: 1, required: 2, rejected: true, complete: false });
      expect(() => store.approveProposal("wrp_123", {
        approver: "reviewer_c",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      })).toThrowError(expect.objectContaining({ code: "PROPOSAL_NOT_PENDING_REVIEW" }));
    } finally {
      store.close();
    }
  });

  it("leases supervised worker items and dead-letters after the retry budget", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
      expect(store.enqueueApprovedForWorker({ maxAttempts: 2, now: "2026-07-12T00:00:00.000Z" })).toEqual([
        expect.objectContaining({ proposal_id: "wrp_123", status: "queued", attempts: 0, max_attempts: 2 }),
      ]);

      const first = store.claimWorkerItem({ workerId: "worker_a", leaseSeconds: 30, now: "2026-07-12T00:00:01.000Z" });
      expect(first).toMatchObject({ status: "leased", attempts: 1, lease_owner: "worker_a" });
      expect(() => store.completeWorkerItem("wrp_123", "worker_a", "applied"))
        .toThrowError(expect.objectContaining({ code: "WORKER_LEASE_ID_REQUIRED" }));
      expect(() => store.completeWorkerItem("wrp_123", "worker_b", "applied", undefined, first!.lease_id))
        .toThrow(/does not hold the lease/);
      expect(store.retryWorkerItem({
        proposalId: "wrp_123",
        workerId: "worker_a",
        leaseId: first!.lease_id!,
        errorCode: "HANDLER_TIMEOUT",
        retryAt: "2026-07-12T00:00:02.000Z",
        now: "2026-07-12T00:00:01.500Z",
      })).toMatchObject({ status: "retry_wait", attempts: 1 });

      const second = store.claimWorkerItem({ workerId: "worker_b", leaseSeconds: 30, now: "2026-07-12T00:00:02.000Z" });
      expect(second).toMatchObject({ status: "leased", attempts: 2, lease_owner: "worker_b" });
      expect(store.retryWorkerItem({
        proposalId: "wrp_123",
        workerId: "worker_b",
        leaseId: second!.lease_id!,
        errorCode: "HANDLER_TIMEOUT",
        retryAt: "2026-07-12T00:00:04.000Z",
        now: "2026-07-12T00:00:02.500Z",
      })).toMatchObject({ status: "dead_letter", attempts: 2, last_error_code: "HANDLER_TIMEOUT" });
      expect(store.claimWorkerItem({ workerId: "worker_c", now: "2026-07-12T00:01:00.000Z" })).toBeUndefined();
      expect(store.events("wrp_123")).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "writeback_retry_scheduled" }),
        expect.objectContaining({ kind: "writeback_dead_lettered" }),
      ]));

      expect(store.requeueDeadLetter({
        proposalId: "wrp_123",
        retryBudget: 3,
        identity: verifiedWorkerIdentity("worker_requeue"),
        reason: "dependency recovered",
        now: "2026-07-12T00:01:01.000Z",
      })).toMatchObject({ status: "queued", attempts: 0, max_attempts: 3 });
      const reclaimed = store.claimWorkerItem({ workerId: "worker_d", now: "2026-07-12T00:01:02.000Z" });
      expect(reclaimed).toMatchObject({ status: "leased", attempts: 1 });
      store.deadLetterWorkerItem({
        proposalId: "wrp_123",
        workerId: "worker_d",
        leaseId: reclaimed!.lease_id!,
        errorCode: "POLICY_REJECTED",
      });
      expect(store.discardDeadLetter({
        proposalId: "wrp_123",
        identity: verifiedWorkerIdentity("worker_discard"),
        reason: "operator closed terminal work item",
      })).toMatchObject({ status: "discarded" });
      expect(store.receipts("wrp_123")).toEqual([]);
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual(expect.arrayContaining([
        "writeback_dead_letter_requeued",
        "writeback_dead_letter_discarded",
      ]));
    } finally {
      store.close();
    }
  });

  it("binds supervised worker queue authority to an exact digest and fenced lease", () => {
    const store = new ProposalStore();
    const digest = `sha256:${"a".repeat(64)}` as const;
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", {
        approver: "support_lead",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      expect(store.enqueueWorkerProposal({
        proposal_id: "wrp_123",
        execution_mode: "supervised_worker",
        contract_digest: digest,
        max_attempts: 3,
        queue_limit: 1,
        now: "2026-07-12T00:00:00.000Z",
      })).toMatchObject({
        status: "queued",
        execution_mode: "supervised_worker",
        contract_digest: digest,
        attempts: 0,
      });
      expect(() => store.enqueueWorkerProposal({
        proposal_id: "wrp_123",
        execution_mode: "supervised_worker",
        contract_digest: `sha256:${"b".repeat(64)}`,
      })).toThrowError(expect.objectContaining({ code: "WORKER_QUEUE_AUTHORITY_MISMATCH" }));
      expect(store.claimWorkerItem({
        workerId: "worker_a",
        executionMode: "supervised_worker",
        capability: changeSet.action,
        contractDigest: `sha256:${"b".repeat(64)}`,
        now: "2026-07-12T00:00:01.000Z",
      })).toBeUndefined();

      const first = store.claimWorkerItem({
        workerId: "worker_a",
        executionMode: "supervised_worker",
        capability: changeSet.action,
        contractDigest: digest,
        leaseSeconds: 15,
        now: "2026-07-12T00:00:01.000Z",
      });
      expect(first).toMatchObject({ status: "leased", execution_mode: "supervised_worker", contract_digest: digest });
      expect(first?.lease_id).toMatch(/^wlease_[a-f0-9]{32}$/);
      expect(store.assertActiveWorkerLease({
        proposalId: "wrp_123",
        workerId: "worker_a",
        leaseId: first!.lease_id!,
        now: "2026-07-12T00:00:15.000Z",
      })).toMatchObject({ lease_id: first?.lease_id });
      expect(() => store.assertActiveWorkerLease({
        proposalId: "wrp_123",
        workerId: "worker_a",
        leaseId: first!.lease_id!,
        now: "2026-07-12T00:00:16.000Z",
      })).toThrowError(expect.objectContaining({ code: "WORKER_LEASE_EXPIRED" }));

      const reclaimed = store.claimWorkerItem({
        workerId: "worker_a",
        executionMode: "supervised_worker",
        capability: changeSet.action,
        contractDigest: digest,
        leaseSeconds: 30,
        now: "2026-07-12T00:00:17.000Z",
      });
      expect(reclaimed?.lease_id).not.toBe(first?.lease_id);
      expect(() => store.completeWorkerItem(
        "wrp_123",
        "worker_a",
        "applied",
        "2026-07-12T00:00:18.000Z",
        first!.lease_id,
      )).toThrowError(expect.objectContaining({ code: "WORKER_LEASE_MISMATCH" }));
      expect(store.renewWorkerLease({
        proposalId: "wrp_123",
        workerId: "worker_a",
        leaseId: reclaimed!.lease_id!,
        leaseSeconds: 60,
        now: "2026-07-12T00:00:18.000Z",
      }).lease_expires_at).toBe("2026-07-12T00:01:18.000Z");
      expect(store.completeWorkerItem(
        "wrp_123",
        "worker_a",
        "applied",
        "2026-07-12T00:00:19.000Z",
        reclaimed!.lease_id,
      )).toMatchObject({ status: "completed", terminal_outcome: "applied", lease_id: undefined });
    } finally {
      store.close();
    }
  });

  it("enforces supervised-worker concurrency and rolling execution limits inside the claim transaction", () => {
    const store = new ProposalStore();
    const digest = `sha256:${"c".repeat(64)}` as const;
    const action = operationChangeSet("single_row_update", "worker_bound_action").action;
    try {
      for (const suffix of ["one", "two"]) {
        const candidate = operationChangeSet("single_row_update", `worker_bound_${suffix}`);
        const proposal = store.createProposal(candidate);
        store.approveProposal(proposal.proposal_id, {
          approver: "support_lead",
          proposal_hash: proposal.proposal_hash,
          proposal_version: proposal.proposal_version,
        });
        store.enqueueWorkerProposal({
          proposal_id: proposal.proposal_id,
          execution_mode: "supervised_worker",
          contract_digest: digest,
          now: "2026-07-12T00:00:00.000Z",
        });
      }

      const first = store.claimWorkerItem({
        workerId: "worker_one",
        executionMode: "supervised_worker",
        capability: action,
        contractDigest: digest,
        maxConcurrent: 1,
        rateLimit: { executions: 1, windowSeconds: 60 },
        leaseSeconds: 30,
        now: "2026-07-12T00:00:01.000Z",
      });
      expect(first).toMatchObject({ status: "leased" });
      expect(store.claimWorkerItem({
        workerId: "worker_two",
        executionMode: "supervised_worker",
        capability: action,
        contractDigest: digest,
        maxConcurrent: 1,
        rateLimit: { executions: 1, windowSeconds: 60 },
        now: "2026-07-12T00:00:02.000Z",
      })).toBeUndefined();

      store.completeWorkerItem(
        first!.proposal_id,
        "worker_one",
        "applied",
        "2026-07-12T00:00:03.000Z",
        first!.lease_id,
      );
      expect(store.claimWorkerItem({
        workerId: "worker_two",
        executionMode: "supervised_worker",
        capability: action,
        contractDigest: digest,
        maxConcurrent: 1,
        rateLimit: { executions: 1, windowSeconds: 60 },
        now: "2026-07-12T00:00:04.000Z",
      })).toBeUndefined();
      expect(store.claimWorkerItem({
        workerId: "worker_two",
        executionMode: "supervised_worker",
        capability: action,
        contractDigest: digest,
        maxConcurrent: 1,
        rateLimit: { executions: 1, windowSeconds: 60 },
        now: "2026-07-12T00:01:04.000Z",
      })).toMatchObject({ status: "leased" });
    } finally {
      store.close();
    }
  });

  it("reserves policy execution limits atomically and blocks expired supervised work before lease", () => {
    const store = new ProposalStore();
    const digest = `sha256:${"e".repeat(64)}` as const;
    const policy = "small_credit";
    const approvalLimits = [{ kind: "count" as const, max: 2, period: "day" as const }];
    const executionLimits = [{ kind: "count" as const, max: 1, period: "day" as const }];
    try {
      for (const suffix of ["one", "two"]) {
        const candidate = operationChangeSet("single_row_update", `worker_policy_${suffix}`);
        const proposal = store.createProposal(candidate);
        expect(store.approveProposalByPolicy(proposal.proposal_id, {
          policy,
          proposal_hash: proposal.proposal_hash,
          proposal_version: proposal.proposal_version,
          reason: "within reviewed approval budget",
          limits: approvalLimits,
          now: "2026-07-13T00:00:00.000Z",
        }).approved).toBe(true);
        store.enqueueWorkerProposal({
          proposal_id: proposal.proposal_id,
          execution_mode: "supervised_worker",
          contract_digest: digest,
          now: "2026-07-13T00:00:00.000Z",
        });
      }

      const first = store.claimWorkerItem({
        workerId: "worker_one",
        executionMode: "supervised_worker",
        capability: "billing.single_row_update",
        contractDigest: digest,
        policyExecution: { policy, limits: executionLimits },
        now: "2026-07-13T00:00:01.000Z",
      });
      expect(first).toMatchObject({ status: "leased" });
      expect(store.claimWorkerItem({
        workerId: "worker_two",
        executionMode: "supervised_worker",
        capability: "billing.single_row_update",
        contractDigest: digest,
        policyExecution: { policy, limits: executionLimits },
        now: "2026-07-13T00:00:02.000Z",
      })).toBeUndefined();
      expect(store.getWorkerQueueItem("wrp_worker_policy_two")).toMatchObject({
        status: "blocked",
        last_error_code: "SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED",
      });
      expect(store.listAttentionItems({ severity: "critical" })).toEqual(expect.arrayContaining([
        expect.objectContaining({ event_type: "policy.limit_exceeded", status: "open" }),
      ]));
      expect(store.events("wrp_worker_policy_two")).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "writeback_worker_blocked",
          payload: expect.objectContaining({
            error_code: "SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED",
          }),
        }),
      ]));
      expect(() => store.assertWorkerPolicyExecutionLimits({
        proposalId: first!.proposal_id,
        policy,
        limits: executionLimits,
        now: "2026-07-13T00:00:03.000Z",
      })).not.toThrow();
      store.blockWorkerItem({
        proposalId: first!.proposal_id,
        workerId: "worker_one",
        leaseId: first!.lease_id!,
        errorCode: "SUPERVISED_WORKER_POLICY_STALE",
        now: "2026-07-13T00:00:04.000Z",
      });
      expect(store.listAttentionItems({ severity: "critical" })).toEqual(expect.arrayContaining([
        expect.objectContaining({ event_type: "contract.digest_stale", status: "open" }),
      ]));

      const expired = operationChangeSet("single_row_update", "worker_expired");
      const expiredProposal = store.createProposal(expired);
      store.approveProposal(expiredProposal.proposal_id, {
        approver: "support_lead",
        proposal_hash: expiredProposal.proposal_hash,
        proposal_version: expiredProposal.proposal_version,
      });
      store.enqueueWorkerProposal({
        proposal_id: expiredProposal.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: digest,
        now: "2026-07-13T00:00:00.000Z",
      });
      const expiryKey = `production:proposal.expiring:${expiredProposal.proposal_id}`;
      store.recordAttentionEvent({
        event_type: "proposal.expiring",
        severity: "warning",
        environment: "production",
        proposal_id: expiredProposal.proposal_id,
        capability: expiredProposal.action,
        contract_digest: digest,
        attention_key: expiryKey,
        attention_required: true,
        immediate_default: true,
        expires_at: "2026-07-13T00:01:00.000Z",
        source_event_key: `test:${expiryKey}`,
      });
      expect(store.claimWorkerItem({
        workerId: "worker_three",
        executionMode: "supervised_worker",
        capability: "billing.single_row_update",
        contractDigest: digest,
        proposalTtlSeconds: 60,
        now: "2026-07-14T00:00:00.000Z",
      })).toBeUndefined();
      expect(store.getWorkerQueueItem(expiredProposal.proposal_id)).toMatchObject({
        status: "blocked",
        last_error_code: "SUPERVISED_WORKER_PROPOSAL_EXPIRED",
      });
      expect(store.listAttentionEvents({ proposal_id: expiredProposal.proposal_id })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_type: "proposal.expired",
          severity: "warning",
          immediate_default: false,
        }),
      ]));
      expect(store.listAttentionItems({ status: "expired" })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_type: "proposal.expired",
          capability: expiredProposal.action,
          status: "expired",
          title: "Approved proposal expired without execution",
        }),
      ]));
    } finally {
      store.close();
    }
  });

  it("enforces one policy reservation across two supervised worker processes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-supervised-workers-"));
    const storePath = path.join(tempDir, "local.db");
    const digest = `sha256:${"f".repeat(64)}` as const;
    const policy = "small_credit";
    const action = "billing.single_row_update";
    const store = new ProposalStore(storePath);
    try {
      for (const suffix of ["process_one", "process_two"]) {
        const candidate = operationChangeSet("single_row_update", suffix);
        const proposal = store.createProposal(candidate);
        expect(store.approveProposalByPolicy(proposal.proposal_id, {
          policy,
          proposal_hash: proposal.proposal_hash,
          proposal_version: proposal.proposal_version,
          reason: "within reviewed approval budget",
          limits: [{ kind: "count", max: 2, period: "day" }],
          now: "2026-07-13T00:00:00.000Z",
        }).approved).toBe(true);
        store.enqueueWorkerProposal({
          proposal_id: proposal.proposal_id,
          execution_mode: "supervised_worker",
          contract_digest: digest,
          now: "2026-07-13T00:00:00.000Z",
        });
      }
    } finally {
      store.close();
    }

    const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
    const childSource = `
      const { ProposalStore } = await import(process.argv[1]);
      const store = new ProposalStore(process.argv[2]);
      try {
        const item = store.claimWorkerItem({
          workerId: process.argv[3],
          executionMode: "supervised_worker",
          capability: process.argv[4],
          contractDigest: process.argv[5],
          policyExecution: {
            policy: process.argv[6],
            limits: [{ kind: "count", max: 1, period: "day" }],
          },
          leaseSeconds: 60,
          now: "2026-07-13T00:00:01.000Z",
        });
        process.stdout.write(JSON.stringify({ proposal_id: item?.proposal_id ?? null }));
      } finally {
        store.close();
      }
    `;
    const runWorker = (workerId: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        childSource,
        moduleUrl,
        storePath,
        workerId,
        action,
        digest,
        policy,
      ], {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

    try {
      const results = await Promise.all([
        runWorker("worker_process_one"),
        runWorker("worker_process_two"),
      ]);
      expect(results).toEqual([
        expect.objectContaining({ code: 0, stderr: "" }),
        expect.objectContaining({ code: 0, stderr: "" }),
      ]);
      const claimed = results
        .map((result) => JSON.parse(result.stdout) as { proposal_id: string | null })
        .filter((result) => result.proposal_id !== null);
      expect(claimed).toHaveLength(1);

      const verified = new ProposalStore(storePath);
      try {
        expect(verified.listWorkerQueue().filter((item) => item.status === "leased")).toHaveLength(1);
        expect(verified.listWorkerQueue().filter((item) =>
          item.status === "blocked"
          && item.last_error_code === "SUPERVISED_WORKER_POLICY_LIMIT_EXCEEDED"))
          .toHaveLength(1);
        expect(verified.receipts("wrp_process_one")).toEqual([]);
        expect(verified.receipts("wrp_process_two")).toEqual([]);
      } finally {
        verified.close();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("binds supervised-worker pause and exact-digest revocation to one integrity-checked operator revision", () => {
    const store = new ProposalStore();
    const digest = `sha256:${"d".repeat(64)}` as const;
    try {
      expect(store.workerControlState()).toMatchObject({ mode: "active", revision: 0, capability_controls: [] });
      const pauseTarget = { action: "pause" as const };
      const pauseIdentity = verifiedWorkerControlIdentity(store, pauseTarget);
      expect(store.updateWorkerControl({
        ...pauseTarget,
        actor: pauseIdentity.subject,
        identity: pauseIdentity,
        require_verified_identity: true,
        now: "2026-07-12T00:00:04.000Z",
      })).toMatchObject({ mode: "paused", revision: 1 });

      expect(() => store.updateWorkerControl({
        action: "resume",
        actor: pauseIdentity.subject,
        identity: pauseIdentity,
        require_verified_identity: true,
        now: "2026-07-12T00:00:05.000Z",
      })).toThrowError(expect.objectContaining({ code: "OPERATOR_DECISION_MISMATCH" }));

      const resumeTarget = { action: "resume" as const };
      const resumeIdentity = verifiedWorkerControlIdentity(store, resumeTarget);
      expect(store.updateWorkerControl({
        ...resumeTarget,
        actor: resumeIdentity.subject,
        identity: resumeIdentity,
        require_verified_identity: true,
        now: "2026-07-12T00:00:06.000Z",
      })).toMatchObject({ mode: "active", revision: 2 });

      const revokeTarget = {
        action: "digest_revoke" as const,
        capability: "billing.single_row_update",
        contract_digest: digest,
      };
      const revokeIdentity = verifiedWorkerControlIdentity(store, revokeTarget);
      expect(store.updateWorkerControl({
        ...revokeTarget,
        actor: revokeIdentity.subject,
        identity: revokeIdentity,
        require_verified_identity: true,
        now: "2026-07-12T00:00:07.000Z",
      })).toMatchObject({
        revision: 3,
        capability_controls: [{
          capability: "billing.single_row_update",
          contract_digest: digest,
          status: "revoked",
        }],
      });

      const enableTarget = {
        action: "capability_enable" as const,
        capability: "billing.single_row_update",
        contract_digest: digest,
      };
      const enableIdentity = verifiedWorkerControlIdentity(store, enableTarget);
      expect(() => store.updateWorkerControl({
        ...enableTarget,
        actor: enableIdentity.subject,
        identity: enableIdentity,
        require_verified_identity: true,
      })).toThrowError(expect.objectContaining({ code: "WORKER_DIGEST_REVOKED" }));

      store.db.prepare("UPDATE runner_state SET value_json = replace(value_json, '\"revision\":3', '\"revision\":99') WHERE key = 'supervised_worker_control'").run();
      expect(() => store.workerControlState()).toThrowError(
        expect.objectContaining({ code: "WORKER_CONTROL_STATE_TAMPERED" }),
      );
    } finally {
      store.close();
    }
  });

  it("commits proposal state and projected human-attention events atomically", () => {
    const store = new ProposalStore();
    const candidate = operationChangeSet("single_row_update", "attention_atomic");
    try {
      store.db.exec(`
        CREATE TRIGGER reject_attention_event
        BEFORE INSERT ON attention_events
        BEGIN
          SELECT RAISE(ABORT, 'simulated attention outbox failure');
        END
      `);
      expect(() => store.createProposal(candidate)).toThrow(/simulated attention outbox failure/);
      expect(store.getProposal(candidate.proposal_id)).toBeUndefined();
      expect(store.events(candidate.proposal_id)).toEqual([]);
      expect(store.listAttentionEvents()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("coalesces human-review events without turning acknowledgement into approval", () => {
    const store = new ProposalStore();
    const first = operationChangeSet("single_row_update", "attention_first");
    const second = operationChangeSet("single_row_update", "attention_second");
    const otherTenant = operationChangeSet("single_row_update", "attention_other_tenant");
    otherTenant.scope.tenant_id = "beta";
    otherTenant.guards.tenant.value = "beta";
    otherTenant.before.tenant_id = "beta";
    otherTenant.after.tenant_id = "beta";
    try {
      store.setRunnerState("attention_context", { environment: "production" });
      store.createProposal(first);
      store.createProposal(second);
      store.createProposal(otherTenant);

      const reviewEvents = store.listAttentionEvents({ event_type: "proposal.review_required" });
      expect(reviewEvents).toHaveLength(3);
      expect(reviewEvents.every((event) => event.immediate_default && event.attention_required)).toBe(true);
      expect(JSON.stringify(reviewEvents)).not.toContain("tenant_id");
      expect(JSON.stringify(reviewEvents)).not.toContain("support_agent_17");

      const allItems = store.listAttentionItems({ status: "open" });
      expect(allItems).toHaveLength(2);
      const [item] = store.listAttentionItems({ status: "open", tenant: "acme" });
      expect(item).toMatchObject({
        severity: "warning",
        environment: "production",
        event_type: "proposal.review_required",
        capability: first.action,
        occurrence_count: 2,
      });
      expect(store.listAttentionItems({ tenant: "beta" })).toEqual([
        expect.objectContaining({ occurrence_count: 1 }),
      ]);
      expect(store.listAttentionItems({ tenant: "missing" })).toEqual([]);
      expect(store.listAttentionEvents({ tenant: "acme", event_type: "proposal.review_required" })).toHaveLength(2);
      expect(store.listAttentionEvents({ tenant: "beta", event_type: "proposal.review_required" })).toHaveLength(1);
      expect(item).toBeDefined();
      const acknowledged = store.acknowledgeAttention({
        attention_id: item!.attention_id,
        actor: "operator_alice",
        now: "2026-07-24T00:00:00.000Z",
      });
      expect(acknowledged).toMatchObject({ status: "acknowledged", acknowledged_by: "operator_alice" });
      expect(store.getProposal(first.proposal_id)?.state).toBe("pending_review");
      expect(store.approvals(first.proposal_id)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("resolves a coalesced review item only after its last pending proposal and reopens for new work", () => {
    const store = new ProposalStore();
    const first = operationChangeSet("single_row_update", "attention_resolve_first");
    const second = operationChangeSet("single_row_update", "attention_resolve_second");
    const third = operationChangeSet("single_row_update", "attention_resolve_third");
    try {
      store.setRunnerState("attention_context", { environment: "production" });
      const firstProposal = store.createProposal(first);
      const secondProposal = store.createProposal(second);
      const item = store.listAttentionItems({ status: "open" })
        .find((candidate) => candidate.event_type === "proposal.review_required");
      expect(item).toMatchObject({ occurrence_count: 2, status: "open" });

      store.approveProposal(firstProposal.proposal_id, {
        approver: "support_lead",
        proposal_hash: firstProposal.proposal_hash,
        proposal_version: firstProposal.proposal_version,
      });
      expect(store.getAttentionItem(item!.attention_id)).toMatchObject({ status: "open" });

      store.approveProposal(secondProposal.proposal_id, {
        approver: "support_lead",
        proposal_hash: secondProposal.proposal_hash,
        proposal_version: secondProposal.proposal_version,
      });
      expect(store.getAttentionItem(item!.attention_id)).toMatchObject({ status: "resolved" });

      store.createProposal(third);
      expect(store.getAttentionItem(item!.attention_id)).toMatchObject({
        status: "open",
        occurrence_count: 3,
      });
    } finally {
      store.close();
    }
  });

  it("binds production acknowledgement to one exact attention version and reopens on a new occurrence", () => {
    const store = new ProposalStore();
    const first = operationChangeSet("single_row_update", "attention_identity_first");
    const second = operationChangeSet("single_row_update", "attention_identity_second");
    try {
      store.setRunnerState("attention_context", { environment: "production" });
      store.createProposal(first);
      const [item] = store.listAttentionItems({ status: "open" });
      expect(item).toBeDefined();
      const subject = attentionDecisionSubject(item!);
      const decision = {
        schema_version: "synapsor.operator-decision.v1" as const,
        action: "attention_acknowledge" as const,
        ...subject,
        subject: "operator_alice",
        issued_at: "2026-07-24T00:00:00.000Z",
      };
      const unsignedIdentity = {
        provider: "signed_key" as const,
        verified: true,
        subject: "operator_alice",
        roles: ["runner_operator"],
        key_id: "operator_alice",
        algorithm: "SHA256",
        decision,
        decision_hash: canonicalJsonDigest(decision),
        signature: "test-signature",
      };
      const identity: OperatorIdentityProof = {
        ...unsignedIdentity,
        integrity_hash: canonicalJsonDigest(unsignedIdentity),
      };
      expect(() => store.acknowledgeAttention({
        attention_id: item!.attention_id,
        actor: "operator_alice",
        identity: {
          ...identity,
          decision: { ...identity.decision, proposal_version: identity.decision.proposal_version + 1 },
        },
        require_verified_identity: true,
      })).toThrowError(/exact attention item version/i);

      const acknowledged = store.acknowledgeAttention({
        attention_id: item!.attention_id,
        actor: "operator_alice",
        identity,
        require_verified_identity: true,
        now: "2026-07-24T00:00:01.000Z",
      });
      expect(acknowledged).toMatchObject({
        status: "acknowledged",
        acknowledged_by: "operator_alice",
        acknowledgement_identity: {
          verified: true,
          decision: { action: "attention_acknowledge" },
        },
      });
      expect(store.approvals(first.proposal_id)).toEqual([]);

      store.createProposal(second);
      const reopened = store.getAttentionItem(item!.attention_id);
      expect(reopened).toMatchObject({
        status: "open",
        occurrence_count: 2,
      });
      expect(reopened?.acknowledged_by).toBeUndefined();
      expect(reopened?.acknowledgement_identity).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("keeps successful policy auto-approval quiet by default", () => {
    const store = new ProposalStore();
    const candidate = operationChangeSet("single_row_update", "attention_policy");
    Object.assign(candidate.approval, {
      mode: "policy",
      policy: "small_change",
    });
    try {
      const proposal = store.createProposal(candidate);
      expect(store.listAttentionItems()).toEqual([]);
      const decision = store.approveProposalByPolicy(proposal.proposal_id, {
        policy: "small_change",
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason: "within reviewed bounds",
        limits: [{ kind: "count", max: 1, period: "day" }],
      });
      expect(decision.approved).toBe(true);
      expect(store.listAttentionItems()).toEqual([]);
      expect(store.listAttentionEvents().map((event) => ({
        event_type: event.event_type,
        immediate_default: event.immediate_default,
      }))).toEqual(expect.arrayContaining([
        { event_type: "proposal.created", immediate_default: false },
        { event_type: "proposal.auto_approved", immediate_default: false },
        { event_type: "policy.limit_near", immediate_default: false },
      ]));
      expect(store.listAttentionEvents({ event_type: "policy.limit_near" })).toEqual([
        expect.objectContaining({
          severity: "warning",
          attention_required: false,
          immediate_default: false,
          details: expect.objectContaining({ projected: 1, max: 1 }),
        }),
      ]);
      expect(store.listAttentionEvents().some((event) => event.immediate_default)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("raises one critical attention incident when a worker job dead-letters", () => {
    const store = new ProposalStore();
    const candidate = operationChangeSet("single_row_update", "attention_dead_letter");
    try {
      const proposal = store.createProposal(candidate);
      store.approveProposal(proposal.proposal_id, {
        approver: "support_lead",
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
      });
      store.enqueueWorkerProposal({
        proposal_id: proposal.proposal_id,
        max_attempts: 1,
        now: "2026-07-24T00:00:00.000Z",
      });
      const claimed = store.claimWorkerItem({
        workerId: "worker_attention",
        now: "2026-07-24T00:00:01.000Z",
      });
      expect(claimed?.lease_id).toBeDefined();
      store.deadLetterWorkerItem({
        proposalId: proposal.proposal_id,
        workerId: "worker_attention",
        leaseId: claimed!.lease_id!,
        errorCode: "HANDLER_TIMEOUT",
        now: "2026-07-24T00:00:02.000Z",
      });

      const [event] = store.listAttentionEvents({ event_type: "worker.dead_lettered" });
      expect(event).toMatchObject({
        severity: "critical",
        immediate_default: true,
        attention_required: true,
        failure_class: "HANDLER_TIMEOUT",
      });
      expect(store.listAttentionItems({ severity: "critical" })).toEqual([
        expect.objectContaining({
          event_type: "worker.dead_lettered",
          occurrence_count: 1,
          status: "open",
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("detects tampering in immutable attention event payloads", () => {
    const store = new ProposalStore();
    const candidate = operationChangeSet("single_row_update", "attention_tamper");
    try {
      store.createProposal(candidate);
      const [event] = store.listAttentionEvents({ event_type: "proposal.review_required" });
      expect(event).toBeDefined();
      store.db.prepare("UPDATE attention_events SET summary = ? WHERE event_id = ?")
        .run("tampered summary", event!.event_id);
      expect(() => store.listAttentionEvents({ event_type: "proposal.review_required" }))
        .toThrowError(expect.objectContaining({ code: "ATTENTION_EVENT_CORRUPT" }));
    } finally {
      store.close();
    }
  });

  it("fences notification delivery retries without replaying proposal authority", () => {
    const store = new ProposalStore();
    const candidate = operationChangeSet("single_row_update", "notification_delivery");
    try {
      const proposal = store.createProposal(candidate);
      const [event] = store.listAttentionEvents({ event_type: "proposal.review_required" });
      const [attention] = store.listAttentionItems({ status: "open" });
      const delivery = store.enqueueNotificationDelivery({
        sink_id: "operations",
        event_id: event!.event_id,
        attention_id: attention!.attention_id,
        max_attempts: 2,
        now: "2026-07-24T00:00:00.000Z",
      });
      expect(store.enqueueNotificationDelivery({
        sink_id: "operations",
        event_id: event!.event_id,
        attention_id: attention!.attention_id,
        max_attempts: 2,
        now: "2026-07-24T00:00:00.000Z",
      })).toEqual(delivery);

      const [first] = store.claimNotificationDeliveries({
        owner: "dispatcher_a",
        sink_id: "operations",
        lease_seconds: 15,
        now: "2026-07-24T00:00:01.000Z",
      });
      expect(first).toMatchObject({ status: "leased", attempts: 1, lease_owner: "dispatcher_a" });
      expect(first?.lease_id).toMatch(/^nlease_[a-f0-9]{32}$/);
      expect(store.failNotificationDelivery({
        delivery_id: first!.delivery_id,
        owner: "dispatcher_a",
        lease_id: first!.lease_id!,
        error_code: "WEBHOOK_TIMEOUT",
        retryable: true,
        retry_at: "2026-07-24T00:00:03.000Z",
        now: "2026-07-24T00:00:02.000Z",
      })).toMatchObject({ status: "retry_wait", attempts: 1 });

      const [second] = store.claimNotificationDeliveries({
        owner: "dispatcher_b",
        sink_id: "operations",
        now: "2026-07-24T00:00:03.000Z",
      });
      expect(second).toMatchObject({ status: "leased", attempts: 2, lease_owner: "dispatcher_b" });
      expect(() => store.completeNotificationDelivery({
        delivery_id: second!.delivery_id,
        owner: "dispatcher_a",
        lease_id: first!.lease_id!,
        now: "2026-07-24T00:00:04.000Z",
      })).toThrowError(expect.objectContaining({ code: "NOTIFICATION_LEASE_MISMATCH" }));
      expect(store.completeNotificationDelivery({
        delivery_id: second!.delivery_id,
        owner: "dispatcher_b",
        lease_id: second!.lease_id!,
        external_reference: "incident-17",
        now: "2026-07-24T00:00:04.000Z",
      })).toMatchObject({
        status: "delivered",
        attempts: 2,
        external_reference: "incident-17",
      });

      expect(store.getProposal(proposal.proposal_id)?.state).toBe("pending_review");
      expect(store.approvals(proposal.proposal_id)).toEqual([]);
      expect(store.receipts(proposal.proposal_id)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("binds notification replay to an exact verified operator decision without replaying authority", () => {
    const store = new ProposalStore();
    const candidate = operationChangeSet("single_row_update", "notification_replay");
    const reason = "Webhook destination repaired and synthetic test passed";
    try {
      const proposal = store.createProposal(candidate);
      const [event] = store.listAttentionEvents({ event_type: "proposal.review_required" });
      const [attention] = store.listAttentionItems({ status: "open" });
      store.enqueueNotificationDelivery({
        sink_id: "operations",
        event_id: event!.event_id,
        attention_id: attention!.attention_id,
        max_attempts: 1,
        now: "2026-07-24T00:00:00.000Z",
      });
      const [claimed] = store.claimNotificationDeliveries({
        owner: "dispatcher_a",
        sink_id: "operations",
        now: "2026-07-24T00:00:01.000Z",
      });
      const deadLetter = store.failNotificationDelivery({
        delivery_id: claimed!.delivery_id,
        owner: "dispatcher_a",
        lease_id: claimed!.lease_id!,
        error_code: "WEBHOOK_DESTINATION_BLOCKED",
        retryable: false,
        now: "2026-07-24T00:00:02.000Z",
      });
      const identity = verifiedNotificationReplayIdentity(deadLetter, reason);

      expect(() => store.requeueNotificationDelivery({
        delivery_id: deadLetter.delivery_id,
        identity: { ...identity, provider: "dev_env", verified: false },
        reason,
        now: "2026-07-24T00:00:03.000Z",
      })).toThrowError(expect.objectContaining({ code: "VERIFIED_OPERATOR_IDENTITY_REQUIRED" }));

      expect(() => store.requeueNotificationDelivery({
        delivery_id: deadLetter.delivery_id,
        identity: verifiedNotificationReplayIdentity(deadLetter, "A different recovery reason"),
        reason,
        now: "2026-07-24T00:00:03.000Z",
      })).toThrowError(expect.objectContaining({ code: "OPERATOR_DECISION_MISMATCH" }));

      expect(store.requeueNotificationDelivery({
        delivery_id: deadLetter.delivery_id,
        identity,
        reason,
        now: "2026-07-24T00:00:03.000Z",
      })).toMatchObject({
        delivery_id: deadLetter.delivery_id,
        event_id: deadLetter.event_id,
        status: "pending",
        attempts: 0,
      });

      expect(store.getProposal(proposal.proposal_id)?.state).toBe("pending_review");
      expect(store.approvals(proposal.proposal_id)).toEqual([]);
      expect(store.receipts(proposal.proposal_id)).toEqual([]);
      expect(store.listAttentionEvents({ event_type: "notification.replayed" })).toEqual([
        expect.objectContaining({
          event_type: "notification.replayed",
          proposal_id: proposal.proposal_id,
          attention_required: false,
          immediate_default: false,
          details: expect.objectContaining({
            delivery_id: deadLetter.delivery_id,
            operator_subject: "fleet_operator",
            identity_provider: "signed_key",
            operator_decision_hash: identity.decision_hash,
            reason,
            approval_replayed: false,
            mutation_replayed: false,
            source_database_changed: false,
          }),
        }),
      ]);
    } finally {
      store.close();
    }
  });

  it("reclaims an expired notification lease with the same immutable event identity", () => {
    const store = new ProposalStore();
    const candidate = operationChangeSet("single_row_update", "notification_crash");
    try {
      store.createProposal(candidate);
      const [event] = store.listAttentionEvents({ event_type: "proposal.review_required" });
      const queued = store.enqueueNotificationDelivery({
        sink_id: "incident",
        event_id: event!.event_id,
        max_attempts: 3,
        now: "2026-07-24T00:00:00.000Z",
      });
      const [crashed] = store.claimNotificationDeliveries({
        owner: "dispatcher_crashed",
        lease_seconds: 15,
        now: "2026-07-24T00:00:01.000Z",
      });
      const [reclaimed] = store.claimNotificationDeliveries({
        owner: "dispatcher_recovery",
        lease_seconds: 15,
        now: "2026-07-24T00:00:17.000Z",
      });
      expect(reclaimed).toMatchObject({
        delivery_id: queued.delivery_id,
        event_id: event!.event_id,
        attempts: 2,
        lease_owner: "dispatcher_recovery",
      });
      expect(reclaimed?.lease_id).not.toBe(crashed?.lease_id);
    } finally {
      store.close();
    }
  });

  it("refuses to requeue a dead letter after a receipt proves the effect", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", { approver: "support_lead", proposal_hash: "sha256:proposal", proposal_version: 1 });
      const job = store.createWritebackJobFromProposal("wrp_123");
      store.enqueueApprovedForWorker({ maxAttempts: 2 });
      const claimed = store.claimWorkerItem({ workerId: "worker_a" });
      store.recordExecutionReceipt({ ...appliedReceipt, writeback_job_id: job.writeback_job_id, idempotency_key: job.idempotency_key });
      store.deadLetterWorkerItem({
        proposalId: "wrp_123",
        workerId: "worker_a",
        leaseId: claimed!.lease_id!,
        errorCode: "WORKER_CRASH_AFTER_COMMIT",
      });

      expect(() => store.requeueDeadLetter({
        proposalId: "wrp_123",
        retryBudget: 3,
        identity: verifiedWorkerIdentity("worker_requeue"),
      })).toThrowError(expect.objectContaining({ code: "DEAD_LETTER_EFFECT_ALREADY_RECORDED" }));
    } finally {
      store.close();
    }
  });

  it("rejects duplicate proposal ids with a different hash", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      const modified = structuredClone(changeSet);
      modified.integrity.proposal_hash = "sha256:different";
      expect(() => store.createProposal(modified)).toThrowError(ProposalStoreError);
    } finally {
      store.close();
    }
  });

  it("rejects obvious secret material before it reaches local replay storage", () => {
    const store = new ProposalStore();
    try {
      const secretProposal = structuredClone(changeSet) as typeof changeSet & { before: Record<string, unknown> };
      secretProposal.before = {
        ...secretProposal.before,
        database_url: "postgresql://reader:reader_secret@localhost:5432/app",
      };
      expectSecretRejection(() => store.createProposal(secretProposal));

      store.createProposal(changeSet);
      expectSecretRejection(() => store.recordEvidenceBundle({
        evidence_bundle_id: "ev_secret",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: { bearer: "Bearer should_not_persist" },
      }));
      expectSecretRejection(() => store.recordQueryAudit({
        proposal_id: "wrp_123",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "invoices",
        row_count: 1,
        payload: { api_key: "should_not_persist" },
      }));
      expectSecretRejection(() => store.setRunnerState("bad", {
        runner_token: "syn_wbr_should_not_persist",
      }));
    } finally {
      store.close();
    }
  });

  it("approves only the exact proposal hash and version", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      expect(() => store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:wrong",
        proposal_version: 1
      })).toThrowError(ProposalStoreError);
      const approved = store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
        reason: "within policy"
      });
      expect(approved.state).toBe("approved");
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual([
        "proposal_created",
        "proposal_approved"
      ]);
    } finally {
      store.close();
    }
  });

  it("records execution receipts and terminal state", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1
      });
      store.markPendingWorker("wrp_123", "sha256:proposal", 1);
      store.recordWritebackJob(writebackJob);
      const applied = store.recordExecutionReceipt(appliedReceipt);
      expect(applied.state).toBe("applied");
      expect(applied.source_database_mutated).toBe(true);
      expect(store.receipts("wrp_123")).toHaveLength(1);
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual([
        "proposal_created",
        "proposal_approved",
        "proposal_pending_worker",
        "writeback_job_recorded",
        "writeback_applied"
      ]);
    } finally {
      store.close();
    }
  });

  it("preserves proposal, evidence, pending writeback, receipt, and replay across restarts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-restart-"));
    const storePath = path.join(tempDir, "local.db");
    const restartedReceipt = { ...appliedReceipt, writeback_job_id: "wbj_wrp_123" };
    let store = new ProposalStore(storePath);
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_456",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: {
          capability: "billing.waive_late_fee",
          source_id: "src_pg_acme",
          query_fingerprint: "sha256:evidence",
        },
        items: [{ row: "invoices/INV-3001", visible_row: { id: "INV-3001", late_fee_cents: 5500 } }],
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_456",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "public.invoices",
        row_count: 1,
        payload: { parameters_redacted: true, primary_key: "INV-3001" },
      });
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.getProposal("wrp_123")?.state).toBe("approved");
      const job = store.createWritebackJobFromProposal("wrp_123", {
        project_id: "acme-support",
        runner_id: "runner_123",
        lease_id: "lease_restart",
      });
      expect(job.writeback_job_id).toBe("wbj_wrp_123");
      expect(store.getProposal("wrp_123")?.state).toBe("pending_worker");
      const replay = store.replay("wrp_123");
      expect(replay.evidence).toHaveLength(1);
      expect(replay.query_audit).toHaveLength(1);
      expect(replay.receipts).toHaveLength(0);
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.getProposal("wrp_123")?.state).toBe("pending_worker");
      store.recordExecutionReceipt(restartedReceipt);
      expect(store.getProposal("wrp_123")?.state).toBe("applied");
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.listReceipts({ proposal: "wrp_123", status: "applied" })).toHaveLength(1);
      expect(store.replay("wrp_123").receipts).toHaveLength(1);
      store.recordExecutionReceipt(restartedReceipt);
      expect(store.listReceipts({ proposal: "wrp_123", status: "applied" })).toHaveLength(1);
      expect(store.stats().idempotency_receipts).toBe(1);
    } finally {
      store.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a public writeback job from an approved immutable proposal", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      expect(() => store.createWritebackJobFromProposal("wrp_123")).toThrowError(ProposalStoreError);
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1
      });
      const job = store.createWritebackJobFromProposal("wrp_123", {
        project_id: "acme-support",
        runner_id: "runner_123",
        lease_id: "lease_123"
      });
      expect(job.schema_version).toBe("synapsor.writeback-job.v1");
      if (job.schema_version !== "synapsor.writeback-job.v1") throw new Error("expected v1 writeback job");
      expect(job.writeback_job_id).toBe("wbj_wrp_123");
      expect(job.proposal_hash).toBe("sha256:proposal");
      expect(job.runner_scope).toEqual({ project_id: "acme-support", source_id: "src_pg_acme" });
      expect(job.target.primary_key).toEqual({ column: "id", value: "INV-3001" });
      expect(job.tenant_guard).toEqual({ column: "tenant_id", value: "acme" });
      expect(job.conflict_guard).toEqual({
        kind: "column",
        column: "updated_at",
        expected_value: "2026-06-20T14:31:08Z"
      });
      expect(store.getProposal("wrp_123")?.state).toBe("pending_worker");
      expect(store.events("wrp_123").map((event) => event.kind)).toEqual([
        "proposal_created",
        "proposal_approved",
        "proposal_pending_worker",
        "writeback_job_recorded"
      ]);
    } finally {
      store.close();
    }
  });

  it("creates operation-aware v2 jobs from approved UPDATE, INSERT, and DELETE proposals", () => {
    for (const [operation, suffix] of [
      ["single_row_update", "update"],
      ["single_row_insert", "insert"],
      ["single_row_delete", "delete"],
    ] as const) {
      const store = new ProposalStore();
      try {
        const input = operationChangeSet(operation, suffix);
        store.createProposal(input);
        store.approveProposal(input.proposal_id, {
          approver: "support_lead_1",
          proposal_hash: input.integrity.proposal_hash,
          proposal_version: 1,
        });
        const job = store.createWritebackJobFromProposal(input.proposal_id);
        expect(job.schema_version).toBe("synapsor.writeback-job.v2");
        if (job.schema_version !== "synapsor.writeback-job.v2") throw new Error("expected v2 writeback job");
        expect(job.mutation.kind).toBe(operation);
        expect(job.tenant_guard).toEqual({ column: "tenant_id", value: "acme" });
        if (operation === "single_row_insert" && job.mutation.kind === "single_row_insert") {
          expect(job.mutation.deduplication.components).toEqual(expect.arrayContaining([
            { column: "request_id", value: input.proposal_id, source: "proposal_id" },
          ]));
        }
        if (operation === "single_row_delete") expect(job.allowed_columns).toEqual([]);
      } finally {
        store.close();
      }
    }
  });

  it("captures reviewed inverse authority for reversible CRUD without hidden fields", () => {
    for (const [operation, suffix, expectedInverse] of [
      ["single_row_update", "reversible_update", "restore_update"],
      ["single_row_insert", "reversible_insert", "remove_insert"],
      ["single_row_delete", "reversible_delete", "restore_insert"],
    ] as const) {
      const store = new ProposalStore();
      try {
        const input = reversibleOperationChangeSet(operation, suffix);
        if (operation === "single_row_update") {
          input.before.internal_note = "kept-out";
          input.after.internal_note = "kept-out";
        }
        store.createProposal(input);
        store.approveProposal(input.proposal_id, { approver: "reviewer", proposal_hash: input.integrity.proposal_hash, proposal_version: 1 });
        const job = store.createWritebackJobFromProposal(input.proposal_id);
        expect(job.schema_version).toBe(protocolVersions.writebackJobV2);
        if (job.schema_version !== protocolVersions.writebackJobV2) throw new Error("expected v2 job");
        expect(job.inverse_capture?.operation).toBe(expectedInverse);
        expect(JSON.stringify(job.inverse_capture)).not.toContain("internal_note");
        if (operation === "single_row_delete") {
          expect(job.inverse_capture).toMatchObject({ availability: "best_effort_unavailable" });
        } else {
          expect(job.inverse_capture).toMatchObject({ availability: "available", cardinality: "single" });
        }
      } finally {
        store.close();
      }
    }
  });

  it("creates a v4 compensation job from a separately approved revert proposal", () => {
    const store = new ProposalStore();
    try {
      const forward = reversibleOperationChangeSet("single_row_update", "forward_revert");
      store.createProposal(forward);
      store.approveProposal(forward.proposal_id, { approver: "reviewer_a", proposal_hash: forward.integrity.proposal_hash, proposal_version: 1 });
      const forwardJob = store.createWritebackJobFromProposal(forward.proposal_id);
      if (forwardJob.schema_version !== protocolVersions.writebackJobV2 || !forwardJob.inverse_capture) throw new Error("expected reversible forward job");

      const compensation: any = {
        schema_version: protocolVersions.compensationChangeSet,
        proposal_id: "wrp_compensation_1",
        proposal_version: 1,
        action: "billing.revert_single_row_update",
        mode: "review_required",
        principal: forward.principal,
        scope: forward.scope,
        source: forward.source,
        before: forward.after,
        patch: forward.before,
        after: forward.before,
        compensation: { descriptor: forwardJob.inverse_capture, forward_receipt_hash: "sha256:forward-receipt" },
        guards: { tenant: forward.guards.tenant, allowed_columns: forward.guards.allowed_columns },
        evidence: { bundle_id: "ev_compensation", query_fingerprint: "sha256:compensation", items: [] },
        approval: { status: "pending", mode: "human", required_role: "support_lead", required_approvals: 1 },
        writeback: { status: "not_applied", mode: "trusted_worker_required", executor: "sql_update" },
        source_database_mutated: false,
        integrity: { proposal_hash: "sha256:compensation-proposal" },
        created_at: "2026-07-13T01:00:00Z",
      };
      store.createProposal(compensation);
      store.approveProposal(compensation.proposal_id, { approver: "reviewer_b", proposal_hash: compensation.integrity.proposal_hash, proposal_version: 1 });
      const job = store.createWritebackJobFromProposal(compensation.proposal_id);
      expect(job).toMatchObject({
        schema_version: protocolVersions.writebackJobV4,
        operation: "restore_update",
        forward_receipt_hash: "sha256:forward-receipt",
      });
      const claim = store.claimWritebackIntent(job, "runner_compensation");
      expect(claim).toEqual({
        decision: "proceed",
        intent_id: "wbi:wbj_wrp_compensation_1",
      });
      expect(store.getWritebackIntent(claim.intent_id)).toMatchObject({
        status: "intent_recorded",
        operation: "restore_update",
      });
      store.markWritebackIntentApplying(claim.intent_id, "runner_compensation");
      expect(store.getWritebackIntent(claim.intent_id)).toMatchObject({
        status: "applying",
        operation: "restore_update",
      });
    } finally {
      store.close();
    }
  });

  it("preserves inverse receipts and compensation lineage through shared-ledger backup and restore", () => {
    const source = new ProposalStore();
    const restored = new ProposalStore();
    try {
      const forward = reversibleOperationChangeSet("single_row_update", "shared_restore_forward");
      source.createProposal(forward);
      source.approveProposal(forward.proposal_id, { approver: "reviewer_a", proposal_hash: forward.integrity.proposal_hash, proposal_version: 1 });
      const forwardJob = source.createWritebackJobFromProposal(forward.proposal_id);
      if (forwardJob.schema_version !== protocolVersions.writebackJobV2 || !forwardJob.inverse_capture) throw new Error("expected reversible forward job");
      source.recordExecutionReceipt({
        schema_version: protocolVersions.executionReceiptV2,
        writeback_job_id: forwardJob.writeback_job_id,
        proposal_id: forward.proposal_id,
        proposal_hash: forward.integrity.proposal_hash,
        approval_id: "approval_shared_restore",
        runner_id: "runner_shared_restore",
        operation: "single_row_update",
        receipt_authority: "runner_ledger",
        status: "applied",
        target: { source_id: forward.source.source_id, schema: forward.source.schema, table: forward.source.table, identity: [{ column: "id", value: forward.source.primary_key.value }] },
        rows_affected: 1,
        idempotency_key: forwardJob.idempotency_key,
        before_digest: "sha256:shared-before",
        after_digest: "sha256:shared-after",
        inverse: forwardJob.inverse_capture,
        source_database_mutated: true,
        safe_outcome_code: "APPLIED",
        executed_at: "2026-07-13T01:00:00Z",
        receipt_hash: "sha256:shared-forward-receipt",
      });
      const compensation: any = {
        schema_version: protocolVersions.compensationChangeSet,
        proposal_id: "wrp_shared_restore_compensation",
        proposal_version: 1,
        action: forward.action,
        mode: "review_required",
        principal: forward.principal,
        scope: forward.scope,
        source: forward.source,
        before: forward.after,
        patch: forward.before,
        after: forward.before,
        compensation: { descriptor: forwardJob.inverse_capture, forward_receipt_hash: "sha256:shared-forward-receipt" },
        guards: { tenant: forward.guards.tenant, allowed_columns: forward.guards.allowed_columns },
        evidence: { bundle_id: "ev_shared_restore_compensation", query_fingerprint: "sha256:shared-restore", items: [] },
        approval: { status: "pending", mode: "human", required_role: "support_lead" },
        writeback: { status: "not_applied", mode: "trusted_worker_required", executor: "sql_update" },
        source_database_mutated: false,
        integrity: { proposal_hash: "sha256:shared-restore-compensation" },
        created_at: "2026-07-13T01:01:00Z",
      };
      source.createProposal(compensation);
      source.approveProposal(compensation.proposal_id, { approver: "reviewer_b", proposal_hash: compensation.integrity.proposal_hash, proposal_version: 1 });

      const entries = source.sharedLedgerEntries();
      expect(restored.importSharedLedgerEntries(entries)).toMatchObject({ imported: entries.length, skipped: 0 });
      const restoredReceipt = restored.receipts(forward.proposal_id)[0]?.receipt;
      expect(restoredReceipt).toMatchObject({
        schema_version: protocolVersions.executionReceiptV2,
        inverse: { availability: "available", operation: "restore_update" },
      });
      const restoredCompensation = restored.getProposal(compensation.proposal_id);
      expect(restoredCompensation?.change_set).toMatchObject({
        schema_version: protocolVersions.compensationChangeSet,
        compensation: {
          forward_receipt_hash: "sha256:shared-forward-receipt",
          descriptor: { lineage: { root_proposal_id: forward.proposal_id, depth: 1 } },
        },
      });
      const restoredJob = restored.createWritebackJobFromProposal(compensation.proposal_id);
      expect(restoredJob).toMatchObject({ schema_version: protocolVersions.writebackJobV4, operation: "restore_update" });
    } finally {
      source.close();
      restored.close();
    }
  });

  it("does not create direct SQL writeback jobs for app-owned executor proposals", () => {
    const store = new ProposalStore();
    try {
      const handlerChangeSet = structuredClone(changeSet) as typeof changeSet & { writeback: { status: string; mode: string; executor?: string } };
      handlerChangeSet.writeback = {
        status: "not_applied",
        mode: "trusted_worker_required",
        executor: "billing_handler",
      };
      store.createProposal(handlerChangeSet);
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      expect(() => store.createWritebackJobFromProposal("wrp_123")).toThrowError(/non-local writeback executor billing_handler/);
    } finally {
      store.close();
    }
  });

  it("keeps shadow proposals inspectable but blocks approval and writeback", () => {
    const store = new ProposalStore();
    try {
      const proposal = store.createProposal(shadowChangeSet());
      expect(proposal.state).toBe("pending_review");
      expect(proposal.change_set.mode).toBe("shadow");
      expect(store.replay("wrp_shadow").proposal.change_set.mode).toBe("shadow");

      expect(() => store.approveProposal("wrp_shadow", {
        approver: "support_lead_1",
        proposal_hash: "sha256:shadow",
        proposal_version: 1,
      })).toThrowError(/shadow proposal wrp_shadow cannot be approved/);

      expect(() => store.createWritebackJobFromProposal("wrp_shadow")).toThrowError(/shadow proposal wrp_shadow cannot be converted into a writeback job/);

      expect(store.getProposal("wrp_shadow")?.source_database_mutated).toBe(false);
    } finally {
      store.close();
    }
  });

  it("runs a persistent shadow study with authoritative outcomes and deterministic classifications", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-shadow-study-"));
    const storePath = path.join(tempDir, "local.db");
    let store = new ProposalStore(storePath);
    try {
      const study = store.createShadowStudy({
        study_id: "sst_support",
        name: "Support waiver comparison",
        description: "Compare shadow proposals with authorized support outcomes.",
        selected_capabilities: ["billing.waive_late_fee"],
      });
      expect(study.status).toBe("active");

      const exactProposal = store.createProposal(shadowCaseChangeSet({
        proposalId: "wrp_shadow_exact",
        objectId: "INV-EXACT",
      }));
      const exactCase = store.shadowCases(study.study_id).find((item) => item.proposal_id === exactProposal.proposal_id);
      expect(exactCase?.evidence_bundle_id).toBe("ev_wrp_shadow_exact");
      store.recordShadowOutcome({
        study_id: study.study_id,
        request_id: exactCase!.request_id,
        proposal_id: exactProposal.proposal_id,
        tenant_id: "acme",
        business_object: "invoice",
        object_id: "INV-EXACT",
        actor: "support_lead_1",
        disposition: "applied",
        actual_effect: exactCase!.proposed_effect,
        occurred_at: "2026-07-19T12:00:00.000Z",
        source: "support_system_audit",
        reference: "ticket:SUP-EXACT",
        reason: "customer qualified",
      });

      const partialProposal = store.createProposal(shadowCaseChangeSet({
        proposalId: "wrp_shadow_partial",
        objectId: "INV-PARTIAL",
      }));
      const partialCase = store.shadowCases(study.study_id).find((item) => item.proposal_id === partialProposal.proposal_id)!;
      store.recordShadowOutcome({
        study_id: study.study_id,
        request_id: partialCase.request_id,
        tenant_id: "acme",
        business_object: "invoice",
        object_id: "INV-PARTIAL",
        actor: "support_lead_2",
        disposition: "applied",
        actual_effect: {
          before: partialCase.proposed_effect!.before,
          after: { ...partialCase.proposed_effect!.after, waiver_reason: "human reason" },
          patch: { late_fee_cents: 0, waiver_reason: "human reason" },
        },
        source: "support_system_audit",
      });

      const rejectedProposal = store.createProposal(shadowCaseChangeSet({
        proposalId: "wrp_shadow_rejected",
        objectId: "INV-REJECTED",
      }));
      const rejectedCase = store.shadowCases(study.study_id).find((item) => item.proposal_id === rejectedProposal.proposal_id)!;
      store.recordShadowOutcome({
        study_id: study.study_id,
        request_id: rejectedCase.request_id,
        tenant_id: "acme",
        business_object: "invoice",
        object_id: "INV-REJECTED",
        actor: "support_lead_3",
        disposition: "rejected_no_action",
        source: "support_system_audit",
        reason: "prior courtesy waiver",
      });

      for (const [request, result, reason] of [
        ["req-policy", "policy_denied", "amount above reviewed bound"],
        ["req-unable", "unable_to_propose", "required evidence unavailable"],
        ["req-stale", "stale_conflict", "source version moved"],
        ["req-forgery", "invalid_unsafe_scope_attempt", "tenant override rejected"],
        ["req-unmatched", "proposed", "awaiting authorized outcome"],
      ] as const) {
        store.recordShadowCase({
          study_id: study.study_id,
          request_id: request,
          tenant_id: "acme",
          principal: "support-agent-shadow",
          capability: "billing.waive_late_fee",
          business_object: "invoice",
          object_id: `INV-${request}`,
          agent_result: result,
          decision_reason: reason,
          risk_score: result === "invalid_unsafe_scope_attempt" ? 100 : 20,
          ...(result === "proposed" ? {
            proposed_effect: {
              before: { late_fee_cents: 5500 },
              after: { late_fee_cents: 0 },
              patch: { late_fee_cents: 0 },
            },
          } : {}),
        });
      }

      const report = store.shadowStudyReport(study.study_id);
      expect(report).toMatchObject({
        total_tasks_observed: 8,
        tasks_with_authoritative_outcomes: 3,
        comparable_tasks: 2,
        exact_agreements: 1,
        exact_agreement_rate: 0.5,
        partial_agreements: 1,
        human_rejections_no_action: 1,
        policy_denials: 1,
        stale_conflicts: 1,
        unmatched_cases: 1,
        invalid_or_unsafe_scope_attempts: 1,
      });
      expect(report.highest_risk_disagreements[0]?.status).toBe("invalid_or_unsafe_scope_attempt");
      expect(report.suggested_policies).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("password");
      expect(store.closeShadowStudy(study.study_id).status).toBe("closed");
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      const report = store.shadowStudyReport("sst_support");
      expect(report.total_tasks_observed).toBe(8);
      expect(report.study.status).toBe("closed");
      expect(() => store.approveProposal("wrp_shadow_exact", {
        approver: "support_lead_1",
        proposal_hash: "sha256:wrp_shadow_exact",
        proposal_version: 1,
      })).toThrow(/shadow proposal/);
    } finally {
      store.close();
    }
  });

  it("fails authoritative shadow outcomes closed on tenant, object, and proposal mismatches", () => {
    const store = new ProposalStore();
    try {
      store.createShadowStudy({ study_id: "sst_scope", name: "Scope binding" });
      store.createProposal(shadowCaseChangeSet({ proposalId: "wrp_shadow_scope", objectId: "INV-SCOPE" }));
      const shadowCase = store.shadowCases("sst_scope")[0]!;
      expect(() => store.recordShadowOutcome({
        study_id: "sst_scope",
        request_id: shadowCase.request_id,
        tenant_id: "globex",
        business_object: "invoice",
        object_id: "INV-SCOPE",
        actor: "operator",
        disposition: "rejected_no_action",
        source: "test",
      })).toThrow(/does not match a case/);
      expect(() => store.recordShadowOutcome({
        study_id: "sst_scope",
        request_id: shadowCase.request_id,
        proposal_id: "wrp_other",
        tenant_id: "acme",
        business_object: "invoice",
        object_id: "INV-SCOPE",
        actor: "operator",
        disposition: "rejected_no_action",
        source: "test",
      })).toThrow(/proposal does not match/);
      expect(() => store.recordShadowCase({
        study_id: "sst_scope",
        request_id: "req-secret",
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
        business_object: "invoice",
        object_id: "INV-SECRET",
        agent_result: "unable_to_propose",
        decision_reason: "Bearer do-not-store-this-token",
      })).toThrow(/secret/i);
    } finally {
      store.close();
    }
  });

  it("round-trips shadow studies, cases, and outcomes through the shared ledger", () => {
    const source = new ProposalStore();
    const restored = new ProposalStore();
    try {
      source.createShadowStudy({ study_id: "sst_shared", name: "Shared study" });
      source.createProposal(shadowCaseChangeSet({ proposalId: "wrp_shadow_shared", objectId: "INV-SHARED" }));
      const shadowCase = source.shadowCases("sst_shared")[0]!;
      source.recordShadowOutcome({
        study_id: "sst_shared",
        request_id: shadowCase.request_id,
        tenant_id: "acme",
        business_object: "invoice",
        object_id: "INV-SHARED",
        actor: "operator",
        disposition: "applied",
        actual_effect: shadowCase.proposed_effect,
        source: "shared-ledger-test",
      });
      restored.importSharedLedgerEntries(source.sharedLedgerEntries());
      expect(restored.shadowStudyReport("sst_shared")).toMatchObject({
        total_tasks_observed: 1,
        tasks_with_authoritative_outcomes: 1,
        exact_agreements: 1,
      });
    } finally {
      source.close();
      restored.close();
    }
  });

  it("records evidence, query audit, replay, and runner state", () => {
    const store = new ProposalStore();
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_456",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: { source_database_changed: false },
        items: [{ row: "invoices/INV-3001" }]
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_456",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "invoices",
        row_count: 1,
        payload: { columns: ["id", "late_fee_cents", "updated_at"] }
      });
      store.setRunnerState("last_seen", { source_id: "src_pg_acme", lsn: "local" });
      const replay = store.replay("wrp_123");
      expect(replay.replay_id).toBe("replay_wrp_123");
      expect(replay.evidence).toHaveLength(1);
      expect(replay.query_audit).toHaveLength(1);
      expect(replay.events.map((event) => event.kind)).toContain("evidence_recorded");
      expect(store.getRunnerState("last_seen")).toEqual({ source_id: "src_pg_acme", lsn: "local" });
    } finally {
      store.close();
    }
  });

  it("indexes and searches local evidence, audit, receipts, and replay metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-store-search-"));
    const storePath = path.join(tempDir, "local.db");
    let store = new ProposalStore(storePath);
    try {
      store.createProposal(changeSet);
      store.recordEvidenceBundle({
        evidence_bundle_id: "ev_456",
        proposal_id: "wrp_123",
        tenant_id: "acme",
        payload: {
          capability: "billing.waive_late_fee",
          source_id: "src_pg_acme",
          target: "public.invoices",
          principal: { id: "support_agent_17" },
          query_fingerprint: "sha256:evidence",
        },
        items: [{
          kind: "external_row",
          source_id: "src_pg_acme",
          table: "public.invoices",
          primary_key: { column: "id", value: "INV-3001" },
          visible_row: {
            id: "INV-3001",
            tenant_id: "acme",
            late_fee_cents: 5500,
            updated_at: "2026-06-20T14:31:08Z",
          },
        }],
      });
      store.recordQueryAudit({
        proposal_id: "wrp_123",
        evidence_bundle_id: "ev_456",
        source_id: "src_pg_acme",
        query_fingerprint: "sha256:evidence",
        table_name: "public.invoices",
        row_count: 1,
        payload: {
          capability: "billing.waive_late_fee",
          statement_template: "SELECT id FROM public.invoices WHERE id = ? AND tenant_id = ? LIMIT 1",
          parameters_redacted: true,
        },
      });
      store.approveProposal("wrp_123", {
        approver: "support_lead_1",
        proposal_hash: "sha256:proposal",
        proposal_version: 1,
      });
      store.markPendingWorker("wrp_123", "sha256:proposal", 1);
      store.recordWritebackJob(writebackJob);
      store.recordExecutionReceipt(appliedReceipt);

      expect(store.listProposals({
        tenant: "acme",
        principal: "support_agent_17",
        capability: "billing.waive_late_fee",
        objectType: "invoice",
        objectId: "INV-3001",
        source: "src_pg_acme",
        table: "invoices",
        status: "applied",
        limit: 20,
      }).map((proposal) => proposal.proposal_id)).toEqual(["wrp_123"]);
      expect(store.listProposals({ tenant: "otherco" })).toHaveLength(0);

      const evidence = store.listEvidenceBundles({
        tenant: "acme",
        principal: "support_agent_17",
        capability: "billing.waive_late_fee",
        proposal: "wrp_123",
        objectType: "invoice",
        objectId: "INV-3001",
        source: "src_pg_acme",
        table: "invoices",
        queryFingerprint: "sha256:evidence",
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        evidence_bundle_id: "ev_456",
        source_table: "public.invoices",
        object_id: "INV-3001",
      });

      const queryAudit = store.listQueryAudit({
        tenant: "acme",
        proposal: "wrp_123",
        evidence: "ev_456",
        source: "src_pg_acme",
        table: "invoices",
        primaryKey: "INV-3001",
        queryFingerprint: "sha256:evidence",
      });
      expect(queryAudit).toHaveLength(1);
      expect(queryAudit[0]).toMatchObject({
        audit_id: 1,
        evidence_bundle_id: "ev_456",
        primary_key_value: "INV-3001",
      });
      expect(store.getQueryAudit(1)).toMatchObject({ table_name: "public.invoices" });

      const receipts = store.listReceipts({
        proposal: "wrp_123",
        writebackJob: "wbj_123",
        idempotencyKey: "wrp_123:INV-3001",
        status: "applied",
        tenant: "acme",
        principal: "support_agent_17",
        capability: "billing.waive_late_fee",
        objectType: "invoice",
        objectId: "INV-3001",
        source: "src_pg_acme",
        table: "invoices",
      });
      expect(receipts).toHaveLength(1);
      const receipt = receipts[0];
      expect(receipt).toBeDefined();
      expect(receipt?.receipt_id).toBe(1);
      expect(receipt).toMatchObject({
        tenant_id: "acme",
        capability: "billing.waive_late_fee",
        business_object: "invoice",
        object_id: "INV-3001",
      });
      expect(store.getReceipt(1)?.idempotency_key).toBe("wrp_123:INV-3001");
      expect(store.listReceipts({ objectType: "invoice", objectId: "INV-NOT-THIS" })).toHaveLength(0);
      expect(store.listReceipts({ tenant: "otherco", objectType: "invoice", objectId: "INV-3001" })).toHaveLength(0);

      expect(store.getReplayByReplayId("replay_wrp_123").proposal.proposal_id).toBe("wrp_123");
      expect(store.proposalIdForEvidence("ev_456")).toBe("wrp_123");

      const proposalIndexes = indexNames(store, "proposals");
      expect(proposalIndexes).toContain("idx_proposals_tenant_created");
      expect(proposalIndexes).toContain("idx_proposals_object_created");
      const evidenceIndexes = indexNames(store, "evidence_bundles");
      expect(evidenceIndexes).toContain("idx_evidence_bundles_tenant_created");
      expect(evidenceIndexes).toContain("idx_evidence_bundles_object_created");
      const auditIndexes = indexNames(store, "query_audit");
      expect(auditIndexes).toContain("idx_query_audit_evidence_id");
      expect(auditIndexes).toContain("idx_query_audit_primary_key_created");
      const receiptIndexes = indexNames(store, "writeback_receipts");
      expect(receiptIndexes).toContain("idx_writeback_receipts_idempotency_key");

      store.migrate();
    } finally {
      store.close();
    }

    store = new ProposalStore(storePath);
    try {
      expect(store.listEvidenceBundles({ tenant: "acme" }).map((bundle) => bundle.evidence_bundle_id)).toEqual(["ev_456"]);
      expect(store.listReceipts({ status: "applied" }).map((receipt) => receipt.receipt_id)).toEqual([1]);
    } finally {
      store.close();
    }
  });

  it("filters receipts through their canonical proposal business object", () => {
    const store = new ProposalStore();
    const seedApplied = (input: {
      proposalId: string;
      objectType: string;
      objectId: string;
      tenant: string;
      action: string;
      sourceId: string;
      table: string;
    }) => {
      const proposal = structuredClone(changeSet);
      proposal.proposal_id = input.proposalId;
      proposal.action = input.action;
      proposal.scope = { tenant_id: input.tenant, business_object: input.objectType, object_id: input.objectId };
      proposal.source.source_id = input.sourceId;
      proposal.source.table = input.table;
      proposal.source.primary_key.value = input.objectId;
      proposal.guards.tenant.value = input.tenant;
      proposal.integrity.proposal_hash = `sha256:${input.proposalId}`;
      proposal.evidence.bundle_id = `ev_${input.proposalId}`;
      store.createProposal(proposal);
      store.approveProposal(input.proposalId, {
        approver: "reviewer",
        proposal_hash: proposal.integrity.proposal_hash,
        proposal_version: 1,
      });
      store.markPendingWorker(input.proposalId, proposal.integrity.proposal_hash, 1);
      const job = structuredClone(writebackJob);
      job.writeback_job_id = `wbj_${input.proposalId}`;
      job.proposal_id = input.proposalId;
      job.proposal_hash = proposal.integrity.proposal_hash;
      job.runner_scope.source_id = input.sourceId;
      job.target.table = input.table;
      job.target.primary_key.value = input.objectId;
      job.tenant_guard.value = input.tenant;
      job.idempotency_key = `${input.proposalId}:${input.objectId}`;
      store.recordWritebackJob(job);
      const receipt = structuredClone(appliedReceipt);
      receipt.writeback_job_id = job.writeback_job_id;
      receipt.proposal_id = input.proposalId;
      receipt.idempotency_key = job.idempotency_key;
      receipt.receipt_hash = `sha256:receipt-${input.proposalId}`;
      store.recordExecutionReceipt(receipt);
    };

    try {
      seedApplied({ proposalId: "wrp_wo_1001", objectType: "work_orders", objectId: "wo_1001", tenant: "acme", action: "fleet.propose_repair", sourceId: "fleet_pg", table: "work_orders" });
      seedApplied({ proposalId: "wrp_wo_1002", objectType: "work_orders", objectId: "wo_1002", tenant: "acme", action: "fleet.propose_repair", sourceId: "fleet_pg", table: "work_orders" });
      seedApplied({ proposalId: "wrp_part_101", objectType: "parts", objectId: "part_101", tenant: "acme", action: "inventory.propose_restock", sourceId: "parts_mysql", table: "parts" });
      seedApplied({ proposalId: "wrp_part_103", objectType: "parts", objectId: "part_103", tenant: "globex", action: "inventory.propose_restock", sourceId: "parts_mysql", table: "parts" });

      expect(store.listReceipts({ objectType: "work_orders", objectId: "wo_1002" }).map((item) => item.proposal_id)).toEqual(["wrp_wo_1002"]);
      expect(store.listReceipts({ objectType: "parts", objectId: "part_101" }).map((item) => item.proposal_id)).toEqual(["wrp_part_101"]);
      expect(store.listReceipts({ tenant: "globex", capability: "inventory.propose_restock", objectType: "parts", objectId: "part_103" }).map((item) => item.proposal_id)).toEqual(["wrp_part_103"]);
      expect(store.listReceipts({ tenant: "acme", objectType: "parts", objectId: "part_103" })).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("graduated-trust recommendation ledger", () => {
  it("requires a verified operator decision and preserves approved/exported history through the shared ledger", () => {
    const store = new ProposalStore();
    const replica = new ProposalStore();
    try {
      const pending = store.createPolicyRecommendation(policyRecommendationInput());
      expect(pending).toMatchObject({ status: "pending_review", current_threshold: 2500, proposed_threshold: 3000 });
      expect(() => store.decidePolicyRecommendation(pending.recommendation_id, {
        action: "approve",
        actor: "reviewer",
        reason: "reviewed",
        identity: recommendationIdentity(pending, "approve", false),
      })).toThrowError(/cryptographically verified/i);

      const approved = store.decidePolicyRecommendation(pending.recommendation_id, {
        action: "approve",
        actor: "reviewer",
        reason: "reviewed evidence and ceiling",
        identity: recommendationIdentity(pending, "approve", true),
      });
      expect(approved).toMatchObject({ status: "approved", decision: { actor: "reviewer", action: "approve" } });
      expect(() => store.decidePolicyRecommendation(pending.recommendation_id, {
        action: "reject",
        actor: "reviewer",
        reason: "too late",
        identity: recommendationIdentity(approved, "reject", true),
      })).toThrowError(/is approved/);

      const exported = store.markPolicyRecommendationExported(pending.recommendation_id, {
        actor: "reviewer",
        artifact_digest: canonicalJsonDigest({ policy: "small_credit", max: 3000 }),
      });
      expect(exported).toMatchObject({ status: "exported", export: { actor: "reviewer" } });

      replica.importSharedLedgerEntries(store.sharedLedgerEntries());
      expect(replica.getPolicyRecommendation(pending.recommendation_id)).toEqual(exported);
    } finally {
      replica.close();
      store.close();
    }
  });

  it("keeps rejection terminal and fails closed on a tampered recommendation payload", () => {
    const store = new ProposalStore();
    try {
      const pending = store.createPolicyRecommendation(policyRecommendationInput());
      const rejected = store.decidePolicyRecommendation(pending.recommendation_id, {
        action: "reject",
        actor: "security_reviewer",
        reason: "sample still too small",
        identity: recommendationIdentity(pending, "reject", true, "security_reviewer"),
      });
      expect(rejected.status).toBe("rejected");
      expect(() => store.markPolicyRecommendationExported(pending.recommendation_id, {
        actor: "security_reviewer",
        artifact_digest: canonicalJsonDigest({ max: 3000 }),
      })).toThrowError(/is rejected/);

      const payload = JSON.parse(String((store.db.prepare("SELECT payload_json FROM policy_recommendations WHERE recommendation_id = ?").get(pending.recommendation_id) as any).payload_json));
      payload.proposed_threshold = 999999;
      store.db.prepare("UPDATE policy_recommendations SET payload_json = ? WHERE recommendation_id = ?").run(JSON.stringify(payload), pending.recommendation_id);
      expect(() => store.getPolicyRecommendation(pending.recommendation_id)).toThrowError(/integrity check|increment or ceiling/i);
    } finally {
      store.close();
    }
  });
});

function expectSecretRejection(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected secret rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ProposalStoreError);
    expect((error as ProposalStoreError).code).toBe("SECRET_MATERIAL_REJECTED");
  }
}

function policyRecommendationInput() {
  return {
    tenant_id: "acme",
    capability: "support.propose_plan_credit",
    policy: "small_credit",
    field: "plan_credit_cents",
    base_contract_digest: canonicalJsonDigest({ contract: "v1" }),
    base_contract_version: "1",
    current_threshold: 2500,
    proposed_threshold: 3000,
    maximum_increment: 500,
    absolute_ceiling: 5000,
    criteria: { minimum_human_reviews: 20, window_days: 30 },
    metrics: {
      window_start: "2026-06-14T00:00:00.000Z",
      window_end: "2026-07-14T00:00:00.000Z",
      human_reviewed: 25,
      human_approved: 24,
      human_rejected: 1,
      conflicts: 0,
      failures: 0,
      reverts: 0,
      auto_approved_excluded: 5,
      rejection_rate: 0.04,
      conflict_rate: 0,
      failure_rate: 0,
      revert_rate: 0,
    },
    evidence_proposal_ids: ["wrp_1", "wrp_2"],
    explanation: ["25 verified human-reviewed outcomes met the configured criteria."],
    now: "2026-07-14T00:00:00.000Z",
  };
}

function recommendationIdentity(recommendation: { recommendation_id: string; integrity_hash: string }, action: "approve" | "reject", verified: boolean, actor = "reviewer"): OperatorIdentityProof {
  const decision = {
    schema_version: "synapsor.operator-decision.v1" as const,
    action,
    proposal_id: recommendation.recommendation_id,
    proposal_version: 1,
    proposal_hash: recommendation.integrity_hash,
    subject: actor,
    issued_at: "2026-07-14T00:01:00.000Z",
  };
  const decisionHash = canonicalJsonDigest(decision);
  const core = {
    provider: "signed_key" as const,
    verified,
    subject: actor,
    roles: ["policy_reviewer"],
    key_id: actor,
    algorithm: "SHA256",
    decision,
    decision_hash: decisionHash,
    signature: "test-signature",
  };
  return { ...core, integrity_hash: canonicalJsonDigest(core) };
}

function indexNames(store: ProposalStore, table: string): string[] {
  return store.db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .map((row) => {
      if (row && typeof row === "object" && "name" in row) return String(row.name);
      return "";
    })
    .filter(Boolean);
}

type FakeLedgerRow = {
  entry_id: number;
  entry_key: string;
  kind: string;
  proposal_id: string | null;
  tenant_id: string | null;
  capability: string | null;
  payload_json: Record<string, unknown>;
  created_at: string;
};

class FakePostgresRuntimePool implements PostgresRuntimePool {
  readonly rows = new Map<string, FakeLedgerRow>();
  readonly queries: string[] = [];
  private nextEntryId = 1;
  ended = false;

  async connect(): Promise<PostgresRuntimeClient> {
    return new FakePostgresRuntimeClient(this);
  }

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    return await this.execute(sql, values);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  async execute(sql: string, values: unknown[] = []): Promise<PostgresRuntimeQueryResult> {
    const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
    this.queries.push(`${normalized}${values.length > 0 ? ` ${values.map(String).join(" ")}` : ""}`);
    if (
      normalized === "begin" ||
      normalized === "commit" ||
      normalized === "rollback" ||
      normalized.startsWith("create schema") ||
      normalized.startsWith("create table") ||
      normalized.startsWith("create index") ||
      normalized.startsWith("alter table")
    ) {
      return { rows: [] };
    }
    if (normalized.startsWith("select pg_try_advisory_xact_lock")) {
      return { rows: [{ locked: true }] };
    }
    if (normalized.startsWith("select pg_advisory_xact_lock")) return { rows: [{}] };
    if (normalized.startsWith("select payload_json from") && normalized.includes("ledger_entries")) {
      const row = this.rows.get(String(values[0]));
      return { rows: row ? [{ payload_json: row.payload_json }] : [] };
    }
    if (normalized.startsWith("select entry_key")) {
      return {
        rows: [...this.rows.values()]
          .sort((left, right) => left.entry_id - right.entry_id)
          .map((row) => ({
            entry_key: row.entry_key,
            kind: row.kind,
            proposal_id: row.proposal_id,
            tenant_id: row.tenant_id,
            capability: row.capability,
            payload_json: row.payload_json,
            created_at: row.created_at,
          })),
      };
    }
    if (normalized.startsWith("insert into") && normalized.includes("ledger_entries")) {
      if (normalized.includes("'writeback_intent'")) {
        const [entryKey, proposalId, payloadJson, createdAt] = values;
        const key = String(entryKey);
        const existing = this.rows.get(key);
        this.rows.set(key, {
          entry_id: existing?.entry_id ?? this.nextEntryId++,
          entry_key: key,
          kind: "writeback_intent",
          proposal_id: proposalId == null ? null : String(proposalId),
          tenant_id: null,
          capability: null,
          payload_json: parseFakePayloadJson(payloadJson),
          created_at: String(createdAt),
        });
        return { rows: [] };
      }
      const [entryKey, kind, proposalId, tenantId, capability, payloadJson, createdAt] = values;
      const key = String(entryKey);
      const existing = this.rows.get(key);
      this.rows.set(key, {
        entry_id: existing?.entry_id ?? this.nextEntryId++,
        entry_key: key,
        kind: String(kind),
        proposal_id: proposalId == null ? null : String(proposalId),
        tenant_id: tenantId == null ? null : String(tenantId),
        capability: capability == null ? null : String(capability),
        payload_json: parseFakePayloadJson(payloadJson),
        created_at: String(createdAt),
      });
      return { rows: [] };
    }
    throw new Error(`unexpected fake Postgres query: ${sql}`);
  }
}

class FakePostgresRuntimeClient implements PostgresRuntimeClient {
  constructor(private readonly pool: FakePostgresRuntimePool) {}

  async query(sql: string, values?: unknown[]): Promise<PostgresRuntimeQueryResult> {
    return await this.pool.execute(sql, values);
  }

  release(): void {}
}

function parseFakePayloadJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const parsed = JSON.parse(String(value ?? "{}")) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return {};
}

describe("Cloud-linked durable outbox", () => {
  it("persists idempotent events, preserves proposal chronology, and records Cloud authority separately", () => {
    const store = new ProposalStore(":memory:");
    try {
      const proposal = store.createProposal(changeSet);
      const first = store.enqueueCloudOutbox({
        event_id: `cloud-proposal:${proposal.proposal_id}`,
        proposal_id: proposal.proposal_id,
        sequence: 0,
        kind: "proposal",
        payload: { schema_version: "synapsor.runner-proposal.v1", proposal_id: proposal.proposal_id },
        now: "2026-07-16T00:00:00.000Z",
      });
      const duplicate = store.enqueueCloudOutbox({
        event_id: first.event_id,
        proposal_id: proposal.proposal_id,
        sequence: 0,
        kind: "proposal",
        payload: { schema_version: "synapsor.runner-proposal.v1", proposal_id: proposal.proposal_id },
        now: "2026-07-16T00:00:00.000Z",
      });
      expect(duplicate.payload_hash).toBe(first.payload_hash);
      store.enqueueCloudOutbox({
        event_id: `cloud-activity:${proposal.proposal_id}`,
        proposal_id: proposal.proposal_id,
        sequence: 10,
        kind: "activity",
        payload: { schema_version: "synapsor.runner-activity.v1", proposal_id: proposal.proposal_id },
        now: "2026-07-16T00:00:00.000Z",
      });

      const firstClaim = store.claimCloudOutbox({ owner: "runner-a", limit: 10, now: "2026-07-16T00:00:00.000Z" });
      expect(firstClaim.map((item) => item.event_id)).toEqual([first.event_id]);
      store.acknowledgeCloudOutbox(first.event_id, "runner-a", "2026-07-16T00:00:01.000Z");
      const secondClaim = store.claimCloudOutbox({ owner: "runner-a", limit: 10, now: "2026-07-16T00:00:02.000Z" });
      expect(secondClaim.map((item) => item.kind)).toEqual(["activity"]);

      const governance = store.recordCloudGovernanceEvent({
        event_id: `cloud-ack:${proposal.proposal_id}`,
        proposal_id: proposal.proposal_id,
        cloud_proposal_id: proposal.proposal_id,
        kind: "proposal.cloud_acknowledged",
        state: "pending_review",
        payload: { evidence_residency: "metadata_only" },
      });
      expect(governance.authority).toBe("synapsor_cloud");
      expect(store.approvals(proposal.proposal_id)).toEqual([]);
      expect(store.listCloudGovernanceEvents(proposal.proposal_id)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("rejects idempotency-key payload drift and dead-letters permanent failures", () => {
    const store = new ProposalStore(":memory:");
    try {
      const proposal = store.createProposal(changeSet);
      store.enqueueCloudOutbox({ event_id: "cloud:event-1", proposal_id: proposal.proposal_id, kind: "proposal", payload: { value: 1 }, max_attempts: 2, now: "2026-07-16T00:00:00.000Z" });
      expect(() => store.enqueueCloudOutbox({ event_id: "cloud:event-1", proposal_id: proposal.proposal_id, kind: "proposal", payload: { value: 2 } }))
        .toThrowError(expect.objectContaining({ code: "CLOUD_OUTBOX_IDEMPOTENCY_MISMATCH" }));
      const [claimed] = store.claimCloudOutbox({ owner: "runner-a", now: "2026-07-16T00:00:00.000Z" });
      expect(claimed).toBeDefined();
      const failed = store.failCloudOutbox({ event_id: claimed!.event_id, owner: "runner-a", error_code: "runner_token_revoked", retryable: false, now: "2026-07-16T00:00:01.000Z" });
      expect(failed.status).toBe("dead_letter");
      expect(store.claimCloudOutbox({ owner: "runner-a", now: "2026-07-17T00:00:00.000Z" })).toEqual([]);
      expect(store.requeueCloudOutbox(failed.event_id, "2026-07-17T00:00:01.000Z")).toMatchObject({ status: "pending", attempts: 0 });
      const [retried] = store.claimCloudOutbox({ owner: "runner-b", now: "2026-07-17T00:00:02.000Z" });
      expect(retried?.event_id).toBe(failed.event_id);
      store.acknowledgeCloudOutbox(failed.event_id, "runner-b", "2026-07-17T00:00:03.000Z");
      expect(store.compactCloudOutbox({ acknowledged_before: "2026-07-18T00:00:00.000Z" })).toBe(1);
      expect(store.listCloudOutbox()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("projects Cloud terminal authority once without allowing stale terminal regression", () => {
    const store = new ProposalStore(":memory:");
    try {
      const proposal = store.createProposal(changeSet);
      store.recordCloudGovernanceEvent({
        event_id: `cloud:${proposal.proposal_id}:applied`,
        proposal_id: proposal.proposal_id,
        kind: "proposal.cloud_applied",
        state: "applied",
        payload: { evidence_residency: "metadata_only" },
      });
      expect(store.getProposal(proposal.proposal_id)).toMatchObject({ state: "applied", source_database_mutated: true });
      expect(store.approvals(proposal.proposal_id)).toEqual([]);

      store.recordCloudGovernanceEvent({
        event_id: `cloud:${proposal.proposal_id}:stale-failed`,
        proposal_id: proposal.proposal_id,
        kind: "proposal.cloud_failed",
        state: "failed",
        payload: { evidence_residency: "metadata_only" },
      });
      expect(store.getProposal(proposal.proposal_id)?.state).toBe("applied");
      expect(store.events(proposal.proposal_id).filter((event) => event.kind.startsWith("proposal_cloud_"))).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("round-trips outbox and governance entries through the shared Postgres runtime store", async () => {
    const pool = new FakePostgresRuntimePool();
    const store = new PostgresProposalRuntimeStore({ pool, autoMigrate: true });
    const proposal = await store.createProposal(changeSet);
    await store.enqueueCloudOutbox({ event_id: "cloud:shared", proposal_id: proposal.proposal_id, kind: "proposal", payload: { proposal_id: proposal.proposal_id } });
    await store.recordCloudGovernanceEvent({ event_id: "cloud:shared:pending", proposal_id: proposal.proposal_id, kind: "proposal.pending_cloud_sync", state: "pending_cloud_sync", payload: { evidence_residency: "metadata_only" } });
    expect((await store.listCloudOutbox()).map((item) => item.event_id)).toContain("cloud:shared");
    expect(await store.listCloudGovernanceEvents(proposal.proposal_id)).toHaveLength(1);
  });
});
