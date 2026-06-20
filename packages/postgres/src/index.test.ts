import { describe, expect, it } from "vitest";
import { buildPostgresUpdate } from "./index.js";

const job = {
  protocol_version: "1.0" as const,
  job_id: "wbj_1",
  proposal_id: "wrp://x",
  approval_id: "appr_1",
  source_id: "src_1",
  engine: "postgres" as const,
  target: {
    schema: "public",
    table: "tickets",
    primary_key: { column: "id", value: "T-1042" },
    tenant_guard: { column: "tenant_id", value: "acme" }
  },
  allowed_columns: ["status", "resolution_note"],
  patch: { status: "pending_review", resolution_note: "Needs approval" },
  conflict_guard: { kind: "version_column" as const, column: "updated_at", expected_value: "v1" },
  idempotency_key: "idem",
  lease_expires_at: 1
};

describe("postgres adapter", () => {
  it("builds parameterized SQL", () => {
    const update = buildPostgresUpdate(job);
    expect(update.sql).toContain('UPDATE "public"."tickets"');
    expect(update.sql).toContain('"id" = $3');
    expect(update.sql).not.toContain("Needs approval");
    expect(update.values).toEqual(["pending_review", "Needs approval", "T-1042", "acme", "v1"]);
  });

  it("rejects unsafe identifiers", () => {
    expect(() => buildPostgresUpdate({ ...job, target: { ...job.target, table: "tickets;drop" } })).toThrow(/unsafe/i);
  });
});

