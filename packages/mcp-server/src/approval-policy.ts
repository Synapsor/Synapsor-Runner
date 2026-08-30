import type {
  ProposalRuntimeStore,
  StoredProposal,
} from "@synapsor-runner/proposal-store";
import type {
  FreshnessProofV1,
} from "@synapsor-runner/protocol";
import {
  isNumericProposalField,
  type ApprovalPolicyRuleSpec,
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
  const evaluation = evaluateApprovalPolicy(input.capability, policy, input.patch, {
    before: input.proposal.change_set.before,
  });
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
    ...(input.config.action_boundary ? {
      action_boundary: {
        name: input.config.action_boundary.name,
        digest: input.config.action_boundary.digest,
        limits: input.config.action_boundary.authority.shared_limits,
      },
    } : {}),
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

export function evaluateApprovalPolicy(
  capability: RuntimeCapabilityConfig,
  policy: PolicySpec,
  patch: Record<string, Scalar>,
  context: { before?: Record<string, Scalar> } = {},
): { qualifies: boolean; reason: string } {
  const explanation = explainApprovalPolicy(capability, policy, patch, context);
  return { qualifies: explanation.qualifies, reason: explanation.reason };
}

export type ApprovalPolicyConditionExplanation = {
  source: "patch" | "before";
  field: string;
  operator: "lte" | "gte" | "eq" | "in" | "max_length";
  expected: Scalar | Scalar[] | undefined;
  actual?: Scalar;
  status: "passed" | "failed" | "indeterminate";
  reason: string;
};

export type ApprovalPolicyExplanation = {
  decision: "auto_approve" | "human_review" | "indeterminate";
  qualifies: boolean;
  reason: string;
  model_controlled_fields: Array<{ field: string; covered: boolean }>;
  conditions: ApprovalPolicyConditionExplanation[];
  limits: NonNullable<PolicySpec["limits"]>;
};

/**
 * Explains the same deterministic decision used by runtime auto-approval.
 * This is deliberately a pure evaluator: rolling limits and freshness remain
 * transaction-time checks and are reported separately as reviewed limits.
 */
export function explainApprovalPolicy(
  capability: RuntimeCapabilityConfig,
  policy: PolicySpec,
  patch: Record<string, Scalar>,
  context: { before?: Record<string, Scalar> } = {},
): ApprovalPolicyExplanation {
  const rules = (policy.rules ?? []).map(normalizeApprovalRule).filter((rule): rule is NormalizedApprovalRule => Boolean(rule));
  if (rules.length === 0) {
    return {
      decision: "human_review",
      qualifies: false,
      reason: "policy has no supported reviewed conditions",
      model_controlled_fields: modelControlledFieldCoverage(capability, rules),
      conditions: [],
      limits: structuredClone(policy.limits ?? []),
    };
  }
  if (rules.length !== (policy.rules ?? []).length) {
    return {
      decision: "human_review",
      qualifies: false,
      reason: "policy contains an unsupported reviewed condition",
      model_controlled_fields: modelControlledFieldCoverage(capability, rules),
      conditions: explainApprovalConditions(rules, patch, context),
      limits: structuredClone(policy.limits ?? []),
    };
  }

  // Policy conditions narrow the immutable Action capability; they do not
  // replace its argument, patch, enum, length, transition, or numeric bounds.
  // Existing policies intentionally narrow risk-bearing numeric amounts while
  // leaving strings/enums under their contract bounds. Preserve that behavior,
  // but continue to fail closed if any model-controlled numeric patch is not
  // covered, as the original evaluator did.
  const coverage = modelControlledFieldCoverage(capability, rules);
  const uncoveredNumeric = coverage.find((field) =>
    !field.covered && isNumericRuntimeProposalField(capability, field.field));
  if (uncoveredNumeric) {
    return {
      decision: "human_review",
      qualifies: false,
      reason: `${uncoveredNumeric.field} is a model-controlled numeric field with no matching policy condition`,
      model_controlled_fields: coverage,
      conditions: explainApprovalConditions(rules, patch, context),
      limits: structuredClone(policy.limits ?? []),
    };
  }
  const conditions = explainApprovalConditions(rules, patch, context);
  const indeterminate = conditions.find((condition) => condition.status === "indeterminate");
  if (indeterminate) {
    return {
      decision: "indeterminate",
      qualifies: false,
      reason: indeterminate.reason,
      model_controlled_fields: coverage,
      conditions,
      limits: structuredClone(policy.limits ?? []),
    };
  }
  const failed = conditions.find((condition) => condition.status === "failed");
  if (failed) {
    return {
      decision: "human_review",
      qualifies: false,
      reason: failed.reason,
      model_controlled_fields: coverage,
      conditions,
      limits: structuredClone(policy.limits ?? []),
    };
  }
  return {
    decision: "auto_approve",
    qualifies: true,
    reason: conditions.map((condition) => condition.reason).join(", "),
    model_controlled_fields: coverage,
    conditions,
    limits: structuredClone(policy.limits ?? []),
  };
}

function modelControlledFieldCoverage(
  capability: RuntimeCapabilityConfig,
  rules: NormalizedApprovalRule[],
): Array<{ field: string; covered: boolean }> {
  return Object.entries(capability.patch ?? {})
    .filter(([, binding]) => typeof binding?.from_arg === "string" || typeof binding?.from_item === "string")
    .map(([field]) => ({
      field,
      covered: rules.some((rule) => rule.source === "patch" && rule.field === field),
    }));
}

function explainApprovalConditions(
  rules: NormalizedApprovalRule[],
  patch: Record<string, Scalar>,
  context: { before?: Record<string, Scalar> },
): ApprovalPolicyConditionExplanation[] {
  return rules.map((rule) => {
    const source = rule.source === "before" ? context.before : patch;
    const expected = rule.operator === "in" ? rule.values : rule.value;
    if (!source || !Object.prototype.hasOwnProperty.call(source, rule.field)) {
      return {
        source: rule.source,
        field: rule.field,
        operator: rule.operator,
        expected: structuredClone(expected),
        status: "indeterminate",
        reason: `${rule.source}.${rule.field} is unavailable`,
      };
    }
    const actual = source[rule.field];
    const evaluated = evaluateApprovalRule(rule, actual);
    return {
      source: rule.source,
      field: rule.field,
      operator: rule.operator,
      expected: structuredClone(expected),
      ...(actual !== undefined ? { actual } : {}),
      status: evaluated.qualifies ? "passed" : "failed",
      reason: evaluated.reason,
    };
  });
}

type NormalizedApprovalRule = {
  source: "patch" | "before";
  field: string;
  operator: "lte" | "gte" | "eq" | "in" | "max_length";
  value?: Scalar;
  values?: Scalar[];
};

function normalizeApprovalRule(rule: ApprovalPolicyRuleSpec): NormalizedApprovalRule | undefined {
  if (!rule || typeof rule.field !== "string") return undefined;
  if (typeof rule.max === "number" && Number.isFinite(rule.max)) {
    return { source: "patch", field: rule.field, operator: "lte", value: rule.max };
  }
  const source = rule.source === "before" ? "before" : "patch";
  if (rule.operator === "in" && Array.isArray(rule.values)) {
    return { source, field: rule.field, operator: "in", values: rule.values as Scalar[] };
  }
  if ((rule.operator === "lte" || rule.operator === "gte" || rule.operator === "eq" || rule.operator === "max_length")
    && Object.prototype.hasOwnProperty.call(rule, "value")) {
    return { source, field: rule.field, operator: rule.operator, value: rule.value as Scalar };
  }
  return undefined;
}

function evaluateApprovalRule(
  rule: NormalizedApprovalRule,
  actual: Scalar | undefined,
): { qualifies: boolean; reason: string } {
  const label = `${rule.source}.${rule.field}`;
  if (rule.operator === "lte" || rule.operator === "gte") {
    if (typeof actual !== "number" || !Number.isFinite(actual) || typeof rule.value !== "number" || !Number.isFinite(rule.value)) {
      return { qualifies: false, reason: `${label} is not a finite number` };
    }
    const qualifies = rule.operator === "lte" ? actual <= rule.value : actual >= rule.value;
    return {
      qualifies,
      reason: `${label} ${actual} ${rule.operator === "lte" ? "<=" : ">="} ${rule.value}${qualifies ? "" : " failed"}`,
    };
  }
  if (rule.operator === "eq") {
    const qualifies = actual === rule.value;
    return {
      qualifies,
      reason: `${label} ${qualifies ? "matches" : "does not match"} its reviewed value`,
    };
  }
  if (rule.operator === "max_length") {
    const qualifies = typeof actual === "string"
      && typeof rule.value === "number"
      && Number.isSafeInteger(rule.value)
      && actual.length <= rule.value;
    return {
      qualifies,
      reason: `${label} ${qualifies ? "fits" : "exceeds"} its reviewed maximum length`,
    };
  }
  const qualifies = (rule.values ?? []).some((value) => value === actual);
  return {
    qualifies,
    reason: `${label} ${qualifies ? "is" : "is not"} in its reviewed value set`,
  };
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
