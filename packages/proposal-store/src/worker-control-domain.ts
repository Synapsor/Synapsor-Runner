import type {
  OperatorDecision,
  OperatorIdentityProof,
  WorkerControlMode,
  WorkerCapabilityControlStatus,
  WorkerCapabilityControl,
  WorkerControlState,
  WorkerControlAction,
  WorkerControlTarget,
  WorkerControlDecisionSubject,
} from "./domain-types.js";
import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import {
  isRecord,
} from "./common.js";
import { ProposalStoreError } from "./errors.js";

export function workerControlDecisionSubject(
  state: WorkerControlState,
  target: WorkerControlTarget,
): WorkerControlDecisionSubject {
  assertWorkerControlTarget(target);
  const targetDigest = canonicalJsonDigest({
    schema_version: "synapsor.worker-control-decision-subject.v1",
    current_revision: state.revision,
    current_integrity_hash: state.integrity_hash,
    action: target.action,
    capability: target.capability ?? null,
    contract_digest: target.contract_digest ?? null,
  });
  return {
    proposal_id: `worker_control_${targetDigest.slice("sha256:".length, "sha256:".length + 32)}`,
    proposal_version: state.revision + 1,
    proposal_hash: targetDigest,
  };
}

export function defaultWorkerControlState(): WorkerControlState {
  const unsigned = {
    schema_version: "synapsor.worker-control.v1" as const,
    mode: "active" as const,
    revision: 0,
    capability_controls: [] as WorkerCapabilityControl[],
    updated_at: "1970-01-01T00:00:00.000Z",
  };
  return { ...unsigned, integrity_hash: canonicalJsonDigest(unsigned) };
}

export function parseWorkerControlState(value: unknown): WorkerControlState {
  if (!isRecord(value)
    || value.schema_version !== "synapsor.worker-control.v1"
    || !["active", "paused", "draining"].includes(String(value.mode))
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
    || !Array.isArray(value.capability_controls)
    || typeof value.updated_at !== "string"
    || typeof value.integrity_hash !== "string") {
    throw new ProposalStoreError("WORKER_CONTROL_STATE_INVALID", "stored supervised-worker control state is invalid");
  }
  const controls = value.capability_controls.map((entry) => {
    if (!isRecord(entry)
      || typeof entry.capability !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(entry.capability)
      || typeof entry.contract_digest !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(entry.contract_digest)
      || !["enabled", "disabled", "revoked"].includes(String(entry.status))
      || typeof entry.updated_at !== "string"
      || typeof entry.actor !== "string") {
      throw new ProposalStoreError("WORKER_CONTROL_STATE_INVALID", "stored supervised-worker capability control is invalid");
    }
    return {
      capability: entry.capability,
      contract_digest: entry.contract_digest as `sha256:${string}`,
      status: entry.status as WorkerCapabilityControlStatus,
      updated_at: entry.updated_at,
      actor: entry.actor,
    };
  });
  const lastDecision = isRecord(value.last_decision)
    ? value.last_decision as OperatorIdentityProof
    : undefined;
  const unsigned = {
    schema_version: "synapsor.worker-control.v1" as const,
    mode: value.mode as WorkerControlMode,
    revision: Number(value.revision),
    capability_controls: controls,
    ...(lastDecision ? { last_decision: lastDecision } : {}),
    updated_at: value.updated_at,
  };
  const integrityHash = value.integrity_hash as `sha256:${string}`;
  if (integrityHash !== canonicalJsonDigest(unsigned)) {
    throw new ProposalStoreError("WORKER_CONTROL_STATE_TAMPERED", "stored supervised-worker control state failed integrity validation");
  }
  return { ...unsigned, integrity_hash: integrityHash };
}

export function assertWorkerControlTarget(target: WorkerControlTarget): void {
  const capabilityAction = target.action === "capability_enable"
    || target.action === "capability_disable"
    || target.action === "digest_revoke";
  if (capabilityAction) {
    if (!target.capability || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(target.capability)) {
      throw new ProposalStoreError("WORKER_CONTROL_CAPABILITY_REQUIRED", `${target.action} requires a fixed capability name`);
    }
    if (!target.contract_digest || !/^sha256:[a-f0-9]{64}$/.test(target.contract_digest)) {
      throw new ProposalStoreError("WORKER_CONTROL_DIGEST_REQUIRED", `${target.action} requires an exact sha256 contract digest`);
    }
  } else if (target.capability || target.contract_digest) {
    throw new ProposalStoreError("WORKER_CONTROL_TARGET_INVALID", `${target.action} is a global control and cannot carry capability authority`);
  }
}

export function workerControlOperatorAction(action: WorkerControlAction): OperatorDecision["action"] {
  if (action === "pause") return "worker_pause";
  if (action === "resume") return "worker_resume";
  if (action === "drain") return "worker_drain";
  if (action === "capability_enable") return "worker_capability_enable";
  if (action === "capability_disable") return "worker_capability_disable";
  return "worker_digest_revoke";
}

export function assertWorkerControlOperatorDecision(
  state: WorkerControlState,
  target: WorkerControlTarget,
  actor: string,
  identity: OperatorIdentityProof | undefined,
  requireVerified: boolean,
): void {
  if (requireVerified && (!identity || !identity.verified || identity.provider === "dev_env")) {
    throw new ProposalStoreError(
      "VERIFIED_OPERATOR_IDENTITY_REQUIRED",
      `verified operator identity is required to ${target.action} supervised execution`,
    );
  }
  if (!identity) return;
  if (identity.subject !== actor || identity.decision.subject !== actor) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_MISMATCH", "worker-control identity does not match its actor");
  }
  const subject = workerControlDecisionSubject(state, target);
  if (
    identity.decision.action !== workerControlOperatorAction(target.action)
    || identity.decision.proposal_id !== subject.proposal_id
    || identity.decision.proposal_version !== subject.proposal_version
    || identity.decision.proposal_hash !== subject.proposal_hash
  ) {
    throw new ProposalStoreError("OPERATOR_DECISION_MISMATCH", "operator proof is not bound to this exact worker-control revision");
  }
  if (identity.decision_hash !== canonicalJsonDigest(identity.decision)) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_TAMPERED", "worker-control decision hash failed integrity validation");
  }
  const { integrity_hash: _integrityHash, ...identityCore } = identity;
  if (identity.integrity_hash !== canonicalJsonDigest(identityCore)) {
    throw new ProposalStoreError("OPERATOR_IDENTITY_TAMPERED", "worker-control identity proof failed integrity validation");
  }
}

export function workerControlSummary(target: WorkerControlTarget): string {
  if (target.action === "pause") return "Supervised execution paused by an operator";
  if (target.action === "resume") return "Supervised execution resumed by an operator";
  if (target.action === "drain") return "Supervised execution is draining without new leases";
  if (target.action === "capability_enable") return `${target.capability} supervised execution enabled for the exact reviewed digest`;
  if (target.action === "capability_disable") return `${target.capability} supervised execution disabled for the exact reviewed digest`;
  return `${target.capability} supervised execution digest revoked`;
}
