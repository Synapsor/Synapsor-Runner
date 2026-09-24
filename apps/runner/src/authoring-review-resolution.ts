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
type Availability = 'available' | 'waiting_for_prerequisite' | 'unsupported' | 'terminal';
type Actor = 'operator' | 'authoring_model' | 'none';
export type ReviewResolutionOption = {
  operation: ReviewResolutionOperation; actor: Actor; availability: Availability;
  handler: keyof typeof REVIEW_RESOLUTION_HANDLERS | null;
  cost: 'local' | 'provider_episode' | 'none'; consent: 'existing_local' | 'bounded_episode' | 'none';
};
export type ReviewResolutionPlan = {
  context: string | null; subject: string | null;
  findings: Array<{ code: string; typed_reason: ReviewResolutionReason | ReviewPrerequisiteReason | 'unclassified'; component: string }>;
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
