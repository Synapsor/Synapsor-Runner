import { canonicalJsonDigest, parseWritebackJob } from "@synapsor-runner/protocol";
import type { ProposalStoreMethodContext } from "./sqlite-method-signatures.js";
import type { BlockedClosureSourceObservation, BlockedClosureAssessment } from "./domain-types.js";

export type { BlockedRollbackEvidence, BlockedClosureSourceObservation, BlockedClosureAssessment, CloseBlockedWorkerInput } from "./domain-types.js";

export function blockedClosureDecisionReason(digest: string, reason: string): string {
  return `Close no-effect blocked work ${digest}: ${reason}`;
}

/** Shared producer/store identity. Epochs and active Action pointers intentionally
 * excluded: resolving old history does not require reactivating it. */
const bridgeBindings = new Map<string, string>();
/** Ephemeral binding established by the existing verified runtime-store bridge.
 * This is not a second policy authority and is never read from CLI/model input. */
export function bindBlockedClosureBridge(path: string, binding: { repository_id: string; deployment_id: string; project_id: string }): () => void {
  const digest = canonicalJsonDigest({ repository_id: binding.repository_id, deployment_id: binding.deployment_id, project_id: binding.project_id });
  const previous = bridgeBindings.get(path);
  bridgeBindings.set(path, digest);
  return () => { if (previous === undefined) bridgeBindings.delete(path); else bridgeBindings.set(path, previous); };
}
export function blockedClosureStoreBinding(store: Pick<ProposalStoreMethodContext, "db" | "path">): string | undefined {
  const bridge = bridgeBindings.get(store.path);
  if (bridge) return bridge;
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_policy_identity'").get()) return undefined;
  const repository = store.db.prepare("SELECT repository_id FROM control_policy_identity").all();
  const deployments = store.db.prepare("SELECT deployment_id, project_id FROM control_policy_deployments").all();
  if (repository.length !== 1 || deployments.length !== 1) return undefined;
  return canonicalJsonDigest({ repository_id: repository[0]!.repository_id, deployment_id: deployments[0]!.deployment_id, project_id: deployments[0]!.project_id });
}

/** Pure assessment; all records are read again in the definitive writer transaction.
 * Missing proof is never reconstructed from a safe error, zero rows or current facts. */
export function assessBlockedClosure(store: ProposalStoreMethodContext, proposalId: string,
  source?: BlockedClosureSourceObservation): BlockedClosureAssessment {
  const proposal = store.getProposal(proposalId), queue = store.getWorkerQueueItem(proposalId);
  const jobs = store.listWritebackJobs({ proposal_id: proposalId, limit: 1000 });
  const receipts = store.receipts(proposalId), events = store.events(proposalId);
  const intents = store.listWritebackIntents({ proposal_id: proposalId, limit: 1000 });
  const admissions = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_policy_effect_admissions'").get()
    ? store.db.prepare("SELECT * FROM control_policy_effect_admissions WHERE request_id = ?").all(proposalId) : [];
  const storeBinding = blockedClosureStoreBinding(store);
  const assessment_digest = canonicalJsonDigest(JSON.parse(JSON.stringify({ storeBinding: storeBinding ?? null, proposal: proposal ?? null, queue: queue ?? null,
    jobs, receipts, events, intents, admissions })));
  const base: BlockedClosureAssessment = { schema_version: "synapsor.blocked-closure.v1", proposal_id: proposalId,
    status: "unavailable", code: "BLOCKED_CLOSURE_RECORDS_UNAVAILABLE", assessment_digest, required_roles: [], approval_refunded: false };
  const refuse = (code: string) => ({ ...base, code });
  if (!proposal || !queue) return base;
  if (!storeBinding) return refuse("BLOCKED_CLOSURE_STORE_BINDING_UNAVAILABLE");
  base.recorded_error = queue.last_error_code;
  const closed = events.filter(e => e.kind === "writeback_blocked_closed");
  if (queue.status === "discarded" && closed.length === 1 && proposal.state === "failed") {
    return { ...base, status: "closed", code: "BLOCKED_CLOSURE_ALREADY_CLOSED", closure_event_id: closed[0]!.event_id,
      assessment_digest: String(closed[0]!.payload.assessment_digest) as `sha256:${string}`,
      receipt_hash: String(closed[0]!.payload.receipt_hash), producer_event_id: Number(closed[0]!.payload.producer_event_id),
      required_roles: Array.isArray(closed[0]!.payload.required_roles) ? closed[0]!.payload.required_roles as string[] : [],
      ...(typeof queue.cancellation_control_role === "string" ? { control_role: queue.cancellation_control_role } : {}) };
  }
  if (queue.status !== "blocked" || queue.terminal_outcome !== "blocked" || proposal.state !== "failed"
    || queue.lease_id || queue.lease_owner || queue.lease_expires_at || proposal.source_database_mutated || closed.length) {
    return refuse("BLOCKED_CLOSURE_NOT_TERMINAL_NO_EFFECT");
  }
  if (queue.attempts !== 1 || jobs.length !== 1 || receipts.length !== 1 || intents.length || admissions.length) {
    return refuse("BLOCKED_CLOSURE_ATTEMPTS_UNRESOLVED");
  }
  const idempotency = store.db.prepare("SELECT receipt_json FROM idempotency_receipts WHERE proposal_id = ?").all(proposalId);
  if (idempotency.length !== 1 || canonicalJsonDigest(JSON.parse(String(idempotency[0]!.receipt_json))) !== canonicalJsonDigest(receipts[0]!.receipt)) return refuse("BLOCKED_CLOSURE_RECEIPT_MISMATCH");
  const count = (kind: string) => events.filter(e => e.kind === kind);
  if (["writeback_authorized", "writeback_worker_claimed", "writeback_job_recorded", "writeback_failed", "writeback_worker_blocked"].some(k => count(k).length !== 1)
    || events.some(e => ["writeback_reconciliation_required", "writeback_worker_retry_scheduled", "writeback_applied", "writeback_already_applied"].includes(e.kind))) {
    return refuse("BLOCKED_CLOSURE_ATTEMPTS_UNRESOLVED");
  }
  const proofs = count("writeback_source_rollback");
  if (proofs.length !== 1) return refuse("BLOCKED_CLOSURE_PRODUCER_EVIDENCE_MISSING");
  const proof = proofs[0]!.payload;
  let job;
  try { job = parseWritebackJob(jobs[0]!.payload); } catch { return refuse("BLOCKED_CLOSURE_JOB_INVALID"); }
  const receipt = receipts[0]!.receipt;
  if (job.protocol_version !== "5.0" || job.engine !== "postgres" || job.semantic_authority.proof.delegation
    || receipt.schema_version !== "synapsor.execution-receipt.v5" || receipt.receipt_authority !== "source_db") {
    return refuse("BLOCKED_CLOSURE_MODE_UNSUPPORTED");
  }
  const { receipt_hash, ...core } = receipt;
  if (receipt_hash !== canonicalJsonDigest(core) || receipt.status !== "failed" || receipt.safe_error_code !== "SEMANTIC_AUTHORITY_STALE"
    || receipt.source_database_mutated || receipt.rows_affected !== 0 || receipt.proposal_id !== proposalId
    || receipt.proposal_hash !== proposal.proposal_hash || receipt.writeback_job_id !== job.job_id
    || receipt.idempotency_key !== job.idempotency_key || job.attempt_count !== 1 || jobs[0]!.status !== "failed"
    || job.proposal_hash !== proposal.proposal_hash || job.proposal_id !== proposalId) return refuse("BLOCKED_CLOSURE_RECEIPT_MISMATCH");
  const claim = count("writeback_worker_claimed")[0]!, terminal = count("writeback_worker_blocked")[0]!;
  if (proof.producer !== "synapsor.postgres.source_db.rollback.v1" || proof.outcome !== "rollback_acknowledged"
    || proof.job_digest !== canonicalJsonDigest(job) || proof.receipt_hash !== receipt_hash || proof.store_binding !== storeBinding
    || proof.lease_id !== claim.payload.lease_id || proof.lease_id !== terminal.payload.lease_id
    || proof.attempt !== 1 || claim.payload.attempt !== 1 || proof.job_id !== job.job_id
    || typeof proof.source_binding_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(proof.source_binding_digest)
    || typeof proof.execution_config_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(proof.execution_config_digest)
    || !Number.isFinite(Date.parse(String(proof.observed_at)))
    || Date.parse(String(proof.observed_at)) > Date.parse(receipt.executed_at)
    || proofs[0]!.event_id >= terminal.event_id) return refuse("BLOCKED_CLOSURE_PRODUCER_EVIDENCE_MISMATCH");
  const roles = proof.required_roles;
  if (!Array.isArray(roles) || !roles.length || roles.some(r => typeof r !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(r))) {
    return refuse("BLOCKED_CLOSURE_CONTROL_ROLE_UNAVAILABLE");
  }
  base.required_roles = roles as string[];
  if (typeof queue.cancellation_control_role === "string") base.control_role = queue.cancellation_control_role;
  base.job_id = job.job_id; base.receipt_hash = receipt_hash; base.source_binding_digest = proof.source_binding_digest;
  base.producer_event_id = proofs[0]!.event_id;
  if (!source) return { ...base, status: "source_check_required", code: "BLOCKED_CLOSURE_SOURCE_CHECK_REQUIRED" };
  if (source.assessment_digest !== assessment_digest || source.source_binding_digest !== base.source_binding_digest) return refuse("BLOCKED_CLOSURE_SOURCE_BINDING_CHANGED");
  if (source.state !== "absent") return refuse(source.state === "present" ? "BLOCKED_CLOSURE_SOURCE_CONTRADICTION" : "BLOCKED_CLOSURE_SOURCE_UNAVAILABLE");
  return { ...base, status: "available", code: "BLOCKED_CLOSURE_AVAILABLE" };
}
