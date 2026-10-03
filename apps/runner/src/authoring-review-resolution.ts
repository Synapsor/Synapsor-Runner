import { randomUUID } from 'node:crypto';
import type { CoverageFeedback, CoverageFinding, ReviewResolutionReason } from './authoring-coverage-feedback.js';

/** A route describes an existing operation; it is never an authority token.
 * The receiving handler still checks actor, exact target, context and consent. */
export const REVIEW_RESOLUTION_HANDLERS = {
  source_transaction_review: 'localSourceTransactionReview',
  source_transaction_scope_review: 'localSourceTransactionScopeReview',
  scoped_disclosure_review: 'localScopedDisclosureReview',
  counting_review: 'reviewUnestablishedCounting',
  scoped_correction: 'createCoverageRepairScope',
  reinspection: 'inspectPolicyReviewSource',
} as const;
export type ReviewResolutionOperation = keyof typeof REVIEW_RESOLUTION_HANDLERS | 'leave_pending' | 'diagnostic_stop';
export type ReviewPrerequisiteReason =
  | 'source_transaction_review' | 'source_transaction_scope' | 'scoped_disclosure'
  | 'counting_review' | 'source_consent' | 'currentness' | 'provider_unavailable' | 'episode_declined'
  | 'episode_exhausted' | 'history_full';
export type AuthoringRefusalReason =
  | 'authoring_pending' | 'authoring_currentness' | 'authoring_integrity'
  | 'authoring_persistence' | 'authoring_exhausted' | 'authoring_prerequisite';
type Availability = 'available' | 'waiting_for_prerequisite' | 'unsupported' | 'terminal';
type Actor = 'operator' | 'authoring_model' | 'none';
export type ReviewResolutionOption = {
  operation: ReviewResolutionOperation; actor: Actor; availability: Availability;
  handler: keyof typeof REVIEW_RESOLUTION_HANDLERS | null;
  cost: 'local' | 'provider_episode' | 'none'; consent: 'existing_local' | 'bounded_episode' | 'none';
};
export type ReviewResolutionPlan = {
  context: string | null; subject: string | null;
  findings: Array<{ code: string; typed_reason: ReviewResolutionReason | ReviewPrerequisiteReason | AuthoringRefusalReason | 'unclassified'; component: string }>;
  unevaluated: string[]; complete_validation: false;
  options: ReviewResolutionOption[]; recommended: ReviewResolutionOperation | null;
  retained_work: 'saved_pending' | 'not_established'; result: 'pending' | 'stopped';
};
type Policy = { operation: ReviewResolutionOperation; actor: Actor; availability: Availability;
  cost: ReviewResolutionOption['cost']; consent: ReviewResolutionOption['consent'] };
const model: Policy = {operation:'scoped_correction',actor:'authoring_model',availability:'available',
  cost:'provider_episode',consent:'bounded_episode'};
const reinspection: Policy = {operation:'reinspection',actor:'operator',availability:'available',cost:'local',consent:'existing_local'};
const terminal: Policy = {operation:'diagnostic_stop',actor:'none',availability:'terminal',cost:'none',consent:'none'};
const scope: Policy = {operation:'source_transaction_scope_review',actor:'operator',availability:'available',cost:'local',consent:'existing_local'};
const reasonPolicy = {
  'retained_duty.applicability':reinspection,
  'scope.unknown':scope, 'scope.excluded':model, 'scope.capability':terminal,
  'counter_support.unknown_message':model, 'counter_support.quote_disagrees':model,
  'counter_support.unrecorded_quote':model, 'counter_support.interpretation_mismatch':model,
  'counter.current_description':model,
  'coupling.representation':model, 'coupling.unavailable':terminal,
  'scoped_correction.unavailable':terminal,
  'receipt_duty.readback_unestablished':terminal, 'receipt_duty.setup_unestablished':terminal,
  'receipt_duty.evidence_stale':reinspection,
  'receipt_exclusion.proof_unavailable':terminal, 'receipt_exclusion.component_not_isolatable':terminal,
  'receipt_exclusion.current_proof_mixed_component':model,
  'receipt_configuration.source_requirement_unestablished':terminal,
  'receipt_configuration.selection_unavailable':reinspection,
  'receipt_configuration.mode_mismatch':terminal,
  'receipt_configuration.component_not_isolatable':terminal,
  'receipt_configuration.responsibility_mismatch':terminal,
  'receipt_configuration.reference_overbroad':terminal,
  'receipt_configuration.current_selection_mixed_component':model,
  'receipt_observation.structural':model, 'receipt_observation.unavailable':terminal,
  'source_lines.missing':model, 'receipt_read_context.overbroad':model,
} satisfies Record<ReviewResolutionReason,Policy>;
const prerequisitePolicy = {
  source_transaction_review:{operation:'source_transaction_review',actor:'operator',availability:'available',cost:'local',consent:'existing_local'},
  source_transaction_scope:scope,
  scoped_disclosure:{operation:'scoped_disclosure_review',actor:'operator',availability:'available',cost:'local',consent:'existing_local'},
  counting_review:{operation:'counting_review',actor:'operator',availability:'available',cost:'local',consent:'existing_local'},
  source_consent:{operation:'diagnostic_stop',actor:'operator',availability:'waiting_for_prerequisite',cost:'none',consent:'none'},
  currentness:reinspection,
  provider_unavailable:terminal,
  episode_declined:{operation:'diagnostic_stop',actor:'operator',availability:'terminal',cost:'none',consent:'none'},
  episode_exhausted:terminal,
  history_full:terminal,
} satisfies Record<ReviewPrerequisiteReason,Policy>;
/** Legacy parser diagnostics retained by the scoped producer. This is an
 * explicit migration boundary, not permission for a new structural code to
 * inherit correction eligibility from its `structural` boolean alone. */
const legacyStructuralCodes=new Set([
  'COUNTING_SUPPORT_MISMATCH','COVERAGE_REFERENCE_MISSING','SOURCE_COUNTER_COMPONENT_MIXED',
  'SOURCE_COUNTER_CLASSIFICATION_REQUIRED','COVERAGE_DEPLOYMENT_COMPONENT_MIXED',
  'COUNTING_REFERENCE_OVERBROAD','COUNTING_COMPARISON_INVALID','COVERAGE_STRUCTURE_INVALID',
  'COVERAGE_SOURCE_LINES_MISSING','COVERAGE_DUPLICATE_COMPONENT','COVERAGE_EVIDENCE_VALUE_MISMATCH',
  'COVERAGE_COUNTER_STRUCTURE_INVALID','COVERAGE_OBLIGATION_STRUCTURE_INVALID',
]);
const option=(policy:Policy):ReviewResolutionOption=>({ ...policy,
  handler:policy.operation==='leave_pending'||policy.operation==='diagnostic_stop'?null:policy.operation });
const pending:ReviewResolutionOption={operation:'leave_pending',actor:'operator',availability:'available',
  handler:null,cost:'local',consent:'none'};

const authoringRefusal = (typed_reason: AuthoringRefusalReason, next_action: string) => ({ typed_reason, next_action });
const assistancePending = authoringRefusal('authoring_pending',
  'Reopen the saved job and resume its exact pending question or local relationship review. Answer or explicitly decline only that current question; no replacement generation or authority was inferred.');
const checkpointInvalid = authoringRefusal('authoring_integrity',
  'Inspect the preserved saved job and integrity diagnostics. No supported operation can force-accept a changed checkpoint, repair its digest, import an old reply or infer a completed generation.');
const checkpointCurrentness = authoringRefusal('authoring_currentness',
  'Reopen the current saved job and exact Source, Read and Action context. Stop this stale continuation; rescan or a model change does not retarget a retained Read assistance checkpoint.');
const checkpointNotSaved = authoringRefusal('authoring_persistence',
  'Inspect actual saved state and local storage, then reopen the last acknowledged job before explicitly continuing. An ambiguous save remains unknown; do not repeat an Action mutation, acknowledge old output or refresh its repair budget.');
const exhausted = authoringRefusal('authoring_exhausted',
  'Preserve the complete saved parent and agenda and inspect failure details. Retry, another model or restart does not renew this finite assistance or Source repair budget. An existing external disabled proposal may use normal structured draft validation; no new correction episode was granted.');
const sourceAssessmentPending = authoringRefusal('authoring_prerequisite',
  'Inspect the current saved Source and choose Review attached rules and unresolved decisions, or boundary review --review-rules in the operator terminal. Retain the nomination; incomplete assessment establishes neither an owner answer nor permission for model repair.');
const nominatedCorrectionStopped = authoringRefusal('authoring_integrity',
  'Inspect the retained original parent and exact current Source nomination. Preserve every component outside its editable scope; an existing external disabled proposal must pass normal structured draft validation. No additional repair episode or acceptance was granted.');
const exchangeInvalid = authoringRefusal('authoring_integrity',
  'Preserve the original envelope and all parts. Export a fresh coherent draft from the current original disabled job into a new local output path, or correct the external input and validate it with --draft FILE --dry-run. Foreign, mixed or reordered records and imported approvals cannot be accepted by repairing a digest.');
const exchangeLimit = authoringRefusal('authoring_exhausted',
  'Preserve the complete original and inspect the exact record, count, part or total limit. Public export already creates bounded parts. Normal changed-Action work units remain bounded; do not raise limits, truncate Source or split an indivisible record to make this declaration pass.');
const exchangePath = authoringRefusal('authoring_prerequisite',
  'Use an unused normal project-local export path or a private single-link input file through the same public command. Do not overwrite existing output, follow a symlink or bypass Runner authority directories.');
const successorInvalid = authoringRefusal('authoring_integrity',
  'Inspect the complete preserved successor inventory, exact page range and independently initialized disabled destination. Use explicit --action-page N and --dry-run only after the reported condition is resolved; no corrupt agenda, changed destination or historical authority may be replaced or accepted automatically.');
const fencedGeneration = authoringRefusal('authoring_integrity',
  'Inspect saved generation and job records without replay. When supported, export only the coherent declarative disabled draft to a new local file for offline inspection. An unknown outcome or missing past consent establishes no viable Resume or recovery permission; do not import old replies, force acknowledgement or repeat the generation.');

/** Finite durable refusals only. Ordinary compiler/grammar diagnostics keep
 * their existing correction path. These entries declare no executable repair,
 * resume, rebind or recovery handler and adopt no unregistered Source meaning. */
export const AUTHORING_REFUSAL_INVENTORY = {
  POLICY_COUNTING_HISTORY_FULL: authoringRefusal('authoring_exhausted',
    'Preserve the complete Source and attributed counting history for local inspection. The existing history limit remains controlling; no supported continuation may prune history, split this confirmation set, infer missing meaning or renew model attempts.'),
  POLICY_COUNTING_HISTORY_INVALID: authoringRefusal('authoring_integrity',
    'Preserve and inspect the original saved counting records. Invalid records are not current interpretations and cannot be dropped, repaired by a new model answer or silently replaced through Resume.'),
  POLICY_COUNTING_HISTORY_CHANGED: authoringRefusal('authoring_integrity',
    'Reopen the current saved Source and inspect the proposed history change. Existing attributed decisions must remain ordered and unchanged; no partial save or silent replacement is permitted.'),
  ASK_GENERATION_OUTCOME_UNKNOWN: fencedGeneration,
  ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION: fencedGeneration,
  ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE: fencedGeneration,
  ASK_GENERATION_RECOVERY_EXHAUSTED: fencedGeneration,
  ASK_GENERATION_HISTORY_LIMIT: fencedGeneration,
  ASK_GENERATION_CONTEXT_CHANGED: fencedGeneration,
  READ_WORKLOAD_AUTHORING_PAUSED: assistancePending,
  READ_RELATIONSHIP_REVIEW_PENDING: assistancePending,
  AUTHORING_OWNER_QUESTION_PENDING: assistancePending,
  READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: checkpointInvalid,
  READ_BOUNDARY_REVISION_CHECKPOINT_INVALID: checkpointInvalid,
  READ_BOUNDARY_REVISION_CHECKPOINT_STALE: checkpointCurrentness,
  READ_BOUNDARY_REVISION_RESULT_NOT_SAVED: authoringRefusal('authoring_integrity',
    'Inspect the exact saved Read request, current disabled Read/Action records and consumed response evidence. A parsed response is not a confirmed save. Preserve the result; this stopped producer cannot regenerate or replay it through Resume or a generic retry.'),
  READ_BOUNDARY_REVISION_SAVED_REVIEW_PENDING: authoringRefusal('authoring_prerequisite',
    'The guarded disabled Read save was recorded; its following review is unfinished. Inspect current Read/Action identities through local boundary review --access or --map --all --details. This read-only disposition grants no replay, automatic companion recovery, activation or complete BUSINESS review.'),
  READ_BOUNDARY_REVISION_STAGED_REVALIDATION_REQUIRED: authoringRefusal('authoring_prerequisite',
    'Preserve the pending Read question and inspected selections. The ordinary host must recheck the exact current source/catalog before continuation; stored metadata is not fresh consent or authority.'),
  READ_BOUNDARY_REVISION_CLARIFICATION_REQUIRED: assistancePending,
  READ_BOUNDARY_REVISION_CLARIFICATION_DECLINED: authoringRefusal('authoring_prerequisite',
    'The exact Read clarification was explicitly declined. Keep its attributable answer and unchanged draft; a decline is not EOF or permission to generate another answer.'),
  READ_BOUNDARY_REVISION_NOT_SUBMITTED: exhausted,
  READ_BOUNDARY_REVISION_CATALOG_TOO_LARGE: authoringRefusal('authoring_exhausted',
    'Preserve the complete disabled Read and inspect the catalog size limit. Use the existing local field review where supported; do not truncate metadata or expand model disclosure to admit a new generation.'),
  BOUNDARY_AUTHORING_RESUME_INVALID: checkpointInvalid,
  ACTION_AUTHORING_CHECKPOINT_INVALID: checkpointInvalid,
  READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE: checkpointCurrentness,
  READ_RELATIONSHIP_CANDIDATE_STALE: checkpointCurrentness,
  READ_RELATIONSHIP_PROOF_STALE: checkpointCurrentness,
  AUTHORING_OWNER_QUESTION_CONTEXT_CHANGED: checkpointCurrentness,
  AUTHORING_RECOVERY_CONTEXT_CHANGED: checkpointCurrentness,
  ACTION_WORK_UNIT_SOURCE_CONTEXT_CHANGED: checkpointCurrentness,
  ACTION_AUTHORING_CHECKPOINT_STALE: checkpointCurrentness,
  ACTION_AUTHORING_QUESTION_STALE: authoringRefusal('authoring_currentness',
    'Reopening preserves this checkpoint; it does not approve changed applicability. Review the current job and context. For an untouched program with no prepared or saved Action, Draft a change may offer a fresh exact agenda for review; it does not resume or rebind the stale question. Prepared or partially saved work requires applicable revision review. Preserve pending answers and history; no authority or additional generation was granted.'),
  BOUNDARY_AUTHORING_RESUME_CHANGED: checkpointCurrentness,
  READ_RELATIONSHIP_REVIEW_MISMATCH: authoringRefusal('authoring_integrity',
    'Inspect the requested Read root and exact reviewed path. A review for another root cannot answer this saved requirement; no link, omission or relationship consent was inferred.'),
  READ_WORKLOAD_CLARIFICATION_DECISION_INVALID: checkpointInvalid,
  READ_WORKLOAD_VALUE_CONTEXT_INVALID: checkpointInvalid,
  READ_RELATIONSHIP_SAVE_UNCONFIRMED: checkpointNotSaved,
  BOUNDARY_AUTHORING_RESUME_NOT_SAVED: checkpointNotSaved,
  ACTION_CHECKPOINT_NOT_SAVED: checkpointNotSaved,
  ACTION_SOURCE_REPAIR_NOT_SAVED: checkpointNotSaved,
  ACTION_SOURCE_REPAIR_EXHAUSTED: exhausted,
  READ_RELATIONSHIP_REVIEW_LIMIT: exhausted,
  READ_WORKLOAD_ASSISTANCE_REQUEST_REPEATED: exhausted,
  READ_WORKLOAD_MECHANICAL_QUESTION_REPEATED: exhausted,
  ACTION_RULE_MODEL_DRAFT_INCOMPLETE: authoringRefusal('authoring_exhausted',
    'Inspect the saved structured components and model failure details. Use the existing structured draft/export path for an exact external disabled proposal when available. This incomplete result grants no new model attempt, compiler exception or authority.'),
  READ_WORKLOAD_CLARIFICATION_DECLINED: authoringRefusal('authoring_prerequisite',
    'Keep the exact declined clarification and saved job pending. Inspect its business meaning before an explicit later continuation; a decline is not an unanswered question and authorizes no automatic replacement generation.'),
  ACTION_WORK_UNIT_CONTEXT_LIMIT: authoringRefusal('authoring_exhausted',
    'Preserve the complete draft and Source and inspect the bounded work-unit context. Review a smaller exact nomination through existing review operations when available; no Source text was truncated and no smaller interpretation or fresh repair budget was inferred.'),
  ACTION_WORK_UNIT_SOURCE_MEANING_PENDING: sourceAssessmentPending,
  ACTION_WORK_UNIT_SOURCE_ASSESSMENT_INCOMPLETE: sourceAssessmentPending,
  ACTION_WORK_UNIT_REPRESENTATION_MISMATCH: nominatedCorrectionStopped,
  ACTION_WORK_UNIT_CORRECTION_OUTSIDE_SCOPE: nominatedCorrectionStopped,
  AUTHORING_RECOVERY_MODEL_UNAVAILABLE: authoringRefusal('authoring_prerequisite',
    'Inspect the exact saved model and recovery permission. An unavailable model cannot consume or replace this pending generation; no different model or additional recovery attempt was selected.'),
  STRUCTURED_DRAFT_BUNDLE_MANIFEST_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_BUNDLE_MEMBERSHIP_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_BUNDLE_INTEGRITY_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_BUNDLE_PART_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_BUNDLE_RECORD_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_BUNDLE_SHAPE_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_SOURCE_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_JSON_INVALID: exchangeInvalid,
  STRUCTURED_DRAFT_BUNDLE_MANIFEST_LIMIT: exchangeLimit,
  STRUCTURED_DRAFT_BUNDLE_PART_LIMIT: exchangeLimit,
  STRUCTURED_DRAFT_BUNDLE_RECORD_LIMIT: exchangeLimit,
  STRUCTURED_DRAFT_BUNDLE_TOTAL_LIMIT: exchangeLimit,
  STRUCTURED_DRAFT_TOO_LARGE: exchangeLimit,
  STRUCTURED_DRAFT_WORK_UNIT_TOO_LARGE: exchangeLimit,
  STRUCTURED_DRAFT_PROGRAM_EXPORT_LIMIT: exchangeLimit,
  STRUCTURED_DRAFT_PATH_INVALID: exchangePath,
  STRUCTURED_DRAFT_OUTPUT_EXISTS: exchangePath,
  STRUCTURED_DRAFT_INPUT_UNAVAILABLE: authoringRefusal('authoring_prerequisite',
    'Check that the exact local input file exists and is readable through the supported private project-local path. No partial draft or unavailable file was accepted.'),
  STRUCTURED_DRAFT_PRIVATE_MATERIAL_BLOCKED: authoringRefusal('authoring_integrity',
    'Remove credentials or private keys from the external declarative proposal and validate again. Preserve the original job and all normal private-boundary reviews; do not auto-redact canonical Source or import rejected material.'),
  STRUCTURED_DRAFT_STALE: authoringRefusal('authoring_currentness',
    'Inspect or rescan the current disabled setup. Export a new structured draft for its exact current review bundle and validate that input. Historical bindings and old approvals are not current proof.'),
  STRUCTURED_DRAFT_SUCCESSOR_CONFIRMATION_REQUIRED: authoringRefusal('authoring_prerequisite',
    'Review the exact selected page with --draft FILE --successor --action-page N --dry-run. Saving that disabled proposal requires explicit --yes through the same public command; it is not provider consent or activation.'),
  STRUCTURED_DRAFT_SUCCESSOR_INVALID: successorInvalid,
  STRUCTURED_DRAFT_REPOSITORY_REQUIRED: authoringRefusal('authoring_prerequisite',
    'Inspect the current disabled destination and its governed project binding. If initialization is needed, use the normal start --from-env path for an independent disabled setup before validating a selected proposal; do not reuse historical authority or unresolved job storage.'),
} as const;
export type RegisteredAuthoringRefusalCode = keyof typeof AUTHORING_REFUSAL_INVENTORY;

/** Callers check this before generic model fallback. Exact allowlisting never
 * upgrades an unregistered prefix or English diagnostic into repair authority. */
export function isRegisteredAuthoringRefusalCode(code: unknown): code is RegisteredAuthoringRefusalCode {
  return typeof code === 'string' && Object.hasOwn(AUTHORING_REFUSAL_INVENTORY, code);
}
export function planAuthoringRefusal(code: unknown, input: {
  subject?: string | null; context?: string | null; retainedWork?: ReviewResolutionPlan['retained_work'];
} = {}): { code: RegisteredAuthoringRefusalCode; plan: ReviewResolutionPlan; next_action: string } | undefined {
  if (!isRegisteredAuthoringRefusalCode(code)) return undefined;
  const record = AUTHORING_REFUSAL_INVENTORY[code];
  const isPending = record.typed_reason === 'authoring_pending';
  const policy: Policy = isPending ? pending : record.typed_reason === 'authoring_prerequisite'
    ? { operation:'diagnostic_stop', actor:'operator', availability:'waiting_for_prerequisite', cost:'none', consent:'none' } : terminal;
  return { code, next_action: record.next_action, plan: {
    context: input.context ?? null, subject: input.subject ?? null,
    findings: [{ code, typed_reason: record.typed_reason, component:'/' }],
    unevaluated:['current-context validation, checkpoint persistence and separate authority reviews'], complete_validation:false,
    options: unique([option(policy), pending]), recommended:isPending ? 'leave_pending' : null,
    retained_work:input.retainedWork ?? 'not_established', result:isPending ? 'pending' : 'stopped',
  } };
}
export class UnregisteredReviewFindingError extends Error {
  constructor() {super('REVIEW_RESOLUTION_UNREGISTERED: A first-party review reason has no declared route; work remains pending.');}
}
/** This check is invoked at the real feedback boundary, not just by a snapshot
 * test. A newly typed producer cannot silently inherit a generic retry. */
export function assertRegisteredReviewFinding(finding:CoverageFinding):void {
  if(finding.typed_reason !== undefined && !Object.hasOwn(reasonPolicy,finding.typed_reason))
    throw new UnregisteredReviewFindingError();
  if(finding.typed_reason===undefined&&finding.structural&&!legacyStructuralCodes.has(finding.code))
    throw new UnregisteredReviewFindingError();
}
const unique=(options:ReviewResolutionOption[])=>options.filter((entry,index)=>
  options.findIndex(prior=>prior.operation===entry.operation)===index);
export function planCoverageResolution(feedback:CoverageFeedback, retainedWork:'saved_pending'|'not_established'='saved_pending'):ReviewResolutionPlan {
  for(const finding of feedback.findings)assertRegisteredReviewFinding(finding);
  const findings=feedback.findings.map(f=>({code:f.code,typed_reason:f.typed_reason??'unclassified' as const,component:f.component}));
  const policies=feedback.findings.map(f=>f.typed_reason?reasonPolicy[f.typed_reason]
    :f.structural&&legacyStructuralCodes.has(f.code)?model:terminal);
  const local=policies.filter(p=>p.operation!=='scoped_correction'&&p.availability==='available');
  const allCorrectable=!feedback.limited&&feedback.findings.length>0&&feedback.findings.every(f=>f.structural)
    && policies.every(p=>p.operation==='scoped_correction');
  const modelOptions=policies.filter(p=>p.operation==='scoped_correction').map(p=>option({ ...p,
    availability:allCorrectable?'available':'waiting_for_prerequisite' as const }));
  const options=unique([...local.map(option),...modelOptions,...policies.filter(p=>p.availability==='terminal'||p.availability==='unsupported').map(option),pending]);
  const recommended=local[0]?.operation??(allCorrectable?'scoped_correction':null);
  return {context:feedback.context,subject:null,findings,unevaluated:[...feedback.unevaluated],
    complete_validation:false,options,recommended,retained_work:retainedWork,result:recommended?'pending':'stopped'};
}
export function planReviewPrerequisite(reason:ReviewPrerequisiteReason,subject:string|null,context:string|null):ReviewResolutionPlan {
  const policy=prerequisitePolicy[reason];
  return {context,subject,findings:[{code:`REVIEW_${reason.toUpperCase()}`,typed_reason:reason,component:'/' }],
    unevaluated:['provider review, complete coverage and persistence'],complete_validation:false,
    options:unique([option(policy),pending]),recommended:policy.availability==='available'?policy.operation:null,
    retained_work:'saved_pending',result:policy.availability==='available'?'pending':'stopped'};
}
export class ReviewResolutionError extends Error {
  constructor(readonly code:string,readonly plan:ReviewResolutionPlan,message:string) {super(`${code}: ${message}`);}
  toJSON(){return {error_code:this.code,resolution:operatorReviewResolution(this.plan)};}
}
/** Rendering is deliberately less capable than the internal plan. The model
 * sees only its safe correction feedback; runtime clients see no local handler. */
export function operatorReviewResolution(plan:ReviewResolutionPlan){
  return {status:plan.result,subject:plan.subject,findings:plan.findings.map(f=>({code:f.code,component:f.component})),
    unevaluated:plan.unevaluated,complete_validation:false,recommended:plan.recommended,
    options:plan.options.filter(o=>o.actor==='operator').map(o=>({operation:o.operation,availability:o.availability,cost:o.cost})),
    retained_work:plan.retained_work};
}
export function modelReviewResolution(plan:ReviewResolutionPlan){
  return {status:plan.result,complete_validation:false,findings:plan.findings.filter(f=>
    plan.options.some(o=>o.operation==='scoped_correction'&&o.availability==='available')).map(f=>({code:f.code,component:f.component})),
    correction_available:plan.recommended==='scoped_correction'};
}
export function runtimeReviewResolution(plan:ReviewResolutionPlan){
  return {status:plan.result,complete_validation:false,review_pending:true};
}
export function unknownReviewResolution():ReviewResolutionError {
  const reference=randomUUID();
  return new ReviewResolutionError('REVIEW_DIAGNOSTIC_ONLY',{
    context:null,subject:null,findings:[{code:'REVIEW_DIAGNOSTIC_ONLY',typed_reason:'unclassified',component:'/'}],
    unevaluated:['review completion and persistence'],complete_validation:false,options:[pending],recommended:null,
    retained_work:'not_established',result:'stopped'},`Review could not be classified. Reference ${reference}; inspect the saved job before any new attempt.`);
}
