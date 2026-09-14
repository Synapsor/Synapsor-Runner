import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicyPassage, PolicyTextSnapshot, PolicySourceSession } from "./authoring-policy-source.js";
import type { CountingOutcomeDomain } from "./authoring-counting-domain.js";

export type CountingComparisonResolution = {
  kind: "conditional_singleton_equivalence";
  source_digest: string;
  source_lines: [number, number];
  source_excerpt: string;
  /** Supporting exact clarification, not an override or independent semantic proof. */
  operator_support: { question: string; answer: string };
  operator_history_digest: string;
  comparisons: Array<{ path: string; retained_capability: null; required_capability: string; actual_predicate: unknown; configured_limit: unknown }>;
  domain: CountingOutcomeDomain;
  dependencies_digest: string;
  reason: string;
  claim_origin: "submitted_passage" | "retained_review";
  established_claim: Pick<PolicyPassage, "disposition" | "interpretation" | "issue_kind" | "next_step">;
  submitted_claim: Pick<PolicyPassage, "disposition" | "interpretation" | "issue_kind" | "next_step">;
};
const record = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, any> : undefined;

/** Reuse only the exact source/program-bound typed comparison and its actual
 * clarification provenance. A generated statement or unrelated owner message
 * is not a decision for this clause. This records interpretation, not consent. */
const comparisonKey = (items: NonNullable<PolicyPassage["counter_requirements"]>) => canonicalJsonDigest([...items].sort((a, b) => a.path.localeCompare(b.path)));

export function policyCountingInterpretations(session: PolicySourceSession | undefined, source: PolicyTextSnapshot | undefined,
  authorityDigest: string, clarifications: Array<{ question: string; answer: string }>) {
  if (!source || session?.coverage?.source_digest !== source.digest || session.coverage_authority_digest !== authorityDigest) return [];
  return session.coverage.passages.flatMap(passage => {
    if (!passage.counter_requirements?.some(check => check.current_capability !== check.required_capability) || !passage.operator_clarification
      || !session.operator_messages?.includes(passage.operator_clarification)
      || passage.counting_resolution && passage.counting_resolution.operator_history_digest !== canonicalJsonDigest(session.operator_messages)) return [];
    const support = clarifications.filter(turn => turn.answer === passage.operator_clarification);
    if (support.length !== 1) return [];
    return [{ source_digest: source.digest, start: passage.start, end: passage.end,
      authority_digest: authorityDigest, operator_support: support[0]!,
      operator_history_digest: canonicalJsonDigest(session.operator_messages),
      comparisons: structuredClone(passage.counter_requirements).sort((a,b) => a.path.localeCompare(b.path)),
      source_passage: { start: passage.start, end: passage.end, draft_paths: [...passage.draft_paths].sort(),
        operator_clarification: passage.operator_clarification, counter_requirements: structuredClone(passage.counter_requirements).sort((a,b) => a.path.localeCompare(b.path)),
        responsibility: "runner" as const,
        ...(passage.counting_resolution?.established_claim ?? { disposition: passage.disposition, interpretation: passage.interpretation,
          ...(passage.issue_kind ? { issue_kind: passage.issue_kind } : {}), ...(passage.next_step ? { next_step: passage.next_step } : {}) }) } }];
  });
}

/** Compare only the typed capability dimension. No natural-language verdict
 * matching, inferred override, quota edit, or favorable whole-report cache. */
export function resolveCountingComparison(passage: PolicyPassage, source: PolicyTextSnapshot, draft: unknown,
  clarification: string | undefined): CountingComparisonResolution | undefined {
  if (!passage.counter_requirements?.length || !["conflict", "implemented"].includes(passage.disposition)
    || passage.responsibility !== "runner" || passage.field_checks?.length || passage.evidence_checks?.length
    || passage.application_obligations?.length || passage.deployment_prerequisite || !clarification) return undefined;
  const evidence = record(record(draft)?.runner_evidence), contract = record(record(evidence?.runtime_contract)?.approval_counter_selection);
  const domain = record(contract?.outcome_domain) as CountingOutcomeDomain | undefined;
  const support = (Array.isArray(evidence?.counting_interpretations) ? evidence.counting_interpretations : [])
    .filter((entry: any) => entry?.source_digest === source.digest && entry.start === passage.start && entry.end === passage.end
      && entry.operator_support?.answer === clarification && typeof entry.operator_support.question === "string"
      && entry.operator_support.question.length > 0
      && comparisonKey(entry.comparisons) === comparisonKey(passage.counter_requirements!));
  if (support.length !== 1 || !domain || domain.complete !== true || domain.history_scope !== "all_retained_boundary_automatic_approvals"
    || !Array.isArray(domain.proposed_outcomes) || domain.proposed_outcomes.length !== 1
    || !Array.isArray(domain.current_outcomes) || !Array.isArray(domain.retained_automatic_outcomes)
    || !/^sha256:[a-f0-9]{64}$/u.test(domain.store_binding_digest) || !/^sha256:[a-f0-9]{64}$/u.test(domain.proposed_revision)) return undefined;
  const outcome = domain.proposed_outcomes[0]!;
  const actions = record(draft)?.actions;
  if (!Array.isArray(actions) || actions.length !== 1 || actions[0]?.outcome !== outcome
    || [...domain.current_outcomes, ...domain.retained_automatic_outcomes].some(entry => entry !== outcome)) return undefined;
  const roots = new Set<string>();
  const comparisons: CountingComparisonResolution["comparisons"] = [];
  for (const check of passage.counter_requirements) {
    const match = /^\/runner_evidence\/actions\/([^/]+)\/automatic_limits\/(\d+)\/history_selector\/capability$/u.exec(check.path);
    if (!match || match[1] !== outcome || check.current_capability !== null || check.required_capability !== outcome) return undefined;
    const automatic = record(evidence?.actions)?.[outcome]?.automatic_limits;
    const limit = Array.isArray(automatic) ? automatic[Number(match[2])] : undefined;
    const selector = record(limit?.history_selector);
    if (!selector || limit.kind !== "count" || selector.capability !== null || selector.action_boundary_name !== domain.boundary_name
      || selector.approval_status !== "approved" || selector.approval_kind !== "boundary_automatic"
      || !["boundary", "tenant", "tenant_principal", "tenant_object"].includes(limit.scope)) return undefined;
    roots.add(`/runner_evidence/actions/${outcome}/automatic_limits`);
    comparisons.push({ path: check.path, retained_capability: null, required_capability: outcome, actual_predicate: structuredClone(selector),
      configured_limit: { kind: limit.kind, scope: limit.scope, maximum: limit.maximum, window_seconds: limit.window_seconds } });
  }
  // Mixed concerns must be separate passages; never discharge privacy, effects,
  // thresholds, source readiness or a new obligation through this comparison.
  if (!passage.draft_paths.every(pointer => pointer === "/runner_evidence/runtime_contract/approval_counter_selection"
    || [...roots].some(root => pointer === root || /^\/\d+\/history_selector(?:\/capability)?$/u.test(pointer.slice(root.length)) && pointer.startsWith(root)))) return undefined;
  const material = { source_digest: source.digest, source_lines: [passage.start, passage.end] as [number, number],
    source_excerpt: source.text.split("\n").slice(passage.start - 1, passage.end).join("\n"),
    operator_support: { question: support[0].operator_support.question, answer: clarification },
    operator_history_digest: support[0].operator_history_digest, comparisons: comparisons.sort((a,b) => a.path.localeCompare(b.path)), domain };
  return { kind: "conditional_singleton_equivalence", ...material, dependencies_digest: canonicalJsonDigest(material),
    reason: "Only the proposed outcome occurs in the complete proposed/current domain and retained automatic-approval history. Human approvals have no Action Boundary tag and do not count. Retaining the absent filter therefore selects the same automatic history here. A changed requirement, decision, selector, authority, store binding or outcome/history domain requires revalidation; this is not general equivalence or an operator override.",
    claim_origin: "submitted_passage", established_claim: {
      disposition: support[0].source_passage.disposition, interpretation: support[0].source_passage.interpretation,
      ...(support[0].source_passage.issue_kind ? { issue_kind: support[0].source_passage.issue_kind } : {}),
      ...(support[0].source_passage.next_step ? { next_step: support[0].source_passage.next_step } : {}) },
    submitted_claim: { disposition: passage.disposition, interpretation: passage.interpretation,
      ...(passage.issue_kind ? { issue_kind: passage.issue_kind } : {}), ...(passage.next_step ? { next_step: passage.next_step } : {}) } };
}
