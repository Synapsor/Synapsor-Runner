import { evaluateApprovalPolicy, resolveSupervisedWorkerEligibility, type RuntimeCapabilityConfig, type RuntimeConfig, type RuntimeSupervisedWorkerCapabilityPolicy } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type PolicyApprovalLimit,
  type StoredProposal,
  type WorkerControlAction
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  inspectDatabase,
  rolePostureFingerprint,
  type SchemaInspection,
  type TableInfo
} from "@synapsor-runner/schema-inspector";
import { type PolicySpec } from "@synapsor/spec";
import process from "node:process";
import { workbenchAttentionId, workbenchAttentionPath } from "./attention-domain.js";


export function supervisedWorkerEligibilityCode(reasons: string[]): string {
  if (reasons.some((reason) => /digest|contract_permission|allowlist/.test(reason))) {
    return "SUPERVISED_WORKER_DIGEST_STALE";
  }
  if (reasons.some((reason) => /identity/.test(reason))) {
    return "SUPERVISED_WORKER_IDENTITY_MISMATCH";
  }
  if (reasons.some((reason) => /writer|source|receipt/.test(reason))) {
    return "SUPERVISED_WORKER_CREDENTIAL_POSTURE_INVALID";
  }
  if (reasons.some((reason) => /tenant|principal|scope/.test(reason))) {
    return "SUPERVISED_WORKER_SCOPE_INVALID";
  }
  return "SUPERVISED_WORKER_POLICY_STALE";
}


export function currentSupervisedApprovalPolicy(
  config: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
): { policy: string; limits: PolicyApprovalLimit[]; spec: PolicySpec } | undefined {
  if (capability.approval?.mode !== "policy" || !capability.approval.policy) return undefined;
  const policy = config.policies?.find((candidate) => candidate.name === capability.approval!.policy);
  if (!policy || policy.kind !== "approval") {
    throw workerPolicyError(
      "SUPERVISED_WORKER_POLICY_STALE",
      `approval policy ${capability.approval.policy} is no longer active`,
    );
  }
  return {
    policy: policy.name,
    limits: (policy.limits ?? []) as PolicyApprovalLimit[],
    spec: policy,
  };
}


export function assertSupervisedPolicyApprovalCurrent(
  store: ProposalStore,
  config: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
  proposal: StoredProposal,
): { policy: string; limits: PolicyApprovalLimit[] } | undefined {
  const current = currentSupervisedApprovalPolicy(config, capability);
  if (!current) return undefined;
  const actor = `policy:${current.policy}`;
  const approval = store.approvals(proposal.proposal_id).find((candidate) =>
    candidate.status === "approved"
    && candidate.approver === actor
    && candidate.proposal_hash === proposal.proposal_hash
    && candidate.proposal_version === proposal.proposal_version);
  if (!approval) return undefined;

  const approvalEvent = [...store.events(proposal.proposal_id)].reverse().find((event) =>
    event.kind === "proposal_approved"
    && event.actor === actor
    && event.payload.proposal_hash === proposal.proposal_hash
    && event.payload.proposal_version === proposal.proposal_version);
  if (!approvalEvent) {
    throw workerPolicyError(
      "SUPERVISED_WORKER_POLICY_STALE",
      "policy approval is missing its immutable policy snapshot",
    );
  }
  const approvedLimits = Array.isArray(approvalEvent.payload.aggregate_limits)
    ? approvalEvent.payload.aggregate_limits
    : [];
  if (canonicalJsonDigest(approvedLimits) !== canonicalJsonDigest(current.limits)) {
    throw workerPolicyError(
      "SUPERVISED_WORKER_POLICY_STALE",
      "the active approval-policy limits changed after this proposal was approved",
    );
  }
  const evaluation = evaluateApprovalPolicy(
    capability,
    current.spec,
    proposal.change_set.patch,
  );
  if (!evaluation.qualifies) {
    throw workerPolicyError(
      "SUPERVISED_WORKER_POLICY_STALE",
      "the active approval policy no longer authorizes this immutable proposal",
    );
  }
  store.assertWorkerPolicyExecutionLimits({
    proposalId: proposal.proposal_id,
    policy: current.policy,
    limits: current.limits,
  });
  return { policy: current.policy, limits: current.limits };
}


export type SupervisedWriterPostureAssessment = {
  ok: boolean;
  fingerprint: `sha256:${string}`;
  expected_fingerprint: `sha256:${string}` | null;
  reasons: string[];
  allowed_relations: string[];
  writable_relations: string[];
};


export function assessSupervisedWriterPosture(
  config: RuntimeConfig,
  policy: RuntimeSupervisedWorkerCapabilityPolicy,
  inspection: SchemaInspection,
): SupervisedWriterPostureAssessment {
  const reasons: string[] = [];
  const fingerprint = rolePostureFingerprint(inspection);
  const role = inspection.role_posture;
  const allowed = new Map<string, Set<keyof NonNullable<TableInfo["role_posture"]>["privileges"]>>();
  const required = new Map<string, Set<"insert" | "update">>();
  const rlsRequired = new Set<string>();
  const addAllowed = (
    relation: string,
    privileges: Array<keyof NonNullable<TableInfo["role_posture"]>["privileges"]>,
  ) => {
    const existing = allowed.get(relation) ?? new Set();
    privileges.forEach((privilege) => existing.add(privilege));
    allowed.set(relation, existing);
  };

  for (const candidate of config.supervised_worker?.capabilities ?? []) {
    if (candidate.write_url_env !== policy.write_url_env) continue;
    const capability = config.capabilities?.find((entry) =>
      entry.name === candidate.capability
      && entry.contract_provenance?.digest === candidate.contract_digest);
    if (!capability) {
      reasons.push("allowlisted_capability_unresolved");
      continue;
    }
    const source = config.sources?.[capability.source];
    if (!source || source.engine !== inspection.engine || source.write_url_env !== policy.write_url_env) {
      reasons.push("writer_source_mismatch");
      continue;
    }
    const relation = `${capability.target.schema}.${capability.target.table}`;
    const operation = capability.operation?.kind ?? "update";
    if (operation !== "insert" && operation !== "update") {
      reasons.push("writer_operation_ineligible");
      continue;
    }
    addAllowed(relation, ["select", operation]);
    const requiredPrivileges = required.get(relation) ?? new Set();
    requiredPrivileges.add(operation);
    required.set(relation, requiredPrivileges);
    if (source.database_scope?.mode === "postgres_rls") rlsRequired.add(relation);

    if (source.receipts?.authority === "source_db") {
      if (
        source.receipts.provisioning !== "precreated"
        || !source.receipts.schema
        || !source.receipts.table
      ) {
        reasons.push("precreated_receipt_relation_required");
      } else {
        addAllowed(
          `${source.receipts.schema}.${source.receipts.table}`,
          ["select", "insert", "update"],
        );
      }
    }
  }

  const enginePrivilegePostureSafe = inspection.engine === "mysql"
    ? (role?.superuser === false || role?.superuser === "unsupported")
      && (role?.bypass_rls === false || role?.bypass_rls === "unsupported")
    : role?.superuser === false && role?.bypass_rls === false;
  if (!role?.verified) reasons.push("writer_posture_unverified");
  if (!enginePrivilegePostureSafe) reasons.push("writer_privileged_role");
  if ((role?.owned_relations.length ?? 0) > 0) reasons.push("writer_owns_relation");
  if (!policy.writer_posture_fingerprint) reasons.push("writer_posture_fingerprint_missing");
  else if (fingerprint !== policy.writer_posture_fingerprint) reasons.push("writer_posture_fingerprint_changed");

  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  for (const [relation, requiredPrivileges] of required.entries()) {
    const table = tables.get(relation);
    if (!table?.role_posture) {
      reasons.push("writer_target_posture_unavailable");
      continue;
    }
    for (const privilege of requiredPrivileges) {
      if (!table.role_posture.privileges[privilege]) {
        reasons.push(`writer_target_${privilege}_missing`);
      }
    }
    if (
      rlsRequired.has(relation)
      && (
        table.row_level_security !== true
        || table.role_posture.row_security_effective_for_current_role !== true
      )
    ) {
      reasons.push("writer_rls_not_effective");
    }
  }

  for (const table of inspection.tables) {
    const relation = `${table.schema}.${table.name}`;
    const posture = table.role_posture;
    if (!posture) {
      reasons.push("writer_relation_posture_unavailable");
      continue;
    }
    const granted = Object.entries(posture.privileges)
      .filter(([, enabled]) => enabled)
      .map(([privilege]) => privilege as keyof typeof posture.privileges);
    if (granted.length === 0) continue;
    const reviewed = allowed.get(relation);
    if (!reviewed) {
      reasons.push("writer_unreviewed_relation_privilege");
      continue;
    }
    if (granted.some((privilege) => !reviewed.has(privilege))) {
      reasons.push("writer_excess_relation_privilege");
    }
    if (posture.current_role_is_owner || posture.current_role_can_assume_owner) {
      reasons.push("writer_owns_relation");
    }
  }

  return {
    ok: reasons.length === 0,
    fingerprint,
    expected_fingerprint: policy.writer_posture_fingerprint ?? null,
    reasons: [...new Set(reasons)].sort(),
    allowed_relations: [...allowed.keys()].sort(),
    writable_relations: [...(role?.writable_relations ?? [])].sort(),
  };
}


function supervisedWriterPostureKey(
  environment: string,
  policy: RuntimeSupervisedWorkerCapabilityPolicy,
): string {
  return `supervised_writer_posture:${canonicalJsonDigest({
    environment,
    capability: policy.capability,
    contract_digest: policy.contract_digest,
  })}`;
}


function supervisedWriterPostureAttentionKey(
  environment: string,
  policy: RuntimeSupervisedWorkerCapabilityPolicy,
): string {
  return [
    environment,
    "credential.posture_changed",
    policy.capability,
    policy.contract_digest,
  ].join(":");
}


function recordSupervisedWriterPosture(
  store: ProposalStore,
  environment: string,
  policy: RuntimeSupervisedWorkerCapabilityPolicy,
  assessment: SupervisedWriterPostureAssessment,
): void {
  const stateKey = supervisedWriterPostureKey(environment, policy);
  const previous = store.getRunnerState(stateKey);
  const occurrence = assessment.ok
    ? Number(previous?.occurrence ?? 0)
    : previous?.status === "invalid"
      ? Number(previous.occurrence ?? 1)
      : Number(previous?.occurrence ?? 0) + 1;
  store.setRunnerState(stateKey, {
    status: assessment.ok ? "healthy" : "invalid",
    checked_at: new Date().toISOString(),
    occurrence,
    capability: policy.capability,
    contract_digest: policy.contract_digest,
    expected_fingerprint: assessment.expected_fingerprint,
    observed_fingerprint: assessment.fingerprint,
    reason_codes: assessment.reasons,
    allowed_relation_count: assessment.allowed_relations.length,
    writable_relation_count: assessment.writable_relations.length,
  });

  const attentionKey = supervisedWriterPostureAttentionKey(environment, policy);
  const attentionId = workbenchAttentionId(attentionKey);
  if (assessment.ok) {
    const attention = store.getAttentionItem(attentionId);
    if (attention && attention.status !== "resolved" && attention.status !== "expired") {
      store.resolveAttention({ attention_id: attention.attention_id });
    }
    return;
  }
  store.recordAttentionEvent({
    event_type: "credential.posture_changed",
    severity: "critical",
    environment,
    capability: policy.capability,
    contract_digest: policy.contract_digest,
    attention_key: attentionKey,
    attention_required: true,
    immediate_default: true,
    failure_class: "SUPERVISED_WORKER_CREDENTIAL_POSTURE_INVALID",
    summary: `${policy.capability} writer posture no longer matches reviewed least privilege`,
    workbench_path: workbenchAttentionPath(attentionKey),
    details: {
      reason_codes: assessment.reasons.join(","),
      expected_fingerprint: assessment.expected_fingerprint,
      observed_fingerprint: assessment.fingerprint,
      allowed_relation_count: assessment.allowed_relations.length,
      writable_relation_count: assessment.writable_relations.length,
      source_database_changed: false,
    },
    source_event_key: `worker-posture:${policy.contract_digest}:${occurrence}:${canonicalJsonDigest({
      fingerprint: assessment.fingerprint,
      reasons: assessment.reasons,
    })}`,
  });
}


export async function assertSupervisedWriterPosture(
  store: ProposalStore,
  config: RuntimeConfig,
  policy: RuntimeSupervisedWorkerCapabilityPolicy,
  env: NodeJS.ProcessEnv = process.env,
  inspect: typeof inspectDatabase = inspectDatabase,
): Promise<SupervisedWriterPostureAssessment | undefined> {
  if (policy.require_least_privilege_writer !== true) return undefined;
  const environment = config.supervised_worker?.profile ?? "unknown";
  const source = config.capabilities
    ?.filter((capability) => capability.name === policy.capability)
    .map((capability) => config.sources?.[capability.source])
    .find((candidate) => candidate?.write_url_env === policy.write_url_env);
  let assessment: SupervisedWriterPostureAssessment;
  try {
    if (!source) throw new Error("writer source is unavailable");
    const inspection = await inspect({
      engine: source.engine,
      databaseUrlEnv: policy.write_url_env,
      statementTimeoutMs: source.statement_timeout_ms ?? 5_000,
      env,
    });
    assessment = assessSupervisedWriterPosture(config, policy, inspection);
  } catch {
    const fallback = canonicalJsonDigest({
      environment,
      capability: policy.capability,
      contract_digest: policy.contract_digest,
      posture: "inspection_unavailable",
    });
    assessment = {
      ok: false,
      fingerprint: fallback,
      expected_fingerprint: policy.writer_posture_fingerprint ?? null,
      reasons: ["writer_posture_inspection_failed"],
      allowed_relations: [],
      writable_relations: [],
    };
  }
  recordSupervisedWriterPosture(store, environment, policy, assessment);
  if (!assessment.ok) {
    throw workerPolicyError(
      "SUPERVISED_WORKER_CREDENTIAL_POSTURE_INVALID",
      `supervised writer posture failed closed: ${assessment.reasons.join(", ")}`,
    );
  }
  return assessment;
}


export function workerPolicyError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}


export function workerControlOperatorDecisionAction(action: WorkerControlAction) {
  if (action === "pause") return "worker_pause" as const;
  if (action === "resume") return "worker_resume" as const;
  if (action === "drain") return "worker_drain" as const;
  if (action === "capability_enable") return "worker_capability_enable" as const;
  if (action === "capability_disable") return "worker_capability_disable" as const;
  return "worker_digest_revoke" as const;
}


export function workerControlAllowsPolicy(
  state: ReturnType<ProposalStore["workerControlState"]>,
  policy: NonNullable<ReturnType<typeof resolveSupervisedWorkerEligibility>["policy"]>,
): boolean {
  const control = state.capability_controls.find((entry) =>
    entry.capability === policy.capability
    && entry.contract_digest === policy.contract_digest);
  return control?.status !== "disabled" && control?.status !== "revoked";
}
