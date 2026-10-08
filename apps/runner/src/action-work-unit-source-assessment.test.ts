import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleCatalogV1 } from '@synapsor-runner/action-rules';
import type { ActionRuleBooleanExpressionV1, ActionRuleScalarTypeSpecV1 } from '@synapsor/spec';
import type { BuiltActionRuleAuthoringCatalogV1 } from './action-rule-authoring.js';
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from './auto-boundary.js';
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from './action-rule-draft.js';
import { newPolicySourceSession, policyTextSnapshot, type PolicyPassage, type CoverageReviewEpisode, authoringDestination } from './authoring-policy-source.js';
import { policyCoverageDraft } from './authoring-policy-evidence.js';
import { parsePolicyCoverage, collectCoverageFeedback, coverageReferences, reviewPolicyCoverage } from './authoring-policy-coverage.js';
import { createCoverageRepairScope, assembleScopedCoverageReplacement } from './authoring-scoped-correction.js';
import { validateActionWorkUnitAssessment, assertActionWorkUnitCorrection, type ActionWorkUnitContext } from './action-authoring-work-unit-contract.js';
import { actionRuleAuthoringCheckpoint, parseActionWorkUnitCoverageProvenance, type ActionRuleSourceRepairCheckpoint, type ActionRuleAuthoringCheckpoint } from './action-rule-authoring-checkpoint.js';
import { generateModelActionRuleDraft, generateFocusedModelActionRuleDraft } from './action-rule-model.js';
import { assessActionWorkUnitSource, reconstructOriginalActionWorkUnitSourceAssessment } from './action-work-unit-source-assessment.js';

function fixture(otherAction = false) {
  const read = boundary(), catalog = builtCatalog(), source = policyTextSnapshot(Buffer.from(
    "Eligible accounts may request a pause.\nActive status and no risk hold are the eligibility conditions.\nA later independent action still needs a source fact."), "owned-assessment-policy.txt");
  const sources = newPolicySourceSession(); sources.snapshots = [source]; sources.active = source.version;
  const context: ActionWorkUnitContext = { readBoundary: read, readBoundaryDigest: explorationBoundaryCandidateDigest(read), builtCatalog: catalog, policySources: sources };
  const draft = modelDraft();
  const eligible=eligiblePredicate();if(eligible.kind!=="all")throw new Error("Missing fixture conjunction");
  draft.require = { kind: "all", expressions: [...eligible.expressions,
    { kind:"compare",operator:"eq",left:{kind:"field",binding:"account",field:"status"},right:statusLiteral("paused") }] };
  const compiled = compileActionRuleModelDraft({ ...context, draft });
  const other = structuredClone(draft); other.name = other.outcome = "billing.second_action";
  other.verification.name = "billing.second_verification"; other.effect.name = "billing.second_effect"; other.approval.class_name = "billing.second_approval";
  const prepared = policyCoverageDraft({ read, decisions: [], actions: [compiled, ...(otherAction ? [compileActionRuleModelDraft({ ...context, draft: other })] : [])], policySources: sources });
  const passages: PolicyPassage[] = [
    { start:1,end:1,disposition:"implemented",interpretation:"Current pause effect associated.",draft_paths:["/actions/0/effect"] },
    { start:2,end:2,disposition:"conflict",responsibility:"runner",issue_kind:"contradiction",interpretation:"This extra condition conflicts with the current interpreted eligibility clause.",draft_paths:["/actions/0/require/expressions/2"] },
    { start:3,end:3,disposition:"needs_decision",interpretation:"Later source interpretation remains pending.",draft_paths:[] },
  ];
  const report = (p = passages) => parsePolicyCoverage({ passages:p }, source, prepared, sources.operator_messages ?? [], sources);
  const sourceAnswerHistoryDigest = canonicalJsonDigest(sources.operator_messages ?? []);
  const assess = (p = passages) => { const r = report(p); return assessActionWorkUnitSource({ context, currentAction: compiled.draft, preparedDraft: prepared,
    report: r, expectedReportDigest: canonicalJsonDigest(r), sourceAnswerHistoryDigest }); };
  return { source, sources, context, prepared, compiled, passages, report, assess, sourceAnswerHistoryDigest };
}

describe("current canonical partial-program Source assessment", () => {
  it("nominates only the exact existing Boolean AST conflict and retains unscoped future duties", () => {
    const f = fixture(), result = f.assess();
    expect(result.assessment).toMatchObject({state:"representation_mismatch",component:"predicate",editable_paths:["/require/expressions/2"]});
    expect(result.scope).toMatchObject({whole_source_review_pending:true,unscoped_pending_indexes:[2],predicate_equivalence_checked:false,subject_meaning_checked:false});
    if (result.assessment.state !== "representation_mismatch") throw new Error("Missing nomination");
    expect(result.assessment.source_review.draft).toHaveProperty("runner_evidence");
    expect(canonicalJsonDigest(result.assessment.source_review.draft)).toBe(result.assessment.source_review.report.draft_digest);
    const corrected = structuredClone(f.compiled.draft); corrected.require = eligiblePredicate();
    const correction = validateActionWorkUnitAssessment(f.context,f.compiled.draft,result.assessment).correction!;
    expect(correction.parent_digest).toBe(canonicalJsonDigest(f.compiled.draft)); expect(correction.source_ranges).toEqual([{start:2,end:2}]);
    expect(()=>assertActionWorkUnitCorrection(f.context,f.compiled.draft,corrected,correction)).not.toThrow();
    corrected.effect.set.status=statusLiteral("active");
    expect(()=>assertActionWorkUnitCorrection(f.context,f.compiled.draft,corrected,correction)).toThrow("ACTION_WORK_UNIT_CORRECTION_OUTSIDE_SCOPE");
  });
  it("checks nominated current requirements while another actually referenced Action stays unfinished", () => {
    const f = fixture(true), p = structuredClone(f.passages); p[1]!.disposition="implemented";
    p[2]!.draft_paths=["/actions/1/require"];
    const result=f.assess(p); expect(result.assessment.state).toBe("current_registered_requirements_satisfied");
    expect(result.scope.other_action_pending_indexes).toEqual([2]); expect(result.scope.whole_source_review_pending).toBe(true);
  });
  it("keeps an unlinked unresolved clause pending without inventing current or future applicability", () => {
    const f=fixture(),p=structuredClone(f.passages);p[1]!.disposition="implemented";
    const result=f.assess(p);expect(result.assessment.state).toBe("source_interpretation_pending");expect(result.scope.unscoped_pending_indexes).toEqual([2]);
  });
  it("does not use a broad all-Actions implementation claim as an exact current or global association",()=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.disposition="implemented";
    p[2]!.disposition="implemented";p[2]!.draft_paths=["/actions"];
    const result=f.assess(p);expect(result.assessment.state).toBe("source_interpretation_pending");expect(result.scope.unscoped_pending_indexes).toEqual([2]);
  });
  it.each(["root","component","mixed","evidence"] as const)("refuses automatic repair from an ambiguous association: %s",kind=>{
    const f=fixture(true),p=structuredClone(f.passages);
    p[1]!.draft_paths=kind==="root"?["/actions/0"]:kind==="component"?["/actions/0/require"]:kind==="mixed"?["/actions/0/require/expressions/2","/actions/1/require"]
      :["/actions/0/require/expressions/2"];
    if(kind==="evidence")p[1]!.evidence_checks=[{path:"/runner_evidence/actions/billing.pause_account/effect/operation",equals:"update"}];
    const result=f.assess(p);expect(result.assessment.state).toBe("source_interpretation_pending");expect(result.scope.subject_meaning_checked).toBe(false);
  });
  it("does not convert a current-evidence transcription error into an Action correction",()=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.evidence_checks=[{path:"/runner_evidence/actions/billing.pause_account/effect/operation",equals:"insert"}];
    expect(()=>f.report(p)).toThrow("Mechanical evidence mismatch");
  });
  it("nominates only an existing interpreted subject source node without choosing its replacement",()=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.draft_paths=["/actions/0/verification/resources/0/source"];
    const result=f.assess(p);expect(result.assessment).toMatchObject({state:"representation_mismatch",component:"subject",editable_paths:["/verification/resources/0/source"]});
    expect(result.scope.subject_meaning_checked).toBe(false);
    if(result.assessment.state!=="representation_mismatch")throw new Error("Missing subject nomination");
    const correction=validateActionWorkUnitAssessment(f.context,f.compiled.draft,result.assessment).correction!;
    const next=structuredClone(f.compiled.draft);next.verification.resources[0]!.fields=["status"];
    expect(()=>assertActionWorkUnitCorrection(f.context,f.compiled.draft,next,correction)).toThrow("OUTSIDE_SCOPE");
  });
  it.each(["missing","unavailable"] as const)("keeps %s actual caller reference-route metadata pending even for an implemented report",kind=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.disposition="implemented";p[2]!.disposition="background";
    if(kind==="missing")delete f.context.builtCatalog.authoring.resources[0]!.subject_reference;
    else f.context.builtCatalog.authoring.resources[0]!.subject_reference={obtainable:false,code:"REFERENCE_ROUTE_UNAVAILABLE"};
    const result=f.assess(p);expect(result.assessment.state).toBe("source_interpretation_pending");expect(result.scope.caller_reference_pending_bindings).toEqual(["account"]);
  });
  it("requires current route metadata and supports separately exact same-Action subject/predicate nodes",()=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.draft_paths=["/actions/0/verification/resources/0/source"];
    delete f.context.builtCatalog.authoring.resources[0]!.subject_reference;
    expect(f.assess(p).assessment.state).toBe("source_interpretation_pending");
    f.context.builtCatalog.authoring.resources[0]!.subject_reference={obtainable:true};
    p[1]!.draft_paths.push("/actions/0/require/expressions/2");expect(f.assess(p).assessment).toMatchObject({state:"representation_mismatch",component:"subject",
      editable_paths:["/verification/resources/0/source","/require/expressions/2"]});
  });
  it("retains a genuine shared field privacy conflict for the existing Read/catalog route",()=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.draft_paths=["/runner_evidence/actions/billing.pause_account/scoped_bindings/account/fields/status"];
    p[1]!.field_checks=[{resource:"billing.accounts",field:"status",expectation:"private"}];
    const result=f.assess(p);expect(result.assessment.state).toBe("source_interpretation_pending");expect(result.scope.applicable_global_indexes).toContain(1);expect(result.scope.read_catalog_pending_indexes).toEqual([1]);
    expect(f.compiled.draft.verification.resources[0]).not.toHaveProperty("model_visible");
  });
  it("binds exact already-private Action evidence absent from public field return",()=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.disposition="implemented";
    p[2]={start:3,end:3,disposition:"implemented",interpretation:"The reviewed hold fact stays private across current Read and Action uses.",draft_paths:["/runner_evidence/actions/billing.pause_account/scoped_bindings/account/fields/risk_hold"],field_checks:[{resource:"billing.accounts",field:"risk_hold",expectation:"private"}]};
    const result=f.assess(p);expect(result.assessment.state).toBe("current_registered_requirements_satisfied");expect(result.scope.applicable_global_indexes).toContain(2);
  });
  it.each(["Source","source_text","Read","history","prepared","report","catalog","compiled_binding"] as const)("rejects changed actual canonical inputs rather than stamping a pass: %s",kind=>{
    const f=fixture(),report=f.report(),expectedReportDigest=canonicalJsonDigest(report);
    if(kind==="Source")f.sources.snapshots[0]!.digest=canonicalJsonDigest("other literal policy");
    if(kind==="source_text")f.sources.snapshots[0]!.text+=" different text";
    if(kind==="Read")f.context.readBoundaryDigest=canonicalJsonDigest("different Read identity");
    if(kind==="history")f.sources.operator_messages=["A new attributed Source answer"];
    if(kind==="prepared")f.prepared.runner_evidence.read_review.pending.push("Changed review");
    if(kind==="report")report.passages[1]!.interpretation+=" changed";
    if(kind==="catalog")f.context.builtCatalog.authoring.resources[0]!.fields.find(field=>field.name==="status")!.role="runner_verification_only";
    if(kind==="compiled_binding"){
      const fields=f.prepared.runner_evidence.actions[f.compiled.draft.outcome]!.scoped_bindings.account!.fields;
      fields.status={...fields.status!,model_visible:false};
    }
    expect(()=>assessActionWorkUnitSource({context:f.context,currentAction:f.compiled.draft,preparedDraft:f.prepared,report,
      expectedReportDigest,sourceAnswerHistoryDigest:f.sourceAnswerHistoryDigest})).toThrow("ACTION_WORK_UNIT_SOURCE_");
  });
});

/** Synthetic ledger records use the actual producer record/factory shapes and
 * canonical parse/assembly. They do not supply an authenticated Main ledger. */
function episodeFixture(scoped = false) {
  const f=fixture(),contextKey=canonicalJsonDigest({owned_fixture:"actual-broad-key-supplied-by-host"}),episodeId=randomUUID();
  const narrow=canonicalJsonDigest({source:f.source.digest,draft:f.prepared,messages:f.sources.operator_messages??[]});
  let raw={passages:structuredClone(f.passages)},submissions:CoverageReviewEpisode["submissions"];
  if(!scoped)submissions=[{number:1,reserved_at:"2026-09-30T10:00:00.000Z",completed_at:"2026-09-30T10:00:01.000Z",validated:true,
    tentative:{status:"unaccepted_generation",context:narrow,raw_response:raw}}];
  else {
    const parent=structuredClone(raw);parent.passages[0]!.draft_paths=["/not_present","/actions/0/effect"];
    let failure:unknown;try{f.report(parent.passages);}catch(e){failure=e;}
    if(!failure)throw new Error("Missing initial structural failure");
    const repairContext={source:f.source,draft:f.prepared,messages:f.sources.operator_messages??[]};
    const feedback=collectCoverageFeedback(parent,f.source,f.prepared,repairContext.messages,failure,f.sources);
    const scope=createCoverageRepairScope(parent,feedback,repairContext,{ordinaryReferences:coverageReferences(f.prepared)});
    const replacement={representation:"replacement_only_v2",scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
      groups:[{target_id:scope.targets[0]!.target_id,passage_replacements:[{member_path:"/passages/0",fragments:[{category:"ordinary",passage:raw.passages[0]}]}],counter_replacements:[]}]};
    const assembly=assembleScopedCoverageReplacement(scope,parent,replacement,repairContext);raw=assembly.assembled as typeof raw;
    submissions=[{number:1,reserved_at:"2026-09-30T10:00:00.000Z",completed_at:"2026-09-30T10:00:01.000Z",validated:false,
      tentative:{status:"unaccepted_generation",context:narrow,raw_response:parent}},
      {number:2,reserved_at:"2026-09-30T10:00:02.000Z",completed_at:"2026-09-30T10:00:03.000Z",validated:true,
        tentative:{status:"unaccepted_generation",context:narrow,raw_response:replacement,raw_parent:parent,
          scope:JSON.parse(JSON.stringify(scope)),assembled:assembly.assembled,
          ...(assembly.audit.host_supplied_fields.length?{host_supplied_fields:assembly.audit.host_supplied_fields}:{})}}];
  }
  const provenance={context_key:contextKey,episode_id:episodeId,submission_number:submissions.length};
  const report=f.report(raw.passages),result=assessActionWorkUnitSource({context:f.context,currentAction:f.compiled.draft,preparedDraft:f.prepared,report,
    expectedReportDigest:canonicalJsonDigest(report),sourceAnswerHistoryDigest:f.sourceAnswerHistoryDigest,coverageProvenance:provenance});
  if(result.assessment.state!=="representation_mismatch")throw new Error("Missing original nomination");
  const saved:ActionRuleSourceRepairCheckpoint={original_parent:f.compiled.draft,correction:validateActionWorkUnitAssessment(f.context,f.compiled.draft,result.assessment).correction!,
    passage_indexes:result.assessment.source_review.passage_indexes,prepared_draft_digest:canonicalJsonDigest(f.prepared),corrections_used:1,coverage_provenance:provenance};
  f.sources.coverage_episodes=[{id:episodeId,context:contextKey,started_at:"2026-09-30T10:00:00.000Z",submissions}];
  const input={context:f.context,savedRepair:saved,originalPreparedDraft:f.prepared,expectedCoverageContextKey:contextKey,
    currentSourceSessionDigest:canonicalJsonDigest(f.sources),episodeIdentity:{id:episodeId,submission_number:submissions.length}};
  return {...f,input,saved,provenance,report};
}

describe("bounded original completed coverage episode reconstruction",()=>{
  it.each([false,true])("reparses the exact completed validated submission with fresh trusted scope when scoped=%s",scoped=>{
    const f=episodeFixture(scoped),result=reconstructOriginalActionWorkUnitSourceAssessment(f.input);
    expect(result.episodeIdentity).toEqual(f.input.episodeIdentity);expect(result.assessment).toMatchObject({component:"predicate",editable_paths:["/require/expressions/2"]});
    expect(result.assessment.source_review.coverage_provenance).toEqual(f.provenance);
    expect(validateActionWorkUnitAssessment(f.context,f.compiled.draft,result.assessment).correction).toEqual(f.saved.correction);
  });
  it.each(["missing_provenance","missing_ledger","unfinished","unvalidated","broad_context","narrow_context","report","prepared","session","answer_history","identity","duplicate"] as const)("refuses missing or changed original lineage: %s",kind=>{
    const f=episodeFixture(),sub=f.sources.coverage_episodes![0]!.submissions[0]!;
    if(kind==="missing_provenance")delete f.saved.coverage_provenance;
    if(kind==="missing_ledger")f.sources.coverage_episodes=[];
    if(kind==="unfinished")delete sub.completed_at;
    if(kind==="unvalidated")sub.validated=false;
    if(kind==="broad_context")f.input.expectedCoverageContextKey=canonicalJsonDigest("other broad key");
    if(kind==="narrow_context")sub.tentative!.context=canonicalJsonDigest("other narrow key");
    if(kind==="report")(sub.tentative!.raw_response as {passages:PolicyPassage[]}).passages[1]!.interpretation+=" modified";
    if(kind==="prepared")f.prepared.runner_evidence.read_review.pending.push("Different actual review");
    if(kind==="session")f.input.currentSourceSessionDigest=canonicalJsonDigest("different loaded ledger");
    if(kind==="answer_history")f.sources.operator_messages=["A newly attributed answer changes Source context"];
    if(kind==="identity")f.input.episodeIdentity.id=randomUUID();
    if(kind==="duplicate")f.sources.coverage_episodes!.push(structuredClone(f.sources.coverage_episodes![0]!));
    if(kind!=="session")f.input.currentSourceSessionDigest=canonicalJsonDigest(f.sources);
    expect(()=>reconstructOriginalActionWorkUnitSourceAssessment(f.input)).toThrow("ACTION_WORK_UNIT_SOURCE_");
  });
  it.each(["raw_parent","scope","assembled","audit"] as const)("refuses tampered scoped original assembly: %s",kind=>{
    const f=episodeFixture(true),t=f.sources.coverage_episodes![0]!.submissions[1]!.tentative!;
    if(kind==="raw_parent")(t.raw_parent as {passages:PolicyPassage[]}).passages[2]!.interpretation+=" other";
    if(kind==="scope")(t.scope as {outside_digest:string}).outside_digest=canonicalJsonDigest("other outside");
    if(kind==="assembled")(t.assembled as {passages:PolicyPassage[]}).passages[1]!.interpretation+=" other";
    if(kind==="audit")t.host_supplied_fields=[{member_path:"/passages/0",fields:["receipt_component"]}];
    f.input.currentSourceSessionDigest=canonicalJsonDigest(f.sources);
    expect(()=>reconstructOriginalActionWorkUnitSourceAssessment(f.input)).toThrow("ACTION_WORK_UNIT_SOURCE_");
  });
  it("requires retained-duty provenance rather than waiving it",()=>{
    const f=episodeFixture();const report={...f.report,retained_duty_history:[{prior_draft_digest:canonicalJsonDigest("older")}]} as unknown as typeof f.report;
    expect(()=>assessActionWorkUnitSource({context:f.context,currentAction:f.compiled.draft,preparedDraft:f.prepared,report,
      expectedReportDigest:canonicalJsonDigest(report),sourceAnswerHistoryDigest:f.sourceAnswerHistoryDigest})).toThrow("ACTION_WORK_UNIT_SOURCE_CONTEXT_CHANGED");
  });
  it.each(["unknown","id","zero","four","context"] as const)("rejects malformed closed episode provenance: %s",kind=>{
    const f=episodeFixture(),p:Record<string,unknown>={...f.provenance};
    if(kind==="unknown")p.extra="not an authority";if(kind==="id")p.episode_id="not-a-real-episode";
    if(kind==="zero")p.submission_number=0;if(kind==="four")p.submission_number=4;if(kind==="context")p.context_key="not a digest";
    expect(()=>parseActionWorkUnitCoverageProvenance(p)).toThrow("CHECKPOINT_INVALID");
  });
  it("preserves closed optional provenance and the existing bounded source counter in the Action checkpoint",()=>{
    const f=episodeFixture(),checkpoint=actionRuleAuthoringCheckpoint({intent_digest:canonicalJsonDigest("pause"),context_digest:canonicalJsonDigest("owned context"),components:{},source_repair:f.saved});
    expect(checkpoint.source_repair!.coverage_provenance).toEqual(f.provenance);expect(checkpoint.source_repair!.corrections_used).toBe(1);
    expect(Buffer.byteLength(JSON.stringify(checkpoint))).toBeLessThan(96*1024);
  });
  it("the actual producer copies original provenance intact before dispatch and stops when saving is refused",async()=>{
    const f=episodeFixture(),assessment=reconstructOriginalActionWorkUnitSourceAssessment(f.input).assessment;
    const requestJson=vi.fn();let checkpoint:ActionRuleAuthoringCheckpoint|undefined;
    await expect(generateModelActionRuleDraft({session:{provider:"openai",model:"owned-offline-model",dependencies:{requestJson},conversation:{turns:[],policySources:f.sources}},
      intent:"Repair the current interpreted Source association.",builtCatalog:f.context.builtCatalog,readBoundary:f.context.readBoundary,readBoundaryDigest:f.context.readBoundaryDigest,
      egressAcknowledged:true,env:{OPENAI_API_KEY:"owned-offline-test-key"},workUnitCorrection:{draft:f.compiled.draft,assessment},
      onCheckpoint:async value=>{checkpoint=value;throw new Error("OWNED_CHECKPOINT_CAS_REFUSED");}})).rejects.toThrow("OWNED_CHECKPOINT_CAS_REFUSED");
    expect(requestJson).not.toHaveBeenCalled();expect(checkpoint!.source_repair!.coverage_provenance).toEqual(f.provenance);
    expect(checkpoint!.source_repair!.corrections_used).toBe(1);
    console.info("Source provenance actual producer byte counts",JSON.stringify({checkpoint_bytes:Buffer.byteLength(JSON.stringify(checkpoint)),source_repair_bytes:Buffer.byteLength(JSON.stringify(checkpoint!.source_repair)),maximum_bytes:96*1024}));
  });
  it("the actual producer refuses callback provenance drift before any repaired send",async()=>{
    const f=episodeFixture(),assessment=reconstructOriginalActionWorkUnitSourceAssessment(f.input).assessment;
    const intent="Repair the current interpreted Source association.",requestJson=vi.fn();
    const checkpoint=actionRuleAuthoringCheckpoint({intent_digest:canonicalJsonDigest(intent),
      context_digest:canonicalJsonDigest({catalog:f.context.builtCatalog.catalog,read:f.context.readBoundaryDigest,baseline:null}),components:{},source_repair:f.saved});
    assessment.source_review.coverage_provenance={...f.provenance,episode_id:randomUUID()};
    await expect(generateModelActionRuleDraft({session:{provider:"openai",model:"owned-offline-model",dependencies:{requestJson},conversation:{turns:[],policySources:f.sources}},
      intent,builtCatalog:f.context.builtCatalog,readBoundary:f.context.readBoundary,readBoundaryDigest:f.context.readBoundaryDigest,
      egressAcknowledged:true,env:{OPENAI_API_KEY:"owned-offline-test-key"},checkpoint,revalidateSourceRepair:async()=>assessment,
      onCheckpoint:async()=>{}})).rejects.toThrow("ACTION_WORK_UNIT_SOURCE_CONTEXT_CHANGED");
    expect(requestJson).not.toHaveBeenCalled();
  });
});

function graphFixture(extraBinding = false) {
  const read=boundary(),built=builtCatalog();
  const unit=built.catalog.resources[0]!;
  const eligibility={...structuredClone(unit),name:'billing.eligibility',table:'eligibility',primary_key:'eligibility_id',fields:[
    {name:'eligibility_id',type:stringId,nullable:false},{name:'account_id',type:stringId,nullable:false},
    {name:'tenant_id',type:stringId,nullable:false},{name:'principal_id',type:stringId,nullable:false},
    {name:'version',type:{kind:'integer' as const},nullable:false},
    {name:'blocked',type:{kind:'boolean' as const},nullable:false},{name:'allowed',type:{kind:'boolean' as const},nullable:false}]};
  built.catalog.resources.push(eligibility);
  const authoring={...structuredClone(built.authoring.resources[0]!),name:eligibility.name,primary_key:eligibility.primary_key,
    subject_reference:{obtainable:false,code:'REFERENCE_ROUTE_UNAVAILABLE'},fields:eligibility.fields.map(f=>({...f,
      role:['eligibility_id','account_id','tenant_id','principal_id','version'].includes(f.name)?'guard' as const:'runner_verification_only' as const,writable:false}))};
  built.authoring.resources.push(authoring);
  const link={name:'eligibility_account',from_resource:eligibility.name,to_resource:unit.name,
    field_pairs:[{local_field:'account_id',target_field:'account_id'},{local_field:'tenant_id',target_field:'tenant_id'},{local_field:'principal_id',target_field:'principal_id'}],cardinality:'many_to_one' as const,target_unique:true,nullable:false};
  built.catalog.relationships=[link];built.authoring.relationships=[link];
  const eligibilityRead={...structuredClone(read.pack.resources[0]!),id:eligibility.name,table:eligibility.table,primary_key:eligibility.primary_key,
    selectable_fields:[],kept_out_fields:['blocked','allowed']};read.pack.resources.push(eligibilityRead);
  const source=policyTextSnapshot(Buffer.from('Select the subject and its scoped evidence.\nUse the exact current interpreted eligibility predicate.'),'owned-graph-route-policy.txt');
  const sources=newPolicySourceSession();sources.snapshots=[source];sources.active=source.version;
  const context:ActionWorkUnitContext={builtCatalog:built,readBoundary:read,readBoundaryDigest:explorationBoundaryCandidateDigest(read),policySources:sources};
  const draft=modelDraft();draft.verification.resources=[{binding:'eligibility',resource:eligibility.name,source:{kind:'subject_ref'},fields:['blocked','allowed']},
    {binding:'account',resource:unit.name,source:{kind:'relationship',from_binding:'eligibility',relationship:link.name,direction:'forward'},fields:['status','risk_hold']}];
  draft.require={kind:'all',expressions:[{kind:'compare',operator:'eq',left:{kind:'field',binding:'account',field:'status'},right:statusLiteral('active')},
    {kind:'compare',operator:'eq',left:{kind:'field',binding:'eligibility',field:'blocked'},right:{kind:'literal',value:false,value_type:{kind:'boolean'}}}]};
  if(extraBinding)draft.verification.resources.push({binding:'supporting_account',resource:unit.name,source:{kind:'subject_ref'},fields:['risk_hold']});
  const compiled=compileActionRuleModelDraft({...context,draft});
  const prepared=policyCoverageDraft({read,decisions:[],actions:[compiled],policySources:sources});
  const passages:PolicyPassage[]=[{start:1,end:1,disposition:'conflict',responsibility:'runner',issue_kind:'contradiction',interpretation:'These exact binding loaders need Source-assisted repair.',
    draft_paths:['/actions/0/verification/resources/0','/actions/0/verification/resources/1']},
    {start:2,end:2,disposition:'conflict',responsibility:'runner',issue_kind:'contradiction',interpretation:'This exact predicate needs collection-aware Source-assisted repair.',draft_paths:['/actions/0/require/expressions/1']}];
  const report=parsePolicyCoverage({passages},source,prepared,[],sources);
  return {context,compiled,prepared,report,passages,source,sources};
}

describe('offline real-compiler caller/evidence graph sequence',()=>{
  it('records actual parent order, missing many bound, old one-row predicate, then supported coherent graph',()=>{
    const f=graphFixture(),swapped=structuredClone(f.compiled.draft);
    swapped.verification.resources[0]!.source={kind:'relationship',from_binding:'account',relationship:'eligibility_account',direction:'inverse'};
    swapped.verification.resources[1]!.source={kind:'subject_ref'};
    let parentFailure='';try{compileActionRuleModelDraft({...f.context,draft:swapped});}catch(e){parentFailure=(e as Error).message;}
    expect(parentFailure).toContain('ordered before its parent');
    swapped.verification.resources.reverse();
    let boundFailure='';try{compileActionRuleModelDraft({...f.context,draft:swapped});}catch(e){boundFailure=(e as Error).message;}
    expect(boundFailure).toContain('max_rows');
    swapped.verification.resources[1]!.max_rows=25;swapped.verification.resources[1]!.overflow='ineligible';swapped.verification.resources[1]!.collection_consistency='complete_locked';
    let predicateFailure='';try{compileActionRuleModelDraft({...f.context,draft:swapped});}catch(e){predicateFailure=(e as Error).message;}
    expect(predicateFailure).toBeTruthy();
    const original=f.compiled.draft.require;if(original.kind!=='all')throw new Error('Missing original conjunction');
    swapped.require={kind:'all',expressions:[original.expressions[0]!,{kind:'not',expression:{kind:'exists',binding:'eligibility',where:{kind:'compare',operator:'eq',
      left:{kind:'field',binding:'eligibility',field:'blocked'},right:{kind:'literal',value:true,value_type:{kind:'boolean'}}}}}]};
    const compiled=compileActionRuleModelDraft({...f.context,draft:swapped});
    expect(compiled.verification_boundary.resources.map(r=>({binding:r.binding,cardinality:r.cardinality,max_rows:r.max_rows,source:r.source.kind}))).toEqual([
      {binding:'account',cardinality:'one',max_rows:1,source:'subject_ref'},{binding:'eligibility',cardinality:'many',max_rows:25,source:'relationship'}]);
    expect(compiled.draft.effect).toEqual(f.compiled.draft.effect);
    console.info('OWNED real compiler graph sequence',JSON.stringify({parentFailure,boundFailure,predicateFailure,normal_ready:true}));
  });
  it('exact current binding-region and nested predicate nominations form one confined repair',()=>{
    const f=graphFixture(),result=assessActionWorkUnitSource({context:f.context,currentAction:f.compiled.draft,preparedDraft:f.prepared,report:f.report,
      expectedReportDigest:canonicalJsonDigest(f.report),sourceAnswerHistoryDigest:canonicalJsonDigest([])});
    expect(result.assessment).toMatchObject({state:'representation_mismatch',component:'subject'});
    if(result.assessment.state!=='representation_mismatch')throw new Error('No Source nomination');
    expect(result.assessment.editable_paths).toContain('/verification/resources/0/max_rows');
    expect(result.assessment.editable_paths).toContain('/require/expressions/1');
    expect(result.assessment).toHaveProperty('binding_permutation',{slots:[0,1],original_bindings:['eligibility','account']});
  });
});

function graphRepair(extraBinding=false) {
  const f=graphFixture(extraBinding),result=assessActionWorkUnitSource({context:f.context,currentAction:f.compiled.draft,preparedDraft:f.prepared,report:f.report,
    expectedReportDigest:canonicalJsonDigest(f.report),sourceAnswerHistoryDigest:canonicalJsonDigest([])});
  if(result.assessment.state!=="representation_mismatch")throw new Error("Missing graph scope");
  const correction=validateActionWorkUnitAssessment(f.context,f.compiled.draft,result.assessment).correction!;
  const next=structuredClone(f.compiled.draft),[eligibility,account]=next.verification.resources;
  eligibility!.source={kind:"relationship",from_binding:"account",relationship:"eligibility_account",direction:"inverse"};
  eligibility!.max_rows=25;eligibility!.overflow="ineligible";eligibility!.collection_consistency="complete_locked";
  account!.source={kind:"subject_ref"};next.verification.resources.splice(0,2,account!,eligibility!);
  if(next.require.kind!=="all")throw new Error("Missing original predicate");
  next.require.expressions[1]={kind:"not",expression:{kind:"exists",binding:"eligibility",where:{kind:"compare",operator:"eq",
    left:{kind:"field",binding:"eligibility",field:"blocked"},right:{kind:"literal",value:true,value_type:{kind:"boolean"}}}}};
  return {...f,assessment:result.assessment,correction,next};
}

function expectGraphGuardReadback(compiled: ReturnType<typeof compileActionRuleModelDraft>) {
  const account=compiled.verification_boundary.resources.find(r=>r.binding==="account")!;
  const eligibility=compiled.verification_boundary.resources.find(r=>r.binding==="eligibility")!;
  expect(account.fields.map(f=>f.name)).toEqual(["account_id","principal_id","risk_hold","status","tenant_id","version"]);
  expect(eligibility.fields.map(f=>f.name)).toEqual(["account_id","allowed","blocked","eligibility_id","principal_id","tenant_id","version"]);
  for(const resource of [account,eligibility]) for(const field of resource.fields.filter(f=>["account_id","eligibility_id","tenant_id","principal_id","version","blocked","allowed"].includes(f.name)))
    expect(field.model_visible).toBe(false);
  expect(compiled.draft.verification.resources.find(r=>r.binding==="account")!.fields).toEqual(["status","risk_hold"]);
  expect(compiled.draft.verification.resources.find(r=>r.binding==="eligibility")!.fields).toEqual(["blocked","allowed"]);
}

describe("identity-bound routing/loader and predicate scope",()=>{
  it("aligns moved bindings to original IDs before masks and compiles the explicitly chosen complete repair",()=>{
    const f=graphRepair(true);expect(()=>assertActionWorkUnitCorrection(f.context,f.compiled.draft,f.next,f.correction)).not.toThrow();
    const compiled=compileActionRuleModelDraft({...f.context,draft:f.next});expect(compiled.draft.effect).toEqual(f.compiled.draft.effect);
    expectGraphGuardReadback(compiled);
    expect(compiled.verification_boundary.resources[1]!.fields.find(field=>field.name==="blocked")!.model_visible).toBe(false);
    expect(f.correction.binding_permutation).toEqual({slots:[0,1],original_bindings:["eligibility","account"]});
  });
  it.each(["add","drop","duplicate","rename","resource","fields","order","other_slot","approval","ttl","other_predicate"] as const)("rejects outside-mask graph change: %s",kind=>{
    const f=graphRepair(true),next=structuredClone(f.next);
    if(kind==="add")next.verification.resources.push({...next.verification.resources[0]!,binding:"extra"});
    if(kind==="drop")next.verification.resources.pop();
    if(kind==="duplicate")next.verification.resources[1]!.binding="account";
    if(kind==="rename")next.verification.resources[1]!.binding="renamed";
    if(kind==="resource")next.verification.resources[1]!.resource="billing.accounts";
    if(kind==="fields")next.verification.resources[1]!.fields=["allowed"];
    if(kind==="order")next.verification.resources[1]!.deterministic_order=[{field:"eligibility_id",direction:"desc"}];
    if(kind==="other_slot")[next.verification.resources[0],next.verification.resources[2]]=[next.verification.resources[2]!,next.verification.resources[0]!];
    if(kind==="approval")next.approval.required_approvals=2;if(kind==="ttl")next.ttl_seconds++;
    if(kind==="other_predicate"&&next.require.kind==="all")next.require.expressions[0]=eligiblePredicate();
    expect(()=>assertActionWorkUnitCorrection(f.context,f.compiled.draft,next,f.correction)).toThrow("OUTSIDE_SCOPE");
  });
  it("allows absent loader fields only from exact region nomination, and refuses region-to-identity widening",()=>{
    const f=graphRepair();const review=structuredClone(f.assessment.source_review);
    review.report.passages[0]!.draft_paths=["/actions/0/verification/resources/0/source","/actions/0/verification/resources/1/source"];
    expect(()=>validateActionWorkUnitAssessment(f.context,f.compiled.draft,{...f.assessment,source_review:review})).toThrow("ASSESSMENT_INCOMPLETE");
    for(const path of ["/verification/resources/0","/verification/resources/0/binding","/verification/resources/0/resource","/verification/resources/0/fields","/verification/resources/0/deterministic_order"])
      expect(()=>validateActionWorkUnitAssessment(f.context,f.compiled.draft,{...f.assessment,editable_paths:[path]})).toThrow("ASSESSMENT_INCOMPLETE");
  });
  it("publishes only existing binding and Boolean nodes in the real finite reference inventory",()=>{
    const f=graphRepair(),refs=coverageReferences(f.prepared);
    expect(refs).toContain("/actions/0/verification/resources/0");expect(refs).toContain("/actions/0/verification/resources/0/source");
    expect(refs).toContain("/actions/0/require/expressions/1");expect(refs).not.toContain("/actions/0/verification/resources/0/max_rows");
    expect(refs).not.toContain("/actions/0/approval/auto_approve_when");expect(refs).not.toContain("/actions/0/verification/resources/99");
  });
  it("roundtrips original selected slots/mask through a completed canonical episode and refuses changed mapping",()=>{
    const f=graphRepair(),provenance={context_key:canonicalJsonDigest("owned-original-graph-review-key"),episode_id:randomUUID(),submission_number:1};
    f.assessment.source_review.coverage_provenance=provenance;
    f.sources.coverage_episodes=[{id:provenance.episode_id,context:provenance.context_key,started_at:"2026-09-30T10:00:00Z",submissions:[{number:1,
      reserved_at:"2026-09-30T10:00:00Z",completed_at:"2026-09-30T10:00:01Z",validated:true,tentative:{status:"unaccepted_generation",
        context:canonicalJsonDigest({source:f.source.digest,draft:f.prepared,messages:[]}),raw_response:{passages:f.passages}}}]}];
    const repair:ActionRuleSourceRepairCheckpoint={original_parent:f.compiled.draft,correction:f.correction,passage_indexes:[0,1],
      prepared_draft_digest:canonicalJsonDigest(f.prepared),corrections_used:1,coverage_provenance:provenance};
    const checkpoint=actionRuleAuthoringCheckpoint({intent_digest:canonicalJsonDigest("repair graph"),context_digest:canonicalJsonDigest("current"),components:{},source_repair:repair});
    const input={context:f.context,savedRepair:checkpoint.source_repair!,originalPreparedDraft:f.prepared,expectedCoverageContextKey:provenance.context_key,currentSourceSessionDigest:canonicalJsonDigest(f.sources)};
    const restored=reconstructOriginalActionWorkUnitSourceAssessment(input);expect(restored.assessment.binding_permutation).toEqual(f.correction.binding_permutation);
    expect(()=>assertActionWorkUnitCorrection(f.context,f.compiled.draft,f.next,validateActionWorkUnitAssessment(f.context,f.compiled.draft,restored.assessment).correction!)).not.toThrow();
    input.savedRepair.correction.binding_permutation!.original_bindings.reverse();
    expect(()=>reconstructOriginalActionWorkUnitSourceAssessment(input)).toThrow("ASSESSMENT_INCOMPLETE");
  });
  it("measures actual outgoing Source definitions for fifty Actions without opening arbitrary references",async()=>{
    const f=graphRepair(),actions=Array.from({length:50},(_,i)=>{
      const draft=structuredClone(f.compiled.draft);draft.name=draft.outcome=`billing.action_${i}`;
      draft.verification.name=`billing.verification_${i}`;draft.effect.name=`billing.effect_${i}`;draft.approval.class_name=`billing.approval_${i}`;
      return compileActionRuleModelDraft({...f.context,draft});});
    const prepared=policyCoverageDraft({read:f.context.readBoundary,decisions:[],actions,policySources:f.sources});
    f.sources.approvals=[{digest:f.source.digest,destination:authoringDestination({provider:"openai",model:"owned-offline-source-model"})}];
    const requests:Record<string,unknown>[]=[];
    const result=await reviewPolicyCoverage({source:f.source,draft:prepared,sourceSession:f.sources,env:{OPENAI_API_KEY:"owned-offline-test-key"},
      session:{provider:"openai",model:"owned-offline-source-model",conversation:{turns:[],policySources:f.sources},dependencies:{requestJson:async request=>{
        requests.push(request.body as Record<string,unknown>);
        return {status:200,body:{output:[{type:"function_call",call_id:"owned_coverage",name:"runner__review_policy_coverage",arguments:JSON.stringify({passages:f.passages})}]}};
      }}}});
    const encoded=JSON.stringify(requests[0]!.tools);
    const definitions=requests[0]!.tools as Array<{parameters:{properties:{passages:{items:{properties:{draft_paths:{items:Record<string,unknown>}}}}}}}>;
    const accepts=new Ajv2020({strict:false}).compile(definitions[0]!.parameters.properties.passages.items.properties.draft_paths.items);
    expect(accepts("/actions/49/verification/resources/1/source")).toBe(true);expect(accepts("/actions/49/require/expressions/1")).toBe(true);
    expect(accepts("/actions/49/verification/resources/0/max_rows")).toBe(false);expect(accepts("/actions/50/verification/resources/1/source")).toBe(false);
    expect(Buffer.byteLength(encoded)).toBeLessThan(131072);expect(result.draft_digest).toBe(canonicalJsonDigest(prepared));
    console.info("OWNED fifty Action outgoing Source definitions",JSON.stringify({tool_definitions_bytes:Buffer.byteLength(encoded),request_bytes:Buffer.byteLength(JSON.stringify(requests[0])),actual_action_count:50,maximum_schema_bytes:131072}));
  });
  it("the actual repaired producer preserves the composite scope across pause/reopen and uses its second total invocation",async()=>{
    const f=graphRepair(),intent="Repair only the exact currently nominated graph and predicate.",provenance={context_key:canonicalJsonDigest("owned-graph-context"),episode_id:randomUUID(),submission_number:1};
    f.sources.approvals=[{digest:f.source.digest,destination:authoringDestination({provider:"openai",model:"owned-offline-model"})}];
    f.assessment.source_review.coverage_provenance=provenance;
    const common={intent,builtCatalog:f.context.builtCatalog,readBoundary:f.context.readBoundary,readBoundaryDigest:f.context.readBoundaryDigest,
      egressAcknowledged:true,env:{OPENAI_API_KEY:"owned-offline-test-key"}};
    const tool=(name:string,args:unknown)=>({status:200,body:{output:[{type:"function_call",call_id:name,name,arguments:JSON.stringify(args)}]}});
    const wrong={status:"draft",name:f.next.name,outcome:f.next.outcome,require:f.next.require,derive:f.next.derive,
      ...(f.next.inputs ? {inputs:f.next.inputs} : {}),ttl_seconds:f.next.ttl_seconds+1,review:f.next.review};
    const steps=[tool("runner__submit_verification_boundary_draft",{status:"draft",...f.next.verification}),tool("runner__submit_action_rule_draft",wrong),
      tool("runner__validate_action_draft",{}),tool("runner__submit_approval_policy_draft",{status:"clarification",question:"Resume this exact nominated repair later?"})];
    let checkpoint:ActionRuleAuthoringCheckpoint|undefined;const encoded:string[]=[];
    await expect(generateModelActionRuleDraft({...common,workUnitCorrection:{draft:f.compiled.draft,assessment:f.assessment},
      session:{provider:"openai",model:"owned-offline-model",conversation:{turns:[],policySources:f.sources},dependencies:{requestJson:async request=>{encoded.push(JSON.stringify(request.body));return steps.shift()!;}}},
      onCheckpoint:async value=>{checkpoint=JSON.parse(JSON.stringify(value));},askClarification:async()=>undefined})).rejects.toThrow("CANCELLED");
    expect(encoded.join("\n")).toContain("ACTION_WORK_UNIT_CORRECTION_OUTSIDE_SCOPE");
    expect(checkpoint!.source_repair!.correction.binding_permutation).toEqual(f.correction.binding_permutation);expect(checkpoint!.source_repair!.corrections_used).toBe(1);
    const resumeSteps=[tool("runner__submit_verification_boundary_draft",{status:"draft",...f.next.verification}),
      tool("runner__submit_action_rule_draft",{...wrong,ttl_seconds:f.next.ttl_seconds}),tool("runner__validate_action_draft",{}),
      {status:200,body:{output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"The confined graph compiles; current Source review remains pending."}]}]}}];
    const requestJson=vi.fn(async request=>{
      const step=resumeSteps.shift();if(!step)throw new Error("OWNED_RESUME_STEPS_EXHAUSTED");
      return step;
    });
    const result=await generateModelActionRuleDraft({...common,checkpoint,revalidateSourceRepair:async()=>f.assessment,
      session:{provider:"openai",model:"owned-offline-model",conversation:{turns:[],policySources:f.sources},dependencies:{requestJson}},onCheckpoint:async value=>{checkpoint=value;},
      askClarification:async()=>"Continue repairing only the exact nominated graph and predicate."});
    expect(result.compiled.draft).toEqual(compileActionRuleModelDraft({...f.context,draft:f.next}).draft);
    expectGraphGuardReadback(result.compiled);
    expect(checkpoint!.source_repair!.original_parent).toEqual(f.compiled.draft);expect(checkpoint!.source_repair!.corrections_used).toBe(2);
    expect(checkpoint!.source_repair!.correction).toEqual(f.correction);expect(checkpoint!.source_repair!.coverage_provenance).toEqual(provenance);
    const requestAfter=vi.fn();await expect(generateModelActionRuleDraft({...common,checkpoint,revalidateSourceRepair:async()=>f.assessment,
      session:{provider:"openai",model:"owned-offline-model",conversation:{turns:[],policySources:f.sources},dependencies:{requestJson:requestAfter}},onCheckpoint:async()=>{}})).rejects.toThrow("SOURCE_REPAIR_EXHAUSTED");
    expect(requestAfter).not.toHaveBeenCalled();console.info("OWNED composite checkpoint bytes",JSON.stringify({checkpoint:Buffer.byteLength(JSON.stringify(checkpoint)),repair:Buffer.byteLength(JSON.stringify(checkpoint!.source_repair)),max:98304}));
  });
  it("the focused producer edits only nominated verification/rule phases with identical original fields and one durable invocation",async()=>{
    const f=graphRepair(),calls:string[]=[];let checkpoint:ActionRuleAuthoringCheckpoint|undefined;
    const provenance={context_key:canonicalJsonDigest("owned-focused-original-graph-review-key"),episode_id:randomUUID(),submission_number:1};
    f.assessment.source_review.coverage_provenance=provenance;
    f.sources.coverage_episodes=[{id:provenance.episode_id,context:provenance.context_key,started_at:"2026-09-30T10:00:00Z",submissions:[{number:1,
      reserved_at:"2026-09-30T10:00:00Z",completed_at:"2026-09-30T10:00:01Z",validated:true,tentative:{status:"unaccepted_generation",
        context:canonicalJsonDigest({source:f.source.digest,draft:f.prepared,messages:[]}),raw_response:{passages:f.passages}}}]}];
    f.sources.approvals=[{digest:f.source.digest,destination:authoringDestination({provider:"openai",model:"owned-offline-model"})}];
    const result=await generateFocusedModelActionRuleDraft({intent:"Repair only the exact current Source nomination.",builtCatalog:f.context.builtCatalog,
      readBoundary:f.context.readBoundary,readBoundaryDigest:f.context.readBoundaryDigest,egressAcknowledged:true,env:{OPENAI_API_KEY:"owned-offline-test-key"},
      workUnitCorrection:{draft:f.compiled.draft,assessment:f.assessment},onCheckpoint:async value=>{checkpoint=value;},
      session:{provider:"openai",model:"owned-offline-model",conversation:{turns:[],policySources:f.sources},dependencies:{requestJson:async request=>{
        const definitions=(request.body as Record<string,unknown>).tools as Array<{name?:string;function?:{name:string}}>;
        const name=definitions[0]!.name??definitions[0]!.function!.name;calls.push(name);
        const args=name.endsWith("submit_verification_boundary_draft")?{status:"draft",...f.next.verification}
          :{status:"draft",name:f.next.name,outcome:f.next.outcome,require:f.next.require,derive:f.next.derive,ttl_seconds:f.next.ttl_seconds,review:f.next.review};
        return {status:200,body:{output:[{type:"function_call",call_id:name,name,arguments:JSON.stringify(args)}]}};
      }}}});
    expect(calls).toHaveLength(2);expect(calls[0]).toContain("submit_verification_boundary_draft");expect(calls[1]).toContain("submit_action_rule_draft");
    expect(result.compiled.draft).toEqual(compileActionRuleModelDraft({...f.context,draft:f.next}).draft);
    expectGraphGuardReadback(result.compiled);
    expect(checkpoint!.source_repair!.corrections_used).toBe(1);expect(checkpoint!.source_repair!.correction).toEqual(f.correction);
    const staleCatalog=structuredClone(f.context.builtCatalog);
    staleCatalog.authoring.resources.find(r=>r.name==="billing.eligibility")!.fields.find(field=>field.name==="blocked")!.role="model_visible";
    const requestAfter=vi.fn();
    await expect(generateFocusedModelActionRuleDraft({intent:"Repair only the exact current Source nomination.",builtCatalog:staleCatalog,
      readBoundary:f.context.readBoundary,readBoundaryDigest:f.context.readBoundaryDigest,egressAcknowledged:true,env:{OPENAI_API_KEY:"owned-offline-test-key"},
      checkpoint,revalidateSourceRepair:async(savedRepair,context)=>reconstructOriginalActionWorkUnitSourceAssessment({context,savedRepair,
        originalPreparedDraft:f.prepared,expectedCoverageContextKey:provenance.context_key,currentSourceSessionDigest:canonicalJsonDigest(f.sources)}).assessment,onCheckpoint:async()=>{},
      session:{provider:"openai",model:"owned-offline-model",conversation:{turns:[],policySources:f.sources},dependencies:{requestJson:requestAfter}}})).rejects.toThrow("SOURCE_CONTEXT_CHANGED");
    expect(requestAfter).not.toHaveBeenCalled();
  });
  it.each(["add","delete","reorder"] as const)("the actual repaired producer refuses declaration field %s before accepting the unchanged list",async kind=>{
    const f=graphRepair(),verification=structuredClone(f.next.verification),encoded:string[]=[];
    const fields=verification.resources.find(r=>r.binding==="eligibility")!.fields;
    if(kind==="add")fields.push("version");if(kind==="delete")fields.pop();if(kind==="reorder")fields.reverse();
    f.sources.approvals=[{digest:f.source.digest,destination:authoringDestination({provider:"openai",model:"owned-offline-model"})}];
    const tool=(name:string,args:unknown)=>({status:200,body:{output:[{type:"function_call",call_id:name,name,arguments:JSON.stringify(args)}]}});
    const rule={status:"draft",name:f.next.name,outcome:f.next.outcome,require:f.next.require,derive:f.next.derive,ttl_seconds:f.next.ttl_seconds,review:f.next.review};
    const steps=[tool("runner__submit_verification_boundary_draft",{status:"draft",...verification}),tool("runner__submit_action_rule_draft",rule),
      tool("runner__validate_action_draft",{}),tool("runner__submit_verification_boundary_draft",{status:"draft",...f.next.verification}),
      tool("runner__validate_action_draft",{})];
    const result=await generateModelActionRuleDraft({intent:"Repair only the exact current Source nomination.",builtCatalog:f.context.builtCatalog,
      readBoundary:f.context.readBoundary,readBoundaryDigest:f.context.readBoundaryDigest,egressAcknowledged:true,env:{OPENAI_API_KEY:"owned-offline-test-key"},
      workUnitCorrection:{draft:f.compiled.draft,assessment:f.assessment},onCheckpoint:async()=>{},
      session:{provider:"openai",model:"owned-offline-model",conversation:{turns:[],policySources:f.sources},dependencies:{requestJson:async request=>{
        encoded.push(JSON.stringify(request.body));const step=steps.shift();if(!step)throw new Error("OWNED_FIELD_REPAIR_STEPS_EXHAUSTED");return step;
      }}}});
    expect(encoded.join("\n")).toContain("ACTION_WORK_UNIT_CORRECTION_OUTSIDE_SCOPE");expect(steps).toEqual([]);
    expect(result.compiled.draft).toEqual(compileActionRuleModelDraft({...f.context,draft:f.next}).draft);expectGraphGuardReadback(result.compiled);
  });
});

const lock = `sha256:${"a".repeat(64)}` as const;
const stringId = { kind: "string", max_length: 64, comparison: "exact" } as const;
const statusType: ActionRuleScalarTypeSpecV1 = {
  kind: "string",
  max_length: 8,
  comparison: "exact",
  enum: ["active", "paused"],
};

function payloadFor(name: string): Record<string, unknown> {
  if (name.endsWith("submit_verification_boundary_draft")) {
    return {
      status: "draft",
      name: "billing.pause_account_verification",
      resources: [{
        binding: "account",
        resource: "billing.accounts",
        source: { kind: "subject_ref" },
        fields: ["status", "risk_hold"],
      }],
    };
  }
  if (name.endsWith("submit_effect_envelope_draft")) {
    return {
      status: "draft",
      name: "billing.pause_account_effect",
      operation: "update",
      target_resource: "billing.accounts",
      target_binding: "account",
      allowed_fields: [{ name: "status", values: ["paused"] }],
      set: { status: statusLiteral("paused") },
      writeback: "proposal_only",
    };
  }
  if (name.endsWith("submit_action_rule_draft")) return rulePayload(eligiblePredicate());
  if (name.endsWith("submit_approval_policy_draft")) {
    return {
      status: "draft",
      class_name: "billing.human_pause",
      mode: "human",
      required_role: "billing_reviewer",
      required_approvals: 1,
      shared_limits: [],
    };
  }
  throw new Error(`Unexpected authoring tool ${name}.`);
}

function rulePayload(require: ActionRuleBooleanExpressionV1): Record<string, unknown> {
  return {
    status: "draft",
    name: "billing.pause_account",
    outcome: "billing.pause_account",
    require,
    derive: {},
    ttl_seconds: 300,
    review: {
      when: "The account is active and has no risk hold.",
      then: "Propose setting the account status to paused.",
      refused: ["The account is already paused.", "A risk hold exists."],
      human_review: "Every eligible proposal requires one billing reviewer.",
      examples: [
        { kind: "eligible", scenario: "Active account without a hold", result: "Propose paused" },
        { kind: "ineligible", scenario: "Risk hold is present", result: "Refuse" },
      ],
    },
  };
}

function eligiblePredicate(binding = "account"): ActionRuleBooleanExpressionV1 {
  return {
    kind: "all",
    expressions: [
      {
        kind: "compare",
        operator: "eq",
        left: { kind: "field", binding, field: "status" },
        right: statusLiteral("active"),
      },
      {
        kind: "compare",
        operator: "eq",
        left: { kind: "field", binding, field: "risk_hold" },
        right: { kind: "literal", value: false, value_type: { kind: "boolean" } },
      },
    ],
  };
}

function modelDraft(): ActionRuleModelDraftV1 {
  const { status: _verificationStatus, ...verification } = payloadFor("submit_verification_boundary_draft");
  const { status: _effectStatus, ...effect } = payloadFor("submit_effect_envelope_draft");
  const { status: _approvalStatus, ...approval } = payloadFor("submit_approval_policy_draft");
  return {
    schema_version: "synapsor.action-rule-model-draft.v1",
    name: "billing.pause_account",
    outcome: "billing.pause_account",
    verification: verification as ActionRuleModelDraftV1["verification"],
    effect: effect as ActionRuleModelDraftV1["effect"],
    require: eligiblePredicate(),
    derive: {},
    approval: approval as ActionRuleModelDraftV1["approval"],
    ttl_seconds: 300,
    review: rulePayload(eligiblePredicate()).review as ActionRuleModelDraftV1["review"],
  };
}

function statusLiteral(value: "active" | "paused") {
  return { kind: "literal" as const, value, value_type: structuredClone(statusType) };
}

function builtCatalog(): BuiltActionRuleAuthoringCatalogV1 {
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "billing.accounts",
      source: "local_postgres",
      engine: "postgres",
      schema: "billing",
      table: "accounts",
      primary_key: "account_id",
      tenant_key: "tenant_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      fields: [
        { name: "account_id", type: stringId, nullable: false },
        { name: "tenant_id", type: stringId, nullable: false },
        { name: "principal_id", type: stringId, nullable: false },
        { name: "status", type: statusType, nullable: false },
        { name: "risk_hold", type: { kind: "boolean" }, nullable: false },
        { name: "version", type: { kind: "integer" }, nullable: false },
      ],
    }],
    relationships: [],
  };
  return {
    catalog,
    authoring: {
      schema_version: "synapsor.action-rule-authoring-catalog.v1",
      source: "local_postgres",
      engine: "postgres",
      read_boundary_name: "billing_read",
      generation_lock_fingerprint: lock,
      resources: [{
        name: "billing.accounts",
        primary_key: "account_id",
        tenant_scope: "direct",
        tenant_key: "tenant_id",
        principal_scope: "direct",
        principal_key: "principal_id",
        version_candidates: ["version"],
        selected_version_field: "version",
        subject_reference: { obtainable: true },
        operations: { update: true, insert: false },
        fields: catalog.resources[0]!.fields.map((field) => ({
          ...field,
          role: ["account_id", "tenant_id", "principal_id", "version"].includes(field.name)
            ? "guard" as const
            : field.name === "risk_hold"
              ? "runner_verification_only" as const
              : "model_visible" as const,
          writable: field.name === "status" || field.name === "risk_hold",
          ...(field.type.kind === "string" && field.type.enum ? { enum_source: "schema" as const } : {}),
        })),
      }],
      relationships: [],
      supported_language: {
        comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
        predicates: ["all", "any", "not", "null_check", "in", "exists"],
        aggregates: ["count", "sum", "min", "max"],
        arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"],
        effects: ["single_row_update", "single_row_insert"],
      },
      diagnostics: [],
      digest: `sha256:${"c".repeat(64)}`,
    },
  };
}

function boundary(): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "production",
    source: "local_postgres",
    compiler_version: "test",
    spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "TENANT", principal_env: "PRINCIPAL" },
    generation_lock_fingerprint: lock,
    role_posture_fingerprint: `sha256:${"d".repeat(64)}`,
    pack: {
      name: "billing_read",
      resources: [{
        id: "billing.accounts",
        schema: "billing",
        table: "accounts",
        primary_key: "account_id",
        tenant_key: "tenant_id",
        principal_key: "principal_id",
        field_types: {},
        field_enums: {},
        selectable_fields: ["status"],
        filterable_fields: {},
        sortable_fields: [],
        groupable_fields: [],
        aggregate_measures: [],
        count_distinct_fields: [],
        time_bucket_fields: {},
        kept_out_fields: ["risk_hold"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: {
      max_rows: 50,
      max_groups: 50,
      max_top_n: 25,
      max_measures: 3,
      max_dimensions: 3,
      max_time_ranges: 2,
      max_relationship_hops: 2,
      max_response_cells: 500,
      max_response_bytes: 65_536,
      statement_timeout_ms: 3_000,
      max_complexity: 24,
      max_queries_per_session: 1_000,
      max_extracted_cells_per_session: 4_000,
      max_differencing_queries: 16,
      rate_limit_per_minute: 120,
    },
    unresolved_decisions: [],
  };
}
