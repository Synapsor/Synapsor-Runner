import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCP_AUDIT_DISCLAIMER,
  assertFrozenSetJobIntegrity,
  auditMcpManifest,
  classifyFrozenSetReconciliation,
  doctorChecks,
  formatMcpAuditReport,
  redact,
  validateJob,
  type RunnerConfig,
} from "./index.js";

const baseConfig: RunnerConfig = {
  controlPlaneUrl: "https://synapsor.example",
  runnerToken: "syn_wbr_test",
  runnerId: "runner_1",
  sourceId: "src_1",
  databaseUrl: "postgresql://writer:secret@example/app",
  engine: "postgres",
  pollIntervalMs: 5000,
  logLevel: "info",
  dryRun: false,
  stateDir: "./state"
};

describe("worker core", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redacts tokens and database URLs", () => {
    const text = redact("Bearer syn_wbr_secret postgresql://user:pass@example/db mysql://root:pass@example/db");
    expect(text).not.toContain("pass");
    expect(text).not.toContain("syn_wbr_secret");
  });

  it("validates jobs through the shared protocol", () => {
    expect(validateJob({
      protocol_version: "1.0",
      job_id: "wbj_1",
      proposal_id: "wrp://x",
      approval_id: "appr_1",
      source_id: "src_1",
      engine: "mysql",
      target: {
        schema: "app",
        table: "orders",
        primary_key: { column: "id", value: "O-1" },
        tenant_guard: { column: "tenant_id", value: "acme" }
      },
      allowed_columns: ["status"],
      patch: { status: "refund_requested" },
      conflict_guard: { kind: "version_column", column: "updated_at", expected_value: "v1" },
      idempotency_key: "idem",
      lease_expires_at: 1
    }).job_id).toBe("wbj_1");
  });

  it("classifies frozen-set reconciliation atomically and treats mixed outcomes as drift", () => {
    const parsed = validateJob(v3SetJob());
    if (parsed.protocol_version !== "3.0") throw new Error("v3 fixture did not parse");
    const before = classifyFrozenSetReconciliation(parsed, [
      { id: "INV-1", tenant_id: "acme", status: "overdue", version: 1 },
      { id: "INV-2", tenant_id: "acme", status: "overdue", version: 2 },
    ]);
    expect(before.classification).toBe("matches_reviewed_before");
    expect(before.member_observations).toHaveLength(2);

    const applied = classifyFrozenSetReconciliation(parsed, [
      { id: "INV-1", tenant_id: "acme", status: "closed", version: 2 },
      { id: "INV-2", tenant_id: "acme", status: "closed", version: 3 },
    ]);
    expect(applied.classification).toBe("matches_proposed");

    const partial = classifyFrozenSetReconciliation(parsed, [
      { id: "INV-1", tenant_id: "acme", status: "closed", version: 2 },
      { id: "INV-2", tenant_id: "acme", status: "overdue", version: 2 },
    ]);
    expect(partial.classification).toBe("drifted");
  });

  it("accepts a 1.4.0 contract-produced set digest after protocol key normalization", () => {
    const input = v3SetJob();
    const frozenSet = input.frozen_set as {
      aggregate_bounds: Array<Record<string, unknown>>;
      members: Array<Record<string, unknown>>;
      set_digest: string;
    };
    for (const member of frozenSet.members) {
      const primaryKey = (member.primary_key as { value: unknown }).value;
      member.before = { ...(member.before as Record<string, unknown>), tenant_id: "acme" };
      member.after = { ...(member.after as Record<string, unknown>), tenant_id: "acme" };
      member.before_digest = legacyDigest({ primary_key: primaryKey, before: member.before });
      member.after_digest = legacyDigest({ primary_key: primaryKey, after: member.after });
    }
    // normalizeContract alphabetizes contract keys before Runner appends actual.
    const contractOrderedBounds = frozenSet.aggregate_bounds.map((bound) => ({
      column: bound.column,
      maximum: bound.maximum,
      measure: bound.measure,
      actual: bound.actual,
    }));
    frozenSet.aggregate_bounds = contractOrderedBounds;
    frozenSet.set_digest = legacyDigest({
      operation: input.operation,
      members: frozenSet.members,
      aggregate_bounds: contractOrderedBounds,
    });

    const parsed = validateJob(input);
    if (parsed.protocol_version !== "3.0") throw new Error("v3 fixture did not parse");
    expect(() => assertFrozenSetJobIntegrity(parsed)).not.toThrow();
    parsed.frozen_set.set_digest = "sha256:tampered";
    expect(() => assertFrozenSetJobIntegrity(parsed)).toThrow("SET_DIGEST_MISMATCH");
  });

  it("combines runner-token doctor and database doctor checks", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toBe("https://synapsor.example/v1/writeback/runner/doctor");
      return new Response(JSON.stringify({
        ok: true,
        source_id: "src_1",
        permissions: ["writeback:claim", "writeback:heartbeat", "writeback:result"]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const report = await doctorChecks(baseConfig, {
      async doctor() {
        return { ok: true, details: { receipt_table: "ready", write_permission_rollback: true } };
      },
      async apply() {
        throw new Error("not used");
      }
    });
    expect(report.ok).toBe(true);
    expect(report.control_plane.authenticated).toBe(true);
    expect(report.database.details.receipt_table).toBe("ready");
  });

  it("flags generic SQL and model-controlled trust fields in MCP manifests", () => {
    const report = auditMcpManifest({
      tools: [
        {
          name: "execute_sql",
          description: "Run SQL against the production database",
          inputSchema: {
            type: "object",
            properties: {
              sql: { type: "string" },
              tenant_id: { type: "string" },
              table_name: { type: "string" }
            }
          }
        }
      ]
    }, { target: "dangerous-tools.json" });

    expect(report.disclaimer).toBe(MCP_AUDIT_DISCLAIMER);
    expect(report.summary.high).toBeGreaterThanOrEqual(4);
    expect(report.findings.map((finding) => finding.code)).toContain("GENERIC_SQL_TOOL");
    expect(report.findings.map((finding) => finding.code)).toContain("WRITE_TOOL_ACCEPTS_ARBITRARY_SQL");
    expect(report.findings.map((finding) => finding.code)).toContain("MODEL_CONTROLLED_TRUST_SCOPE");
    expect(report.findings.map((finding) => finding.code)).toContain("ARBITRARY_IDENTIFIER_INPUT");
    expect(formatMcpAuditReport(report)).toContain(MCP_AUDIT_DISCLAIMER);
  });

  it("does not flag reviewed proposal tools as direct write tools", () => {
    const report = auditMcpManifest({
      result: {
        tools: [
          {
            name: "billing.propose_late_fee_waiver",
            description: "Create an evidence-backed proposal for support lead approval before trusted writeback.",
            inputSchema: {
              type: "object",
              properties: {
                invoice_id: { type: "string" },
                reason: { type: "string" }
              },
              required: ["invoice_id", "reason"]
            },
            outputSchema: {
              type: "object",
              properties: {
                status: { type: "string" },
                proposal_id: { type: "string" },
                evidence_bundle_id: { type: "string" },
                source_database_changed: { type: "boolean" }
              },
              required: ["status", "proposal_id", "source_database_changed"]
            },
            annotations: { readOnlyHint: false, destructiveHint: false },
            examples: [
              { invoice_id: "INV-3001", reason: "customer requested review" }
            ]
          }
        ]
      }
    }, { target: "synapsor-tools.json" });

    expect(report.findings.filter((finding) => finding.severity === "HIGH")).toEqual([]);
    expect(report.findings.map((finding) => finding.code)).not.toContain("WRITE_WITHOUT_PROPOSAL_BOUNDARY");
    expect(report.findings.map((finding) => finding.code)).not.toContain("NO_IDEMPOTENCY_FIELD");
    expect(report.findings.map((finding) => finding.code)).not.toContain("NO_CONFLICT_GUARD");
  });
});

function v3SetJob(): Record<string, unknown> {
  return {
    protocol_version: "3.0",
    job_id: "wbj_set_1",
    proposal_id: "wrp_set_1",
    proposal_hash: "sha256:proposal-set-1",
    approval_id: "sha256:approval-set-1",
    source_id: "src_1",
    engine: "postgres",
    operation: "set_update",
    target: {
      schema: "public",
      table: "invoices",
      primary_key: { column: "id" },
      tenant_guard: { column: "tenant_id", value: "acme" },
    },
    allowed_columns: ["status"],
    patch: { status: "closed" },
    conflict_guard: { kind: "none" },
    version_advance: { column: "version", strategy: "integer_increment" },
    frozen_set: {
      max_rows: 2,
      row_count: 2,
      aggregate_bounds: [{ column: "version", measure: "before", maximum: 3, actual: 3 }],
      members: [
        {
          primary_key: { column: "id", value: "INV-1" },
          expected_version: { column: "version", value: 1 },
          before: { status: "overdue", version: 1 },
          after: { status: "closed", version: 2 },
          before_digest: "sha256:before-1",
          after_digest: "sha256:after-1",
        },
        {
          primary_key: { column: "id", value: "INV-2" },
          expected_version: { column: "version", value: 2 },
          before: { status: "overdue", version: 2 },
          after: { status: "closed", version: 3 },
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

function legacyDigest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
