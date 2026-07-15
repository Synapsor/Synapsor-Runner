import {
  type CreatePolicyRecommendationInput,
  type GraduatedTrustMetrics,
  type OperatorIdentityProof,
  type PolicyRecommendation,
  type PolicyRecommendationStatus,
  type ProposalRuntimeStore,
  type StoredApproval,
  type StoredProposal,
  type StoredWritebackReceipt,
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, protocolVersions } from "@synapsor-runner/protocol";
import { normalizeContract, validateContract, type SynapsorContract } from "@synapsor/spec";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";

export type GraduatedTrustCriterion = NonNullable<NonNullable<RuntimeConfig["graduated_trust"]>["criteria"]>[number];

export type GraduatedTrustEvaluation = {
  ok: boolean;
  code:
    | "RECOMMENDATION_CREATED"
    | "GRADUATED_TRUST_DISABLED"
    | "GRADUATED_TRUST_KILL_SWITCH"
    | "CRITERION_NOT_FOUND"
    | "POLICY_THRESHOLD_NOT_FOUND"
    | "POLICY_THRESHOLD_AT_CEILING"
    | "HISTORY_UNAVAILABLE"
    | "HISTORY_SCOPE_INCOMPLETE"
    | "HISTORY_TAMPERED"
    | "INSUFFICIENT_HUMAN_REVIEWS"
    | "REJECTION_RATE_EXCEEDED"
    | "CONFLICT_RATE_EXCEEDED"
    | "FAILURE_RATE_EXCEEDED"
    | "REVERT_RATE_EXCEEDED";
  message: string;
  metrics?: GraduatedTrustMetrics;
  recommendation?: PolicyRecommendation;
};

export type GraduatedTrustStore = Pick<ProposalRuntimeStore,
  | "listProposals"
  | "approvals"
  | "events"
  | "receipts"
  | "createPolicyRecommendation"
  | "getPolicyRecommendation"
  | "listPolicyRecommendations"
  | "decidePolicyRecommendation"
  | "markPolicyRecommendationExported"
>;

export async function evaluateGraduatedTrust(input: {
  config: RuntimeConfig;
  contract: SynapsorContract;
  store: GraduatedTrustStore;
  tenant: string;
  capability: string;
  policy: string;
  now?: string;
}): Promise<GraduatedTrustEvaluation> {
  const trust = input.config.graduated_trust;
  if (trust?.enabled !== true) return failure("GRADUATED_TRUST_DISABLED", "Graduated trust is disabled. No recommendation was created.");
  if (trust.kill_switch === true) return failure("GRADUATED_TRUST_KILL_SWITCH", "The graduated-trust operator kill switch is active. No recommendation was created.");
  const criterion = trust.criteria?.find((item) => item.capability === input.capability && item.policy === input.policy);
  if (!criterion) return failure("CRITERION_NOT_FOUND", `No reviewed graduated-trust criterion permits ${input.capability} / ${input.policy}.`);
  if (!input.store.listProposals || !input.store.approvals || !input.store.createPolicyRecommendation || !input.store.listPolicyRecommendations) {
    return failure("HISTORY_UNAVAILABLE", "The configured ledger does not expose the scoped history required for graduated trust.");
  }

  const contract = normalizeContract(input.contract);
  const baseDigest = canonicalJsonDigest(contract);
  const baseVersion = contract.metadata?.version ?? contract.spec_version;
  const threshold = approvalThreshold(contract, input.capability, input.policy, criterion.field);
  if (threshold === undefined) return failure("POLICY_THRESHOLD_NOT_FOUND", `Policy ${input.policy} has no reviewed numeric threshold for ${criterion.field}.`);
  if (threshold >= criterion.absolute_ceiling) return failure("POLICY_THRESHOLD_AT_CEILING", `Policy ${input.policy} is already at its reviewed ceiling ${criterion.absolute_ceiling}.`);

  const now = new Date(input.now ?? new Date().toISOString());
  if (!Number.isFinite(now.getTime())) throw new Error("graduated-trust evaluation requires a valid --now timestamp");
  const windowStart = new Date(now.getTime() - criterion.window_days * 86_400_000).toISOString();
  const windowEnd = now.toISOString();
  const proposals = await input.store.listProposals({ tenant: input.tenant, capability: input.capability, from: windowStart, to: windowEnd });
  const history = await inspectHistory(input.store, proposals, baseDigest, baseVersion);
  if (!history.ok) return failure(history.code, history.message);

  const metrics = metricsFromHistory(history.outcomes, windowStart, windowEnd);
  const gate = metricsGate(metrics, criterion);
  if (gate) return { ...gate, metrics };

  const proposedThreshold = Math.min(threshold + criterion.maximum_threshold_increase, criterion.absolute_ceiling);
  if (proposedThreshold <= threshold) return failure("POLICY_THRESHOLD_AT_CEILING", `Policy ${input.policy} cannot increase within its reviewed ceiling.`);
  const existing = (await input.store.listPolicyRecommendations({ tenant: input.tenant, capability: input.capability, policy: input.policy }))
    .find((item) => item.base_contract_digest === baseDigest && item.current_threshold === threshold && item.proposed_threshold === proposedThreshold && item.status !== "rejected");
  if (existing) return { ok: true, code: "RECOMMENDATION_CREATED", message: `Existing reviewed recommendation ${existing.recommendation_id} matches this evidence window.`, metrics, recommendation: existing };

  const recommendationInput: CreatePolicyRecommendationInput = {
    ...(trust.workspace_id ? { workspace_id: trust.workspace_id } : {}),
    ...(trust.project_id ? { project_id: trust.project_id } : {}),
    tenant_id: input.tenant,
    capability: input.capability,
    policy: input.policy,
    field: criterion.field,
    base_contract_digest: baseDigest,
    base_contract_version: baseVersion,
    current_threshold: threshold,
    proposed_threshold: proposedThreshold,
    maximum_increment: criterion.maximum_threshold_increase,
    absolute_ceiling: criterion.absolute_ceiling,
    criteria: { ...criterion },
    metrics,
    evidence_proposal_ids: history.outcomes.filter((item) => item.humanReviewed).map((item) => item.proposal.proposal_id),
    explanation: [
      `${metrics.human_reviewed} human-reviewed outcomes were evaluated from ${windowStart} through ${windowEnd}.`,
      `${metrics.auto_approved_excluded} policy-auto-approved outcomes were excluded from the human evidence sample.`,
      `Rejection ${rate(metrics.rejection_rate)}, conflict ${rate(metrics.conflict_rate)}, failure ${rate(metrics.failure_rate)}, and revert ${rate(metrics.revert_rate)} stayed within reviewed criteria.`,
      `The proposed threshold ${proposedThreshold} is one reviewed increment above ${threshold} and does not exceed ceiling ${criterion.absolute_ceiling}.`,
      "Human approval creates a reviewable artifact only; it does not activate or push the contract.",
    ],
    now: windowEnd,
  };
  const recommendation = await input.store.createPolicyRecommendation(recommendationInput);
  return { ok: true, code: "RECOMMENDATION_CREATED", message: `Created pending policy recommendation ${recommendation.recommendation_id}. No contract was changed or activated.`, metrics, recommendation };
}

export async function decideGraduatedTrustRecommendation(input: {
  store: GraduatedTrustStore;
  recommendationId: string;
  action: "approve" | "reject";
  actor: string;
  reason: string;
  identity: OperatorIdentityProof;
  now?: string;
}): Promise<PolicyRecommendation> {
  if (!input.store.decidePolicyRecommendation) throw new Error("configured ledger cannot persist policy recommendation decisions");
  return await input.store.decidePolicyRecommendation(input.recommendationId, {
    action: input.action,
    actor: input.actor,
    reason: input.reason,
    identity: input.identity,
    now: input.now,
  });
}

export async function prepareGraduatedTrustArtifact(input: {
  store: GraduatedTrustStore;
  recommendationId: string;
  activeContract: SynapsorContract;
}): Promise<{ recommendation: PolicyRecommendation; contract: SynapsorContract; digest: `sha256:${string}`; diff: { field: string; before: number; after: number } }> {
  if (!input.store.getPolicyRecommendation) throw new Error("configured ledger cannot read policy recommendations");
  const recommendation = await input.store.getPolicyRecommendation(input.recommendationId);
  if (!recommendation) throw new Error(`policy recommendation not found: ${input.recommendationId}`);
  if (recommendation.status !== "approved") throw new Error(`policy recommendation ${input.recommendationId} is ${recommendation.status}; export requires approved`);
  const active = normalizeContract(input.activeContract);
  const activeDigest = canonicalJsonDigest(active);
  const activeVersion = active.metadata?.version ?? active.spec_version;
  if (activeDigest !== recommendation.base_contract_digest || activeVersion !== recommendation.base_contract_version) {
    throw new Error(`STALE_POLICY_RECOMMENDATION_BASE: active contract ${activeDigest} (${activeVersion}) does not match ${recommendation.base_contract_digest} (${recommendation.base_contract_version})`);
  }
  const clone = structuredClone(active);
  const policy = clone.policies?.find((item) => item.name === recommendation.policy);
  const rule = policy?.rules?.find((item) => item.field === recommendation.field);
  if (!rule || rule.max !== recommendation.current_threshold) throw new Error("STALE_POLICY_RECOMMENDATION_THRESHOLD: active policy threshold changed after recommendation creation");
  rule.max = recommendation.proposed_threshold;
  const validation = validateContract(clone);
  if (!validation.ok) throw new Error(`generated policy artifact is invalid: ${validation.errors.map((item) => item.code).join(", ")}`);
  const contract = normalizeContract(clone);
  return {
    recommendation,
    contract,
    digest: canonicalJsonDigest(contract),
    diff: { field: recommendation.field, before: recommendation.current_threshold, after: recommendation.proposed_threshold },
  };
}

export async function markGraduatedTrustArtifactExported(input: {
  store: GraduatedTrustStore;
  recommendationId: string;
  actor: string;
  artifactDigest: string;
  now?: string;
}): Promise<PolicyRecommendation> {
  if (!input.store.markPolicyRecommendationExported) throw new Error("configured ledger cannot persist policy recommendation exports");
  return await input.store.markPolicyRecommendationExported(input.recommendationId, {
    actor: input.actor,
    artifact_digest: input.artifactDigest,
    now: input.now,
  });
}

export function formatGraduatedTrustEvaluation(result: GraduatedTrustEvaluation): string {
  const lines = [
    `Synapsor graduated trust: ${result.ok ? "recommendation ready" : "no recommendation"}`,
    `Code: ${result.code}`,
    result.message,
  ];
  if (result.metrics) lines.push(
    "",
    `Human reviewed: ${result.metrics.human_reviewed}`,
    `Human approved/rejected: ${result.metrics.human_approved}/${result.metrics.human_rejected}`,
    `Rates: rejection ${rate(result.metrics.rejection_rate)}; conflict ${rate(result.metrics.conflict_rate)}; failure ${rate(result.metrics.failure_rate)}; revert ${rate(result.metrics.revert_rate)}`,
    `Auto-approved outcomes excluded: ${result.metrics.auto_approved_excluded}`,
  );
  if (result.recommendation) lines.push(
    "",
    `Recommendation: ${result.recommendation.recommendation_id}`,
    `Status: ${result.recommendation.status}`,
    `Threshold: ${result.recommendation.current_threshold} -> ${result.recommendation.proposed_threshold}`,
    `Base contract: ${result.recommendation.base_contract_digest}`,
    "Activation: not performed; verified operator approval and explicit artifact export are still required.",
  );
  return `${lines.join("\n")}\n`;
}

type HistoryOutcome = {
  proposal: StoredProposal;
  humanReviewed: boolean;
  humanApproved: boolean;
  humanRejected: boolean;
  autoApproved: boolean;
  conflict: boolean;
  failure: boolean;
  revert: boolean;
};

async function inspectHistory(
  store: GraduatedTrustStore,
  proposals: StoredProposal[],
  digest: string,
  version: string,
): Promise<{ ok: true; outcomes: HistoryOutcome[] } | { ok: false; code: "HISTORY_SCOPE_INCOMPLETE" | "HISTORY_TAMPERED"; message: string }> {
  const outcomes: HistoryOutcome[] = [];
  for (const proposal of proposals) {
    if (!proposal.change_set.contract || proposal.change_set.contract.digest !== digest || proposal.change_set.contract.version !== version) {
      return { ok: false, code: "HISTORY_SCOPE_INCOMPLETE", message: `Proposal ${proposal.proposal_id} lacks matching contract digest/version provenance; no recommendation was created.` };
    }
    const approvals = await store.approvals!(proposal.proposal_id);
    if (approvals.some((approval) => approval.proposal_hash !== proposal.proposal_hash || approval.proposal_version !== proposal.proposal_version)) {
      return { ok: false, code: "HISTORY_TAMPERED", message: `Proposal ${proposal.proposal_id} has an approval identity mismatch; no recommendation was created.` };
    }
    const human = approvals.filter(isHumanDecision);
    const auto = approvals.some((approval) => approval.approver.startsWith("policy:"));
    const receipts = await store.receipts(proposal.proposal_id);
    const events = await store.events(proposal.proposal_id);
    outcomes.push({
      proposal,
      humanReviewed: human.length > 0,
      humanApproved: human.some((approval) => approval.status === "approved"),
      humanRejected: human.some((approval) => approval.status === "rejected"),
      autoApproved: auto,
      conflict: proposal.state === "conflict" || receipts.some((receipt) => receipt.status === "conflict"),
      failure: proposal.state === "failed" || proposal.state === "reconciliation_required" || receipts.some(isFailedReceipt),
      revert: proposal.change_set.schema_version === protocolVersions.compensationChangeSet || events.some((event) => /revert|compensation/.test(event.kind)),
    });
  }
  return { ok: true, outcomes };
}

function isHumanDecision(approval: StoredApproval): boolean {
  return !approval.approver.startsWith("policy:") && approval.status !== undefined;
}

function isFailedReceipt(receipt: StoredWritebackReceipt): boolean {
  return receipt.status === "failed" || receipt.status === "reconciliation_required";
}

function metricsFromHistory(outcomes: HistoryOutcome[], start: string, end: string): GraduatedTrustMetrics {
  const reviewed = outcomes.filter((item) => item.humanReviewed);
  const denominator = Math.max(1, reviewed.length);
  const humanRejected = reviewed.filter((item) => item.humanRejected).length;
  const conflicts = reviewed.filter((item) => item.conflict).length;
  const failures = reviewed.filter((item) => item.failure).length;
  const reverts = reviewed.filter((item) => item.revert).length;
  return {
    window_start: start,
    window_end: end,
    human_reviewed: reviewed.length,
    human_approved: reviewed.filter((item) => item.humanApproved).length,
    human_rejected: humanRejected,
    conflicts,
    failures,
    reverts,
    auto_approved_excluded: outcomes.filter((item) => item.autoApproved && !item.humanReviewed).length,
    rejection_rate: humanRejected / denominator,
    conflict_rate: conflicts / denominator,
    failure_rate: failures / denominator,
    revert_rate: reverts / denominator,
  };
}

function metricsGate(metrics: GraduatedTrustMetrics, criterion: GraduatedTrustCriterion): GraduatedTrustEvaluation | undefined {
  if (metrics.human_reviewed < criterion.minimum_human_reviews) return failure("INSUFFICIENT_HUMAN_REVIEWS", `Only ${metrics.human_reviewed} human-reviewed outcomes are available; ${criterion.minimum_human_reviews} are required.`);
  if (metrics.rejection_rate > criterion.maximum_rejection_rate) return failure("REJECTION_RATE_EXCEEDED", `Rejection rate ${rate(metrics.rejection_rate)} exceeds ${rate(criterion.maximum_rejection_rate)}.`);
  if (metrics.conflict_rate > criterion.maximum_conflict_rate) return failure("CONFLICT_RATE_EXCEEDED", `Conflict rate ${rate(metrics.conflict_rate)} exceeds ${rate(criterion.maximum_conflict_rate)}.`);
  if (metrics.failure_rate > criterion.maximum_failure_rate) return failure("FAILURE_RATE_EXCEEDED", `Failure rate ${rate(metrics.failure_rate)} exceeds ${rate(criterion.maximum_failure_rate)}.`);
  if (metrics.revert_rate > criterion.maximum_revert_rate) return failure("REVERT_RATE_EXCEEDED", `Revert rate ${rate(metrics.revert_rate)} exceeds ${rate(criterion.maximum_revert_rate)}.`);
  return undefined;
}

function approvalThreshold(contract: SynapsorContract, capabilityName: string, policyName: string, field: string): number | undefined {
  const capability = contract.capabilities.find((item) => item.name === capabilityName);
  if (capability?.kind !== "proposal" || capability.proposal?.approval?.mode !== "policy" || capability.proposal.approval.policy !== policyName) return undefined;
  const policy = contract.policies?.find((item) => item.name === policyName && item.kind === "approval");
  const rule = policy?.rules?.find((item) => item.field === field);
  return typeof rule?.max === "number" && Number.isFinite(rule.max) ? rule.max : undefined;
}

function failure(code: GraduatedTrustEvaluation["code"], message: string): GraduatedTrustEvaluation {
  return { ok: false, code, message };
}

function rate(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function recommendationStatusIsTerminal(status: PolicyRecommendationStatus): boolean {
  return status === "rejected" || status === "exported";
}
