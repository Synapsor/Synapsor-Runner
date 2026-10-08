import { describe, it, expect } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { manualSemanticActionDraft } from "./manual-semantic-action-editor.js";
import { semanticActionBusinessReviewLines } from "./boundary-commands.js";
import { values, catalog, boundary, readDigest } from "./test-fixtures/typed-action-parameter.js";
import { parseOperatorQuestions, assertOperatorQuestionsAdvance, type OperatorQuestion } from "./authoring-operator-question.js";
import { createTypedParameterQuestion, createTypedParameterHost } from "./authoring-typed-parameter-host.js";
import type { TypedParameterBinding } from "./authoring-typed-parameter-binding.js";
import type { TypedFieldEvent } from "./authoring-typed-review.js";
const qid = "caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function fixture() {
 const builtCatalog=catalog(), readBoundary=boundary();
 const compile=(draft:ActionRuleModelDraftV1)=>{const c=compileActionRuleModelDraft({draft,builtCatalog,readBoundary,readBoundaryDigest:readDigest});return {draft:c.draft,business_lines:semanticActionBusinessReviewLines(c,readBoundary)};};
 const initial=compile(manualSemanticActionDraft(values())).draft;
 const ref={kind:"saved_authority" as const,identity:{location:"disabled" as const,record:"test-actual-record-reference",store:digest("store")},authority_digest:digest("test-authority"),outcome:initial.outcome,draft_digest:digest(initial)};
 const binding:TypedParameterBinding={version:1,baseline:ref,origin:ref,initial_candidate_digest:digest(initial),proposal_id:"typed-warehouse-review",operation_id:"typed-native-op",applicability_digest:digest("scope"),targets:[{kind:"required_approvals",label:"Required reviewers",expected_baseline_approval_digest:digest(initial.approval),expected_approval_digest:digest(initial.approval)}]};
 const resolved={baseline:initial,initial,compile};
 let questions:OperatorQuestion[]=[createTypedParameterQuestion({id:qid,revision:1,scope_digest:digest("scope"),context_digest:digest("context"),binding,resolved})];
 let saved=structuredClone(questions),fail=false;
 const access={readQuestions:()=>questions,readHandoffs:()=>[],readRecovery:()=>undefined,resolve:async()=>resolved,assertFresh:async()=>{},mutate:async <T>(fn:(permit:any)=>Promise<T>)=>{try{return await fn({});}catch(e){questions=structuredClone(saved);throw e;}},installQuestions:(next:OperatorQuestion[])=>{questions=next;},save:async()=>{if(fail)throw new Error("native CAS refused");assertOperatorQuestionsAdvance(saved,questions);parseOperatorQuestions(questions,[]);saved=structuredClone(questions);}};
 const host=()=>createTypedParameterHost({question_id:qid,access});
 return {binding,resolved,host,questions:()=>questions,saved:()=>saved,fail:()=>{fail=true;},replace:(next:OperatorQuestion[])=>{questions=next;}};
}
async function event(f:ReturnType<typeof fixture>,kind:"replace_literal"|"leave_pending"|"keep_suggestion",raw="2") {
 const h=f.host(),c=await h.loadCurrent(),field=c.view.fields[0]!;
 const e={kind,binding:c.view.binding,field_id:field.id,target_digest:field.target_digest,dependencies_digest:field.dependencies_digest,...(kind==="replace_literal"?{raw}:{})} as TypedFieldEvent;
 return {h,expected:{native:c.native,binding:c.view.binding},event:e};
}
describe("native typed parameter question owner",()=>{
 it("retains complete initial proposal/history and literal provenance through cold host reconstruction",async()=>{
  const f=fixture(),before=f.questions()[0]!,e=await event(f,"replace_literal");
  const ack=await e.h.submitField(e),cold=await f.host().loadCurrent();
  expect(cold.native).toEqual(ack.native);expect(cold.view.binding).toEqual(ack.binding);
  expect(cold.domain.working.approval.required_approvals).toBe(2);expect(cold.native.question_revision).toBe(1);
  const q=f.questions()[0]!;expect(q.raw_answer).toBeUndefined();expect(q.budget).toBeUndefined();expect(q.confirmation).toBeUndefined();
  expect(q.proposal_history).toEqual([before.proposal]);expect(q.typed_parameters).toEqual(before.typed_parameters);
  expect(q.proposal?.value).toMatchObject({kind:"typed_parameters",record:{event:{kind:"replace_literal",raw:"2"}}});
  await e.h.recordDecision({expected:ack,accepted:true});expect(f.questions()[0]!.confirmation).toBeDefined();
 });
 it("keeps explicit pending unresolved across restart and only exact valid event clears it",async()=>{
  const f=fixture(),e=await event(f,"leave_pending"),ack=await e.h.submitField(e);
  expect((await f.host().loadCurrent()).view.unresolved).not.toHaveLength(0);
  await expect(f.host().recordDecision({expected:ack,accepted:true})).rejects.toThrow("pending");
  const keep=await event(f,"keep_suggestion"),next=await keep.h.submitField(keep);expect((await f.host().loadCurrent()).view.unresolved).toHaveLength(0);
  expect(f.questions()[0]!.proposal?.value).toMatchObject({record:{event:{kind:"keep_suggestion"}}});
  expect((f.questions()[0]!.proposal?.value as any).record.event).not.toHaveProperty("raw");
  await f.host().recordDecision({expected:next,accepted:false});expect(f.questions()[0]!.confirmation).toBeUndefined();
 });
 it("failed protected save leaves no acknowledgement or uncommitted candidate",async()=>{
  const f=fixture(),before=structuredClone(f.saved()),e=await event(f,"replace_literal");f.fail();
  await expect(e.h.submitField(e)).rejects.toThrow("native CAS refused");expect(f.questions()).toEqual(before);
 });
 it("rejects stale event and immutable origin or history substitution",async()=>{
  const f=fixture(),e=await event(f,"replace_literal");await e.h.submitField(e);
  await expect(e.h.submitField(e)).rejects.toThrow("STALE");
  const corrupted=structuredClone(f.questions());corrupted[0]!.typed_parameters!.initial_candidate_digest=digest("other");
  const {digest:_,...body}=corrupted[0]!;corrupted[0]!.digest=digest(body);
  expect(()=>parseOperatorQuestions(corrupted,[])).toThrow();
 });
});
