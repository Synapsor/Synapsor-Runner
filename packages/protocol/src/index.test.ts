import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseChangeSet,
  parseExecutionReceipt,
  parseRunnerRegistration,
  parseWritebackJob,
  parseWritebackResult,
  protocolVersions
} from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const validJob = {
  protocol_version: "1.0",
  job_id: "wbj_1",
  proposal_id: "wrp://external/xwp_1",
  approval_id: "appr_1",
  source_id: "src_1",
  engine: "postgres",
  target: {
    schema: "public",
    table: "tickets",
    primary_key: { column: "id", value: "T-1042" },
    tenant_guard: { column: "tenant_id", value: "acme" }
  },
  allowed_columns: ["status", "resolution_note"],
  patch: { status: "pending_review" },
  conflict_guard: { kind: "version_column", column: "updated_at", expected_value: "2026-06-20T12:00:00Z" },
  idempotency_key: "idem_1",
  lease_expires_at: 1
};

describe("writeback job schema", () => {
  it("accepts a guarded single-row update job", () => {
    expect(parseWritebackJob(validJob)).toMatchObject({ job_id: "wbj_1" });
  });

  it("normalizes v2 UPDATE, INSERT, and DELETE without changing v1", () => {
    const update = parseWritebackJob(v2Job({
      kind: "single_row_update",
      values: { amount_cents: 500 },
      conflict_guard: { kind: "column", column: "version", expected_value: 7 },
      version_advance: { column: "version", strategy: "integer_increment" },
    }));
    expect(update).toMatchObject({
      protocol_version: "2.0",
      operation: "single_row_update",
      patch: { amount_cents: 500 },
      version_advance: { column: "version", strategy: "integer_increment" },
    });

    const insert = parseWritebackJob(v2Job({
      kind: "single_row_insert",
      values: { amount_cents: 500 },
      deduplication: {
        components: [
          { column: "tenant_id", value: "acme", source: "trusted_tenant" },
          { column: "request_id", value: "wrp_2", source: "proposal_id" },
        ],
      },
    }));
    expect(insert).toMatchObject({ operation: "single_row_insert", patch: { amount_cents: 500 } });

    const deletion = parseWritebackJob(v2Job({
      kind: "single_row_delete",
      conflict_guard: { kind: "column", column: "version", expected_value: 7 },
    }, []));
    expect(deletion).toMatchObject({ operation: "single_row_delete", patch: {} });

    expect(parseWritebackJob(update)).toEqual(update);
    expect(parseWritebackJob(insert)).toEqual(insert);
    expect(parseWritebackJob(deletion)).toEqual(deletion);
  });

  it("rejects unsafe v2 mutation authority", () => {
    expect(() => parseWritebackJob(v2Job({
      kind: "single_row_insert",
      values: { request_id: "model-value" },
      deduplication: { components: [{ column: "request_id", value: "wrp_2", source: "proposal_id" }] },
    }))).toThrow(/Runner-supplied/i);
    expect(() => parseWritebackJob(v2Job({
      kind: "single_row_delete",
      conflict_guard: { kind: "column", column: "version", expected_value: 7 },
    }))).toThrow(/must not allow write columns/i);
  });

  it("rejects patch columns outside the allowlist", () => {
    expect(() => parseWritebackJob({ ...validJob, patch: { admin: "yes" } })).toThrow(/patch column not allowed/i);
  });

  it("rejects primary key patch allowlisting", () => {
    expect(() => parseWritebackJob({ ...validJob, allowed_columns: ["id", "status"] })).toThrow(/primary key/i);
  });

  it("rejects tenant guard patch allowlisting", () => {
    expect(() => parseWritebackJob({ ...validJob, allowed_columns: ["tenant_id", "status"] })).toThrow(/tenant guard/i);
  });

  it("rejects jobs without approval data", () => {
    const { approval_id: _approvalId, ...withoutApproval } = validJob;
    expect(() => parseWritebackJob(withoutApproval)).toThrow(/approval_id/i);
  });

  it("rejects path traversal and SQL-like database identifiers", () => {
    expect(() => parseWritebackJob({
      ...validJob,
      target: { ...validJob.target, schema: "../private" },
    })).toThrow(/fixed safe identifier/i);
    expect(() => parseWritebackJob({
      ...validJob,
      target: {
        ...validJob.target,
        primary_key: { column: "id/../../tenant_id", value: "T-1042" },
      },
    })).toThrow(/fixed safe identifier/i);
    expect(() => parseWritebackJob({
      ...validJob,
      allowed_columns: ["status", "../admin"],
    })).toThrow(/fixed safe identifier/i);
    expect(() => parseWritebackJob({
      ...validJob,
      patch: { "status; DROP TABLE tickets": "resolved" },
    })).toThrow(/fixed safe identifier/i);
  });
});

describe("operation-aware change sets and receipts", () => {
  it("accepts UPDATE, INSERT, and DELETE change-set v2 envelopes", () => {
    expect(parseChangeSet(v2ChangeSet("single_row_update"))).toMatchObject({
      schema_version: protocolVersions.changeSetV2,
      operation: "single_row_update",
    });
    expect(parseChangeSet(v2ChangeSet("single_row_insert"))).toMatchObject({ operation: "single_row_insert", before: {} });
    expect(parseChangeSet(v2ChangeSet("single_row_delete"))).toMatchObject({ operation: "single_row_delete", patch: {}, after: {} });
  });

  it("rejects operation envelopes that weaken their guards", () => {
    const insert = v2ChangeSet("single_row_insert");
    expect(() => parseChangeSet({ ...insert, guards: { ...insert.guards, deduplication: undefined } })).toThrow(/deduplication/i);
    expect(() => parseChangeSet({
      ...insert,
      guards: {
        ...insert.guards,
        deduplication: {
          components: (insert.guards as { deduplication: { components: Array<{ source: string }> } }).deduplication.components
            .filter((component) => component.source !== "proposal_id"),
        },
      },
    })).toThrow(/proposal identity/i);
    const deletion = v2ChangeSet("single_row_delete");
    expect(() => parseChangeSet({ ...deletion, patch: { status: "deleted" } })).toThrow(/DELETE has no patch/i);
  });

  it("requires explicit reconciliation metadata on ambiguous v2 receipts", () => {
    const receipt = {
      schema_version: protocolVersions.executionReceiptV2,
      writeback_job_id: "wbj_2",
      proposal_id: "wrp_2",
      proposal_hash: "sha256:proposal",
      approval_id: "approval_2",
      runner_id: "runner_1",
      operation: "single_row_update",
      receipt_authority: "runner_ledger",
      status: "reconciliation_required",
      target: { source_id: "src_1", schema: "public", table: "credits", identity: [{ column: "id", value: "credit_2" }] },
      rows_affected: 0,
      idempotency_key: "idem_2",
      source_database_mutated: false,
      safe_outcome_code: "OUTCOME_UNKNOWN",
      executed_at: "2026-07-13T00:00:00Z",
      receipt_hash: "sha256:receipt",
    };
    expect(() => parseExecutionReceipt(receipt)).toThrow(/reconciliation metadata/i);
    expect(parseExecutionReceipt({ ...receipt, reconciliation: { intent_id: "intent_2", reason: "source_commit_not_proven" } })).toMatchObject({ status: "reconciliation_required" });
  });
});

describe("public protocol fixtures", () => {
  it("keeps the shared manifest in sync with checked-in schemas and fixtures", () => {
    const manifest = fixture("MANIFEST.json") as {
      schema_version: string;
      hash_algorithm: string;
      artifacts: Array<{ kind: string; name: string; sha256: string }>;
    };
    expect(manifest.schema_version).toBe("synapsor.protocol-manifest.v1");
    expect(manifest.hash_algorithm).toBe("sha256");
    expect(manifest.artifacts).toHaveLength(35);
    for (const artifact of manifest.artifacts) {
      const file = artifact.kind === "schema"
        ? path.resolve(here, "../../../schemas", artifact.name)
        : path.resolve(here, "../../../fixtures/protocol", artifact.name);
      const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      expect(digest, artifact.name).toBe(artifact.sha256);
    }
  });

  it("parses the public change-set fixture", () => {
    const changeSet = parseChangeSet(fixture("change-set.late-fee-waiver.v1.json"));
    expect(changeSet.schema_version).toBe(protocolVersions.changeSet);
    expect(changeSet.source_database_mutated).toBe(false);
    expect(changeSet.patch.late_fee_cents).toBe(0);
  });

  it("normalizes a public writeback-job fixture for the existing worker", () => {
    const job = parseWritebackJob(fixture("writeback-job.late-fee-waiver.v1.json"));
    expect(job.protocol_version).toBe("1.0");
    if (job.protocol_version !== protocolVersions.legacyWritebackJob) throw new Error("expected v1 writeback job fixture");
    expect(job.job_id).toBe("wbj_123");
    expect(job.source_id).toBe("src_pg_acme");
    expect(job.target.tenant_guard).toEqual({ column: "tenant_id", value: "acme" });
    expect(job.conflict_guard).toEqual({
      kind: "version_column",
      column: "updated_at",
      expected_value: "2026-06-20T14:31:08Z"
    });
    expect(job.patch).toEqual({ late_fee_cents: 0, waiver_reason: "approved support waiver" });
  });

  it("parses public execution receipts and normalizes them for control-plane callbacks", () => {
    const receipt = parseExecutionReceipt(fixture("execution-receipt.applied.v1.json"));
    expect(receipt.schema_version).toBe(protocolVersions.executionReceipt);
    expect(receipt.source_database_mutated).toBe(true);

    const result = parseWritebackResult(fixture("execution-receipt.conflict.v1.json"));
    expect(result.protocol_version).toBe("1.0");
    expect(result.job_id).toBe("wbj_124");
    expect(result.status).toBe("conflict");
    expect(result.affected_rows).toBe(0);
    expect(result.error_code).toBe("VERSION_CONFLICT");
  });

  it("parses runner registration fixtures", () => {
    const registration = parseRunnerRegistration(fixture("runner-registration.v1.json"));
    expect(registration.schema_version).toBe(protocolVersions.runnerRegistration);
    expect(registration.engines).toContain("postgres");
    expect(registration.scope.source_ids).toContain("src_pg_acme");
  });

  it("parses public v2 fixtures for every guarded single-row operation", () => {
    for (const operation of ["update", "insert", "delete"] as const) {
      const changeSet = parseChangeSet(fixture(`change-set.${operation}.v2.json`));
      expect(changeSet.schema_version).toBe(protocolVersions.changeSetV2);
      if (changeSet.schema_version !== protocolVersions.changeSetV2) throw new Error("expected v2 change set fixture");
      expect(changeSet.operation).toBe(`single_row_${operation}`);

      const job = parseWritebackJob(fixture(`writeback-job.${operation}.v2.json`));
      expect(job.protocol_version).toBe(protocolVersions.normalizedWritebackJobV2);
      expect(job.operation).toBe(`single_row_${operation}`);

      const receipt = parseExecutionReceipt(fixture(`execution-receipt.${operation}-applied.v2.json`));
      expect(receipt.schema_version).toBe(protocolVersions.executionReceiptV2);
      expect(receipt.operation).toBe(`single_row_${operation}`);
      expect(receipt.status).toBe("applied");
    }
  });

  it("normalizes a public reconciliation receipt without losing operator state", () => {
    const receipt = fixture("execution-receipt.reconciliation-required.v2.json");
    const parsed = parseExecutionReceipt(receipt);
    expect(parsed).toMatchObject({
      schema_version: protocolVersions.executionReceiptV2,
      status: "reconciliation_required",
      reconciliation: { intent_id: "intent_update_2004" },
    });
  });

  it("accepts bounded set v3 jobs and exact applied receipts", () => {
    const job = parseWritebackJob(v3Job());
    expect(job).toMatchObject({
      protocol_version: protocolVersions.normalizedWritebackJobV3,
      operation: "set_update",
      frozen_set: { max_rows: 2, row_count: 2 },
    });

    const receipt = parseExecutionReceipt(v3Receipt());
    expect(receipt).toMatchObject({
      schema_version: protocolVersions.executionReceiptV3,
      operation: "set_update",
      rows_affected: 2,
    });
  });

  it("parses the public bounded-set v3 change set, job, and receipt", () => {
    const changeSet = parseChangeSet(fixture("change-set.bounded-update.v3.json"));
    expect(changeSet).toMatchObject({
      schema_version: protocolVersions.changeSetV3,
      operation: "set_update",
      frozen_set: { row_count: 2, max_rows: 10 },
    });
    if (changeSet.schema_version !== protocolVersions.changeSetV3) throw new Error("expected v3 change-set fixture");

    const job = parseWritebackJob(fixture("writeback-job.bounded-update.v3.json"));
    expect(job).toMatchObject({
      protocol_version: protocolVersions.normalizedWritebackJobV3,
      operation: "set_update",
      frozen_set: { set_digest: changeSet.frozen_set.set_digest },
    });

    const receipt = parseExecutionReceipt(fixture("execution-receipt.bounded-update-applied.v3.json"));
    expect(receipt).toMatchObject({
      schema_version: protocolVersions.executionReceiptV3,
      operation: "set_update",
      rows_affected: 2,
      target: { set_digest: changeSet.frozen_set.set_digest },
    });
    if (receipt.schema_version !== protocolVersions.executionReceiptV3) throw new Error("expected v3 receipt fixture");
    expect(receipt.member_effects.map((member) => member.primary_key.value)).toEqual(["INV-1", "INV-2"]);
  });

  it("rejects unsafe bounded set envelopes", () => {
    const unordered = v3Job();
    unordered.frozen_set.members.reverse();
    expect(() => parseWritebackJob(unordered)).toThrow(/deterministic primary-key ordering/i);

    const overflow = v3Job();
    overflow.frozen_set.max_rows = 1;
    expect(() => parseWritebackJob(overflow)).toThrow(/within max_rows/i);

    const aggregateOverflow = v3Job();
    aggregateOverflow.frozen_set.aggregate_bounds[0]!.actual = 20_001;
    expect(() => parseWritebackJob(aggregateOverflow)).toThrow(/aggregate exceeds reviewed maximum/i);

    const incompleteReceipt = v3Receipt();
    incompleteReceipt.member_effects.pop();
    expect(() => parseExecutionReceipt(incompleteReceipt)).toThrow(/identify every affected member/i);
  });

  it("parses reviewed compensation proposals, v4 jobs, and receipts", () => {
    const changeSet = parseChangeSet(fixture("compensation-change-set.update.v1.json"));
    expect(changeSet).toMatchObject({
      schema_version: protocolVersions.compensationChangeSet,
      source_database_mutated: false,
      compensation: { descriptor: { operation: "restore_update", cardinality: "single" } },
    });

    const job = parseWritebackJob(fixture("writeback-job.compensation-update.v4.json"));
    expect(job).toMatchObject({
      protocol_version: protocolVersions.normalizedWritebackJobV4,
      operation: "restore_update",
      compensation: { lineage: { depth: 1 } },
    });

    const receipt = parseExecutionReceipt(fixture("execution-receipt.compensation-update-applied.v4.json"));
    expect(receipt).toMatchObject({
      schema_version: protocolVersions.executionReceiptV4,
      status: "applied",
      inverse: { lineage: { depth: 2 } },
    });
  });

  it("rejects compensation authority drift and successful receipts without an inverse", () => {
    const mismatched = fixture("writeback-job.compensation-update.v4.json") as Record<string, unknown>;
    expect(() => parseWritebackJob({ ...mismatched, operation: "remove_insert" })).toThrow(/operation mismatch|must match descriptor/i);

    const receipt = fixture("execution-receipt.compensation-update-applied.v4.json") as Record<string, unknown>;
    const { inverse: _inverse, ...withoutInverse } = receipt;
    expect(() => parseExecutionReceipt(withoutInverse)).toThrow(/requires its own inverse/i);

    const descriptor = (mismatched.compensation as { members: Array<{ primary_key: { value: string } }> });
    const duplicate = structuredClone(mismatched) as typeof mismatched;
    (duplicate.compensation as typeof descriptor).members.push(structuredClone(descriptor.members[0]!));
    expect(() => parseWritebackJob(duplicate)).toThrow(/primary keys must be unique/i);
  });

  it("keeps credentials and unrestricted SQL out of protocol fixtures", () => {
    const fixtureDir = path.resolve(here, "../../../fixtures/protocol");
    for (const file of fs.readdirSync(fixtureDir)) {
      const text = fs.readFileSync(path.join(fixtureDir, file), "utf8");
      expect(text).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret|execute_sql|run_query|raw_sql/i);
    }
  });
});

function fixture(name: string): unknown {
  const file = path.resolve(here, "../../../fixtures/protocol", name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function v3Job() {
  return {
    protocol_version: protocolVersions.normalizedWritebackJobV3,
    job_id: "wbj_set_1",
    proposal_id: "wrp_set_1",
    proposal_hash: "sha256:proposal-set-1",
    approval_id: "sha256:approval-set-1",
    source_id: "src_1",
    engine: "postgres" as const,
    operation: "set_update" as const,
    target: {
      schema: "public",
      table: "invoices",
      primary_key: { column: "id" },
      tenant_guard: { column: "tenant_id", value: "acme" },
    },
    allowed_columns: ["status"],
    patch: { status: "closed" },
    version_advance: { column: "version", strategy: "integer_increment" as const },
    frozen_set: {
      max_rows: 2,
      row_count: 2,
      aggregate_bounds: [{ column: "balance_cents", measure: "before" as const, maximum: 20_000, actual: 15_000 }],
      members: [
        {
          primary_key: { column: "id", value: "INV-1" },
          expected_version: { column: "version", value: 1 },
          before: { status: "overdue", balance_cents: 5_000 },
          after: { status: "closed", balance_cents: 5_000 },
          before_digest: "sha256:before-1",
          after_digest: "sha256:after-1",
        },
        {
          primary_key: { column: "id", value: "INV-2" },
          expected_version: { column: "version", value: 2 },
          before: { status: "overdue", balance_cents: 10_000 },
          after: { status: "closed", balance_cents: 10_000 },
          before_digest: "sha256:before-2",
          after_digest: "sha256:after-2",
        },
      ],
      set_digest: "sha256:set-1",
    },
    idempotency_key: "idem-set-1",
    lease_expires_at: 1,
    lease_token: "lease-set-1",
    runner_id: "runner-1",
    attempt_count: 1,
  };
}

function v3Receipt() {
  return {
    schema_version: protocolVersions.executionReceiptV3,
    writeback_job_id: "wbj_set_1",
    proposal_id: "wrp_set_1",
    proposal_hash: "sha256:proposal-set-1",
    approval_id: "approval_set_1",
    runner_id: "runner-1",
    operation: "set_update" as const,
    receipt_authority: "source_db" as const,
    status: "applied" as const,
    target: {
      source_id: "src_1",
      schema: "public",
      table: "invoices",
      identities: [
        { column: "id", value: "INV-1" },
        { column: "id", value: "INV-2" },
      ],
      set_digest: "sha256:set-1",
    },
    rows_affected: 2,
    idempotency_key: "idem-set-1",
    member_effects: [
      { primary_key: { column: "id", value: "INV-1" }, before_digest: "sha256:before-1", after_digest: "sha256:after-1" },
      { primary_key: { column: "id", value: "INV-2" }, before_digest: "sha256:before-2", after_digest: "sha256:after-2" },
    ],
    source_database_mutated: true,
    safe_outcome_code: "APPLIED",
    executed_at: "2026-07-13T00:00:00Z",
    receipt_hash: "sha256:receipt-set-1",
  };
}

function v2Job(mutation: Record<string, unknown>, allowedColumns = ["amount_cents"]): Record<string, unknown> {
  return {
    schema_version: protocolVersions.writebackJobV2,
    writeback_job_id: "wbj_v2",
    proposal_id: "wrp_2",
    proposal_version: 1,
    proposal_hash: "sha256:proposal",
    runner_scope: { project_id: "local", source_id: "src_1" },
    engine: "postgres",
    target: {
      schema: "public",
      table: "credits",
      primary_key: { column: "id", value: "credit_wrp_2" },
    },
    tenant_guard: { column: "tenant_id", value: "acme" },
    allowed_columns: allowedColumns,
    mutation,
    idempotency_key: "wrp_2:credit_wrp_2",
    lease: { lease_id: "lease_2", attempt: 1, expires_at: "2026-07-13T23:59:59Z" },
  };
}

function v2ChangeSet(operation: "single_row_update" | "single_row_insert" | "single_row_delete") {
  const insert = operation === "single_row_insert";
  const deletion = operation === "single_row_delete";
  const before = insert ? {} : { id: "credit_2", tenant_id: "acme", amount_cents: 100, version: 7 };
  const patch = deletion ? {} : { amount_cents: 500 };
  const after = deletion ? {} : { ...before, id: "credit_2", tenant_id: "acme", amount_cents: 500, version: operation === "single_row_update" ? 8 : 1 };
  return {
    schema_version: protocolVersions.changeSetV2,
    proposal_id: "wrp_2",
    proposal_version: 1,
    action: "billing.change_credit",
    operation,
    mode: "review_required",
    principal: { id: "operator_1", source: "trusted_session" },
    scope: { tenant_id: "acme", business_object: "credits", object_id: "credit_2" },
    source: {
      kind: "external_postgres",
      source_id: "src_1",
      schema: "public",
      table: "credits",
      primary_key: { column: "id", ...(insert ? {} : { value: "credit_2" }) },
    },
    before,
    patch,
    after,
    guards: {
      tenant: { column: "tenant_id", value: "acme" },
      allowed_columns: deletion ? [] : ["amount_cents"],
      ...(insert ? {
        deduplication: { components: [
          { column: "tenant_id", value: "acme", source: "trusted_tenant" },
          { column: "request_id", value: "wrp_2", source: "proposal_id" },
        ] },
      } : {
        expected_version: { column: "version", value: 7 },
        ...(operation === "single_row_update" ? { version_advance: { column: "version", strategy: "integer_increment" } } : {}),
      }),
    },
    evidence: { bundle_id: "ev_2", query_fingerprint: "sha256:query", items: [] },
    approval: { status: "pending", required_role: "reviewer" },
    writeback: { status: "not_applied", mode: "trusted_worker_required", executor: "sql_update" },
    source_database_mutated: false,
    integrity: { proposal_hash: "sha256:proposal" },
    created_at: "2026-07-13T00:00:00Z",
  };
}
