import { canonicalJsonDigest } from '@synapsor-runner/protocol';

/** Only host-authored text and fixed response coordinates leave this boundary. */
export class CoverageComponentError extends Error {
  constructor(readonly component: string, readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Invalid coverage component.');
  }
}
export class CoverageComponentsError extends Error {
  constructor(readonly errors: CoverageComponentError[]) { super(errors[0]!.message); }
}
export type CoverageFinding = {
  code: string; component: string; identity: string; component_identity: string; passage_identity?: string; reason: string; repair: string; structural: boolean;
};
export type CoverageFeedback = {
  context: string; findings: CoverageFinding[]; limited: boolean;
  unevaluated: string[]; complete_validation: false;
};
// Host-only evidence of completed checks in this traversal, never provider input
// or a durable success flag. Restart requires a separately authorized episode.
const checkedPassages = new WeakMap<CoverageFeedback, Map<string,string>>();
export function recordCheckedCoveragePassage(feedback: CoverageFeedback, component: string, identity: string): void {
  const checked=checkedPassages.get(feedback)??new Map<string,string>(); checked.set(component,identity); checkedPassages.set(feedback,checked);
}
export const MAX_COVERAGE_FINDINGS = 8;
export const MAX_COVERAGE_FEEDBACK_BYTES = 8_192;
export const MAX_COVERAGE_SUBMISSIONS = 3;

export function coverageFinding(error: unknown, component: string, identityBasis: unknown): CoverageFinding {
  if (error instanceof CoverageComponentError) component = error.component;
  const message = error instanceof Error ? error.message : '';
  let code = 'COVERAGE_VALIDATION_INCOMPLETE', structural = false;
  let reason = 'Complete coverage validation did not finish; no partial review was accepted.';
  let repair = 'Keep the saved review pending. Use the current attached-rules review to resolve its requirement or revalidate its evidence; no business edit was inferred.';
  if (message.startsWith('COUNTING_SUPPORT_MISMATCH:')) {
    code = 'COUNTING_SUPPORT_MISMATCH'; structural = true;
    reason = 'The counter-specific citation has no applicable exact support association; a paragraph citation is separate.';
    repair = 'Correct only this counter citation using its current scoped support. Retain the counting comparison, all source requirements and every other claim. Do not change selectors or invent an owner decision.';
  } else if (message.startsWith('Draft pointer(s) not present:') || message.startsWith('Draft pointer not present:')) {
    code = 'COVERAGE_REFERENCE_MISSING'; structural = true;
    reason = 'The submitted reference is absent from the current prepared review context. Its untrusted value is withheld.';
    repair = 'Use only an existing exact reference that proves this claim. Read exclusion is not evidence that an Action privately uses a field. Do not invent an Action binding or substitute a nearby pointer. If proof is unavailable, preserve the claim as unresolved, with no invented reference; resubmit the complete review.';
  } else if (message.startsWith('SOURCE_COUNTER_COMPONENT_MIXED:') || message.startsWith('SOURCE_COUNTER_CLASSIFICATION_REQUIRED:')) {
    code = message.startsWith('SOURCE_COUNTER_CLASSIFICATION_REQUIRED:') ? 'SOURCE_COUNTER_CLASSIFICATION_REQUIRED' : 'SOURCE_COUNTER_COMPONENT_MIXED'; structural = true;
    reason = 'A source-counter maintenance component mixes responsibilities or uses an unclassified source requirement.';
    repair = 'Separate the maintenance duty from effect/version-update, privacy and other claims. Use the exact source_counter_maintenance entry and typed source_counter_obligation requirement. Owner maintenance needs current exact host attestation; independent assurance remains blocked. False verification flags alone are not an additional source requirement. Do not drop any claim or repeat an existing owner confirmation.';
  } else if (message.startsWith('SOURCE_COUNTER_ATTESTATION_REQUIRED:')) {
    code = 'SOURCE_COUNTER_ATTESTATION_REQUIRED';
    reason = 'The required source-owner maintenance confirmation is absent or not current for this effect.';
    repair = 'Keep the duty unresolved. Use the existing reviewed-counter operation to review the exact current source, metadata and target; external assurance remains unverified. Another model opinion cannot establish confirmation.';
  } else if (message.includes('draft_paths must contain only') || message.includes('Classify the deployment prerequisite against its exact')) {
    code = 'COVERAGE_DEPLOYMENT_COMPONENT_MIXED'; structural = true;
    reason = 'The deployment component contains references outside its exact prerequisite or has no supported classification.';
    repair = 'Use only the exact deployment_prerequisites entry for that supported setup duty. Split receipt-mode/setup, Read/privacy and business claims into their own independently checked passages. Selection is not setup, a receipt or independent readback; keep all outstanding duties pending. Do not change the draft.';
  } else if (message.startsWith('Counter requirements must name an exact referenced')) {
    code = 'COUNTING_REFERENCE_OVERBROAD'; structural = true;
    reason = 'The comparison does not identify a valid narrow referenced history-selector component.';
    repair = 'Name the exact history_selector/capability path already present in current evidence and include its parent in draft_paths. A broad approval context cannot prove the narrow comparison or arbitrary children. Keep the complete counting obligation.';
  } else if (message.startsWith('Field privacy evidence is not present:') || message.startsWith('Incomplete field privacy evidence')) {
    code = 'COVERAGE_FIELD_EVIDENCE_UNAVAILABLE';
    reason = 'The required privacy claim has no complete applicable field evidence in this prepared context.';
    repair = 'Preserve the privacy requirement as unresolved. Read exclusion and private Action use are distinct; do not invent or redirect evidence. Use current evidence review rather than another policy opinion.';
  } else if (message.startsWith('COUNTING_')) {
    const known = ['COUNTING_REQUIREMENT_UNESTABLISHED','COUNTING_REQUIREMENT_AMBIGUOUS','COUNTING_REQUIREMENT_MISMATCH','COUNTING_CONFIGURATION_INCOMPLETE','COUNTING_DOMAIN_STALE','COUNTING_SUPPORT_STALE','COUNTING_BEHAVIOR_DIFFERENT','COUNTING_INTERPRETATION_AMBIGUOUS','COUNTING_COMPARISON_INVALID','COUNTING_REFERENCE_OVERBROAD'];
    code = known.find(c => message.startsWith(c + ':')) ?? 'COVERAGE_EVIDENCE_UNAVAILABLE';
    reason = 'The counting requirement, comparison or its current evidence is not established. This is not an invitation for another policy opinion.';
    structural = ['COUNTING_COMPARISON_INVALID','COUNTING_REFERENCE_OVERBROAD'].includes(code);
    repair = structural ? 'Use one valid narrow typed comparison per counter; broad context cannot prove child properties. Preserve every unrelated claim.' : 'Retain the unresolved requirement and use its existing decision or current-evidence review. No selector change or ownership completion is inferred.';
  } else if (message.includes('Each passage must be an object') || message.includes('Invalid passage range') || message.startsWith('Coverage tool accepts only passages') || message.startsWith('Coverage passages must be an array') || message.startsWith('Coverage contains ') || message.startsWith('Use exact JSON pointers')) {
    code = 'COVERAGE_STRUCTURE_INVALID'; structural = true;
    reason = 'The response envelope or passage structure does not satisfy the supplied schema. Dependent claim checks were not evaluated.';
    repair = 'Submit the complete passages array; prose alone cannot record a review. Use only supported schema properties, valid source ranges and exact references; do not drop requirements to repair structure.';
  } else if (message.startsWith('Unaccounted source lines:')) {
    code = 'COVERAGE_SOURCE_LINES_MISSING'; structural = true;
    reason = 'One or more nonblank source lines have no submitted disposition.';
    repair = 'Account for every nonblank line of the current consented source, including restrictions and unsupported requirements. Submit the complete replacement; omission is not evidence of implementation.';
  } else if (message.startsWith('Mechanical evidence mismatch at')) {
    code = 'COVERAGE_EVIDENCE_VALUE_MISMATCH'; structural = true;
    reason = 'Mechanical evidence mismatch: the typed claim does not equal the value in the existing prepared context.';
    repair = 'Correct the typed evidence comparison against that exact current context; do not change configuration to repair a claim. Keep any actual source-policy disagreement unresolved and validate it separately.';
  } else if (message.startsWith('Field coverage mismatch:')) {
    code = 'COVERAGE_PRIVACY_CONFLICT';
    reason = 'The claimed privacy disposition conflicts with validated field exposure.';
    repair = 'Keep the privacy requirement unresolved and use the existing reviewed privacy decision path. Do not request another favorable opinion or assign the obligation away.';
  } else if (message.includes('Invalid counter requirements record')) {
    code = 'COVERAGE_COUNTER_STRUCTURE_INVALID'; structural = true;
    reason = 'The counter comparison has an unsupported shape, responsibility or disposition.';
    repair = 'Counter requirements need Runner responsibility and implemented or conflict disposition. Keep an actual threshold override in its own passage with its exact accepted decision, and retain every unchanged scope, window, filter and limit. Omit an inapplicable comparison property rather than null or an empty array. Return the complete corrected coverage.';
  } else if (message.includes('An override must reference an actual operator message.')) {
    code = 'COVERAGE_OVERRIDE_UNESTABLISHED';
    reason = 'The purported override has no valid current operator support. Leaving work pending is not an override.';
    repair = 'Keep the requirement unresolved. Review its existing decision through attached-rules review; do not ask another model opinion to invent an override or claim completed ownership.';
  } else if (message.includes('Invalid application obligation record')) {
    code = 'COVERAGE_OBLIGATION_STRUCTURE_INVALID'; structural = true;
    reason = 'The application-obligation record does not match the supported isolated duty structure.';
    repair = 'Use the exact named application contract, responsibility=application and a pending disposition. Keep field/privacy, counter and Runner claims separately validated; assignment remains unverified. Return the complete corrected coverage.';
  }
  return {code,component,component_identity:canonicalJsonDigest(identityBasis),identity:canonicalJsonDigest({component:identityBasis,code}),reason,repair,structural};
}

/** A code change alone is not progress. Every old failed component must now
 * validate; a recurrence anywhere in the episode stops rather than resetting. */
export function permitsSecondCoverageCorrection(prior: CoverageFeedback[], next: CoverageFeedback): boolean {
  if (prior.length !== 1 || !next.findings.length || next.limited || !next.findings.every(f => f.structural)) return false;
  const old = prior.flatMap(r => r.findings);
  const checked = checkedPassages.get(next);
  if (!checked || old.some(f => !f.passage_identity || checked.get(f.component.match(/^\/passages\/\d+/u)?.[0] ?? "/") !== f.passage_identity)) return false;
  return prior.every(r => r.context === next.context && !r.limited && r.findings.every(f => f.structural))
    && next.findings.every(f => !old.some(p => p.identity === f.identity || p.component_identity === f.component_identity || p.component === f.component
      || p.component.split('/counter_requirements/')[0] === f.component.split('/counter_requirements/')[0]))
    && old.every(p => !next.unevaluated.some(c => p.component.startsWith(c) || c.startsWith(p.component)));
}
