import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleCatalogV1 } from '@synapsor-runner/action-rules';
import type { ActionRuleBooleanExpressionV1, ActionRuleScalarTypeSpecV1 } from '@synapsor/spec';
import type { BuiltActionRuleAuthoringCatalogV1 } from './action-rule-authoring.js';
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from './auto-boundary.js';
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from './action-rule-draft.js';
import { newPolicySourceSession, policyTextSnapshot, type PolicyPassage, type CoverageReviewEpisode } from './authoring-policy-source.js';
import { policyCoverageDraft } from './authoring-policy-evidence.js';
import { parsePolicyCoverage, collectCoverageFeedback, coverageReferences } from './authoring-policy-coverage.js';
import { createCoverageRepairScope, assembleScopedCoverageReplacement } from './authoring-scoped-correction.js';
import { validateActionWorkUnitAssessment, assertActionWorkUnitCorrection, type ActionWorkUnitContext } from './action-authoring-work-unit-contract.js';
import { actionRuleAuthoringCheckpoint, parseActionWorkUnitCoverageProvenance, type ActionRuleSourceRepairCheckpoint, type ActionRuleAuthoringCheckpoint } from './action-rule-authoring-checkpoint.js';
import { generateModelActionRuleDraft } from './action-rule-model.js';
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
  it.each(["root","component","mixed","binding_root","evidence"] as const)("refuses automatic repair from an ambiguous association: %s",kind=>{
    const f=fixture(true),p=structuredClone(f.passages);
    p[1]!.draft_paths=kind==="root"?["/actions/0"]:kind==="component"?["/actions/0/require"]:kind==="mixed"?["/actions/0/require/expressions/2","/actions/1/require"]
      :kind==="binding_root"?["/actions/0/verification/resources/0"]:["/actions/0/require/expressions/2"];
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
  it("requires current route metadata for a subject nomination and refuses a mixed component nomination",()=>{
    const f=fixture(),p=structuredClone(f.passages);p[1]!.draft_paths=["/actions/0/verification/resources/0/source"];
    delete f.context.builtCatalog.authoring.resources[0]!.subject_reference;
    expect(f.assess(p).assessment.state).toBe("source_interpretation_pending");
    f.context.builtCatalog.authoring.resources[0]!.subject_reference={obtainable:true};
    p[1]!.draft_paths.push("/actions/0/require/expressions/2");expect(f.assess(p).assessment.state).toBe("source_interpretation_pending");
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
