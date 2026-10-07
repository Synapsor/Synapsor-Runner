import {readActionRuleCoverageLineage,readActionRuleProspectiveWithdrawal,readActionRuleReviewSubjects} from './action-rule-authority.js';
import {explorationBoundaryCandidateDigest} from './auto-boundary.js';
import {prepareRetainedDutyReview, assembleRetainedDutyReview, preflightRetainedDutyEvidence, RetainedDutyApplicabilityError} from './authoring-retained-duties.js';
import { scopedDisclosureInventory } from "./authoring-scoped-disclosure.js";
import { currentSourceTransactionReview, sourceTransactionReviewNeeded } from './authoring-source-transaction-review.js';
import { sourceTransactionScopeQuestions } from './authoring-source-transaction-scope.js';
import { assertRequiredReceiptCoupling, receiptCouplingInterpretation, receiptCouplingPaths } from './authoring-obligation-review.js';
import { planReviewPrerequisite, ReviewResolutionError, type ReviewPrerequisiteReason } from './authoring-review-resolution.js';
import { CoverageComponentError, coverageFinding } from './authoring-coverage-feedback.js';
import { SourceTransactionScopeError } from './authoring-source-transaction-scope.js';
import { planCoverageResolution } from './authoring-review-resolution.js';
import { randomUUID } from "node:crypto";
import { authoringInterruptedProducerInput } from "./authoring-generation-recovery.js";
import { retainedSourceRecoveryEpisode } from "./authoring-recovery-source.js";
import type { CoverageReviewEpisode } from "./authoring-policy-source.js";
import { reviewClientDutyOwnership, type ClientDutyReviewState } from "./authoring-client-duties.js";
import { AskError } from "./model-provider-transport.js";
import { authoringReceiptConfiguration } from "./authoring-receipt-configuration.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleAuthorityReviewSubjectV1 } from "./action-rule-authority.js";
import { withCountingOutcomeDomain, type CountingOutcomeDomain } from "./authoring-counting-domain.js";
import { reviewUnestablishedCounting } from "./authoring-counting-decision-review.js";
import { countingSourceRequirements } from "./authoring-counting-requirements.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { activePolicySource, authoringDestination, bindPolicyCoverage, loadPolicySources, policySourceSavedDigest, savePolicySources,
  MAX_COUNTING_DECISIONS,
  type PolicyCoverage, type PolicySourceSession } from "./authoring-policy-source.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

/** One coverage producer/validator/persistence path for guided and review-only
 * operations. Preparing the candidate never authorizes an edit or activation. */
export type PreparedPolicyReviewState = {
  attemptKey?: string;
  report?: { key: string; report: PolicyCoverage };
  activity?: "provider" | "validated_reuse";
  clientDutyReview?: ClientDutyReviewState;
};
const pending=(reason:ReviewPrerequisiteReason,code:string,message:string,subject:string|null=null,context:string|null=null):never=>{
  throw new ReviewResolutionError(code,planReviewPrerequisite(reason,subject,context),message);
};

export async function ensurePreparedPolicyCoverage(input: {
  projectRoot: string;
  sources: PolicySourceSession;
  modelSession: Parameters<typeof reviewPolicyCoverage>[0]["session"];
  operatorSession: BoundaryReviewInteractiveSession;
  currentDraft: () => ReturnType<typeof policyCoverageDraft>;
  authorityDigest: string;
  authority?: ActionRuleAuthorityReviewSubjectV1;
  countingDomain?: CountingOutcomeDomain;
  clarifications: unknown[];
  assertCurrent: (permit?: ProjectAuthorityMutationPermit) => Promise<void>;
  /** Native reader metadata refresh. Only called outside authority locks. */
  assertEvidenceCurrent?: () => Promise<void>;
  progress?: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
  state: PreparedPolicyReviewState;
  force?: boolean;
  subjectLocation?: "active" | "draft";
  /** Saved Review/Resume only. Initial guided authoring has its own authorization. */
  savedReviewEpisode?: { job: string; subject: string };
  requireCountingChoice?: boolean;
  onValidated?: (result: { report: PolicyCoverage; key: string; sources: PolicySourceSession; activity: "provider" | "validated_reuse" }, permit: ProjectAuthorityMutationPermit) => Promise<void>;
}) {
  const { sources, state } = input;
  const source = activePolicySource(sources);
  if (!source) throw new ReviewResolutionError('POLICY_REVIEW_SOURCE_UNAVAILABLE',
    planReviewPrerequisite('currentness',null,null),'Select a complete saved source before reviewing this job.');
  const selectedDestination = authoringDestination(input.modelSession);
  if (!sources.approvals.some(a => a.digest === source.digest && a.destination === selectedDestination)) {
    pending('source_consent','POLICY_REVIEW_SOURCE_CONSENT_REQUIRED','Review transfer of this exact source to the selected model before continuing.');
  }
  let expectedSource = await policySourceSavedDigest(input.projectRoot, sources.id);
  if (canonicalJsonDigest(await loadPolicySources(input.projectRoot, sources.id)) !== canonicalJsonDigest(sources)) {
    pending('currentness','POLICY_SOURCE_CHANGED','The in-memory source is not the current saved source. Reopen its review before continuing.');
  }
  const assertCurrent = async (permit?: ProjectAuthorityMutationPermit) => {
    if (!permit) await input.assertEvidenceCurrent?.();
    await input.assertCurrent(permit);
    if (authoringDestination(input.modelSession) !== selectedDestination)
      pending('currentness','POLICY_COVERAGE_CONTEXT_CHANGED','The selected model or destination changed during review. Reopen current Review; no stale response was saved.');
    if (await policySourceSavedDigest(input.projectRoot, sources.id) !== expectedSource) {
      pending('currentness','POLICY_SOURCE_CHANGED','The selected source or its decisions changed during review. Reopen the current saved review; no stale result was saved.');
    }
  };
  const coordinated = async (operation: (permit: ProjectAuthorityMutationPermit) => Promise<void>) => {
    if (input.countingDomain && input.authority) {
      await withCountingOutcomeDomain(input.projectRoot, input.authority, async (current, permit) => {
        if (canonicalJsonDigest(current) !== canonicalJsonDigest(input.countingDomain)) {
          pending('currentness','POLICY_COUNTING_DOMAIN_CHANGED',
            'Current authority or retained history changed during review. Recheck the saved rules; no selector changed.');
        }
        await operation(permit);
      });
    } else await withProjectAuthorityMutation(input.projectRoot, operation);
  };
  await assertCurrent();
  let draftRecord = input.currentDraft();
  const transactionRequirement=currentSourceTransactionReview(source,draftRecord,sources);
  if ((sourceTransactionReviewNeeded(draftRecord) || sources.source_transaction_reviews?.length)
    && !transactionRequirement)
    pending('source_transaction_review','SOURCE_TRANSACTION_REVIEW_PENDING',
      'Review the exact current source transaction requirement locally before a model-backed review. No source meaning was inferred from receipt mode or compiled effects.');
  const scopeQuestions=sourceTransactionScopeQuestions(source,draftRecord,sources);
  const unresolvedScope=scopeQuestions.find(question=>!question.current||question.current.decision==='deferred');
  if(unresolvedScope)pending('source_transaction_scope','SOURCE_TRANSACTION_SCOPE_REVIEW_PENDING',
    'Review the exact source requirement for this outcome locally before another model-backed review. The saved candidate and active rules are unchanged.',
    unresolvedScope.action.outcome,canonicalJsonDigest({source:source.digest,action:unresolvedScope.action,
      binding:unresolvedScope.action_binding_digest,requirement:unresolvedScope.requirement.digest}));
  if (transactionRequirement) try{ assertRequiredReceiptCoupling([
    {start:transactionRequirement.start,end:transactionRequirement.end,
      disposition:'implemented',responsibility:'runner',issue_kind:'coverage_link',receipt_component:'source_transaction_coupling',
      interpretation:receiptCouplingInterpretation(transactionRequirement.action.outcome),
      draft_paths:receiptCouplingPaths(transactionRequirement.action.outcome)},
    ...scopeQuestions.filter(question=>question.current?.decision==='applies').map(question=>({
      start:question.requirement.start,end:question.requirement.end,
      disposition:'implemented' as const,responsibility:'runner' as const,issue_kind:'coverage_link' as const,
      receipt_component:'source_transaction_coupling' as const,
      interpretation:receiptCouplingInterpretation(question.action.outcome),
      draft_paths:receiptCouplingPaths(question.action.outcome)}))],source,draftRecord,[],sources); }
  catch(error){
    const cause=error instanceof CoverageComponentError?error.cause:error;
    if(!(cause instanceof SourceTransactionScopeError))throw error;
    const finding=coverageFinding(error,'/',{source:source.digest,draft:canonicalJsonDigest(draftRecord)});
    throw new ReviewResolutionError(finding.code,planCoverageResolution({
      context:canonicalJsonDigest({source:source.digest,draft:draftRecord}),findings:[finding],limited:false,
      unevaluated:['model review and whole-report persistence'],complete_validation:false}),
      finding.reason);
  }
  // Unknown owner facts do not become a request for another model opinion.
  // Local inspection/deferral is available before provider consent/selection.
  if (scopedDisclosureInventory(source, draftRecord).items.some(f => f.state !== "confirmed_non_sensitive"))
    pending('scoped_disclosure','SCOPED_DISCLOSURE_REVIEW_PENDING',
      'The source-required classification remains pending. Open the local source-required disclosure review; no provider call was made.');
  const neededCountingDecisions = countingSourceRequirements(source, draftRecord, sources.operator_messages ?? [])
    .filter(requirement => requirement.state !== 'established').length;
  if ((sources.counting_decisions?.length ?? 0) + neededCountingDecisions > MAX_COUNTING_DECISIONS)
    pending('history_full', 'POLICY_COUNTING_HISTORY_FULL',
      'The complete new interpretation set cannot fit the supported counting-history limit. Prior decisions remain saved; no question, provider call or partial decision was started. Preserve and inspect the exact Source and history locally; no pruning or replacement review is authorized.');
  const decisions = await reviewUnestablishedCounting({ source, draft: draftRecord,
    messages: sources.operator_messages ?? [], session: input.operatorSession, assertCurrent });
  if (decisions === undefined && input.requireCountingChoice) pending('counting_review','POLICY_COUNTING_REVIEW_PENDING',
    'The counting choice remains unresolved. Resume Review attached rules; no business rule changed.');
  if (decisions?.length) {
    const staged = structuredClone(sources);
    // A newly attributed interpretation does not erase the earlier decision.
    // Applicability still requires the exact Source, full owner history and
    // configured limit. Conflicting current meanings remain ambiguous.
    staged.counting_decisions = [...(staged.counting_decisions ?? []), ...decisions];
    await coordinated(async permit => {
      await assertCurrent(permit);
      await savePolicySources(input.projectRoot, staged, { expectedDigest: expectedSource, permit });
      // Later coverage must compare against our own committed snapshot. Reading
      // "latest" after releasing the lock could adopt a competing writer's digest
      // while retaining this older in-memory source and overwrite that writer.
      expectedSource = canonicalJsonDigest(staged);
    });
    Object.assign(sources, staged);
    draftRecord = input.currentDraft();
  }
  const loadLineage = () => input.authority && sources.coverage ? readActionRuleCoverageLineage(input.projectRoot,
    input.authority, explorationBoundaryCandidateDigest(draftRecord.read)) : Promise.resolve(undefined);
  const lineage = await loadLineage();
  const loadProspective = () => input.authority && sources.coverage ? readActionRuleProspectiveWithdrawal(input.projectRoot,
    input.authority, explorationBoundaryCandidateDigest(draftRecord.read)) : Promise.resolve(undefined);
  const prospective = await loadProspective();
  const loadCounterContext = async () => {
    if (!sources.coverage || !(sources.coverage.source_digest !== source.digest || sources.coverage.cross_source_counter_reviews?.length)) return undefined;
    const context = {snapshots:sources.snapshots};
    if (!input.authority) return context;
    const matches = (await readActionRuleReviewSubjects(input.projectRoot))
      .filter(subject=>canonicalJsonDigest(subject.authority)===canonicalJsonDigest(input.authority));
    if (matches.length !== 1) return context;
    return {...context,selected:matches[0]!,readDigest:explorationBoundaryCandidateDigest(draftRecord.read),authorityDigest:input.authorityDigest};
  };
  const counterContext = await loadCounterContext();
  let retainedDutyPlan: ReturnType<typeof prepareRetainedDutyReview>;
  const hostPending = (error: RetainedDutyApplicabilityError): never => { throw new ReviewResolutionError(error.code,
    planCoverageResolution(error.feedback(canonicalJsonDigest(draftRecord))), error.message); };
  try { retainedDutyPlan = prepareRetainedDutyReview(sources.coverage, source, draftRecord, lineage, sources.coverage_authority_digest,prospective,counterContext);
    preflightRetainedDutyEvidence(retainedDutyPlan, source, draftRecord); }
  catch (error) { if (error instanceof RetainedDutyApplicabilityError) hostPending(error); throw error; }
  const assertRetainedCurrent = async () => {
    if (canonicalJsonDigest(await loadCounterContext() ?? null) !== canonicalJsonDigest(counterContext ?? null))
      pending('currentness','POLICY_RETAINED_DUTY_CHANGED','The selected immutable Action, store or current Source origin changed; reopen saved Review. No stale transition was saved.');
    const current = await loadLineage();
    if (canonicalJsonDigest(current ?? null) !== canonicalJsonDigest(lineage ?? null))
      pending('currentness','POLICY_RETAINED_DUTY_CHANGED','Current Action publication history changed; reopen saved Review. No stale duty reconciliation was saved.');
    if (canonicalJsonDigest(await loadProspective() ?? null) !== canonicalJsonDigest(prospective ?? null))
      pending('currentness','POLICY_RETAINED_DUTY_CHANGED','The exact proposed withdrawal changed; reopen saved Review. No stale prospective duty review was saved.');
  };
  const preparedDraftDigest = canonicalJsonDigest(draftRecord);
  const key = canonicalJsonDigest({ source: source.digest, draft: draftRecord, messages: sources.operator_messages ?? [],
    clarifications: input.clarifications, interpretations: sources.read_interpretations ?? [],
    source_transaction_scope_reviews:sources.source_transaction_scope_reviews?.map(record=>record.digest)??[],
    ...(sources.input_policy_reviews?.length?{input_policy_reviews:sources.input_policy_reviews.map(record=>record.digest)}:{}),
    ...(lineage ? {retained_duty_lineage:canonicalJsonDigest(lineage)} : {}),
    ...((retainedDutyPlan.counterHistory?.length || retainedDutyPlan.crossSource) ? {counter_source_review_contexts:[
      ...(retainedDutyPlan.counterHistory??[]).map(record=>record.context_digest),
      ...(retainedDutyPlan.crossSource?[retainedDutyPlan.crossSource.base.context_digest]:[])]} : {}),
    ...(prospective ? {prospective_withdrawal:canonicalJsonDigest(prospective)} : {}) });
  let reused: PolicyCoverage | undefined;
  if (!input.force && (state.attemptKey === key && state.report?.key === key
    || state.attemptKey === undefined && sources.coverage_context_digest === key && sources.coverage)) {
    try {
      reused = parsePolicyCoverage({ passages: (state.report?.key === key ? state.report.report : sources.coverage!).passages },
        source, draftRecord, sources.operator_messages ?? [],sources);
      reused = assembleRetainedDutyReview(reused, retainedDutyPlan, source, draftRecord,
        passages => parsePolicyCoverage({passages},source,draftRecord,sources.operator_messages??[],sources));
    } catch { /* Revalidate incompatible evidence; never treat a ready flag as proof. */ }
  }
  if (!input.force && state.attemptKey === key && !reused) {
    return { source, key, draftRecord, report: undefined, activity: state.activity };
  }
  let episode: CoverageReviewEpisode;
  const saveEpisode = async (update: (e: CoverageReviewEpisode) => void) => {
    // Covers both initial/correction submissions and received responses. The
    // native reader may have changed during consent or the provider wait.
    await assertCurrent();
    await coordinated(async permit => {
      await assertCurrent(permit);
      await assertRetainedCurrent();
      if (canonicalJsonDigest(input.currentDraft()) !== preparedDraftDigest)
        pending('currentness','POLICY_COVERAGE_CONTEXT_CHANGED','Reopen current Review; no stale correction was sent.');
      const staged = structuredClone(sources);
      const current = staged.coverage_episodes!.find(e => e.id === episode.id)!;
      update(current);
      await savePolicySources(input.projectRoot, staged, { expectedDigest: expectedSource, permit });
      expectedSource = canonicalJsonDigest(staged);
      Object.assign(sources,staged); episode = current;
    });
  };
  const produce = async () => {
    await assertRetainedCurrent();
    const origin = await authoringInterruptedProducerInput("policy_coverage");
    const retained = origin && retainedSourceRecoveryEpisode(sources, key, origin);
    if (origin && !retained) pending('episode_declined','POLICY_COVERAGE_EPISODE_PENDING',
      'The original saved review round cannot be continued faithfully from this checkpoint. Review the interrupted step locally, or start a separately reviewed job. Its earlier submissions, scoped proof and uncertainty remain saved; no new episode or provider allowance was allocated.');
    const prior = sources.coverage_episodes?.filter(e=>e.context===key).at(-1);
    if (!retained && (input.savedReviewEpisode || prior)) {
      const context = input.savedReviewEpisode ? [
        `Saved job: ${input.savedReviewEpisode.job}`,
        `Review subject: ${input.savedReviewEpisode.subject}`,
        `Selected model: ${input.modelSession.provider}[${input.modelSession.model}]`,
        "Maximum: three model response submissions, including up to two eligible structural corrections, in this episode.",
        "No current validated coverage is reusable for this prepared review. A new provider-backed review is needed; provider charges may apply.",
        ...(retainedDutyPlan.retire.length ? ["The earlier BUSINESS report included a removed Action. This is a changed review subject; obsolete associations stay in history and surviving source-wide duties remain unverified operating responsibilities."] : []),
        "This review does not publish rules, authorize execution or change source rows.",
        ...(prior ? [`A prior episode for this exact context reserved ${prior.submissions.length} submissions; its history remains saved.`]
          : sources.coverage_episodes?.length ? ["Earlier episodes for other contexts remain saved; none authorizes this new episode."] : []),
      ] : [`The previous episode reserved ${prior!.submissions.length} response submissions. Its evidence and unresolved review remain saved. A new episode is separately recorded; it is not an uninterrupted retry or a business edit.`];
      if (!await input.operatorSession.confirm("Run a new bounded model review?", { defaultValue: false, context }))
        pending('episode_declined','POLICY_COVERAGE_EPISODE_PENDING',
          'A new provider-backed review was declined. Prior attempts and unresolved review remain saved; no model submission was reserved.');
      await assertCurrent();
      await assertRetainedCurrent();
      if (canonicalJsonDigest(input.currentDraft()) !== preparedDraftDigest)
        pending('currentness','POLICY_COVERAGE_CONTEXT_CHANGED',
          'The reviewed target or selected model changed while awaiting consent. Reopen current Review; no provider call was started.');
    }
    if (!retained && (sources.coverage_episodes?.length ?? 0) >= 120) pending('history_full','POLICY_COVERAGE_EPISODE_HISTORY_FULL',
      'Prior attempts are preserved; no provider call was started.');
    episode = retained ?? {id:randomUUID(), context:key, started_at:new Date().toISOString(),submissions:[]};
    if (!retained) await coordinated(async permit=>{
      await assertCurrent(permit);
      await assertRetainedCurrent();
      if (canonicalJsonDigest(input.currentDraft()) !== preparedDraftDigest)
        pending('currentness','POLICY_COVERAGE_CONTEXT_CHANGED','Reopen current Review; no stale episode was allocated.');
      const staged={...sources,coverage_episodes:[...(sources.coverage_episodes??[]),episode]};
      await savePolicySources(input.projectRoot,staged,{expectedDigest:expectedSource,permit});
      expectedSource=canonicalJsonDigest(staged); Object.assign(sources,staged);
    });
    state.attemptKey = key;
    let retainedReservation = Boolean(retained);
    return reviewPolicyCoverage({session:input.modelSession,source,draft:draftRecord,sourceSession:sources,retainedDutyPlan,
      ...(sources.coverage?.source_digest===source.digest?{previousReport:sources.coverage}:{}),
      episode:{authoringInput:number=>({consumer:"policy_coverage",episode_id:episode.id,
        context_digest:key,submission_number:number}),beforeSubmission:async number=>{
        if (retainedReservation) {
          await assertCurrent(); await assertRetainedCurrent();
          if (number !== origin!.submission_number || canonicalJsonDigest(input.currentDraft()) !== preparedDraftDigest)
            pending('currentness','POLICY_COVERAGE_CONTEXT_CHANGED','The exact interrupted review round changed; no replacement was sent.');
          retainedReservation=false;
          return;
        }
        await saveEpisode(e=>{
        if(number!==e.submissions.length+1 || number>3) pending('episode_exhausted','POLICY_COVERAGE_EPISODE_EXHAUSTED',
          'The bounded episode has no remaining submissions. Prior attempts remain saved.');
        e.submissions.push({number,reserved_at:new Date().toISOString()});
      });},afterSubmission:async(number,feedback,accepted,tentative)=>saveEpisode(e=>{
        const submission=e.submissions[number-1]!;
        submission.completed_at=new Date().toISOString(); submission.validated=accepted;
        if(feedback) submission.diagnostic=JSON.stringify(feedback);
        if(tentative) submission.tentative=structuredClone(tentative);
      })}});
  };
  const report = reused ?? await (input.progress ? input.progress(input.subjectLocation === "active" ? "Checking attached rules against this active published subject" : "Checking attached rules against this exact draft", produce) : produce());
  const staged = structuredClone(sources);
  bindPolicyCoverage(staged, report, input.authorityDigest);
  staged.coverage_context_digest = key;
  let assignments: Awaited<ReturnType<typeof reviewClientDutyOwnership>> = [];
  let clientCancellation: AskError | undefined;
  try {
    assignments = await reviewClientDutyOwnership({ report, sources: staged, session: input.operatorSession, assertCurrent,
      reviewState: state.clientDutyReview ??= {} });
  } catch (error) {
    if (!(error instanceof AskError) || error.code !== "ASK_CANCELLED") throw error;
    clientCancellation = error;
  }
  if (assignments.length) {
    if ((staged.application_assignments?.length ?? 0) + assignments.length > 120)
      pending('history_full','POLICY_CLIENT_ASSIGNMENT_HISTORY_FULL',
        'Existing ownership history is preserved. No new acceptance was saved.');
    staged.application_assignments = [...(staged.application_assignments ?? []), ...assignments];
  }
  // Reuse has the same source/authority/history serialization as a new review.
  // Provider calls occur above, outside this coordinated section.
  // Ownership menus (including Back) can wait after the response or reuse.
  await assertCurrent();
  await coordinated(async permit => {
    await assertCurrent(permit);
    await assertRetainedCurrent();
    assembleRetainedDutyReview(report, retainedDutyPlan, source, input.currentDraft(),
      passages => parsePolicyCoverage({passages},source,input.currentDraft(),sources.operator_messages??[],sources));
    if (canonicalJsonDigest(input.currentDraft()) !== preparedDraftDigest) {
      pending('currentness','POLICY_CLIENT_CONTRACT_CHANGED',
        'The prepared candidate or client contract changed during review. Reopen current Review; no stale ownership was saved.');
    }
    const capturedConfiguration = draftRecord.runner_evidence.runtime_contract.receipt_configuration;
    if (capturedConfiguration && canonicalJsonDigest(capturedConfiguration) !== canonicalJsonDigest(await authoringReceiptConfiguration(
      input.projectRoot, input.authority?.authority.rules.map(r => r.rule.source) ?? []))) {
      pending('currentness','OBLIGATION_CONFIGURATION_CHANGED',
        'Receipt configuration changed during review. Reopen current Review; no stale result was saved.');
    }
    if (canonicalJsonDigest(staged) !== canonicalJsonDigest(sources)) {
      await savePolicySources(input.projectRoot, staged, { expectedDigest: expectedSource, permit });
    }
    await input.onValidated?.({ report, key, sources: staged, activity: reused ? "validated_reuse" : "provider" }, permit);
  });
  Object.assign(sources, staged);
  state.report = { key, report };
  state.activity = reused ? "validated_reuse" : "provider";
  // A received valid report is saved normally with ownership still pending.
  // Cancellation grants nothing and never bypasses the coordinated guards above.
  if (clientCancellation) {
    input.operatorSession.present?.("Client responsibilities remain pending", [
      "Resume Review attached rules to explicitly assign current ownership. Selection, status presentation and integration remain unverified.",
    ]);
    throw clientCancellation;
  }
  return { source, key, draftRecord, report, activity: state.activity };
}
