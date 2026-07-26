import type {
  StoredShadowHumanAction,
  ShadowAgentResult,
  ShadowOutcomeDisposition,
  ShadowComparisonStatus,
  StoredShadowStudy,
  ShadowEffect,
  StoredShadowCase,
  StoredShadowOutcome,
  ShadowStudyComparison,
  ShadowDistribution,
  ShadowStudyReport,
  ShadowComparison,
} from "./domain-types.js";
import {
  canonicalJsonDigest,
  type ChangeSet,
} from "@synapsor-runner/protocol";
import {
  isRecord,
} from "./common.js";
import {
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import { ProposalStoreError } from "./errors.js";

export function comparePatches(
  proposalId: string,
  agentPatch: Record<string, unknown>,
  humanAction?: StoredShadowHumanAction,
): ShadowComparison {
  const comparedAt = new Date().toISOString();
  if (!humanAction) {
    return {
      proposal_id: proposalId,
      status: "no_human_action",
      agent_patch: agentPatch,
      matching_columns: [],
      differing_columns: [],
      missing_from_human: Object.keys(agentPatch),
      extra_human_columns: [],
      compared_at: comparedAt,
    };
  }
  const humanPatch = humanAction.patch;
  const agentColumns = Object.keys(agentPatch);
  const humanColumns = Object.keys(humanPatch);
  const matchingColumns = agentColumns.filter((column) => Object.is(agentPatch[column], humanPatch[column]));
  const differingColumns = agentColumns.filter((column) => column in humanPatch && !Object.is(agentPatch[column], humanPatch[column]));
  const missingFromHuman = agentColumns.filter((column) => !(column in humanPatch));
  const extraHumanColumns = humanColumns.filter((column) => !(column in agentPatch));
  const exact = matchingColumns.length === agentColumns.length && differingColumns.length === 0 && missingFromHuman.length === 0 && extraHumanColumns.length === 0;
  const partial = !exact && matchingColumns.length > 0;
  return {
    proposal_id: proposalId,
    status: exact ? "exact_match" : partial ? "partial_match" : "mismatch",
    agent_patch: agentPatch,
    human_patch: humanPatch,
    matching_columns: matchingColumns,
    differing_columns: differingColumns,
    missing_from_human: missingFromHuman,
    extra_human_columns: extraHumanColumns,
    notes: humanAction.notes,
    compared_at: comparedAt,
  };
}

export function compareShadowStudyCase(
  shadowCase: StoredShadowCase,
  outcome?: StoredShadowOutcome,
): ShadowStudyComparison {
  const base = {
    study_id: shadowCase.study_id,
    case_id: shadowCase.case_id,
    request_id: shadowCase.request_id,
    proposal_id: shadowCase.proposal_id,
    tenant_id: shadowCase.tenant_id,
    principal: shadowCase.principal,
    capability: shadowCase.capability,
    business_object: shadowCase.business_object,
    object_id: shadowCase.object_id,
    agent_result: shadowCase.agent_result,
    proposed_effect: shadowCase.proposed_effect,
    outcome,
    matching_columns: [] as string[],
    differing_columns: [] as string[],
    missing_from_human: [] as string[],
    extra_human_columns: [] as string[],
    decision_reason: shadowCase.decision_reason,
    risk_score: shadowCase.risk_score,
    amount_value: shadowCase.amount_value,
    compared_at: outcome?.created_at ?? shadowCase.created_at,
  };
  if (shadowCase.agent_result === "invalid_unsafe_scope_attempt") {
    return { ...base, status: "invalid_or_unsafe_scope_attempt", comparable: false };
  }
  if (shadowCase.agent_result === "policy_denied") {
    return { ...base, status: "agent_policy_denied", comparable: false };
  }
  if (shadowCase.agent_result === "unable_to_propose") {
    return { ...base, status: "agent_unable_to_propose", comparable: false };
  }
  if (shadowCase.agent_result === "stale_conflict" || outcome?.disposition === "stale_conflict") {
    return { ...base, status: "stale_conflict", comparable: false };
  }
  if (!outcome) {
    return { ...base, status: "unmatched_no_authoritative_outcome", comparable: false };
  }
  if (outcome.disposition === "rejected_no_action") {
    return { ...base, status: "human_rejected_no_action", comparable: false };
  }
  const agentPatch = shadowCase.proposed_effect?.patch ?? {};
  const humanPatch = outcome.actual_effect?.patch ?? {};
  const agentColumns = Object.keys(agentPatch).sort();
  const humanColumns = Object.keys(humanPatch).sort();
  const matchingColumns = agentColumns.filter((column) =>
    column in humanPatch && shadowValuesEqual(agentPatch[column], humanPatch[column])
  );
  const differingColumns = agentColumns.filter((column) =>
    column in humanPatch && !shadowValuesEqual(agentPatch[column], humanPatch[column])
  );
  const missingFromHuman = agentColumns.filter((column) => !(column in humanPatch));
  const extraHumanColumns = humanColumns.filter((column) => !(column in agentPatch));
  const exact =
    matchingColumns.length === agentColumns.length &&
    differingColumns.length === 0 &&
    missingFromHuman.length === 0 &&
    extraHumanColumns.length === 0;
  const partial = !exact && matchingColumns.length > 0;
  return {
    ...base,
    status: exact ? "exact_agreement" : partial ? "partial_agreement" : "disagreement",
    comparable: true,
    matching_columns: matchingColumns,
    differing_columns: differingColumns,
    missing_from_human: missingFromHuman,
    extra_human_columns: extraHumanColumns,
  };
}

export function latestIsoTimestamp(values: string[]): string {
  return [...values].sort((left, right) => Date.parse(right) - Date.parse(left))[0]!;
}

export function normalizeShadowEffect(input: ShadowEffect, path: string): ShadowEffect {
  if (!isRecord(input) || !isRecord(input.before) || !isRecord(input.after) || !isRecord(input.patch)) {
    throw new ProposalStoreError("SHADOW_EFFECT_INVALID", `${path} must contain before, after, and patch objects`);
  }
  const before = structuredClone(input.before);
  const after = structuredClone(input.after);
  const patch = structuredClone(input.patch);
  for (const [column, value] of Object.entries(patch)) {
    if (!(column in after) || !shadowValuesEqual(after[column], value)) {
      throw new ProposalStoreError("SHADOW_EFFECT_PATCH_MISMATCH", `${path}.patch.${column} must equal the normalized after value`);
    }
  }
  assertNoSecretMaterial({ before, after, patch }, path);
  return { before, after, patch };
}

export function shadowEffectFromChangeSet(changeSet: ChangeSet): ShadowEffect {
  return normalizeShadowEffect({
    before: changeSet.before,
    after: changeSet.after,
    patch: changeSet.patch,
  }, "shadow_proposal.effect");
}

export function effectAmountValue(effect: ShadowEffect): number | undefined {
  let total = 0;
  let found = false;
  for (const column of Object.keys(effect.patch)) {
    const before = effect.before[column];
    const after = effect.after[column];
    if (typeof before === "number" && Number.isFinite(before) && typeof after === "number" && Number.isFinite(after)) {
      total += Math.abs(after - before);
      found = true;
    }
  }
  return found ? total : undefined;
}

export function shadowStudyIncludes(study: StoredShadowStudy, capability: string, createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) return false;
  if (study.starts_at && timestamp < Date.parse(study.starts_at)) return false;
  if (study.ends_at && timestamp > Date.parse(study.ends_at)) return false;
  return study.selected_capabilities.length === 0 || study.selected_capabilities.includes(capability);
}

export function requiredBoundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProposalStoreError("SHADOW_FIELD_REQUIRED", `${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new ProposalStoreError("SHADOW_FIELD_INVALID", `${label} exceeds its safe bound or contains control characters`);
  }
  return normalized;
}

export function optionalBoundedText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredBoundedText(value, label, maximum);
}

export function optionalIsoTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = requiredBoundedText(value, label, 64);
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new ProposalStoreError("SHADOW_TIMESTAMP_INVALID", `${label} must be an ISO-8601 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

export function optionalFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProposalStoreError("SHADOW_NUMBER_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function safeShadowId(value: unknown, kind: string): string {
  const id = requiredBoundedText(value, `shadow ${kind} id`, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    throw new ProposalStoreError("SHADOW_ID_INVALID", `shadow ${kind} id contains unsupported characters`);
  }
  return id;
}

export function assertShadowAgentResult(value: string): asserts value is ShadowAgentResult {
  if (!isShadowAgentResult(value)) {
    throw new ProposalStoreError("SHADOW_AGENT_RESULT_INVALID", `unsupported shadow agent result: ${value}`);
  }
}

export function isShadowAgentResult(value: string): value is ShadowAgentResult {
  return [
    "proposed",
    "policy_denied",
    "unable_to_propose",
    "stale_conflict",
    "invalid_unsafe_scope_attempt",
  ].includes(value);
}

export function assertShadowOutcomeDisposition(value: string): asserts value is ShadowOutcomeDisposition {
  if (!isShadowOutcomeDisposition(value)) {
    throw new ProposalStoreError("SHADOW_OUTCOME_DISPOSITION_INVALID", `unsupported shadow outcome disposition: ${value}`);
  }
}

export function isShadowOutcomeDisposition(value: string): value is ShadowOutcomeDisposition {
  return ["applied", "rejected_no_action", "stale_conflict"].includes(value);
}

export function shadowValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonDigest(left) === canonicalJsonDigest(right);
}

export function countShadowStatus(comparisons: ShadowStudyComparison[], status: ShadowComparisonStatus): number {
  return comparisons.filter((item) => item.status === status).length;
}

export function emptyShadowStatusCounts(): Record<ShadowComparisonStatus, number> {
  return {
    exact_agreement: 0,
    partial_agreement: 0,
    disagreement: 0,
    human_rejected_no_action: 0,
    agent_policy_denied: 0,
    agent_unable_to_propose: 0,
    stale_conflict: 0,
    unmatched_no_authoritative_outcome: 0,
    invalid_or_unsafe_scope_attempt: 0,
  };
}

export function distribution(values: number[]): ShadowDistribution | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const total = ordered.reduce((sum, value) => sum + value, 0);
  const percentile = (fraction: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
  return {
    count: ordered.length,
    minimum: ordered[0]!,
    maximum: ordered.at(-1)!,
    mean: total / ordered.length,
    median: percentile(0.5),
    p95: percentile(0.95),
    total,
  };
}

export function suggestedShadowPolicies(
  comparisons: ShadowStudyComparison[],
): ShadowStudyReport["suggested_policies"] {
  const byCapability = new Map<string, ShadowStudyComparison[]>();
  for (const comparison of comparisons) {
    const items = byCapability.get(comparison.capability) ?? [];
    items.push(comparison);
    byCapability.set(comparison.capability, items);
  }
  const suggestions: ShadowStudyReport["suggested_policies"] = [];
  for (const [capability, items] of [...byCapability.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const exact = items.filter((item) => item.status === "exact_agreement");
    const values = exact.map((item) => item.amount_value).filter((value): value is number => value !== undefined);
    if (exact.length < 5 || values.length !== exact.length) continue;
    suggestions.push({
      capability,
      suggestion: `Review a bounded policy no higher than the observed exact-agreement maximum (${Math.max(...values)}).`,
      sample_size: exact.length,
      active: false,
    });
  }
  return suggestions;
}

export function shadowTrustProgression(
  comparisons: ShadowStudyComparison[],
  suggestions: ShadowStudyReport["suggested_policies"],
): ShadowStudyReport["trust_progression"] {
  const outcomes = comparisons.filter((item) => item.outcome !== undefined).length;
  const comparable = comparisons.filter((item) => item.comparable).length;
  const exact = comparisons.filter((item) => item.status === "exact_agreement").length;
  const currentStage = comparisons.length === 0
    ? "observe"
    : outcomes === 0
      ? "compare"
      : suggestions.length === 0
        ? "manual_review"
        : "suggested_bounded_policy";
  const stageOrder = ["observe", "compare", "manual_review", "suggested_bounded_policy"] as const;
  const currentIndex = stageOrder.indexOf(currentStage);
  const details = {
    observe: `${comparisons.length} task${comparisons.length === 1 ? "" : "s"} observed without source mutation.`,
    compare: `${outcomes} authoritative outcome${outcomes === 1 ? "" : "s"}; ${comparisons.length - outcomes} unmatched.`,
    manual_review: `${comparable} comparable task${comparable === 1 ? "" : "s"}; ${exact} exact agreement${exact === 1 ? "" : "s"}. At least 5 exact numeric examples are required before a bounded-policy suggestion.`,
    suggested_bounded_policy: suggestions.length > 0
      ? `${suggestions.length} inactive bounded-policy suggestion${suggestions.length === 1 ? "" : "s"}; a human must review and activate any contract change separately.`
      : "No policy suggestion is available.",
  };
  const labels = ["Observe", "Compare", "Manual review", "Suggested bounded policy"] as const;
  return {
    current_stage: currentStage,
    minimum_policy_sample_size: 5,
    insufficient_sample_size: suggestions.length === 0,
    stages: stageOrder.map((stage, index) => ({
      name: labels[index]!,
      status: index < currentIndex ? "complete" : index === currentIndex ? "current" : "locked",
      detail: details[stage],
    })),
    automatic_activation: false,
  };
}

export function safeSqliteFailure(_error: unknown, fallback: string): string {
  return fallback;
}
