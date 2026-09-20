import type { ProposalRuntimeStore, StoredProposal, WorkerQueueItem } from "@synapsor-runner/proposal-store";
import { canonicalJsonStringify } from "@synapsor-runner/protocol";
export type SemanticRequestExecution = "human_review" | "not_enabled" | "queued" | "held" | "completed";

/** Client projection only. Never admits, dispatches, reconciles or inspects the source. */
export async function semanticRequestLifecycle(store: ProposalRuntimeStore, initial: StoredProposal,
  continuation?: { execution: SemanticRequestExecution }) {
  const id = initial.proposal_id;
  const proposal = await store.getProposal(id) ?? initial;
  const queue = await store.getWorkerQueueItem?.(id);
  const approvals = await store.approvals?.(id);
  const receipts = await store.receipts(id);
  const events = await store.events(id);
  // Reuse the existing control-only assessment, including its proof/lineage
  // checks. It does not perform the separate administrator source inspection.
  const needsRollback = proposal.state === "failed" && (queue?.status === "blocked" || queue?.status === "discarded");
  const assessRollback = () => needsRollback
    ? Promise.resolve().then(() => store.assessBlockedWorkerClosure?.(id)).catch(() => undefined) : undefined;
  const rollback = await assessRollback();
  const latest = await store.getProposal(id);
  const latestQueue = await store.getWorkerQueueItem?.(id);
  // These are ordinary reads, not an atomic snapshot. Do not combine observations
  // across a detected transition or incompatible queue/receipt states.
  const stable = latest !== undefined && same(proposal, latest) && same(queue, latestQueue)
    && same(approvals, await store.approvals?.(id)) && same(receipts, await store.receipts(id))
    && same(events, await store.events(id)) && same(rollback, await assessRollback());
  const matching = receipts.filter(r => r.proposal_id === id && r.receipt.proposal_id === id
    && r.writeback_job_id === r.receipt.writeback_job_id && r.idempotency_key === r.receipt.idempotency_key
    && (!("proposal_hash" in r.receipt) || r.receipt.proposal_hash === proposal.proposal_hash)
    && r.status === r.receipt.status && r.source_database_mutated === r.receipt.source_database_mutated);
  const applied = matching.filter(r => r.status === "applied" && r.receipt.source_database_mutated && r.receipt.rows_affected > 0);
  const failed = matching.filter(r => r.status === "failed");
  const complete = stable && proposal.state === "applied" && applied.length > 0
    && failed.length === 0 && (!queue || queue.status === "completed");
  const unresolved = !stable || proposal.state === "reconciliation_required" || queue?.status === "reconciliation_required"
    || (proposal.state === "applied" && !complete)
    || (proposal.state !== "applied" && applied.length > 0)
    || (proposal.state === "pending_review" && Boolean(queue))
    || matching.length !== receipts.length || applied.length > 1
    || (queue?.status === "completed" && !complete)
    || (queue?.status === "retry_wait" && !validRetryTime(queue));

  const applicable = approvals?.filter(a => a.proposal_id === id && a.proposal_hash === proposal.proposal_hash
    && a.proposal_version === proposal.proposal_version) ?? [];
  const accepted = applicable.filter(a => a.status === "approved");
  const rejected = applicable.some(a => a.status === "rejected");
  const automatic = accepted.some(a => a.approver.startsWith("policy:"));
  const human = accepted.some(a => !a.approver.startsWith("policy:"));
  const approval = !stable || (rejected && accepted.length > 0) || (automatic && human) || accepted.filter(a => a.approver.startsWith("policy:")).length > 1 ? "unknown"
    : proposal.state === "pending_review" && !automatic && !rejected ? "pending_human_review"
    : rejected ? "not_approved"
    : automatic ? "automatic" : human ? "human" : "unknown";
  const limitDeferred = approval === "pending_human_review" && events.some(e => e.proposal_id === id
    && e.kind === "policy_auto_approval_deferred" && e.payload.fallback === "human_review"
    && Array.isArray(e.payload.tripped_limits) && e.payload.tripped_limits.length > 0);
  const approvalText = approval === "automatic" ? "automatically approved; apply remains a separate authority"
    : approval === "human" ? "approved by a human reviewer; apply remains a separate authority"
    : approval === "pending_human_review" ? limitDeferred
      ? "pending human review because a recorded automatic-approval limit did not pass" : "human review required"
    : approval === "not_approved" ? "a rejection is recorded; no approval is granted"
    : "the recorded approval decision is unavailable; do not infer a new decision";

  let outcome: "not_started" | "queued" | "in_progress" | "retry_wait" | "applied" | "failed" | "unknown" = "unknown";
  if (!unresolved) {
    if (complete) outcome = "applied";
    else if (queue?.status === "leased") outcome = "in_progress";
    else if (queue?.status === "retry_wait") outcome = "retry_wait";
    else if (proposal.state === "failed" && failed.length > 0) outcome = "failed";
    else if (queue?.status === "queued" && (queue.attempts === 0 || proposal.state === "approved" || proposal.state === "pending_worker")) outcome = "queued";
    else if (!queue && receipts.length === 0 && ["pending_review", "approved"].includes(proposal.state)) outcome = "not_started";
  }
  const disposition = !stable ? "unknown"
    : queue?.status === "reconciliation_required" || proposal.state === "reconciliation_required" ? "reconciliation_required"
    : queue?.status === "discarded" || queue?.status === "cancelled" || proposal.state === "rejected" || proposal.state === "canceled" ? "closed"
    : queue?.status === "blocked" || queue?.status === "dead_letter" ? "blocked"
    : "open";
  const retry = unresolved || !store.getWorkerQueueItem || queue?.status === "retry_wait" && !validRetryTime(queue) ? null : queue?.status === "retry_wait";
  const execution: SemanticRequestExecution = complete ? "completed"
    : unresolved || disposition === "closed" || disposition === "blocked" ? "held"
    : proposal.state === "pending_review" ? "human_review"
    : outcome === "queued" ? "queued"
    : outcome === "in_progress" || outcome === "retry_wait" ? "held"
    : (proposal.state === "approved" || proposal.state === "pending_worker") && outcome === "not_started"
      ? continuation?.execution === "not_enabled" || continuation?.execution === "held"
        ? continuation.execution : continuation?.execution === "completed" || continuation?.execution === "queued" ? "held" : "not_enabled"
      : "held";
  const status = complete ? "completed" : disposition === "closed" ? "closed"
    : unresolved ? "attention_required" : proposal.state === "pending_review" ? "pending_human_review"
    : (proposal.state === "approved" || proposal.state === "pending_worker") && (approval === "automatic" || approval === "human")
      ? "approved_pending_execution" : "attention_required";
  const noEffect = stable && !unresolved && outcome === "failed" && failed.length === 1
    && rollback !== undefined && (rollback.status === "source_check_required" || rollback.status === "closed")
    && rollback.receipt_hash === failed[0]!.receipt.receipt_hash
    && events.some(e => e.proposal_id === id && e.event_id === rollback.producer_event_id
      && e.kind === "writeback_source_rollback" && e.payload.receipt_hash === rollback.receipt_hash);
  const sourceChanged = complete ? true : noEffect || outcome === "not_started" || outcome === "queued" && queue?.attempts === 0 ? false : null;
  const next = disposition === "closed"
    ? "This work is closed; it will not retry. Its recorded approval and original outcome remain. A distinct request needs a new current reference and all ordinary checks; approval is not promised."
    : outcome === "applied" ? "Re-read the reviewed resource to present current source values."
    : outcome === "failed" || disposition === "blocked" ? `Execution did not complete successfully. ${retry === false ? "No automatic retry is scheduled." : "Retry status is unavailable."} Ask an authorized operator to inspect this request; do not assume a fresh request will be approved.`
    : outcome === "retry_wait" ? "A retry is scheduled; current policy, worker control and execution checks still apply."
    : outcome === "in_progress" ? "An execution attempt is in progress; await its recorded outcome. Do not create a replacement request."
    : execution === "human_review" ? "Wait for the separate authorized human review."
    : outcome === "queued" || execution === "queued" ? "Wait for an eligible worker; approval alone does not establish execution."
    : outcome === "not_started" ? "Execution has not started. An authorized operator can inspect execution readiness."
    : "The execution outcome is not established by the available records. Ask an authorized operator to inspect or reconcile it before retrying.";
  return { proposal, stable, approval, approvalText, execution, status, sourceChanged, next,
    lifecycle: { execution: outcome, disposition, automatic_retry_scheduled: retry,
      next_retry_at: retry === true && validRetryTime(queue) ? queue!.next_attempt_at : null },
    executionReceipt: complete ? { verified: true, status: "applied", source_database_changed: true }
      : !unresolved && outcome === "failed" ? { verified: true, status: "failed", source_database_changed: noEffect ? false : null } : undefined,
  };
}

function same(a: unknown, b: unknown): boolean { return canonicalJsonStringify(JSON.parse(JSON.stringify(a ?? null))) === canonicalJsonStringify(JSON.parse(JSON.stringify(b ?? null))); }
function validRetryTime(queue: WorkerQueueItem | undefined): boolean {
  return Boolean(queue && Number.isFinite(Date.parse(queue.next_attempt_at)));
}
