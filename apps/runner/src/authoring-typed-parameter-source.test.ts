import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { values, catalog, boundary, readDigest } from "./test-fixtures/typed-action-parameter.js";
import { manualSemanticActionDraft } from "./manual-semantic-action-editor.js";
import { actionRuleModelDraftFromAuthority, compileActionRuleModelDraft } from "./action-rule-draft.js";
import { semanticActionBusinessReviewLines } from "./boundary-commands.js";
import { buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, readActionRuleReviewSubjects } from "./action-rule-authority.js";
import { generateModelActionRuleDraft } from "./action-rule-model.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, type BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, authoringActionCheckpoint } from "./authoring-generation-recovery.js";
import { actionLogicalTurnMaterialDigest, type ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { resolveTypedParameterSources, resolveTypedParameterSourceRecords } from "./authoring-typed-parameter-source.js";
import type { TypedParameterBinding, TypedParameterReference } from "./authoring-typed-parameter-binding.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const nativeBinding={boundary_name:"warehouse",generation_lock_fingerprint:digest("lock"),schema_fingerprint:digest("schema"),role_posture_fingerprint:digest("role")};
const intent="Prepare proposals setting enabled warehouse items' reorder threshold to a requested integer from 1 to 1000. Auto-approve at most 100; otherwise one warehouse_reviewer. Overall 10 and per customer 3 approvals per 86400 seconds. Expire requests after 300 seconds. Proposal only; no execution.";
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"typed-source-owned-"));roots.push(root);
 const context={builtCatalog:catalog(),readBoundary:boundary(),readBoundaryDigest:readDigest};
 const declared=manualSemanticActionDraft(values());
 // A new producer fixture declares the second explanation required by the
 // existing provider grammar; saved/manual one-example fixtures stay unchanged.
 declared.review.examples.push({kind:"ineligible",scenario:"The item has reorder disabled",result:"Refuse the requested change."});
 const compiled=compileActionRuleModelDraft({...context,draft:declared});
 const businessLines=(c:typeof compiled)=>semanticActionBusinessReviewLines(c,context.readBoundary);
 const binding=(ref:TypedParameterReference):TypedParameterBinding=>({version:1,baseline:ref,origin:ref,initial_candidate_digest:ref.draft_digest,proposal_id:"native-source-review",operation_id:"native-source-operation",applicability_digest:digest("applicability"),targets:[{kind:"required_approvals",label:"Required reviewers",expected_baseline_approval_digest:digest(compiled.draft.approval),expected_approval_digest:digest(compiled.draft.approval)}]});
 return {root,context,declared,compiled,businessLines,binding};
}
describe("typed parameter actual source resolution",()=>{
 it("reads exact saved authority files, full draft and reviewed identity; refuses substitutions without writes",async()=>{
  const f=await fixture();
  const draft=buildActionRuleAuthorityDraft({name:"warehouse_rules",action_boundary_name:"warehouse_actions",catalog:f.context.builtCatalog.catalog,rules:[{read_boundary_name:f.context.readBoundary.pack.name,read_boundary_digest:readDigest,verification_boundary:f.compiled.verification_boundary,effect_envelope:f.compiled.effect_envelope,rule:f.compiled.rule}],approval_classes:[f.compiled.approval_class],reviews:[{outcome:f.compiled.draft.outcome,...f.compiled.review}]});
  await writeActionRuleAuthorityDraft(f.root,draft);
  const subjects=await readActionRuleReviewSubjects(f.root);expect(subjects).toHaveLength(1);const selected=subjects[0]!;
  const baseline=compileActionRuleModelDraft({...f.context,draft:actionRuleModelDraftFromAuthority({authority:selected.authority.authority,outcome:f.compiled.draft.outcome,review:selected.authority.reviews[0]!,preserveVerificationFields:true})}).draft;
  const ref:TypedParameterReference={kind:"saved_authority",identity:selected.identity,authority_digest:selected.authority.digest,outcome:baseline.outcome,draft_digest:digest(baseline)};
  const input={projectRoot:f.root,resumeBinding:nativeBinding,binding:f.binding(ref),context:f.context,businessLines:f.businessLines};
  expect((await resolveTypedParameterSources(input)).initial).toEqual(baseline);
  for(const changed of [{...ref,identity:{...ref.identity,record:"foreign"}},{...ref,authority_digest:digest("foreign")},{...ref,draft_digest:digest("wrong normalized draft")}])
   await expect(resolveTypedParameterSources({...input,binding:f.binding(changed)})).rejects.toThrow();
  expect(await readActionRuleReviewSubjects(f.root)).toEqual(subjects);
 });
 it("reloads an actual Action producer compiled checkpoint from native Resume with exact consumed operation",async()=>{
  const f=await fixture(),input={binding:nativeBinding,stage:"action_drafting" as const,jobIntent:intent,provider:"openai" as const,model:"controlled-native-action"};
  let state=buildBoundaryAuthoringResumeState({...input,authoringProtocol:{version:"synapsor.structured-authoring.v1"}});
  await writeBoundaryAuthoringResumeState(f.root,state,{expectedRevisionDigest:null});
  const persist=async(next:BoundaryAuthoringResumeState)=>{await writeBoundaryAuthoringResumeState(f.root,next,{expectedRevisionDigest:state.revision_digest});state=next;};
  let checkpoint:ActionRuleAuthoringCheckpoint|undefined;let calls=0;
  const {verification,effect,approval,schema_version:_,...rule}=f.declared;
  const steps=[{name:"runner__submit_verification_boundary_draft",args:{status:"draft",...verification}},{name:"runner__submit_effect_envelope_draft",args:{status:"draft",...effect}},{name:"runner__submit_action_rule_draft",args:{status:"draft",...rule}},{name:"runner__submit_approval_policy_draft",args:{status:"draft",...approval}},{name:"runner__validate_action_draft",args:{}}];
  const result=await withAuthoringGenerationRecovery(async()=>{
   configureAuthoringGenerationRecovery({available:()=>true,read:()=>state.generation_recovery,current:async()=>digest("same-protected-source-context"),progress:()=>{},write:recovery=>persist(buildBoundaryAuthoringResumeState({...input,previous:state,generationRecovery:recovery}))});
   return generateModelActionRuleDraft({...f.context,intent,authoringProtocol:{version:"synapsor.structured-authoring.v1"},egressAcknowledged:true,expectedOutcome:f.declared.outcome,
    session:{provider:"openai",model:input.model,apiKey:"inert-local-only",dependencies:{requestJson:async request=>{
     const next=steps.shift();if(!next)throw new Error("Declared finite responder exhausted");
     const body=JSON.stringify(request.body);expect(body).toContain(next.name);expect(body).toContain("warehouse.items");calls++;
     return {status:200,body:{output:[{type:"function_call",call_id:`declared_${calls}`,name:next.name,arguments:JSON.stringify(next.args)}]}};
    }}},
    stageVersionQuestion:()=>{throw new Error("No Version question declared in this prepared fixture");},reviewVersionQuestion:async()=>{throw new Error("No Version review pending");},assertLogicalTurnBoundary:async()=>{throw new Error("Initial producer needs no rollover");},
    onCheckpoint:async(next,metadata)=>{
     if(metadata?.expected_checkpoint_digest!==checkpoint?.digest)throw new Error("Unexpected checkpoint predecessor");
     let recovery=state.generation_recovery;
     if(metadata?.ordinary_completion){const closed=metadata.ordinary_completion;expect(closed.kind).toBe("compiled_draft");recovery=authoringActionCheckpoint(recovery!,closed.completion,{consumer:"action_rule_components",kind:"compiled_draft",material_digest:closed.material_digest});}
     await persist(buildBoundaryAuthoringResumeState({...input,previous:state,generationRecovery:recovery,action:{intent,checkpoint:next}}));checkpoint=next;
    },deferCompletionMessage:true});
  });
  expect(result.state).toBe("ready");expect(calls).toBe(5);expect(steps).toHaveLength(0);
  const closed=checkpoint!.logical_turns!.at(-1)!.completed!;
  const ref:TypedParameterReference={kind:"compiled_checkpoint",checkpoint_digest:checkpoint!.digest,material_digest:actionLogicalTurnMaterialDigest(checkpoint!),completion:closed.completion,outcome:result.compiled.draft.outcome,draft_digest:digest(result.compiled.draft)};
  const resolution={projectRoot:f.root,resumeBinding:nativeBinding,binding:f.binding(ref),context:f.context,businessLines:f.businessLines};
  expect((await resolveTypedParameterSources(resolution)).initial).toEqual(result.compiled.draft);
  const loaded=await readBoundaryAuthoringResumeState(f.root,nativeBinding);if(loaded.status!=="ready")throw new Error("native saved state missing");
  const records={subjects:[],checkpoints:[loaded.value.action!.checkpoint!],generation:loaded.value.generation_recovery!};
  const before=digest(records);const foreign=structuredClone(records);foreign.generation.operations.find(op=>op.id===ref.completion.operation_id)!.state="handled";
  expect(()=>resolveTypedParameterSourceRecords({...resolution,records:foreign})).toThrow();
  expect(()=>resolveTypedParameterSourceRecords({...resolution,binding:f.binding({...ref,checkpoint_digest:digest("same bytes cannot replace identity")}),records})).toThrow();
  expect(digest(records)).toBe(before);expect((await readBoundaryAuthoringResumeState(f.root,nativeBinding))).toEqual(loaded);
 });
});
