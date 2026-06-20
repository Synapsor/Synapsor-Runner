import { describe, expect, it } from "vitest";
import { buildMysqlUpdate } from "./index.js";

const job = {
  protocol_version: "1.0" as const,
  job_id: "wbj_1",
  proposal_id: "wrp://x",
  approval_id: "appr_1",
  source_id: "src_1",
  engine: "mysql" as const,
  target: {
    schema: "appdb",
    table: "orders",
    primary_key: { column: "id", value: "O-1" },
    tenant_guard: { column: "tenant_id", value: "acme" }
  },
  allowed_columns: ["status"],
  patch: { status: "refund_requested" },
  conflict_guard: { kind: "version_column" as const, column: "updated_at", expected_value: "v1" },
  idempotency_key: "idem",
  lease_expires_at: 1
};

describe("mysql adapter", () => {
  it("builds parameterized SQL", () => {
    const update = buildMysqlUpdate(job);
    expect(update.sql).toContain("UPDATE `appdb`.`orders`");
    expect(update.sql).not.toContain("refund_requested");
    expect(update.values).toEqual(["refund_requested", "O-1", "acme", "v1"]);
  });

  it("rejects unsafe identifiers", () => {
    expect(() => buildMysqlUpdate({ ...job, target: { ...job.target, table: "orders;drop" } })).toThrow(/unsafe/i);
  });
});

