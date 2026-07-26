import type {
  ProposalRuntimeStore,
  StoredProposal,
} from "@synapsor-runner/proposal-store";
import type {
  FreshnessProofV1,
} from "@synapsor-runner/protocol";
import {
  isNumericProposalField,
  type PolicySpec,
  type ProposalActionSpec,
} from "@synapsor/spec";
import type {
  Scalar,
  RuntimeCapabilityConfig,
  RuntimeConfig,
  DbRowReader,
  ResultEnvelopeV2,
} from "./runtime-types.js";
import {
  capabilityWritebackExecutor,
  capabilityWritebackMode,
  isSetCapability,
} from "./capability-authority.js";
import {
  evaluateProposalFreshness,
} from "./proposal-freshness.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  isRecord,
} from "./safe-values.js";

export function assertProposalWritebackResolvable(config: RuntimeConfig, capability: RuntimeCapabilityConfig): void {
  if (capability.kind !== "proposal") return;
  const mode = capabilityWritebackMode(capability);
  if (mode === "none" || mode === "cloud_worker") return;
  if (mode === "direct_sql") {
    const source = config.sources?.[capability.source];
    if (!source) {
      throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares DIRECT SQL writeback but source ${capability.source} is not configured.`);
    }
    if (source.read_only === true) {
      throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares DIRECT SQL writeback but source ${capability.source} is read-only.`);
    }
    if (!source.write_url_env) {
      throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares DIRECT SQL writeback but source ${capability.source} has no write_url_env.`);
    }
    return;
  }
  const executorName = capabilityWritebackExecutor(capability);
  if (!executorName || executorName === "sql_update") {
    throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares HANDLER writeback but has no executor name.`);
  }
  const executor = config.executors?.[executorName];
  if (!isRecord(executor)) {
    throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares HANDLER writeback but executor ${executorName} is not configured.`);
  }
  if (executor.type !== "http_handler" && executor.type !== "command_handler") {
    throw new McpRuntimeError("WRITEBACK_UNRESOLVED", `capability ${capability.name} declares HANDLER writeback but executor ${executorName} is not an app-owned handler.`);
  }
}

export function assertApprovalPolicyResolvable(config: RuntimeConfig, capability: RuntimeCapabilityConfig): void {
  if (capability.kind !== "proposal" || capability.approval?.mode !== "policy") return;
  const policyName = capability.approval.policy;
  if (!policyName) {
    throw new McpRuntimeError("APPROVAL_POLICY_UNRESOLVED", `capability ${capability.name} uses policy approval but does not name approval.policy.`);
  }
  const policy = approvalPolicyByName(config, policyName);
  if (!policy) {
    throw new McpRuntimeError("APPROVAL_POLICY_UNRESOLVED", `capability ${capability.name} references missing approval policy ${policyName}.`);
  }
}

export async function maybeAutoApproveProposal(input: {
  config: RuntimeConfig;
  capability: RuntimeCapabilityConfig;
  store: ProposalRuntimeStore;
  proposal: StoredProposal;
  patch: Record<string, Scalar>;
  env: NodeJS.ProcessEnv;
  readRow: DbRowReader;
}): Promise<{
  proposal: StoredProposal;
  approved: boolean;
  policy?: string;
  tripped_limits?: Array<Record<string, unknown>>;
  freshness?: {
    status: FreshnessProofV1["result"];
    safe_code: string;
  };
}> {
  if (input.config.mode !== "review") return { proposal: input.proposal, approved: false };
  if (input.config.approvals?.disable_auto_approval === true) return { proposal: input.proposal, approved: false };
  if (isSetCapability(input.capability)) return { proposal: input.proposal, approved: false };
  if (input.capability.operation?.kind === "delete") return { proposal: input.proposal, approved: false };
  if (input.capability.approval?.mode !== "policy" || !input.capability.approval.policy) return { proposal: input.proposal, approved: false };
  if (input.proposal.state === "approved") return { proposal: input.proposal, approved: true, policy: input.capability.approval.policy };
  if (input.proposal.state !== "pending_review") return { proposal: input.proposal, approved: false };
  const policyName = input.capability.approval.policy;
  const policy = approvalPolicyByName(input.config, policyName);
  if (!policy) throw new McpRuntimeError("APPROVAL_POLICY_UNRESOLVED", `capability ${input.capability.name} references missing approval policy ${policyName}.`);
  const evaluation = evaluateApprovalPolicy(input.capability, policy, input.patch);
  if (!evaluation.qualifies) return { proposal: input.proposal, approved: false, policy: policyName };

  let freshnessProofDigest: string | undefined;
  const freshness = await evaluateProposalFreshness({
    config: input.config,
    proposal: input.proposal,
    env: input.env,
    readRow: input.readRow,
  });
  if (freshness.required) {
    await input.store.recordFreshnessProof(freshness.proof);
    if (freshness.status !== "fresh") {
      await input.store.recordFreshnessApprovalBlocked(input.proposal.proposal_id, {
        proof_digest: freshness.proof.proof_digest,
        safe_code: freshness.safe_code,
        actor: `policy:${policyName}`,
      });
      return {
        proposal: await input.store.getProposal(input.proposal.proposal_id) ?? input.proposal,
        approved: false,
        policy: policyName,
        freshness: {
          status: freshness.status,
          safe_code: freshness.safe_code,
        },
      };
    }
    freshnessProofDigest = freshness.proof.proof_digest;
  }

  // Safety boundary: policy approval is contract-owned server behavior only.
  // No MCP tool can choose a policy, approve a proposal, or apply the writeback.
  const decision = await input.store.approveProposalByPolicy(input.proposal.proposal_id, {
    policy: policyName,
    proposal_hash: input.proposal.proposal_hash,
    proposal_version: input.proposal.proposal_version,
    reason: `auto-approved by policy ${policyName}: ${evaluation.reason}`,
    limits: policy.limits,
    freshness_proof_digest: freshnessProofDigest,
  });
  return {
    proposal: decision.proposal,
    approved: decision.approved,
    policy: policyName,
    tripped_limits: decision.tripped_limits,
    ...(freshness.required ? {
      freshness: {
        status: freshness.status,
        safe_code: freshness.safe_code,
      },
    } : {}),
  };
}

export function approvalPolicyByName(config: RuntimeConfig, policyName: string): PolicySpec | undefined {
  return (config.policies ?? []).find((policy) => policy.kind === "approval" && policy.name === policyName);
}

export function evaluateApprovalPolicy(capability: RuntimeCapabilityConfig, policy: PolicySpec, patch: Record<string, Scalar>): { qualifies: boolean; reason: string } {
  const ruleByField = new Map<string, number>();
  for (const rule of policy.rules ?? []) {
    const field = typeof rule.field === "string" ? rule.field : undefined;
    const max = typeof rule.max === "number" && Number.isInteger(rule.max) ? rule.max : undefined;
    if (field && max !== undefined) ruleByField.set(field, max);
  }
  const numericFields = Object.keys(patch).filter((field) => isNumericRuntimeProposalField(capability, field));
  if (numericFields.length === 0) return { qualifies: false, reason: "no numeric patch fields covered by policy" };
  const reasons: string[] = [];
  for (const field of numericFields) {
    const max = ruleByField.get(field);
    const value = patch[field];
    if (max === undefined) return { qualifies: false, reason: `${field} has no matching policy rule` };
    if (typeof value !== "number" || !Number.isInteger(value)) return { qualifies: false, reason: `${field} is not an integer` };
    if (value > max) return { qualifies: false, reason: `${field} ${value} > ${max}` };
    reasons.push(`${field} ${value} <= ${max}`);
  }
  return { qualifies: true, reason: reasons.join(", ") };
}

export function isNumericRuntimeProposalField(capability: RuntimeCapabilityConfig, field: string): boolean {
  const proposal: ProposalActionSpec = {
    action: capability.name,
    allowed_fields: capability.allowed_columns ?? Object.keys(capability.patch ?? {}),
    patch: capability.patch ?? {},
    ...(capability.numeric_bounds ? { numeric_bounds: capability.numeric_bounds } : {}),
  };
  return isNumericProposalField(proposal, capability.args, field);
}

export function evidenceHandle(bundleId: string): ResultEnvelopeV2["evidence"] {
  return {
    bundle_id: bundleId,
    note: "audit/replay handle; you do not need to act on it during this turn",
  };
}
