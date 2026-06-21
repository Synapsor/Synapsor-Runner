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
    expect(parseWritebackJob(validJob).job_id).toBe("wbj_1");
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

describe("public protocol fixtures", () => {
  it("keeps the shared manifest in sync with checked-in schemas and fixtures", () => {
    const manifest = fixture("MANIFEST.json") as {
      schema_version: string;
      hash_algorithm: string;
      artifacts: Array<{ kind: string; name: string; sha256: string }>;
    };
    expect(manifest.schema_version).toBe("synapsor.protocol-manifest.v1");
    expect(manifest.hash_algorithm).toBe("sha256");
    expect(manifest.artifacts).toHaveLength(9);
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
