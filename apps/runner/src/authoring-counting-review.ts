import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicyPassage, PolicyTextSnapshot, PolicySourceSession } from "./authoring-policy-source.js";
import type { CountingOutcomeDomain, CountingComparisonResolution, CountingComponentResolution, CountingInterpretation } from "./authoring-policy-source.js";

const record = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, any> : undefined;

/** Reuse only the exact source/program-bound typed comparison and its actual
 * clarification provenance. A generated statement or unrelated owner message
 * is not a decision for this clause. This records interpretation, not consent. */
const comparisonKey = (items: NonNullable<PolicyPassage["counter_requirements"]>) => canonicalJsonDigest(items.map(({ path, current_capability, required_capability }) =>
  ({ path, current_capability, required_capability })).sort((a, b) => a.path.localeCompare(b.path)));

export function policyCountingInterpretations(session: PolicySourceSession | undefined, source: PolicyTextSnapshot | undefined,
  authorityDigest: string, clarifications: Array<{ question: string; answer: string }>): CountingInterpretation[] {
  if (!source || session?.coverage?.source_digest !== source.digest || session.coverage_authority_digest !== authorityDigest) return [];
  const retained = session.coverage.passages.flatMap(passage => (passage.counting_components ?? []).flatMap(component => {
    const entry = component.interpretation;
    if (entry.source_digest !== source.digest || entry.authority_digest !== authorityDigest
      || entry.operator_history_digest !== canonicalJsonDigest(session.operator_messages ?? [])
      || !session.operator_messages?.includes(entry.operator_support.answer)
      || clarifications.filter(turn => turn.question === entry.operator_support.question && turn.answer === entry.operator_support.answer).length !== 1) return [];
    return [structuredClone(entry)];
  }));
  const legacy = session.coverage.passages.flatMap(passage => {
    if (passage.counting_components?.length) return [];
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
  return [...new Map([...retained, ...legacy].map(entry => [canonicalJsonDigest(entry), entry])).values()];
}

export function isCountingOnlyPassage(passage: PolicyPassage): boolean {
  if (passage.field_checks?.length || passage.evidence_checks?.length || passage.application_obligations?.length || passage.deployment_prerequisite) return false;
  const roots = (passage.counter_requirements ?? []).map(check => check.path.replace(/\/\d+\/history_selector\/capability$/u, ""));
  return passage.draft_paths.every(pointer => pointer === "/runner_evidence/runtime_contract/approval_counter_selection"
    || roots.some(root => pointer === root || pointer.startsWith(root) && /^\/\d+\/history_selector(?:\/capability)?$/u.test(pointer.slice(root.length))));
}

/** Resolve typed components, never the surrounding prose. Exact structural
 * identity supplies association; a paragraph citation supplies no counter proof. */
export function associateCountingComponents(passage: PolicyPassage, source: PolicyTextSnapshot, draft: unknown,
  messages: readonly string[], submittedMessageId?: number): CountingComponentResolution[] {
  const evidence = record(record(draft)?.runner_evidence);
  const interpretations: CountingInterpretation[] = Array.isArray(evidence?.counting_interpretations) ? evidence.counting_interpretations : [];
  const result: CountingComponentResolution[] = [];
  for (const check of passage.counter_requirements ?? []) {
    if (check.current_capability === check.required_capability) continue;
    const label = check.path.replace(/[^a-zA-Z0-9_./~:-]/gu, "_").slice(0, 500);
    const fail = (code: string, detail: string): never => { throw new Error(`Counting component ${label}: ${code}. ${detail} Correct this comparison's evidence structure; keep the saved program and settled policy decision unchanged.`); };
    const root = check.path.replace(/\/\d+\/history_selector\/capability$/u, "");
    if (!passage.draft_paths.some(pointer => pointer.startsWith(root) && (check.path === pointer || check.path.startsWith(`${pointer}/`)))) {
      fail("COUNTING_REFERENCE_OVERBROAD", "Reference this counter's exact automatic_limits root or history_selector/capability path; broad approval context cannot establish it");
    }
    const candidates = interpretations.filter(entry => entry?.source_digest === source.digest && entry.start === passage.start && entry.end === passage.end
      && Array.isArray(entry.comparisons) && entry.comparisons.some(prior => comparisonKey([prior]) === comparisonKey([check])));
    if (candidates.length > 1) fail("COUNTING_INTERPRETATION_AMBIGUOUS", "More than one scoped interpretation applies; provide a uniquely established source/counter decision, not another business restatement");
    if (!candidates.length) fail("COUNTING_SUPPORT_MISSING", "No established interpretation matches this source span and typed current/required counter values");
    const accepted = candidates[0]!;
    if (!accepted.operator_support?.question || !messages.includes(accepted.operator_support.answer)
      || accepted.operator_history_digest !== canonicalJsonDigest(messages)) fail("COUNTING_SUPPORT_STALE", "The interpretation's exact supporting decision or current operator-history binding is unavailable");
    if (check.operator_clarification !== undefined && check.operator_clarification !== accepted.operator_support.answer) {
      fail("COUNTING_SUPPORT_MISMATCH", `The explicit counter support differs from the applicable interpretation (indexed operator reference ${messages.indexOf(accepted.operator_support.answer) + 1}); the enclosing paragraph citation is separate`);
    }
    const domain = record(record(record(evidence?.runtime_contract)?.approval_counter_selection)?.outcome_domain) as CountingOutcomeDomain | undefined;
    if (!domain?.complete || !Array.isArray(domain.proposed_outcomes) || !Array.isArray(domain.current_outcomes)
      || !Array.isArray(domain.retained_automatic_outcomes)) return fail("COUNTING_DOMAIN_INCOMPLETE", "Current complete proposed/current authority and retained automatic-history evidence is required; missing storage is not empty history");
    if (domain.proposed_outcomes.length !== 1 || [...domain.current_outcomes, ...domain.retained_automatic_outcomes].some(outcome => outcome !== check.required_capability)) {
      fail("COUNTING_BEHAVIOR_DIFFERENT", "The complete domain contains another relevant automatic outcome; absent and outcome-specific selectors are not established equivalent");
    }
    const comparison = { path: check.path, current_capability: check.current_capability, required_capability: check.required_capability };
    const narrow = { ...passage, draft_paths: [check.path], counter_requirements: [comparison], evidence_checks: undefined,
      field_checks: undefined, application_obligations: undefined, deployment_prerequisite: undefined };
    const scopedDraft = { ...record(draft), runner_evidence: { ...evidence,
      counting_interpretations: [{ ...accepted, comparisons: [comparison] }] } };
    const resolution = resolveCountingComparison(narrow, source, scopedDraft, accepted.operator_support.answer);
    if (!resolution) return fail("COUNTING_COMPARISON_INVALID", "The exact typed predicate, automatic approval kind, boundary, proposed revision or store/domain binding does not validate");
    result.push({ origin: "HOST-RESOLVED", submitted_support: {
      ...(passage.operator_clarification ? { paragraph: passage.operator_clarification } : {}),
      ...(submittedMessageId !== undefined ? { operator_message_id: submittedMessageId } : {}),
      ...(check.operator_clarification ? { counter: check.operator_clarification } : {}),
    }, interpretation: structuredClone(accepted), resolution });
  }
  return result;
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
    comparisons.push({ path: check.path, retained_capability: null, required_capability: outcome, actual_predicate: structuredClone(selector),
      configured_limit: { kind: limit.kind, scope: limit.scope, maximum: limit.maximum, window_seconds: limit.window_seconds } });
  }
  // This guard still protects a whole-passage normalization. Mixed passages use
  // separately validated components and retain their residual disposition/checks.
  if (!isCountingOnlyPassage(passage)) return undefined;
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
