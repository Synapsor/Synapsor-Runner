import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { CoverageSourceLinesError } from './authoring-source-coverage.js';

/** Only host-authored text and fixed response coordinates leave this boundary. */
export class CoverageComponentError extends Error {
  constructor(readonly component: string, readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Invalid coverage component.');
  }
}
export class CoverageComponentsError extends Error {
  constructor(readonly errors: CoverageComponentError[]) { super(errors[0]!.message); }
}
/** Constructed only after the exact reference has resolved in the prepared,
 * consented context. A transcription finding never establishes required policy. */
export class CoverageCurrentDescriptionError extends Error {
  readonly code = 'COUNTING_CURRENT_DESCRIPTION_MISMATCH';
  constructor(readonly evidence: { path: string; actual: string | null; submitted: string | null | { withheld: true } }) {
    super('COUNTING_CURRENT_DESCRIPTION_MISMATCH: The submitted current selector does not describe the prepared configuration.');
  }
}
/** Eligibility is established by the obligation validator's typed current
 * evidence, never inferred here from exception prose or a model heading. */
export class CoverageReceiptObservationError extends Error {
  readonly code = 'OBLIGATION_OBSERVATION_UNESTABLISHED';
  constructor(readonly structural: boolean) {
    super('OBLIGATION_OBSERVATION_UNESTABLISHED: Receipt capability or selected configuration is not an observed receipt or independent source readback. Keep the applicable exact setup/after-execution duty pending; no observation evidence is supplied by this review.');
  }
}
/** Host-only reason from the strict exclusion validator, never a provider flag.
 * A current narrow proof can justify repairing a representation, not accepting it. */
export class CoverageReceiptReadExclusionError extends Error {
  readonly code = 'RECEIPT_READ_EXCLUSION_UNESTABLISHED';
  constructor(readonly reason: 'proof_unavailable' | 'component_not_isolatable' | 'current_proof_mixed_component') {
    super('RECEIPT_READ_EXCLUSION_UNESTABLISHED: The exact current selected-Read exclusion must be isolated; it proves no other privacy, business or observation claim.');
  }
}
/** Assessment reasons are host-only; each has a complete safe feedback mapping.
 * A mixed configuration claim remains invalid even when correction is possible. */
export type ReceiptConfigurationFindingReason =
  | 'source_requirement_unestablished' | 'selection_unavailable' | 'mode_mismatch'
  | 'component_not_isolatable' | 'responsibility_mismatch' | 'reference_overbroad' | 'current_selection_mixed_component';
const receiptConfigurationFindings = {
  source_requirement_unestablished: { code: 'OBLIGATION_RECEIPT_REQUIREMENT_UNESTABLISHED', structural: false,
    reason: 'The exact source-required receipt mode is not established for this component.',
    repair: 'Keep the requirement unresolved. Current configuration cannot supply owner meaning. Use the existing source decision or evidence review; do not invent a receipt guarantee.' },
  selection_unavailable: { code: 'OBLIGATION_CONFIGURATION_UNAVAILABLE', structural: false,
    reason: 'The applicable current receipt selection or its source, Read, Action or destination binding is unavailable or does not agree.',
    repair: 'Revalidate the exact selected receipt configuration and its current bindings. Do not substitute another source, outcome, destination or historical selection, infer an observation, or obtain another opinion to manufacture evidence.' },
  mode_mismatch: { code: 'OBLIGATION_RECEIPT_MODE_MISMATCH', structural: false,
    reason: 'The source-required receipt mode conflicts with the applicable selected mode.',
    repair: 'Keep this genuine conflict unresolved. Use the existing separate reviewed receipt setup if authorized; do not downgrade the source requirement, relabel the conflict as formatting or change business policy to clear review.' },
  reference_overbroad: { code: 'OBLIGATION_CONFIGURATION_REFERENCE_OVERBROAD', structural: false,
    reason: 'The submitted reference does not identify the exact receipt-configuration comparison; a scalar child or broad contract cannot establish this receipt requirement.',
    repair: 'Keep the receipt requirement unresolved. Review its exact source meaning against the applicable receipt_configuration root, with authentic current evidence. Broad context or a selected scalar cannot prove the receipt guarantee, effects, setup or observations; keep those claims separately supported.',
  },
  responsibility_mismatch: { code: 'OBLIGATION_CONFIGURATION_COMPONENT_MIXED', structural: false,
    reason: 'An implemented receipt-configuration comparison must be a Runner evidence claim. The submitted responsibility does not establish that claim.',
    repair: 'Keep this claim unresolved. Separate the actual Runner selection comparison from deployment, application duties and observed outcomes; each needs its own applicable evidence and responsibility. Do not relabel a substantive duty as implemented to bypass validation.',
  },
  component_not_isolatable: { code: 'OBLIGATION_CONFIGURATION_COMPONENT_MIXED', structural: false,
    reason: 'The configuration claim has unsupported, duplicated or unrelated components. No supported representation correction is established.',
    repair: 'Keep the complete review unresolved. Each configuration, effect, privacy, condition and observation claim needs its own applicable evidence. Do not erase a residual requirement or invent an observation to make this report valid.' },
  current_selection_mixed_component: { code: 'OBLIGATION_CONFIGURATION_COMPONENT_MIXED', structural: true,
    reason: 'The exact current receipt selection matches the independently established source mode, but its narrow comparison is mixed with supported capability or receipt-overview roots. The submitted report remains invalid.',
    repair: 'Return the COMPLETE REPLACEMENT review. Isolate the selected receipt-mode comparison at /runner_evidence/runtime_contract/receipt_configuration; give compiled effects and receipt guarantees their own separately supported components. Preserve every source range, condition, privacy claim and duty. Configuration is not execution, a performed receipt or independent source readback. Retain applicable pending setup and observation duties and authentic historical facts without inventing evidence. Keep optional counter citations only when their exact support is authentic. Do not change policy, selectors, configuration or owner decisions.' },
} satisfies Record<ReceiptConfigurationFindingReason, {code:string;structural:boolean;reason:string;repair:string}>;
export class CoverageReceiptConfigurationError extends Error {
  readonly code: string;
  constructor(readonly reason: ReceiptConfigurationFindingReason) {
    super(`${receiptConfigurationFindings[reason].code}: ${receiptConfigurationFindings[reason].reason}`);
    this.code = receiptConfigurationFindings[reason].code;
  }
}
/** Known early receipt-duty/currentness refusals must not become an unlabelled
 * generic error. None supplies a formatting-only retry or positive evidence. */
export class CoverageReceiptDutyError extends Error {
  constructor(readonly reason: 'readback_unestablished' | 'setup_unestablished' | 'evidence_stale') {
    super(reason === 'evidence_stale' ? 'OBLIGATION_EVIDENCE_STALE: The saved obligation no longer matches current source and phase evidence.'
      : reason === 'readback_unestablished' ? 'OBLIGATION_READBACK_UNESTABLISHED: Independent source readback needs its exact unverified after-execution contract.'
      : 'OBLIGATION_SETUP_UNESTABLISHED: Execution setup can remain pending only for already compiled, supported direct SQL effects and a separate later writer/consent/worker review. Do not defer missing effects, business decisions, eligibility, privacy or approval limits; setup remains unverified.');
  }
}
export class CoverageReceiptReadContextError extends Error {
  constructor() { super('COVERAGE_RECEIPT_REFERENCE_OVERBROAD: The receipt guarantee overview is not evidence for the separate Read-exclusion claim.'); }
}
export type CoverageFinding = {
  code: string; component: string; identity: string; component_identity: string; passage_identity?: string; reason: string; repair: string; structural: boolean;
  current_evidence?: CoverageCurrentDescriptionError['evidence'];
  source_digest?: string; missing_ranges?: Array<{ start: number; end: number }>; omitted_range_count?: number;
};
export type CoverageFeedback = {
  context: string; findings: CoverageFinding[]; limited: boolean;
  unevaluated: string[]; complete_validation: false;
};
// Host-only evidence of completed checks in this traversal, never provider input
// or a durable success flag. Restart requires a separately authorized episode.
// Opaque local identity of the referenced component, including rejected paths.
// Never serialize a hash/value of undisclosed submitted data into feedback.
const findingSubjects = new WeakMap<CoverageFinding, string>();
export function recordCoverageFindingSubject(finding: CoverageFinding, subject: unknown): void {
  findingSubjects.set(finding, canonicalJsonDigest(subject));
}
const checkedPassages = new WeakMap<CoverageFeedback, Map<string,string>>();
export function recordCheckedCoveragePassage(feedback: CoverageFeedback, component: string, identity: string): void {
  const checked=checkedPassages.get(feedback)??new Map<string,string>(); checked.set(component,identity); checkedPassages.set(feedback,checked);
}
export const MAX_COVERAGE_FINDINGS = 8;
export const MAX_COVERAGE_FEEDBACK_BYTES = 8_192;
export const MAX_COVERAGE_SUBMISSIONS = 3;

export function coverageFinding(error: unknown, component: string, identityBasis: unknown): CoverageFinding {
  if (error instanceof CoverageComponentError) component = error.component;
  const cause = error instanceof CoverageComponentError ? error.cause : error;
  if (cause instanceof CoverageReceiptConfigurationError) return {
    ...receiptConfigurationFindings[cause.reason], component, component_identity: canonicalJsonDigest(identityBasis),
    identity: canonicalJsonDigest({ component: identityBasis, code: cause.code, reason: cause.reason }),
  };
  if (cause instanceof CoverageReceiptDutyError) {
    const descriptions = {
      readback_unestablished: {code: 'OBLIGATION_READBACK_UNESTABLISHED', reason: 'The submitted readback duty lacks its exact applicable unverified after-execution contract.'},
      setup_unestablished: {code: 'OBLIGATION_SETUP_UNESTABLISHED', reason: 'Supported execution setup and its exact current unverified phase are not established.'},
      evidence_stale: {code: 'OBLIGATION_EVIDENCE_STALE', reason: 'The saved obligation no longer matches its exact current source and phase evidence.'},
    } satisfies Record<CoverageReceiptDutyError['reason'], {code:string;reason:string}>;
    const finding = descriptions[cause.reason];
    return {...finding, component, component_identity: canonicalJsonDigest(identityBasis),
      identity: canonicalJsonDigest({component: identityBasis, code:finding.code}), structural:false,
      repair: 'Keep the requirement unresolved and revalidate its actual source, component and current phase evidence. A selected mode or compiled capability is not deployment verification, a performed receipt or independent readback. Do not invent an observation, assign away a business requirement or request another favorable opinion.'};
  }
  if (cause instanceof CoverageReceiptReadExclusionError) return {
    code: cause.code, component, component_identity: canonicalJsonDigest(identityBasis),
    identity: canonicalJsonDigest({component: identityBasis, code: cause.code}),
    structural: cause.reason === 'current_proof_mixed_component',
    reason: cause.reason === 'current_proof_mixed_component'
      ? 'The current host proof establishes only exclusion of configured receipt destinations from this selected Read. Its exact root is mixed with recognized effect/configuration roots; the submitted claim remains invalid.'
      : 'The required current exclusion proof is unavailable or the mixed claim is outside the supported isolation boundary. No exclusion or repairable representation is established.',
    repair: cause.reason === 'current_proof_mixed_component'
      ? 'Return the COMPLETE REPLACEMENT review. Isolate the receipt Read-exclusion claim with only /runner_evidence/runtime_contract/receipt_read_exclusion in draft_paths and no unrelated checks or duties. Preserve its source range. Give the effect and selected receipt configuration their own separately supported claims, retaining every condition, privacy requirement and obligation. This narrow proof establishes neither provisioning, execution permission, a performed receipt, independent readback nor privacy of other data/interfaces. Do not invent observations or erase applicable history; use only evidence actually supplied for each claim. Do not change policy, selectors, configuration or owner decisions.'
      : 'Keep the unsupported requirement unresolved and revalidate its actual evidence. Do not infer exclusion from missing names, substitute a nearby receipt overview or request another opinion to invent proof. The complete report still requires independent support for every residual claim.',
  };
  if (cause instanceof CoverageReceiptReadContextError) return {
    code: 'COVERAGE_RECEIPT_REFERENCE_OVERBROAD', component, component_identity: canonicalJsonDigest(identityBasis),
    identity: canonicalJsonDigest({component: identityBasis, code: 'COVERAGE_RECEIPT_REFERENCE_OVERBROAD'}), structural: true,
    reason: 'This receipt overview/Read combination mixes evidence kinds. The current host context has a separate narrow configured-destination Read-exclusion record; it supplies no observation proof.',
    repair: 'If the claim is exclusion of configured receipt storage from the selected Read, isolate it using only /runner_evidence/runtime_contract/receipt_read_exclusion and its exact excluded value. Keep the source range and every other claim. This evidence proves neither provisioning, database-wide privacy, execution, a performed receipt nor independent readback. Keep those duties separate and unverified where applicable. A broader privacy or observation claim remains unresolved. Return the COMPLETE REPLACEMENT review and account for the entire source inventory; do not change policy or configuration.',
  };
  if (cause instanceof CoverageSourceLinesError) return {
    code: 'COVERAGE_SOURCE_LINES_MISSING', component,
    component_identity: canonicalJsonDigest({source: cause.source_digest, ranges: cause.missing_ranges}),
    identity: canonicalJsonDigest({code: 'COVERAGE_SOURCE_LINES_MISSING', source: cause.source_digest, ranges: cause.missing_ranges}),
    structural: true, source_digest: cause.source_digest, missing_ranges: cause.missing_ranges, omitted_range_count: cause.omitted_range_count,
    reason: 'The listed nonblank source ranges have no submitted disposition. This is a structural omission, not a conclusion about their meaning.',
    repair: 'Read each missing range in the exact consented source inventory and give it its own supported disposition in the COMPLETE REPLACEMENT report. Preserve every other requirement and unresolved claim. Headings and definitions are not automatically background; overlapping ranges may represent separate claims. Nothing from a rejected response is accepted or silently retained. Check the entire inventory when omitted_range_count is nonzero.',
  };
  if (cause instanceof CoverageReceiptObservationError) return {
    code: cause.code, component, component_identity: canonicalJsonDigest(identityBasis),
    identity: canonicalJsonDigest({component: identityBasis, code: cause.code}), structural: cause.structural,
    reason: 'A supported execution capability or reviewed receipt selection does not establish provisioned execution, an observed receipt or independent readback.',
    repair: cause.structural
      ? 'Separate the compiled capability claim from receipt setup and observation duties. /runner_evidence/runtime_contract/receipt_configuration reports its actual current configuration and separately candidate-bound reviewed_intent; neither establishes a performed receipt. /runner_evidence/runtime_contract/receipts describes the distinct guarantee; /runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup keeps applicable setup pending. Resubmit a complete review with the isolated receipt setup duty needs_decision/deployment/missing_configuration and unperformed work unverified. Preserve applicable historical achievements without attributing them to this edited revision. Keep independent readback separately pending. Do not change source policy, program, receipt mode or any other requirement. No observation claim was accepted.'
      : 'Keep the observation unestablished and the review unresolved. Required meaning, applicable configuration, deployment permission and performed receipts/readback need their own evidence; another opinion cannot supply it. Do not change the receipt guarantee or mark unperformed work verified.',
  };
  if (cause instanceof CoverageCurrentDescriptionError) return {
    code: cause.code, component, component_identity: canonicalJsonDigest(identityBasis),
    identity: canonicalJsonDigest({component: identityBasis, code: cause.code}), structural: true,
    current_evidence: cause.evidence,
    reason: 'The submitted current_capability misdescribes the exact configuration supplied in this review context; this does not establish that configuration changed.',
    repair: 'Resubmit this counter with current_capability equal to current_evidence.actual. This is an observation, not an owner decision. Do not infer required_capability from it: establish required meaning independently from its authentic source/support, and keep a real disagreement unresolved. Do not change selectors, invent singleton equivalence, omit a counter or drop other claims. Return the complete replacement review.',
  };
  const message = error instanceof Error ? error.message : '';
  let code = 'COVERAGE_VALIDATION_INCOMPLETE', structural = false;
  let reason = 'Complete coverage validation did not finish; no partial review was accepted.';
  let repair = 'Keep the saved review pending. Use the current attached-rules review to resolve its requirement or revalidate its evidence; no business edit was inferred.';
  if (message.startsWith('COUNTING_SUPPORT_MISMATCH:')) {
    code = 'COUNTING_SUPPORT_MISMATCH'; structural = true;
    reason = 'The counter-specific citation has no applicable exact support association; a paragraph citation is separate.';
    repair = 'Correct only this counter citation using its current scoped support. Cite an accepted operator message only when it actually supports this exact comparison. If the prepared source or typed host-recorded counting review independently establishes required meaning without a linked message, omit the OPTIONAL counter operator_message_id while retaining the comparison and that authentic positive basis. Omission or current/required equality alone supplies no proof. Keep paragraph support separate, preserve every source requirement and other claim, and do not change selectors or invent or repeat an owner decision. Return the complete replacement review.';
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
  } else if (message.startsWith('RECEIPT_READ_EXCLUSION_UNESTABLISHED:')) {
    code = 'RECEIPT_READ_EXCLUSION_UNESTABLISHED';
    reason = 'The exact isolated receipt-destination exclusion is absent, stale, false or combined with claims outside its scope.';
    repair = 'Keep this privacy requirement unresolved. The narrow selected-Read proof cannot establish unrelated fields, conditions, provisioning, execution or observations. Revalidate its actual configuration/Read binding; do not infer privacy from an absent name or select a nearby receipt overview.';
  } else if (message.startsWith('COVERAGE_DUPLICATE_COMPONENT:')) {
    code = 'COVERAGE_DUPLICATE_COMPONENT'; structural = true;
    reason = 'The complete response repeats an identical validated component. Distinct claims may share a source range; identical records are not distinct claims.';
    repair = 'Return one copy of this component in the COMPLETE REPLACEMENT, preserving all distinct claims, unresolved concerns and full source coverage. Do not combine contrary dispositions or replace the source.';
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
  if (!checked || old.some(f => !f.passage_identity || checked.get(f.component === '/passages' ? '/passages' : f.component.match(/^\/passages\/\d+/u)?.[0] ?? "/") !== f.passage_identity)) return false;
  return prior.every(r => r.context === next.context && !r.limited && r.findings.every(f => f.structural))
    && next.findings.every(f => !old.some(p => (findingSubjects.has(f) && findingSubjects.get(p) === findingSubjects.get(f)) || p.identity === f.identity || p.component_identity === f.component_identity || p.component === f.component
      || p.component.split('/counter_requirements/')[0] === f.component.split('/counter_requirements/')[0]))
    && old.every(p => !next.unevaluated.some(c => p.component.startsWith(c) || c.startsWith(p.component)));
}
