import { SOURCE_RECEIPT_CONTRACT, ATOMIC_EFFECT_TRANSACTION } from "./authoring-receipt-contract.js";
import { currentSourceTransactionReview, sourceTransactionMappings, sourceTransactionReviewNeeded } from './authoring-source-transaction-review.js';
import { currentSourceTransactionScopeReview, sourceTransactionScopeQuestions, SourceTransactionScopeError } from './authoring-source-transaction-scope.js';
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { currentReceiptRequirement } from './authoring-receipt-requirement.js';
import { isDeferredSourceCounterMaintenance, isDeferredSourceReadback, receiptSetupComponentOnly as receiptOnly, receiptConfigurationComponentOnly, type ReviewObligationAssessment, type PolicyPassage, type PolicyTextSnapshot, type ReceiptCouplingAssessment, type PolicySourceSession } from "./authoring-policy-source.js";
import { CoverageComponentError, CoverageReceiptObservationError, CoverageReceiptReadContextError, CoverageReceiptReadExclusionError, CoverageReceiptConfigurationError, type ReceiptConfigurationFindingReason } from "./authoring-coverage-feedback.js";
export { deferredReviewObligation } from "./authoring-policy-source.js";

export const RECEIPT_PATH = "/runner_evidence/runtime_contract/receipts";
const SETUP_PATH = "/runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup";
const READBACK_PATH = "/runner_evidence/runtime_contract/application_obligations/independent_source_readback";
const CONFIGURATION_PATH = "/runner_evidence/runtime_contract/receipt_configuration";
export const RECEIPT_READ_PATH = "/runner_evidence/runtime_contract/receipt_read_exclusion";
function at(draft: unknown, pointer: string): any {
  return pointer.slice(1).split("/").reduce<any>((value, key) => value?.[key.replace(/~1/gu, "/").replace(/~0/gu, "~")], draft);
}
function currentReceiptReadExclusion(draft: unknown): boolean {
  const proof = at(draft, RECEIPT_READ_PATH), read = at(draft, '/read'), configuration = at(draft, CONFIGURATION_PATH);
  return proof?.origin === 'HOST-CONFIGURATION-AND-READ' && proof.scope === 'selected_read_graph' && proof.excluded === true
    && configuration?.status === 'current' && proof.configuration_digest === configuration.digest
    && proof.selected_read_digest === canonicalJsonDigest(read) && proof.graph_digest === canonicalJsonDigest(read?.pack?.resources)
    && proof.generation_lock_fingerprint === read?.generation_lock_fingerprint
    && configuration.modes?.length > 0
    && configuration.modes.every((mode: any) => mode.source === read.source && mode.authority === 'source_db')
    && configuration.source_receipt_destinations?.length > 0
    && configuration.source_receipt_destinations.length === configuration.modes.length
    && configuration.source_receipt_destinations.every((destination: any) => destination.source === read.source
      && /^sha256:[a-f0-9]{64}$/u.test(destination.relation_digest ?? ''))
    && proof.destination_binding_digest === canonicalJsonDigest(configuration.source_receipt_destinations);
}
function isolatedReceiptReadFields(p: PolicyPassage): boolean {
  return p.responsibility === 'runner' && !p.field_checks?.length && !p.counter_requirements?.length
    && !p.application_obligations?.length && !p.deployment_prerequisite && !p.source_counter_obligation && !p.operator_override
    && !p.evidence_checks?.length;
}

/** A bounded correction subcase, not acceptance or a claim about prose meaning.
 * Only known prepared capability/configuration roots may accompany the current
 * exclusion proof. Their actual claims still undergo full replacement validation. */
function isolatableReceiptReadExclusion(p: PolicyPassage, draft: unknown): boolean {
  if (!isolatedReceiptReadFields(p) || p.issue_kind !== 'coverage_link'
    || p.draft_paths.length < 2 || !p.draft_paths.includes(RECEIPT_READ_PATH)
    || new Set(p.draft_paths).size !== p.draft_paths.length
    || !p.draft_paths.some(path => path !== RECEIPT_READ_PATH)) return false;
  const roots = (at(draft, '/actions') ?? []).flatMap((action: any) => {
    const root = `/runner_evidence/actions/${action.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}/effect`;
    const effect = at(draft, root);
    return action.effect?.writeback === 'supervised' && effect
      && effect.target_resource === action.effect.target_resource
      && effect.target_binding === action.effect.target_binding
      && effect.operation === action.effect.operation ? [root] : [];
  });
  return p.draft_paths.every(path => path === RECEIPT_READ_PATH || path === CONFIGURATION_PATH || roots.includes(path));
}

/** Host preparation already checks the selected management revision against
 * project/store, metadata and policy binding. Check its exact candidate links
 * again here; the complete evidence digest is rechecked on save and reuse. */
function currentReceiptSelection(source: PolicyTextSnapshot, draft: unknown, mode: string): boolean {
  const configured = at(draft, CONFIGURATION_PATH);
  const actions = at(draft, "/actions")?.filter((a: any) => a.effect?.writeback === "supervised");
  if (!Array.isArray(actions) || !actions.length) return false;
  if (configured?.status === "current" && configured.modes?.length
    && configured.modes.every((e: any) => e.authority === mode && e.source === at(draft, "/read/source"))) return true;
  const intent = configured?.reviewed_intent;
  return intent?.phase === "disabled_authoring" && intent.status === "current" && intent.verified === false
    && intent.outcomes?.length === actions.length
    && new Set(intent.outcomes.map((entry: any) => entry.outcome)).size === actions.length
    && actions.every((action: any) => intent.outcomes.some((entry: any) => entry.selection_current === true
      && entry.mode === mode && entry.outcome === action.outcome && entry.source_digest === source.digest
      && entry.source === at(draft, "/read/source")
      && /^sha256:[a-f0-9]{64}$/u.test(entry.binding_digest ?? "")
      && /^policy:[a-f0-9]{64}$/u.test(entry.revision_id ?? "")
      && entry.read_digest === canonicalJsonDigest(at(draft, "/read"))
      && entry.action_digest === canonicalJsonDigest(action)));
}

/** Prepared configuration is host-built under the governed binding reader.
 * Recheck its local source/candidate links here; persistence/reuse still compare
 * the whole prepared context. This establishes selection, never an observation. */
function receiptSelectionProblem(source: PolicyTextSnapshot, draft: unknown, mode: string | undefined): ReceiptConfigurationFindingReason | undefined {
  if (!mode) return 'source_requirement_unestablished';
  const configured = at(draft, CONFIGURATION_PATH);
  const modes = configured?.modes;
  if (configured?.status === 'current' && Array.isArray(modes) && modes.some((entry: any) => ['runner_ledger', 'source_db'].includes(entry.authority) && entry.authority !== mode)) return 'mode_mismatch';
  if (!currentReceiptSelection(source, draft, mode)) return 'selection_unavailable';
  if (configured.status === 'current') {
    if (!/^sha256:[a-f0-9]{64}$/u.test(configured.digest ?? '')
      || !Array.isArray(modes) || !modes.length
      || new Set(modes.map((entry: any) => entry.source)).size !== modes.length
      || modes.some((entry: any) => entry.authority !== mode || entry.source !== at(draft, '/read/source'))) return 'selection_unavailable';
    if (mode === 'source_db') {
      const destinations = configured.source_receipt_destinations;
      if (!Array.isArray(destinations) || destinations.length !== modes.length
        || destinations.some((entry: any) => entry.source !== at(draft, '/read/source') || !/^sha256:[a-f0-9]{64}$/u.test(entry.relation_digest ?? ''))
        || new Set(destinations.map((entry: any) => entry.source)).size !== destinations.length) return 'selection_unavailable';
      const exclusion = at(draft, RECEIPT_READ_PATH);
      // When supplied, this independent host binding must agree even though
      // exclusion itself does not prove selection or any other receipt fact.
      if (exclusion && (exclusion.configuration_digest !== configured.digest
        || exclusion.destination_binding_digest !== canonicalJsonDigest(destinations)
        || exclusion.selected_read_digest !== canonicalJsonDigest(at(draft, '/read')))) return 'selection_unavailable';
    }
  }
  const snapshot = at(draft, '/runner_evidence/runtime_contract/authoring_lifecycle/current_policy_snapshot');
  if (snapshot && snapshot.digest !== source.digest) return 'selection_unavailable';
  return undefined;
}
function receiptCapabilityRoots(draft: unknown): string[] {
  return (at(draft, '/actions') ?? []).flatMap((action: any, index: number) => {
    const base = `/runner_evidence/actions/${action.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
    const effect = at(draft, `${base}/effect`), execution = at(draft, `${base}/execution`);
    return action.effect?.writeback === 'supervised' && effect
      && effect.target_resource === action.effect.target_resource && effect.target_binding === action.effect.target_binding
      && effect.operation === action.effect.operation && execution?.configured_mode === 'direct_sql'
      && execution.activation === 'separate_operator_review'
      ? [`${base}/effect`, `${base}/execution`, `/actions/${index}/effect`] : [];
  });
}
function isolatableReceiptConfiguration(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown, session?: PolicySourceSession): boolean {
  const mode = receiptRequirement(source, p, draft, session);
  if (!mode || receiptSelectionProblem(source, draft, mode) || !supportedReceiptSetup(draft, mode)
    || !isolatedReceiptReadFields(p) || p.issue_kind !== 'coverage_link'
    || p.draft_paths.length < 2 || new Set(p.draft_paths).size !== p.draft_paths.length) return false;
  const roots = receiptCapabilityRoots(draft);
  return p.draft_paths.includes(CONFIGURATION_PATH) && p.draft_paths.some(path => roots.includes(path))
    && p.draft_paths.every(path => path === CONFIGURATION_PATH || path === RECEIPT_PATH || roots.includes(path));
}

function supportedReceiptSetup(draft: unknown, mode: string): boolean {
  const setup = at(draft, SETUP_PATH), actions = at(draft, '/actions')?.filter((action: any) => action.effect?.writeback === 'supervised');
  return setup?.supported === true && setup.stage === "after_authority_review" && setup.verified === false
    && Array.isArray(setup.receipt_modes_supported) && setup.receipt_modes_supported.includes(mode)
    && Array.isArray(actions) && actions.length > 0 && Array.isArray(setup.outcomes) && setup.outcomes.length === actions.length
    && new Set(setup.outcomes.map((entry: any) => entry.outcome)).size === actions.length
    && actions.every((action: any) => {
      const execution = at(draft, `/runner_evidence/actions/${action.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}/execution`);
      return execution?.configured_mode === 'direct_sql' && setup.outcomes.some((entry: any) => entry.outcome === action.outcome
        && entry.configured_mode === execution.configured_mode);
    });
}

/** A correction, never a successful assessment. Exact typed capability roots
 * can be separated from receipt duties; arbitrary child/observation claims,
 * private/threshold claims and missing source/selection evidence cannot. */
function isolatableReceiptCapability(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): boolean {
  const mode = receiptRequirement(source, p);
  if (!mode || !supportedReceiptSetup(draft, mode) || !currentReceiptSelection(source, draft, mode)
    || p.responsibility !== "runner" || p.issue_kind !== "coverage_link"
    || p.field_checks?.length || p.counter_requirements?.length || p.evidence_checks?.length
    || p.application_obligations?.length || p.deployment_prerequisite || p.source_counter_obligation || p.operator_override) return false;
  const configured = at(draft, CONFIGURATION_PATH);
  if (configured?.status === "unavailable" || configured?.modes?.some((e: any) => e.authority !== mode)) return false;
  const roots = receiptCapabilityRoots(draft);
  return !receiptSelectionProblem(source, draft, mode)
    && new Set(p.draft_paths).size === p.draft_paths.length
    && p.draft_paths.includes(RECEIPT_PATH) && p.draft_paths.some(path => roots.includes(path))
    && p.draft_paths.every(path => path === RECEIPT_PATH || path === CONFIGURATION_PATH || roots.includes(path));
}

/** This is the existing host receipt contract emitted by policyCoverageDraft,
 * not a provider-selected description or a proof of a performed operation.
 * Binding its complete value prevents a contradictory edited overview from
 * inheriting the capability merely by retaining a familiar phrase. */
export function receiptCouplingPaths(outcome: string): string[] {
  const root = `/runner_evidence/actions/${outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
  return [`${root}/effect`, `${root}/execution`, RECEIPT_PATH];
}
/** Exact canonical meaning for this narrow component. Free prose cannot add an
 * observation, provisioning claim, or independent readback to its proof. The
 * raw correction remains retained separately by the scoped producer. */
export function receiptCouplingInterpretation(outcome: string): string {
  return `The compiled ${outcome} direct-SQL capability couples every listed business effect and its required source_db receipt in one source transaction: they commit together or roll back. This establishes capability only. Provisioning, execution authorization, a performed receipt and independent source readback remain separately unverified.`;
}
/** Feedback eligibility only. The submitted passage remains invalid. Exact
 * typed component/paths plus independent current requirement and capability
 * permit a narrow replacement; rejected narration supplies neither proof nor
 * an accepted claim. The replacement is validated from scratch. */
export function repairableReceiptCouplingRepresentation(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown,
  session?: PolicySourceSession): boolean {
  if (p.receipt_component !== 'source_transaction_coupling' || p.disposition !== 'implemented'
    || p.responsibility !== undefined && p.responsibility !== 'runner'
    || p.issue_kind !== undefined && p.issue_kind !== 'coverage_link'
    || Object.keys(p).some(key => !['start', 'end', 'disposition', 'interpretation', 'draft_paths',
      'receipt_component', 'responsibility', 'issue_kind'].includes(key))) return false;
  const actions = at(draft, '/actions');
  if (!Array.isArray(actions)) return false;
  const matches = actions.filter((action: any) => typeof action?.outcome === 'string'
    && sameSet(p.draft_paths, receiptCouplingPaths(action.outcome)));
  if (matches.length !== 1) return false;
  const requirement=currentSourceTransactionReview(source,draft,session);
  if (!requirement || requirement.start!==p.start || requirement.end!==p.end
    || requirement.action.outcome!==matches[0].outcome) return false;
  const currentMapping=sourceTransactionMappings(draft).find(mapping=>canonicalJsonDigest(mapping)===canonicalJsonDigest({
    action:requirement.action,required_effects:requirement.required_effects,
    required_receipt:requirement.required_receipt,relation:requirement.relation}));
  if (!currentMapping) return false;
  const canonical = receiptCouplingInterpretation(matches[0].outcome);
  // The single typed component is replaced in full; its submitted narration
  // stays in invalid episode history, not in the assembled replacement or as
  // evidence. English variants cannot decide correction eligibility. Extra
  // typed claims and sibling passages remain outside this isolation boundary.
  if (typeof p.interpretation !== 'string' || !p.interpretation.trim()
    || p.interpretation.length > 2_000) return false;
  if (p.responsibility === 'runner' && p.issue_kind === 'coverage_link' && p.interpretation === canonical) return false;
  try {
    return assessReceiptCouplingCapability({ ...p, responsibility: 'runner', issue_kind: 'coverage_link',
      interpretation: canonical }, source, draft)?.origin === 'HOST-RESOLVED';
  } catch { return false; }
}
function couplingFailure(reason: string): never {
  throw new Error(`OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED: ${reason} Capability, current selection, setup and observation remain distinct.`);
}
function sameSet(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) && actual.every(value => typeof value === 'string')
    && new Set(actual).size === actual.length && actual.length === expected.length
    && expected.every(value => actual.includes(value));
}
/** Positive authoring binding for the engine's existing source_db transaction
 * contract. It validates every compiled effect against this exact prepared
 * candidate; it neither adds an engine capability nor reads receipt contents.
 * Saved passages call this again against fresh prepared evidence. */
export function assessReceiptCouplingCapability(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown): ReceiptCouplingAssessment | undefined {
  if (p.receipt_component !== 'source_transaction_coupling') return undefined;
  if (p.disposition !== 'implemented' || p.responsibility !== 'runner' || p.issue_kind !== 'coverage_link'
    || !isolatedReceiptReadFields(p) || p.operator_clarification !== undefined || p.next_step !== undefined || p.topic !== undefined
    || (p as PolicyPassage & { operator_message_id?: unknown }).operator_message_id !== undefined) {
    return couplingFailure('The typed coupling component must contain only the Runner capability claim.');
  }
  if (receiptRequirement(source,p)==='runner_ledger')
    return couplingFailure('The cited source explicitly requires Runner-ledger receipts, not this source_db transaction association.');
  const problem = receiptSelectionProblem(source, draft, 'source_db');
  if (problem) return couplingFailure(`The exact current source receipt selection is unavailable (${problem}).`);
  const configuration = at(draft, CONFIGURATION_PATH), read = at(draft, '/read');
  if (configuration?.status !== 'current' || !supportedReceiptSetup(draft, 'source_db')) {
    return couplingFailure('Current source_db selection and complete supported direct-SQL setup bindings are required.');
  }
  const candidates = (at(draft, '/actions') ?? []).filter((action: any) => typeof action.outcome === 'string'
    && sameSet(p.draft_paths, receiptCouplingPaths(action.outcome)));
  if (candidates.length !== 1) return couplingFailure('Exactly one complete effect/execution/receipt reference group is required.');
  const action = candidates[0], root = receiptCouplingPaths(action.outcome)[0]!.slice(0, -'/effect'.length);
  const host = at(draft, root), effect = host?.effect, execution = host?.execution;
  const phase = at(draft, '/runner_evidence/runtime_contract/review_evidence_phases');
  const actionRevision = at(draft, '/runner_evidence/action_revision');
  const executionReview = at(draft, '/runner_evidence/runtime_contract/saved_execution_review');
  const reader = at(draft, '/runner_evidence/runtime_contract/onboarding_reader');
  if (p.interpretation !== receiptCouplingInterpretation(action.outcome)) {
    return couplingFailure('The component must preserve the exact canonical capability meaning, without observation or setup assertions.');
  }
  if (action.effect?.writeback !== 'supervised' || host?.outcome !== action.outcome
    || execution?.configured_mode !== 'direct_sql' || execution.supported_automatic_completion !== true
    || execution.activation !== 'separate_operator_review'
    || !['postgres', 'mysql'].includes(reader?.engine) || reader.source !== read?.source
    || reader.generation_lock_fingerprint !== read?.generation_lock_fingerprint
    || reader.role_posture_fingerprint !== read?.role_posture_fingerprint
    || at(draft, '/runner_evidence/runtime_contract/authoring_lifecycle/current_policy_snapshot/digest') !== source.digest
    || phase?.selected_read_digest !== canonicalJsonDigest(read)
    || !/^sha256:[a-f0-9]{64}$/u.test(phase?.candidate_action_digest ?? '')
    || (actionRevision
      ? actionRevision.action_boundary_digest !== phase.candidate_action_digest
        || !/^sha256:[a-f0-9]{64}$/u.test(actionRevision.review_record_digest ?? '')
      : !executionReview?.action_digest)
    || (executionReview?.action_digest && phase.candidate_action_digest !== executionReview.action_digest)
    || (phase?.candidate_action_binding_digest
      ? phase.candidate_action_binding_digest !== canonicalJsonDigest({
        candidate_action_digest: phase.candidate_action_digest, actions: at(draft, '/actions') })
      : !executionReview?.action_digest)
    || canonicalJsonDigest(at(draft, RECEIPT_PATH) ?? null) !== canonicalJsonDigest(SOURCE_RECEIPT_CONTRACT)) {
    return couplingFailure('The current candidate, source, supported execution and complete host transaction contract do not agree.');
  }
  const rawCompanions = action.effect.atomic_updates, hostCompanions = effect?.atomic_updates;
  if ((rawCompanions === undefined) !== (hostCompanions === undefined)
    || rawCompanions === undefined && effect?.transaction !== undefined
    || rawCompanions !== undefined && (!Array.isArray(rawCompanions) || !Array.isArray(hostCompanions)
      || rawCompanions.length < 1 || rawCompanions.length > 3 || rawCompanions.length !== hostCompanions.length
      || effect.transaction !== ATOMIC_EFFECT_TRANSACTION)) {
    return couplingFailure('The complete ordered atomic effect group and its transaction contract are required.');
  }
  const rawEffects = [action.effect, ...(rawCompanions ?? [])], hostEffects = [effect, ...(hostCompanions ?? [])];
  if (new Set(rawEffects.map(entry => entry.target_binding)).size !== rawEffects.length
    || new Set(rawEffects.map(entry => entry.target_resource)).size !== rawEffects.length) {
    return couplingFailure('Every business effect must retain its distinct exact verified target.');
  }
  for (const [index, raw] of rawEffects.entries()) {
    const compiled = hostEffects[index], fields = raw.allowed_fields?.map((field: any) => field.name);
    const bindings = action.verification?.resources?.filter((entry: any) => entry.binding === raw.target_binding);
    const binding = host.scoped_bindings?.[raw.target_binding];
    const version = compiled?.version_advance;
    if (raw.operation !== 'update' || !compiled || index === 0 && compiled.operation !== raw.operation
      || typeof raw.target_binding !== 'string' || typeof raw.target_resource !== 'string'
      || compiled.target_binding !== raw.target_binding || compiled.target_resource !== raw.target_resource
      || !Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length
      || !sameSet(compiled.fields, fields) || !raw.set || typeof raw.set !== 'object'
      || !Object.keys(raw.set).length || Object.keys(raw.set).some(field => !fields.includes(field))
      || index > 0 && canonicalJsonDigest(compiled.set ?? null) !== canonicalJsonDigest(raw.set)
      || !Array.isArray(bindings) || bindings.length !== 1 || bindings[0].resource !== raw.target_resource
      || binding?.binding !== raw.target_binding || binding.resource !== raw.target_resource
      || binding.database_scope_proof && (binding.database_scope_proof.source !== read.source
        || binding.database_scope_proof.resource !== raw.target_resource
        || binding.database_scope_proof.generation_lock_fingerprint !== read.generation_lock_fingerprint)
      || typeof binding.row_identity !== 'string' || !binding.row_identity
      || !bindings[0].source || Object.entries(bindings[0].source).some(([key, value]) =>
        canonicalJsonDigest(value) !== canonicalJsonDigest(binding.source?.[key] ?? null))
      || version?.strategy !== 'integer_increment' || version.column !== binding.conflict_field
      || binding.fields?.[version.column]?.type?.kind !== 'integer'
      || binding.fields?.[version.column]?.nullable !== false
      || !sameSet(compiled.source_fields_modified, [...new Set([...fields, version.column])])) {
      return couplingFailure('A primary or companion effect no longer matches its exact compiled fields, assignments, scope and version guard.');
    }
  }
  const evidence = { action, host, read, configuration, phase, reader, receipt_contract: at(draft, RECEIPT_PATH),
    setup: at(draft, SETUP_PATH) };
  return { origin: 'HOST-RESOLVED', category: 'source_transaction_coupling', source_digest: source.digest,
    source_range: { start: p.start, end: p.end }, source: read.source, outcome: action.outcome,
    effect_count: rawEffects.length, configuration_digest: configuration.digest,
    dependencies_digest: canonicalJsonDigest({ source: source.digest, range: [p.start, p.end], evidence }),
    phase: 'compiled_capability', observed: false };
}

/** Structural conjunction guard, not a new prose/atomicity interpreter. The
 * existing receiptRequirement establishes mode only. A host-nominated repair
 * pins its source spans; otherwise an implemented effect/execution claim on an
 * explicit source_db span must retain a positive coupling component. A pure
 * configuration comparison continues to establish selection only. */
export function assertRequiredReceiptCoupling(passages: readonly PolicyPassage[], source: PolicyTextSnapshot, draft: unknown,
  requiredSpans: readonly Pick<PolicyPassage, 'start' | 'end'>[] = [], session?: PolicySourceSession): void {
  const needed=sourceTransactionReviewNeeded(draft);
  const requirement=currentSourceTransactionReview(source,draft,session);
  if (!requirement && passages.some(p=>p.receipt_component==='source_transaction_coupling'))
    couplingFailure('The current source transaction meaning needs an explicit applicable operator review. Receipt mode and compiled capability cannot supply it.');
  if ((needed || session?.source_transaction_reviews?.length) && !requirement) {
    // A report about other concerns may remain a pending review artifact. It
    // cannot become BUSINESS-ready: no association is emitted and readiness
    // requires the current operator record independently of provider prose.
    return;
  }
  if (requirement && receiptRequirement(source,requirement)==='runner_ledger')
    couplingFailure('The current source range explicitly specifies Runner-ledger receipts; an operator record cannot waive this conflicting requirement.');
  if (requirement && !sourceTransactionMappings(draft).some(mapping =>
    canonicalJsonDigest(mapping) === canonicalJsonDigest({action:requirement.action,
      required_effects:requirement.required_effects,required_receipt:requirement.required_receipt,relation:requirement.relation})))
    couplingFailure('The current complete Action effect and receipt mapping does not implement the retained source requirement.');
  const proofs = passages.flatMap((p,index) => {
    const proof = assessReceiptCouplingCapability(p, source, draft);
    return proof ? [{proof,index}] : [];
  });
  const questions=requirement && session ? sourceTransactionScopeQuestions(source,draft,session) : [];
  if (requirement) for(const {proof,index} of proofs) {
    if(proof.source_range.start!==requirement.start||proof.source_range.end!==requirement.end)
      couplingFailure('A coupling component refers to a different Action or source range than the current operator-reviewed requirement.');
    if(proof.outcome===requirement.action.outcome)continue;
    const action=(at(draft,'/actions')??[]).find((entry:any)=>entry?.outcome===proof.outcome);
    const scoped=action&&session?currentSourceTransactionScopeReview(source,draft,session,requirement,
      {name:action.name,outcome:action.outcome,source:requirement.action.source}):undefined;
    if(scoped?.decision==='does_not_apply')throw new CoverageComponentError(`/passages/${index}`,new SourceTransactionScopeError('excluded'));
    if(scoped?.decision!=='applies')throw new CoverageComponentError(`/passages/${index}`,new SourceTransactionScopeError('unknown'));
    const mapping=sourceTransactionMappings(draft).find(entry=>entry.action.name===action.name&&entry.action.outcome===action.outcome);
    // The owner reviewed particular business conjuncts, not just their count.
    // A second Action can claim the same source clause only when its complete
    // ordered assignments and source receipt relationship implement that
    // exact requirement. Its own Action identity remains separately bound by
    // the attributed scope decision above.
    if(!mapping||canonicalJsonDigest({effects:mapping.required_effects,receipt:mapping.required_receipt,relation:mapping.relation})
      !==canonicalJsonDigest({effects:requirement.required_effects,receipt:requirement.required_receipt,relation:requirement.relation})
      ||proof.effect_count!==mapping.required_effects.length)
      throw new CoverageComponentError(`/passages/${index}`,new SourceTransactionScopeError('capability'));
  }
  for(const question of questions) {
    if(!question.current||question.current.decision==='deferred')throw new SourceTransactionScopeError('unknown');
    if(question.current.decision==='applies'&&!proofs.some(({proof})=>proof.outcome===question.action.outcome
      && proof.source_range.start===requirement!.start&&proof.source_range.end===requirement!.end))
      throw new SourceTransactionScopeError('capability');
  }
  const identities = proofs.map(({proof}) => canonicalJsonDigest({ range: proof.source_range, outcome: proof.outcome }));
  if (new Set(identities).size !== identities.length) {
    couplingFailure('The same source-range/outcome coupling component cannot be duplicated or renamed to manufacture proof.');
  }
  const roots = receiptCapabilityRoots(draft);
  const required = [...(requirement ? [{start:requirement.start,end:requirement.end}] : []),
    ...requiredSpans.filter(span=>receiptRequirement(source,span)==='source_db'), ...passages.filter(p => p.disposition === 'implemented' && p.responsibility === 'runner'
    && receiptRequirement(source, p) === 'source_db' && p.draft_paths.some(path => roots.includes(path)))];
  for (const span of required) {
    if (!proofs.some(({proof}) => proof.source_range.start === span.start && proof.source_range.end === span.end
      && (!requirement || proof.outcome===requirement.action.outcome))) {
      couplingFailure('The required source transaction conjunction remains unestablished; separate effect and receipt-selection claims cannot replace it.');
    }
  }
}
/** Only an explicit receipt-mode requirement can supply this narrow binding.
 * Missing/ambiguous prose never means the default mode or an absent duty.
 * This does not interpret arbitrary delivery, atomicity or durability claims. */
export function receiptRequirement(source: PolicyTextSnapshot, p: Pick<PolicyPassage, "start" | "end">,
  draft?: unknown, session?: PolicySourceSession): "runner_ledger" | "source_db" | undefined {
  const explicit = explicitReceiptRequirement(source, p);
  const reviewed = currentReceiptRequirement(source, p, draft, session);
  if (explicit && reviewed && explicit !== reviewed.mode) throw new CoverageReceiptConfigurationError('mode_mismatch');
  return explicit ?? reviewed?.mode;
}
function explicitReceiptRequirement(source: PolicyTextSnapshot, p: Pick<PolicyPassage, "start" | "end">): "runner_ledger" | "source_db" | undefined {
  const text = source.text.split(/\r\n|\r|\n/u).slice(p.start - 1, p.end).join("\n");
  const mentions = [...text.matchAll(/\b(runner[-_ ]ledger|source[-_ ]db|source-atomic)\s+receipt\b/giu)];
  if (mentions.length !== 1 || /\b(?:not|never|unless|instead|either|optional)\b/iu.test(text.slice(Math.max(0, mentions[0]!.index! - 45), mentions[0]!.index))) return undefined;
  const prefix = text.slice(0, mentions[0]!.index);
  const direct = /\b(?:request|require|requires|required)(?:\s+a)?(?:\s+stored)?\s+$/iu.test(prefix);
  const selected = /\b(?:use|using)(?:\s+the)?(?:\s+(?:existing|local))?\s+$/iu.test(prefix);
  if (!direct && !selected) return undefined;
  if (selected && /["“”]|\b(?:not|never|unless|instead|either|optional)\b/iu.test(prefix.split(/[.;\n]/u).at(-1) ?? "")) return undefined;
  return /^runner/iu.test(mentions[0]![1]!) ? "runner_ledger" : "source_db";
}

/** The configured mode is a different, narrow claim from receipt production.
 * The enclosing provider passage is retained; a pending component below keeps
 * future setup/observation duties visible. No other fields use this proof. */
export function receiptSelectionComponent(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown,
  session?: PolicySourceSession): PolicyPassage | undefined {
  if (p.disposition !== "implemented") return undefined;
  const configurationReference = p.draft_paths.some(path => path === CONFIGURATION_PATH || path.startsWith(`${CONFIGURATION_PATH}/`));
  // A broad ancestor does not become a narrow mode comparison. Use the same
  // existing explicit source requirement, not interpretation keywords, to
  // identify this bounded receipt claim before model-selected paths can skip it.
  const broadReceiptReference = receiptRequirement(source, p, draft, session) && p.draft_paths.some(path =>
    path === '/runner_evidence' || path === '/runner_evidence/runtime_contract');
  if (!configurationReference && !broadReceiptReference) return undefined;
  if (!p.draft_paths.includes(CONFIGURATION_PATH)) throw new CoverageReceiptConfigurationError('reference_overbroad');
  if (p.responsibility !== "runner") throw new CoverageReceiptConfigurationError("responsibility_mismatch");
  const mode = receiptRequirement(source, p, draft, session), problem = receiptSelectionProblem(source, draft, mode);
  // Determine evidence independently of the submitted disposition/shape. A
  // conflict or unavailable binding is not a formatting problem, regardless of
  // which pointer is first. The original grouping is still strictly rejected.
  if (problem) throw new CoverageReceiptConfigurationError(problem);
  if (p.draft_paths.some(path => path !== CONFIGURATION_PATH && path !== RECEIPT_PATH)
    || new Set(p.draft_paths).size !== p.draft_paths.length
    || p.field_checks?.length || p.counter_requirements?.length || p.application_obligations?.length || p.deployment_prerequisite
    || p.source_counter_obligation || p.operator_override || p.evidence_checks?.some(c => !c.path.startsWith(`${CONFIGURATION_PATH}/`))) {
    throw new CoverageReceiptConfigurationError(isolatableReceiptConfiguration(p, source, draft, session)
      ? 'current_selection_mixed_component' : 'component_not_isolatable');
  }
  if (at(draft, CONFIGURATION_PATH)?.status !== 'current') throw new CoverageReceiptConfigurationError('selection_unavailable');
  return { start: p.start, end: p.end, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
    topic: "Receipt/execution setup", draft_paths: [RECEIPT_PATH],
    interpretation: "HOST-RESOLVED pending component: the configured receipt mode matches the explicit source requirement. Writer/provisioning verification, execution authorization and receipt production remain separate and unverified. The submitted configuration claim is retained separately.",
    next_step: "Continue through execution setup after authority review; an actual receipt and independent source readback still require their applicable later evidence." };
}

/** Recomputed from current host inputs, never deserialized as a provider claim.
 * All three families use the same phase record; their proof requirements differ. */
export function assessReviewObligation(p: PolicyPassage, source: PolicyTextSnapshot, draft: unknown,
  session?: PolicySourceSession): ReviewObligationAssessment | undefined {
  const coupling = assessReceiptCouplingCapability(p, source, draft);
  if (p.disposition === 'implemented' && p.draft_paths.some(path => path === RECEIPT_READ_PATH || path.startsWith(`${RECEIPT_READ_PATH}/`))) {
    if (!currentReceiptReadExclusion(draft)) throw new CoverageReceiptReadExclusionError('proof_unavailable');
    if (!isolatedReceiptReadFields(p) || p.draft_paths.length !== 1 || p.draft_paths[0] !== RECEIPT_READ_PATH) {
      throw new CoverageReceiptReadExclusionError(isolatableReceiptReadExclusion(p, draft)
        ? 'current_proof_mixed_component' : 'component_not_isolatable');
    }
  }
  // No claim is accepted or rewritten here. A narrow alternative exists only
  // with current host proof; the provider must resubmit a complete report.
  if (p.disposition === 'implemented' && isolatedReceiptReadFields(p) && currentReceiptReadExclusion(draft)
    && p.draft_paths.length === 2 && p.draft_paths.includes('/read') && p.draft_paths.includes(RECEIPT_PATH)) {
    throw new CoverageReceiptReadContextError();
  }
  const selection = receiptSelectionComponent(p, source, draft, session);
  if (p.disposition === "implemented" && (p.draft_paths.includes(READBACK_PATH)
    || p.draft_paths.includes(RECEIPT_PATH) && receiptRequirement(source, p, draft, session) && !selection && !coupling)) {
    throw new CoverageReceiptObservationError(isolatableReceiptCapability(p, source, draft));
  }
  let family: ReviewObligationAssessment["family"], phase: ReviewObligationAssessment["phase"], requirement: string, pointer: string, evidence: unknown;
  let state: ReviewObligationAssessment["state"] = "pending";
  if (p.source_counter_obligation) {
    if (!isDeferredSourceCounterMaintenance(p)) return undefined;
    family = "source_counter_maintenance"; phase = "ongoing_source_operation";
    requirement = p.source_counter_obligation.requirement; pointer = p.source_counter_obligation.path;
    evidence = p.source_counter_resolution; state = "owner_attested_external_assurance_unverified";
  } else if (isDeferredSourceReadback(p)) {
    const contract = at(draft, READBACK_PATH);
    if (contract?.phase !== "after_execution" || contract.verified !== false || contract.receipt_proves_observation !== false || contract.observation_scope !== null) return undefined;
    const clauses = source.text.split(/\r\n|\r|\n/u).slice(p.start - 1, p.end).join("\n").split(/[.;]/u);
    const explicit = clauses.filter(clause => /\bindependent(?:ly)?\b/iu.test(clause) && /\b(?:source|row|readback)\b/iu.test(clause));
    if (!explicit.length || explicit.some(clause => /\b(?:automatically|runtime|transactional|postcondition)\b/iu.test(clause))) return undefined;
    family = "independent_source_readback"; phase = "after_execution"; requirement = "independent_source_readback";
    pointer = READBACK_PATH; evidence = contract;
  } else if (receiptOnly(p) || receiptConfigurationComponentOnly(p)) {
    const mode = receiptRequirement(source, p, draft, session), setup = at(draft, SETUP_PATH);
    if (!mode) return undefined;
    if (setup?.supported !== true || setup.stage !== "after_authority_review" || setup.verified !== false
      || !Array.isArray(setup.receipt_modes_supported) || !setup.receipt_modes_supported.includes(mode)) return undefined;
    const configured = at(draft, "/runner_evidence/runtime_contract/receipt_configuration");
    if (configured?.status === "unavailable") return undefined;
    if (configured?.modes?.some((entry: { authority: string }) => entry.authority !== mode)) {
      throw new CoverageReceiptConfigurationError("mode_mismatch");
    }
    // A configuration pointer is not a global receipt alias. It needs an exact
    // current selection as well as independent required meaning. Submitted
    // paths/prose/disposition are never rewritten.
    if (receiptConfigurationComponentOnly(p) && !currentReceiptSelection(source, draft, mode)) return undefined;
    // Source-atomic configuration requires exact current evidence. Generic
    // support or a missing store/configuration is never a source receipt proof.
    if (mode === "source_db" && (!configured?.modes?.length || configured.status !== "current")) {
      const intent = configured?.reviewed_intent;
      const actions = at(draft, "/actions")?.filter((action: any) => action.effect?.writeback === "supervised");
      if (intent?.phase !== "disabled_authoring" || intent.status !== "current" || intent.verified !== false
        || !Array.isArray(actions) || !actions.length || intent.outcomes?.length !== actions.length
        || new Set(intent.outcomes.map((entry: any) => entry.outcome)).size !== actions.length
        || !actions.every((action: any) => intent.outcomes.some((entry: any) => entry.selection_current === true
          && entry.mode === mode && entry.outcome === action.outcome && entry.source_digest === source.digest
          && entry.read_digest === canonicalJsonDigest(at(draft, "/read"))
          && entry.action_digest === canonicalJsonDigest(action)))) return undefined;
    }
    family = "receipt_setup"; phase = "after_authority_review"; requirement = mode; pointer = RECEIPT_PATH;
    evidence = { setup, configuration: configured ?? null, actions: at(draft, "/runner_evidence/actions"),
      ...(currentReceiptRequirement(source, p, draft, session) ? { owner_meaning: currentReceiptRequirement(source, p, draft, session) } : {}) };
  } else return undefined;
  return { ...(family === "receipt_setup" ? { configuration_digest: at(draft, CONFIGURATION_PATH)?.digest ?? null,
    ...(receiptConfigurationComponentOnly(p) ? { association: { kind: "reviewed_receipt_configuration" as const,
      submitted_path: CONFIGURATION_PATH, evidence_digest: canonicalJsonDigest(evidence) } } : {}) } : {}), origin: "HOST-RESOLVED", family, path: pointer, source_digest: source.digest, requirement, phase, state, verified: false,
    dependencies_digest: canonicalJsonDigest({ source: source.digest, range: [p.start, p.end], family, requirement, pointer, evidence }) };
}
