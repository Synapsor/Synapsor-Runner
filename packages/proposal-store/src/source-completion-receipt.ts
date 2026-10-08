import { canonicalJsonDigest, protocolVersions, type ExecutionReceipt, type WritebackResult } from "@synapsor-runner/protocol";
import type { StoredWritebackIntent } from "./domain-types.js";
import { ProposalStoreError } from "./errors.js";

export function assertSourceCompletionReceipt(intent: StoredWritebackIntent, receipt: ExecutionReceipt, result: WritebackResult): void {
  const job = intent.intent;
  const invalid = (): never => { throw new ProposalStoreError("SOURCE_COMPLETION_RECEIPT_MISMATCH", "bookkeeping receipt differs from the exact Source completion"); };
  if ((receipt.schema_version !== protocolVersions.executionReceiptV2 && receipt.schema_version !== protocolVersions.executionReceiptV5)
    || (result.protocol_version !== "2.0" && result.protocol_version !== "5.0")
    || receipt.schema_version !== (result.protocol_version === "5.0" ? protocolVersions.executionReceiptV5 : protocolVersions.executionReceiptV2)
    || receipt.status !== "applied" || receipt.receipt_authority !== "source_db" || !receipt.source_database_mutated
    || receipt.rows_affected !== result.affected_rows || receipt.approval_id !== job.approval_id
    || receipt.idempotency_key !== job.idempotency_key || receipt.runner_id !== result.runner_id || receipt.executed_at !== result.completed_at
    || receipt.target.source_id !== job.source_id || receipt.target.schema !== job.target.schema || receipt.target.table !== job.target.table
    || canonicalJsonDigest(receipt.target.identity) !== canonicalJsonDigest(result.target_identity)) return invalid();
  if (receipt.schema_version === protocolVersions.executionReceiptV2 && result.protocol_version === "2.0"
    && canonicalJsonDigest(receipt.new_version ?? null) !== canonicalJsonDigest(result.result_version ?? null)) return invalid();
  const receiptFields = receipt as unknown as Record<string, unknown>, resultFields = result as unknown as Record<string, unknown>;
  for (const field of ["before_digest", "after_digest", "tombstone_digest", "inverse", "semantic_verification", "atomic_effects"]) {
    if (canonicalJsonDigest(receiptFields[field] ?? null) !== canonicalJsonDigest(resultFields[field] ?? null)) return invalid();
  }
}
