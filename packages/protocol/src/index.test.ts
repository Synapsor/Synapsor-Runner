import { describe, expect, it } from "vitest";
import { parseWritebackJob } from "./index.js";

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
});
