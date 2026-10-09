import { STRUCTURED_AUTHORING_PROTOCOL_VERSION } from "./authoring-protocol.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { catalog, boundary, readDigest, values } from "./test-fixtures/typed-action-parameter.js";
import { manualSemanticActionDraft } from "./manual-semantic-action-editor.js";
import { actionRuleModelDraftFromAuthority, compileActionRuleModelDraft } from "./action-rule-draft.js";
import { semanticActionBusinessReviewLines } from "./boundary-commands.js";
import { buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, readActionRuleReviewSubjects } from "./action-rule-authority.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, readBoundaryAuthoringResumeStateHeld, writeBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeCurrentHeld } from "./boundary-authoring-resume.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { createTypedParameterQuestion } from "./authoring-typed-parameter-host.js";
import { resolveTypedParameterSourceRecords } from "./authoring-typed-parameter-source.js";
import { createNativeTypedParameterAdapter, type NativeTypedParameterPorts } from "./authoring-typed-parameter-native-adapter.js";
import type { TypedParameterBinding } from "./authoring-typed-parameter-binding.js";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"b64-native-parameter-adapter-"));await fs.chmod(root,0o700);roots.push(root);
 const context={builtCatalog:catalog(),readBoundary:boundary(),readBoundaryDigest:readDigest};
 const compiled=compileActionRuleModelDraft({...context,draft:manualSemanticActionDraft(values())});
 const authority=buildActionRuleAuthorityDraft({name:"warehouse_rules",action_boundary_name:"warehouse_actions",catalog:context.builtCatalog.catalog,
  rules:[{read_boundary_name:context.readBoundary.pack.name,read_boundary_digest:readDigest,verification_boundary:compiled.verification_boundary,effect_envelope:compiled.effect_envelope,rule:compiled.rule}],
  approval_classes:[compiled.approval_class],reviews:[{outcome:compiled.draft.outcome,...compiled.review}]});
 await writeActionRuleAuthorityDraft(root,authority);
 const subjects=await readActionRuleReviewSubjects(root),subject=subjects[0]!;
 const initial=compileActionRuleModelDraft({...context,draft:actionRuleModelDraftFromAuthority({authority:subject.authority.authority,outcome:compiled.draft.outcome,review:subject.authority.reviews[0]!,preserveVerificationFields:true})}).draft;
 const reference={kind:"saved_authority" as const,identity:subject.identity,authority_digest:subject.authority.digest,outcome:initial.outcome,draft_digest:digest(initial)};
 const binding:TypedParameterBinding={version:1,baseline:reference,origin:reference,initial_candidate_digest:reference.draft_digest,proposal_id:"real-file-parameter-review",operation_id:"real-file-edit-operation",applicability_digest:digest("reviewed current fixture"),targets:[{kind:"required_approvals",label:"Required warehouse reviewers",expected_baseline_approval_digest:digest(initial.approval),expected_approval_digest:digest(initial.approval)}]};
 const businessLines=(c:typeof compiled)=>semanticActionBusinessReviewLines(c,context.readBoundary);
 const resolved=resolveTypedParameterSourceRecords({binding,records:{subjects,checkpoints:[]},context,businessLines});
 const question=createTypedParameterQuestion({id:randomUUID(),revision:1,scope_digest:digest("scope"),context_digest:digest("context"),binding,resolved});
 const nativeBinding={boundary_name:"warehouse",generation_lock_fingerprint:digest("lock"),schema_fingerprint:digest("schema"),role_posture_fingerprint:digest("role")};
 const base={binding:nativeBinding,stage:"authority_review" as const,jobIntent:"Change required warehouse reviewers from one to two; keep other rules.",provider:"openai" as const,model:"unused-local-only"};
 await writeBoundaryAuthoringResumeState(root,buildBoundaryAuthoringResumeState({...base,authoringProtocol:{version:STRUCTURED_AUTHORING_PROTOCOL_VERSION},operatorQuestions:[question]}),{expectedRevisionDigest:null});
 const readState=async(loaded:Awaited<ReturnType<typeof readBoundaryAuthoringResumeState>>)=>{if(loaded.status!=="ready")throw new Error("Exact native state missing");return loaded.value;};
 const load=()=>readBoundaryAuthoringResumeState(root,nativeBinding).then(readState);
 const loadHeld=(permit:ProjectAuthorityMutationPermit)=>readBoundaryAuthoringResumeStateHeld(root,nativeBinding,permit).then(readState);
 let held=0,saveFault=false,ackFault=false;
 const ports:NativeTypedParameterPorts={
  loadCurrent:async permit=>{const saved=await loadHeld(permit);return{resume_revision:saved.revision_digest,questions:saved.operator_questions??[],handoffs:saved.owner_handoffs??[],generation:saved.generation_recovery,checkpoints:[],compiler_context:context};},
  assertCurrent:async(expected,permit)=>{const current=await loadHeld(permit);if(current.revision_digest!==expected.resume_revision||digest(expected.binding)!==digest(binding))throw new Error("NATIVE_ADAPTER_CONTEXT_STALE");await assertBoundaryAuthoringResumeCurrentHeld(root,current,permit);},
  mutate:operation=>withProjectAuthorityMutation(root,async permit=>{held++;try{return await operation(permit);}finally{held--;}}),
  saveQuestions:async(request,permit)=>{
   expect(held).toBe(1);if(saveFault)throw new Error("CONTROLLED_NATIVE_CAS_FAILURE");
   const current=await loadHeld(permit);expect(digest(current.operator_questions??[])).toBe(request.expected_questions_digest);
   const next=buildBoundaryAuthoringResumeState({...base,previous:current,operatorQuestions:request.questions});
   await writeBoundaryAuthoringResumeState(root,next,{expectedRevisionDigest:request.expected_resume_revision,permit});
   return{resume_revision:next.revision_digest,questions_digest:ackFault?digest("wrong acknowledgement"):digest(next.operator_questions??[])};
  },
 };
 const adapter=()=>createNativeTypedParameterAdapter({projectRoot:root,question_id:question.id,ports,businessLines});
 return{root,load,adapter,held:()=>held,subjects,binding,base,saveFault:()=>{saveFault=true;},ackFault:()=>{ackFault=true;}};
}
async function amendment(f:Awaited<ReturnType<typeof fixture>>){const adapter=f.adapter(),current=await adapter.loadCurrent(),field=current.view.fields[0]!;
 return{adapter,expected:{native:current.native,binding:current.view.binding},event:{kind:"replace_literal" as const,raw:"2",binding:current.view.binding,field_id:field.id,target_digest:field.target_digest,dependencies_digest:field.dependencies_digest}};}
it("composes actual authority/source/compiler with protected native question CAS and cold grouped readback",async()=>{
 const f=await fixture(),before=await f.load(),edit=await amendment(f);expect(f.held()).toBe(0);
 const ack=await edit.adapter.submitField(edit);expect(f.held()).toBe(0);
 const cold=await f.adapter().loadCurrent();expect({native:cold.native,binding:cold.view.binding}).toEqual(ack);expect(cold.domain.working.approval.required_approvals).toBe(2);
 const changed=await f.load();expect(changed.operator_questions![0]!.confirmation).toBeUndefined();expect(changed.operator_questions![0]!.proposal_history).toEqual([before.operator_questions![0]!.proposal]);
 expect(changed.operator_questions![0]!.typed_parameters).toEqual(before.operator_questions![0]!.typed_parameters);
 expect(await readActionRuleReviewSubjects(f.root)).toEqual(f.subjects);
 const decision=await f.adapter().recordDecision({expected:ack,accepted:true});expect(decision.binding).toEqual(ack.binding);expect(decision.native.question_revision).toBe(ack.native.question_revision);
 expect((await f.load()).operator_questions![0]!.confirmation?.proposal_digest).toBe(digest(changed.operator_questions![0]!.proposal));
 expect(await readActionRuleReviewSubjects(f.root)).toEqual(f.subjects);expect(f.held()).toBe(0);
});
it("refuses stale displayed field after a real competing native question write",async()=>{
 const f=await fixture(),stale=await amendment(f),competing=await amendment(f);await competing.adapter.submitField({...competing,event:{...competing.event,raw:"3"}});
 const before=await f.load();await expect(stale.adapter.submitField(stale)).rejects.toThrow("STALE");expect(await f.load()).toEqual(before);expect(f.held()).toBe(0);
});
it("native save failure returns no ACK and leaks no ephemeral candidate across a new load",async()=>{
 const f=await fixture(),edit=await amendment(f),before=await f.load();f.saveFault();await expect(edit.adapter.submitField(edit)).rejects.toThrow("CONTROLLED_NATIVE_CAS_FAILURE");
 expect(await f.load()).toEqual(before);expect((await f.adapter().loadCurrent()).domain.working.approval.required_approvals).toBe(1);expect(f.held()).toBe(0);
});
it("wrong durable ACK refuses completion while preserving the actually saved native history",async()=>{
 const f=await fixture(),edit=await amendment(f);f.ackFault();await expect(edit.adapter.submitField(edit)).rejects.toThrow("ACK");
 expect((await f.adapter().loadCurrent()).domain.working.approval.required_approvals).toBe(2);expect((await f.load()).operator_questions![0]!.confirmation).toBeUndefined();expect(f.held()).toBe(0);
});
