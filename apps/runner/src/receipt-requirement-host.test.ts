import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { createBusinessStatementHost, type BusinessStatementRecordUpdate } from './authoring-business-statement-host.js';
import type { BusinessStatementInteraction, BusinessStatementResponse } from './authoring-business-statement-interaction.js';
import { assertOperatorQuestionsAdvance, parseOperatorQuestions } from './authoring-operator-question.js';
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources } from './authoring-policy-source.js';
import { receiptRequirementCheckpoint } from './authoring-receipt-requirement-host.js';
import { currentReceiptRequirement, receiptRequirementDependencies, receiptRequirementPreparedContext,
  receiptRequirementQuestionContext, receiptRequirementSourceBinding } from './authoring-receipt-requirement.js';
import { withProjectAuthorityMutation } from './project-authority-mutation.js';
import type { ProviderHttpInput } from './model-ask.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive:true,force:true}); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-host-')); roots.push(root);
  const source = policyTextSnapshot(Buffer.from('Describe a change as complete only from its trusted completion receipt.'), 'declared-policy.txt');
  const sources = newPolicySourceSession(); sources.snapshots = [source]; sources.active = source.version;
  await savePolicySources(root, sources);
  const store = canonicalJsonDigest('declared local store'), scope = canonicalJsonDigest('declared current job');
  const draft = { read: {source:'lab'}, actions: [{name:'Change a plan',outcome:'lab.change',effect:{writeback:'supervised',operation:'update',
    target_resource:'lab.plans',primary_key:'id',conflict_key:'version'}}], runner_evidence: {runtime_contract:{
      receipt_configuration:{status:'current',modes:[{source:'lab',authority:'runner_ledger'}]},
      receipts:{ledger:'local',observed:false},onboarding_reader:{engine:'postgres',fingerprint:'declared metadata'}}} };
  const dependency = receiptRequirementDependencies(draft), binding = receiptRequirementSourceBinding(source,sources.id,store,1,1);
  const file = path.join(root,'native-port.json');
  let state: BusinessStatementRecordUpdate = {questions:[],handoffs:[],conversationTurns:[]}, saved = structuredClone(state);
  const requests: ProviderHttpInput[] = [], events: string[] = [];
  const context = () => canonicalJsonDigest({source:receiptRequirementQuestionContext(sources),draft});
  const prepared = () => ({...draft,runner_evidence:{...draft.runner_evidence,receipt_requirement:receiptRequirementPreparedContext(sources,store)}});
  const checkpoint = receiptRequirementCheckpoint({projectRoot:root,sources,store,start:1,end:1,currentDraft:prepared,questions:()=>state.questions!,
    assertCurrent:async()=>{ expect(canonicalJsonDigest(await loadPolicySources(root,sources.id))).toBe(canonicalJsonDigest(sources)); },
    acknowledge:async()=>{events.push('Source acknowledgment');await fs.writeFile(file,JSON.stringify(state));} });
  const invoke = (interact:(view:BusinessStatementInteraction)=>Promise<BusinessStatementResponse>) => createBusinessStatementHost({
    question:'What establishes completion, and how should an unapplied request be described?',stage:'authority_review',assertCurrent:async()=>{},
    receiptDecision:{target:{phase:'receipt_requirement',resource:source.digest,field:'lines:1-1',outcomes:['lab.change']},material:[source.text],
      evidence:[{id:'receipt-source-range',digest:binding},{id:'receipt-meaning-dependencies',digest:dependency}],
      selection:{source:'lab',mode:'runner_ledger',dependencies_digest:dependency},
      // Prepared responder reads only the actual wire question and captured
      // operator words. It has no fixture state, oracle or expected mapping.
      session:{provider:'openai',model:'declared-offline-model',apiKey:'inert-controlled-credential',dependencies:{requestJson:async request=>{
        requests.push({ ...request, body: structuredClone(request.body) });
        const q = JSON.parse(findQuestionText(request.body));
        const clear = /completion receipt/u.test(q.raw_answer) && /pending or approved/u.test(q.raw_answer);
        return {status:200,body:{status:'completed',output:[{type:'function_call',call_id:randomUUID(),name:'runner__propose_operator_decision',
          arguments:JSON.stringify({question_id:q.question_id,revision:q.revision,answer_id:q.answer_id,status:'proposal',
            disposition:clear?'proposed':'pending',...(clear?{value:{kind:'receipt_requirement',completion_basis:'applied_change_receipt',unapplied_status:'pending_or_approved'}}:{})})}]}};
      }}}},
    access:{readQuestions:()=>state.questions!,readHandoffs:()=>state.handoffs!,readRecovery:()=>state.recovery,
      readConversationTurns:()=>state.conversationTurns,readCheckpointDigest:()=>undefined,scopeDigest:()=>scope,contextDigest:async()=>context(),
      mutate:operation=>withProjectAuthorityMutation(root,operation),install:update=>{state={...state,...update};},
      save:async(_permit,_stage,subject)=>{parseOperatorQuestions(state.questions,state.handoffs!,state.recovery);
        assertOperatorQuestionsAdvance(saved.questions!,state.questions!); await fs.writeFile(file,JSON.stringify(state));saved=structuredClone(state);
        events.push(subject);await checkpoint.saved(_permit);},
      appendSourceStatement:async()=>{throw new Error('Receipt answers must stay separate from Source text.');},
      prepareReadDecision:async()=>({}),checkpointFailure:subject=>new Error(subject)},interact}).review();
  return {root,source,sources,prepared,invoke,requests,events,inspect:()=>structuredClone(state),
    restart:async()=>{state=JSON.parse(await fs.readFile(file,'utf8'));saved=structuredClone(state);Object.assign(sources,await loadPolicySources(root,sources.id));}};
}
function findQuestionText(value:unknown):string {
  if(typeof value==='string') {const m=/Current question: (\{[^\n]+\})/u.exec(value);if(m)return m[1]!;}
  if(value && typeof value==='object') for(const v of Object.values(value)) {const found=findQuestionText(v);if(found)return found;}
  return '';
}
const respond = (raw:string,accepted:boolean=true) => async(view:BusinessStatementInteraction):Promise<BusinessStatementResponse>=>
  view.kind==='question'?{kind:'answer',binding:view.binding,raw}:view.kind==='readback'?{kind:'decision',binding:view.binding,accepted}
    :{kind:'pending',binding:view.binding,choice:'keep'};
const clear = 'Use the trusted worker completion receipt. Unapplied requests stay pending or approved.';

it('saves the pending target before asking, then maps actual words and separately confirms configured applicability',async()=>{
  const f=await fixture();
  expect(await f.invoke(async view=>{
    if(view.kind==='question')expect(f.sources.receipt_requirement_reviews!.at(-1)?.decision).toBe('pending');
    if(view.kind==='readback') {expect(view.defaultValue).toBe(false);expect(view.lines.join('\n')).toContain('outside the source database transaction');}
    return respond(clear)(view);
  })).toBe(clear);
  expect(f.requests).toHaveLength(1);expect(f.inspect().questions!.at(-1)?.budget?.iterations_used).toBe(1);
  expect(currentReceiptRequirement(f.source,{start:1,end:1},f.prepared(),f.sources)?.mode).toBe('runner_ledger');
  expect(f.sources.operator_messages).toBeUndefined();expect(f.sources.receipt_requirement_reviews!.at(-1)?.verified).toBe(false);
  await f.restart();expect(f.inspect().questions!.at(-1)?.confirmation).toBeDefined();
});
it('preserves a vague answer on restart, then Replace uses the same finite pool and keeps the old words',async()=>{
  const f=await fixture();expect(await f.invoke(respond('Some kind of record, I guess.'))).toBeUndefined();
  const old=f.inspect().questions![0]!;expect(old.disposition).toBe('unknown');expect(f.requests).toHaveLength(1);
  await f.restart();
  expect(await f.invoke(async view=>view.kind==='pending'?{kind:'pending',binding:view.binding,choice:'replace'}:respond(clear)(view))).toBe(clear);
  const records=f.inspect().questions!;expect(records[0]).toEqual(old);expect(records[1]!.budget_owner_id).toBe(old.id);
  expect(records[1]!.budget?.iterations_used).toBe(2);expect(records[1]!.budget?.tool_calls_used).toBe(2);
  expect(f.requests).toHaveLength(2);expect(f.sources.receipt_requirement_reviews!.at(-1)?.decision).toBe('confirmed');
});
it('decline and cancellation remain pending; Review accepts the same retained mapping without another model call',async()=>{
  const f=await fixture();expect(await f.invoke(respond(clear,false))).toBeUndefined();await f.restart();
  expect(currentReceiptRequirement(f.source,{start:1,end:1},f.prepared(),f.sources)).toBeUndefined();
  expect(await f.invoke(async view=>view.kind==='pending'?{kind:'pending',binding:view.binding,choice:'review'}:respond('unused')(view))).toBe(clear);
  expect(f.requests).toHaveLength(1);expect(f.inspect().questions).toHaveLength(1);
});
