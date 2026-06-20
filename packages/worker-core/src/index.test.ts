import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCP_AUDIT_DISCLAIMER,
  auditMcpManifest,
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
