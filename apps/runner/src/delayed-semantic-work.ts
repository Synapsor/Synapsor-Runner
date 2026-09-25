import { canonicalJsonDigest, type DelayedSemanticWorkV1 } from "@synapsor-runner/protocol";
import { resolveSemanticSupervisedWriterSource, type RuntimeConfig,
  type RuntimeSupervisedWorkerOutcomePolicy } from "@synapsor-runner/mcp-server";
import { executionBindingDigest } from "./control-policy-execution.js";

/** Public/operator-safe classification shared by approval and dispatch. */
export function safeDelayedValidationCode(error: unknown): string {
  const ownCode = error && typeof error === "object" && "code" in error
    && typeof error.code === "string" ? error.code : undefined;
  const prefix = error instanceof Error ? /^([A-Z][A-Z0-9_]{1,79}):/.exec(error.message)?.[1] : undefined;
  const code = ownCode ?? prefix;
  if (code === "ACTION_RULE_AUTHORITY_STALE") return "DELAYED_WORK_EXACT_OPERATION_CHANGED";
  return code?.startsWith("DELAYED_WORK_") ? code
    : code?.startsWith("DELAYED_VALIDATION_") ? `DELAYED_WORK_${code.slice("DELAYED_VALIDATION_".length)}`
      : "DELAYED_WORK_VERIFICATION_UNAVAILABLE";
}

/** The reviewed execution and receipt selection, not just the Action digest,
 * bind an opt-in new request. A changed selection needs a new request/review. */
export function currentDelayedSemanticWork(input: {
  config: RuntimeConfig;
  outcome: string;
  action_boundary_digest: string;
  source: string;
  engine: "postgres" | "mysql";
}): Omit<DelayedSemanticWorkV1, "schema_version" | "requested_at"> | undefined {
  const worker = input.config.supervised_worker;
  const policy = worker?.enabled ? worker.outcomes?.find((entry) => entry.outcome === input.outcome
    && entry.action_boundary_digest === input.action_boundary_digest) : undefined;
  if (!policy?.delayed_work) return undefined;
  if (input.engine !== "postgres") throw new Error("DELAYED_WORK_UNSUPPORTED: only PostgreSQL semantic source transactions are supported.");
  const writer = resolveSemanticSupervisedWriterSource(input.config, input.source, policy);
  if (writer?.receipts?.authority !== "source_db" || writer.receipts.provisioning !== "precreated") {
    throw new Error("DELAYED_WORK_RECEIPT_REQUIRED: an exact precreated source-db receipt is required.");
  }
  if (policy.delayed_work.absolute_request_age_seconds > policy.proposal_ttl_seconds) {
    throw new Error("DELAYED_WORK_WORKER_AGE: the worker proposal-age bound is shorter than the requested absolute age.");
  }
  return {
    execution_policy_digest: canonicalJsonDigest({ execution_binding: executionBindingDigest(input.config),
      worker_policy: policy, source_receipts: writer.receipts }),
    approval_wait_seconds: policy.delayed_work.approval_wait_seconds,
    approval_validity_seconds: policy.delayed_work.approval_validity_seconds,
    absolute_request_age_seconds: policy.delayed_work.absolute_request_age_seconds,
    max_validation_attempts: policy.delayed_work.max_validation_attempts,
  };
}

export function assertDelayedSemanticWorkCurrent(input: {
  config: RuntimeConfig;
  delayed_work: DelayedSemanticWorkV1;
  outcome: string;
  action_boundary_digest: string;
  source: string;
  engine: "postgres" | "mysql";
  now: string;
  phase: "approval" | "dispatch";
  approvals?: readonly { created_at: string; status: string }[];
}): RuntimeSupervisedWorkerOutcomePolicy {
  const current = currentDelayedSemanticWork(input);
  const policy = input.config.supervised_worker?.outcomes?.find((entry) => entry.outcome === input.outcome
    && entry.action_boundary_digest === input.action_boundary_digest);
  if (!current || !policy || canonicalJsonDigest(current) !== canonicalJsonDigest({
    execution_policy_digest: input.delayed_work.execution_policy_digest,
    approval_wait_seconds: input.delayed_work.approval_wait_seconds,
    approval_validity_seconds: input.delayed_work.approval_validity_seconds,
    absolute_request_age_seconds: input.delayed_work.absolute_request_age_seconds,
    max_validation_attempts: input.delayed_work.max_validation_attempts,
  })) {
    throw new Error("DELAYED_WORK_AUTHORITY_CHANGED: current reviewed execution or receipt authority differs from the original request.");
  }
  const nowMs = Date.parse(input.now);
  const requestedMs = Date.parse(input.delayed_work.requested_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(requestedMs) || nowMs < requestedMs
    || nowMs >= requestedMs + input.delayed_work.absolute_request_age_seconds * 1_000
    || nowMs >= requestedMs + policy.proposal_ttl_seconds * 1_000) {
    throw new Error("DELAYED_WORK_REQUEST_EXPIRED: the original request's absolute or worker age bound ended.");
  }
  if (input.phase === "approval") {
    if (nowMs >= requestedMs + input.delayed_work.approval_wait_seconds * 1_000) {
      throw new Error("DELAYED_WORK_APPROVAL_EXPIRED: the reviewed approval waiting window ended.");
    }
  } else {
    const approvals = input.approvals?.filter((entry) => entry.status === "approved") ?? [];
    if (approvals.length === 0 || approvals.some((entry) => !Number.isFinite(Date.parse(entry.created_at))
      || nowMs >= Date.parse(entry.created_at) + input.delayed_work.approval_validity_seconds * 1_000)) {
      throw new Error("DELAYED_WORK_MANDATE_EXPIRED: a current exact approval is missing or past its reviewed validity.");
    }
  }
  return policy;
}
