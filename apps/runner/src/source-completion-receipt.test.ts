import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, parseWritebackJob, parseWritebackResult } from "@synapsor-runner/protocol";
import type { StoredWritebackIntent } from "@synapsor-runner/proposal-store";
import { reconciliationReceipt } from "./writeback-setup.js";

describe("Source-proven bookkeeping receipt encoding", () => {
  it("encodes an ordinary native result with absent optional digests and the exact resulting version", () => {
    const job = parseWritebackJob({ protocol_version: "2.0", job_id: "wbj_encoding", proposal_id: "wrp_encoding",
      approval_id: canonicalJsonDigest({ approval: "encoding" }), source_id: "unit_source", engine: "postgres", operation: "single_row_update",
      target: { schema: "public", table: "credits", primary_key: { column: "id", value: "credit_1" }, tenant_guard: { column: "tenant_id", value: "unit_tenant" } },
      allowed_columns: ["amount_cents"], patch: { amount_cents: 2500 }, conflict_guard: { kind: "version_column", column: "version", expected_value: 7 },
      version_advance: { column: "version", strategy: "integer_increment" }, idempotency_key: "unit_encoding", lease_expires_at: "2099-01-01T00:00:00Z", attempt_count: 1 });
    const primaryKey = job.target.primary_key;
    if (primaryKey.value === undefined) throw new Error("Unit update requires an exact identity");
    const identity = [{ column: primaryKey.column, value: primaryKey.value }];
    const result = parseWritebackResult({ protocol_version: "2.0", job_id: job.job_id, runner_id: "unit_runner", operation: "single_row_update",
      receipt_authority: "source_db", status: "applied", affected_rows: 1, target_identity: identity, result_version: 8,
      after_digest: canonicalJsonDigest({ native: "result" }), completed_at: "2026-10-08T00:00:00Z" });
    // Pure typed encoder unit: no Source query, authority, approval or adoption occurs.
    const intent = { intent_id: "wbi:" + job.job_id, intent: job } as StoredWritebackIntent;
    const receipt = reconciliationReceipt(intent, { operation: "single_row_update", classification: "completion_proven",
      target_identity: identity, expected: {}, observed: {}, observed_digest: canonicalJsonDigest(result),
      source_completion: { status: "proven", evidence: { schema_version: "synapsor.postgres.source-completion.v1",
        job_digest: canonicalJsonDigest(job), binding_digest: canonicalJsonDigest({ unit: "binding" }), result, result_digest: canonicalJsonDigest(result) } } },
      "applied", "unit_reconciler", "Exact Source proof");
    expect(receipt).toMatchObject({ schema_version: "synapsor.execution-receipt.v2", new_version: 8, runner_id: "unit_runner" });
    expect(receipt).not.toHaveProperty("before_digest");
    const { receipt_hash, ...core } = receipt;
    expect(receipt_hash).toBe(canonicalJsonDigest(core));
  });
});
