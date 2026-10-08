import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { createBusinessStatementHost, type BusinessStatementRecordUpdate } from './authoring-business-statement-host.js';
import type { BusinessStatementInteraction, BusinessStatementResponse } from './authoring-business-statement-interaction.js';
import { assertOperatorQuestionsAdvance, parseOperatorQuestions } from './authoring-operator-question.js';
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources, PolicySourceChangedError } from './authoring-policy-source.js';
import { createReceiptRequirementHost, receiptRequirementCheckpoint, type ReceiptRequirementAnswerReview } from './authoring-receipt-requirement-host.js';
import { currentReceiptRequirement, receiptRequirementDependencies, receiptRequirementPreparedContext,
  receiptRequirementQuestionContext, receiptRequirementSourceBinding } from './authoring-receipt-requirement.js';
import { withProjectAuthorityMutation } from './project-authority-mutation.js';
import { receiptBusinessStatementAdapter, receiptRequirementMaterial } from './authoring-receipt-decision-adapter.js';
import type { ProviderHttpInput } from './model-ask.js';
import { authoringDestination } from './authoring-policy-source.js';
import { ensurePreparedPolicyCoverage } from './authoring-prepared-policy-review.js';
import { coverageResponseContext } from './authoring-coverage-feedback.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, {recursive:true,force:true}); });
async function fixture(options:{failConfirmationProjectionOnce?:boolean;sourceText?:string;productionHost?:boolean;nominateTarget?:boolean;onRefresh?:()=>Promise<void>;currentContext?:()=>string}={}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-host-')); roots.push(root);
  const source = policyTextSnapshot(Buffer.from(options.sourceText ?? 'Describe a change as complete only from its trusted completion receipt.'), 'declared-policy.txt');
  const sources = newPolicySourceSession(); sources.snapshots = [source]; sources.active = source.version;
  await savePolicySources(root, sources);
  const store = canonicalJsonDigest('declared local store'), scope = canonicalJsonDigest('declared current job');
  const draft = { read: {source:'lab'}, actions: [{name:'Change a plan',outcome:'lab.change',effect:{writeback:'supervised',operation:'update',
    target_resource:'lab.plans',primary_key:'id',conflict_key:'version'}}], runner_evidence: {runtime_contract:{
      receipt_configuration:{status:'current',digest:canonicalJsonDigest('declared current configuration'),modes:[{source:'lab',authority:'runner_ledger'}]},
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
  const modelSession: import('./action-tui.js').ActionModelSuggestionSession = {provider:'openai',model:'declared-offline-model',apiKey:'inert-controlled-credential',dependencies:{requestJson:async request=>{
        requests.push({ ...request, body: structuredClone(request.body) });
        const q = JSON.parse(findQuestionText(request.body));
        const clear = /completion receipt/u.test(q.raw_answer) && /pending or approved/u.test(q.raw_answer);
        return {status:200,body:{status:'completed',output:[{type:'function_call',call_id:randomUUID(),name:'runner__propose_operator_decision',
          arguments:JSON.stringify({question_id:q.question_id,revision:q.revision,answer_id:q.answer_id,status:'proposal',
            disposition:clear?'proposed':'pending',...(clear?{value:{kind:'receipt_requirement',completion_basis:'applied_change_receipt',unapplied_status:'pending_or_approved'}}:{})})}]}};
      }}};
  const invoke = (interact:(view:BusinessStatementInteraction)=>Promise<BusinessStatementResponse>, domain?:ReceiptRequirementAnswerReview|null) => createBusinessStatementHost({
    question:domain?.question ?? 'What establishes completion, and how should an unapplied request be described?',stage:'authority_review',assertCurrent:domain?.assertCurrent ?? (async()=>{}),
    decision:domain===null ? undefined : domain?.decision ?? receiptBusinessStatementAdapter({target:{phase:'receipt_requirement',resource:source.digest,field:'lines:1-1',outcomes:['lab.change']},material:receiptRequirementMaterial({start:1,end:1,source_excerpt:source.text}),
      evidence:[{id:'receipt-source-range',digest:binding},{id:'receipt-meaning-dependencies',digest:dependency}],
      selection:{source:'lab',mode:'runner_ledger',dependencies_digest:dependency},
      // Prepared responder reads only the actual wire question and captured
      // operator words. It has no fixture state, oracle or expected mapping.
      session:modelSession}),
    access:{readQuestions:()=>state.questions!,readHandoffs:()=>state.handoffs!,readRecovery:()=>state.recovery,
      readConversationTurns:()=>state.conversationTurns,readCheckpointDigest:()=>undefined,scopeDigest:()=>scope,contextDigest:permit=>domain?.contextDigest(permit) ?? Promise.resolve(context()),
      mutate:operation=>withProjectAuthorityMutation(root,operation),install:update=>{state={...state,...update};},
      save:async(_permit,_stage,subject)=>{parseOperatorQuestions(state.questions,state.handoffs!,state.recovery);
        assertOperatorQuestionsAdvance(saved.questions!,state.questions!); await fs.writeFile(file,JSON.stringify(state));saved=structuredClone(state);
        if(options.failConfirmationProjectionOnce && state.questions?.at(-1)?.confirmation){
          options.failConfirmationProjectionOnce=false;throw new Error('Declared interruption after native confirmation save');}
        events.push(subject);await (domain?.afterSave ?? checkpoint.saved)(_permit);},
      appendSourceStatement:async()=>{throw new Error('Receipt answers must stay separate from Source text.');},
      prepareReadDecision:async()=>({}),checkpointFailure:subject=>new Error(subject)},interact}).review();
  const attemptKey=canonicalJsonDigest('declared whole prepared review key');
  if(options.nominateTarget) {
    const responseContext=coverageResponseContext(source.digest,prepared(),[]);
    sources.coverage_episodes=[{id:randomUUID(),context:attemptKey,started_at:'2026-10-07T23:15:45.188Z',submissions:[{
      number:1,reserved_at:'2026-10-07T23:15:45.188Z',completed_at:'2026-10-07T23:15:46.188Z',validated:false,
      tentative:{status:'unaccepted_generation',context:responseContext,raw_response:{passages:[{start:1,end:1,
        disposition:'implemented',responsibility:'runner',draft_paths:['/runner_evidence/runtime_contract/receipt_configuration']}] }},
      diagnostic:JSON.stringify({context:responseContext,findings:[{component:'/passages/0',
        typed_reason:'receipt_configuration.source_requirement_unestablished'}]}),
    }]}];
    await savePolicySources(root,sources);
  }
  const productionInvoke=(interact:(view:BusinessStatementInteraction)=>Promise<BusinessStatementResponse>)=>createReceiptRequirementHost({
    projectRoot:root,modelSession,businessContext:{references:[]},attemptKey,
    readSources:()=>sources,readQuestions:()=>state.questions!,readHandoff:()=>state.handoffs!.at(-1),
    scopeDigest:()=>scope,storeDigest:()=>store,currentDraft:prepared as never,refreshEvidence:async()=>{events.push('Evidence refresh');await options.onRefresh?.();},
    assertEvidenceCurrent:async()=>{},
    readConfiguration:async()=>draft.runner_evidence.runtime_contract.receipt_configuration as never,
    questionContext:async()=>{if(canonicalJsonDigest(await loadPolicySources(root,sources.id))!==canonicalJsonDigest(sources))throw new PolicySourceChangedError();return options.currentContext ? canonicalJsonDigest(options.currentContext()) : context();},
    mutate:operation=>withProjectAuthorityMutation(root,operation),
    acknowledgeResume:async()=>{events.push('Source acknowledgment');await fs.writeFile(file,JSON.stringify(state));},
    assertGenerationAdmission:()=>{events.push('Generation admission');},reviewAnswer:review=>invoke(interact,review),
  }).review();
  return {root,source,sources,prepared,invoke,invokeWithoutDecision:(interact:(view:BusinessStatementInteraction)=>Promise<BusinessStatementResponse>)=>invoke(interact,null),productionInvoke,requests,events,checkpoint,draft,inspect:()=>structuredClone(state),
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
it.each(['initial-question','replacement-question'] as const)('answers a cancelled %s after reload while preserving the old question and finite pool',async point=>{
  const f=await fixture();
  if(point==='replacement-question')await f.invoke(respond(clear,false));
  expect(await f.invoke(async view=>view.kind==='pending'
    ?{kind:'pending',binding:view.binding,choice:'replace'}:{kind:'answer',binding:view.binding,raw:null})).toBeUndefined();
  await f.restart();const before=f.inspect(),old=before.questions!.at(-1)!,calls=f.requests.length;
  expect(old.disposition).toBe('cancelled');expect(old.raw_answer).toBeUndefined();
  expect(await f.invoke(async view=>{
    expect(view.kind).toBe('pending');
    if(view.kind==='pending') {expect(view.defaultValue).toBe('keep');expect(view.canReplace).toBe(true);}
    return {kind:'pending',binding:view.binding,choice:'keep'};
  })).toBeUndefined();
  expect(f.inspect()).toEqual(before);expect(f.requests).toHaveLength(calls);
  expect(await f.invoke(async view=>view.kind==='pending'
    ?{kind:'pending',binding:view.binding,choice:'replace'}:respond(clear)(view))).toBe(clear);
  const after=f.inspect().questions!;
  expect(after.slice(0,-1)).toEqual(before.questions);
  expect(after.at(-1)!.revision).toBe(old.revision+1);
  expect(after.at(-1)!.budget_owner_id).toBe(old.budget_owner_id??old.id);
  expect(after.at(-1)!.budget!.iterations_used).toBe(old.budget!.iterations_used+1);
  expect(after.at(-1)!.budget!.tool_calls_used).toBe(old.budget!.tool_calls_used+1);
  expect(f.requests).toHaveLength(calls+1);
  expect(f.sources.receipt_requirement_reviews!.at(-1)!.decision).toBe('confirmed');
});
it('decline and cancellation remain pending; Review accepts the same retained mapping without another model call',async()=>{
  const f=await fixture();expect(await f.invoke(respond(clear,false))).toBeUndefined();await f.restart();
  expect(currentReceiptRequirement(f.source,{start:1,end:1},f.prepared(),f.sources)).toBeUndefined();
  expect(await f.invoke(async view=>view.kind==='pending'?{kind:'pending',binding:view.binding,choice:'review'}:respond('unused')(view))).toBe(clear);
  expect(f.requests).toHaveLength(1);expect(f.inspect().questions).toHaveLength(1);
});
it.each(['before-answer','after-vague-answer'] as const)('restarts %s at the saved receipt decision, without opening another coverage episode',async point=>{
  const f=await fixture();
  if(point==='before-answer')await f.invoke(async view=>({kind:'answer',binding:view.binding,raw:null}));
  else await f.invoke(respond('Some kind of record, I guess.'));
  await f.restart();
  const calls:unknown[]=[];
  const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
  const modelSession={provider:'openai' as const,model:'declared-offline-model',apiKey:'inert-controlled-credential',conversation,
    dependencies:{requestJson:async(request:ProviderHttpInput)=>{calls.push(request.body);throw new Error('Unexpected full coverage request');}}};
  f.sources.approvals=[{digest:f.source.digest,destination:authoringDestination(modelSession)}];
  await savePolicySources(f.root,f.sources);
  const before=structuredClone(f.sources);
  await expect(ensurePreparedPolicyCoverage({projectRoot:f.root,sources:f.sources,modelSession,
    operatorSession:{confirm:async()=>false} as never,currentDraft:f.prepared as never,
    authorityDigest:canonicalJsonDigest('declared current authority'),clarifications:[],assertCurrent:async()=>{},state:{}}))
    .rejects.toMatchObject({plan:expect.objectContaining({recommended:'receipt_requirement_review'})});
  expect(calls).toHaveLength(0);expect(f.sources).toEqual(before);
});
it('finishes only a missing Source projection after a durable native confirmation, without remapping or reconfirming',async()=>{
  const f=await fixture({failConfirmationProjectionOnce:true});
  await expect(f.invoke(respond(clear))).rejects.toThrow('Declared interruption after native confirmation save');
  await f.restart();const native=f.inspect();
  expect(native.questions!.at(-1)?.confirmation).toBeDefined();
  expect(f.sources.receipt_requirement_reviews!.at(-1)?.decision).toBe('pending');
  await withProjectAuthorityMutation(f.root,permit=>f.checkpoint.saved(permit));
  expect(currentReceiptRequirement(f.source,{start:1,end:1},f.prepared(),f.sources)?.mode).toBe('runner_ledger');
  expect(f.inspect()).toEqual(native);expect(f.requests).toHaveLength(1);
  expect(native.questions!.at(-1)?.budget?.iterations_used).toBe(1);
});

it.each([2_000,2_001,16_000])('preserves the full %i-character Source target within native question material limits',async length=>{
  const text='R'.repeat(length-2)+' Z';
  const f=await fixture({sourceText:text});
  expect(await f.invoke(respond(clear))).toBe(clear);
  const material=f.inspect().questions![0]!.material;
  expect(material.every(entry=>entry.length<=2_000)).toBe(true);
  expect(material.filter(entry=>entry.startsWith('Attached Source lines '))
    .map(entry=>entry.slice(entry.indexOf('\n')+1)).join('')).toBe(text);
  expect(f.requests).toHaveLength(1);
  expect(f.sources.receipt_requirement_reviews!.at(-1)!.source_excerpt).toBe(text);
});

it('the production owner distinguishes no target, pending, confirmed, reused and a configuration prerequisite',async()=>{
  const absent=await fixture();
  expect(await absent.productionInvoke(async()=>{throw new Error('No target must not ask');})).toEqual({kind:'no_target'});
  expect(absent.requests).toHaveLength(0);expect(absent.inspect().questions).toHaveLength(0);
  const f=await fixture({nominateTarget:true});
  expect(await f.productionInvoke(respond(clear,false))).toMatchObject({kind:'pending'});
  expect(f.requests).toHaveLength(1);await f.restart();
  expect(await f.productionInvoke(async view=>view.kind==='pending'
    ?{kind:'pending',binding:view.binding,choice:'review'}:respond('unused')(view))).toEqual({kind:'saved',disposition:'confirmed'});
  expect(f.requests).toHaveLength(1);const native=f.inspect();
  expect(await f.productionInvoke(async()=>{throw new Error('Reuse must not ask');})).toEqual({kind:'saved',disposition:'reused'});
  expect(f.inspect()).toEqual(native);expect(f.requests).toHaveLength(1);
  f.draft.runner_evidence.runtime_contract.receipt_configuration.status='absent' as 'current';
  expect(await f.productionInvoke(async()=>{throw new Error('Configuration is not operator meaning');}))
    .toMatchObject({kind:'blocked',code:'receipt_configuration_unestablished'});
  expect(f.inspect()).toEqual(native);expect(f.requests).toHaveLength(1);
});
it('the production owner completes only the missing Source projection after the native confirmation save',async()=>{
  const f=await fixture({nominateTarget:true,failConfirmationProjectionOnce:true});
  await expect(f.productionInvoke(respond(clear))).rejects.toThrow('Declared interruption after native confirmation save');
  await f.restart();const native=f.inspect();
  expect(await f.productionInvoke(async()=>{throw new Error('Recovery must not prompt or map');}))
    .toEqual({kind:'saved',disposition:'projection_recovered'});
  expect(f.inspect()).toEqual(native);expect(f.requests).toHaveLength(1);
});
it('refuses a reused receipt interpretation when Source changes during evidence refresh',async()=>{
  let onRefresh=async()=>{};
  const f=await fixture({nominateTarget:true,onRefresh:()=>onRefresh()});
  expect(await f.productionInvoke(respond(clear))).toEqual({kind:'saved',disposition:'confirmed'});
  const before=f.inspect(),calls=f.requests.length;
  let winner: Awaited<ReturnType<typeof loadPolicySources>> | undefined;
  onRefresh=async()=>{
    const current=await loadPolicySources(f.root,f.sources.id);
    winner={...current,active:2,snapshots:[...current.snapshots,policyTextSnapshot(Buffer.from('Require completion evidence inside the source transaction.'),'replacement.txt',2)]};
    await savePolicySources(f.root,winner,{expectedDigest:canonicalJsonDigest(current)});
  };
  await expect(f.productionInvoke(async()=>{throw new Error('A stale interpretation must not ask again or be reused');}))
    .rejects.toThrow('POLICY_SOURCE_CHANGED');
  expect(await loadPolicySources(f.root,f.sources.id)).toEqual(winner);
  expect(f.inspect()).toEqual(before);expect(f.requests).toHaveLength(calls);
});
it('retains applicable receipt meaning across an unrelated change made before a new entry',async()=>{
  let context='prior checked review context';
  const f=await fixture({nominateTarget:true,currentContext:()=>context});
  expect(await f.productionInvoke(respond(clear))).toEqual({kind:'saved',disposition:'confirmed'});
  const before=f.inspect(),calls=f.requests.length;
  // The exact receipt dependencies and evidence guard remain current. Only the
  // enclosing context changed before this invocation, not during its waits.
  context='new presentation or unrelated review context';
  expect(await f.productionInvoke(async()=>{throw new Error('Applicable meaning must not be asked again');}))
    .toEqual({kind:'saved',disposition:'reused'});
  expect(f.inspect()).toEqual(before);expect(f.requests).toHaveLength(calls);
});
it('refuses receipt reuse when the checked reader or Action context changes during refresh',async()=>{
  let context='declared current reader and Action role',onRefresh=async()=>{};
  const f=await fixture({nominateTarget:true,onRefresh:()=>onRefresh(),currentContext:()=>context});
  expect(await f.productionInvoke(respond(clear))).toEqual({kind:'saved',disposition:'confirmed'});
  const before=f.inspect(),calls=f.requests.length;
  onRefresh=async()=>{context='changed inspected role, same cached draft and Source';};
  await expect(f.productionInvoke(async()=>{throw new Error('Changed evidence cannot be reused or prompt');}))
    .rejects.toThrow('POLICY_SOURCE_CHANGED');
  expect(f.inspect()).toEqual(before);expect(f.requests).toHaveLength(calls);
});
it.each([2_000,2_001,16_000])('production target nomination and mapping preserve a %i-character Source',async length=>{
  const text='R'.repeat(length-4)+' 😀';
  const f=await fixture({nominateTarget:true,sourceText:text});
  expect(await f.productionInvoke(respond(clear))).toEqual({kind:'saved',disposition:'confirmed'});
  expect(f.sources.receipt_requirement_reviews!.at(-1)!.source_excerpt).toBe(text);
  const entries=f.inspect().questions!.at(-1)!.material.filter(entry=>entry.startsWith('Attached Source lines '));
  expect(entries.every(entry=>entry.length<=2_000)).toBe(true);
  expect(entries.map(entry=>entry.slice(entry.indexOf('\n')+1)).join('')).toBe(text);
  expect(entries.every(entry=>!/[\uD800-\uDBFF]$/u.test(entry))).toBe(true);
  expect(f.requests).toHaveLength(1);
});

it('refuses a cached receipt proposal when reopened through an unrelated generic statement owner',async()=>{
  const f=await fixture();await f.invoke(respond(clear,false));const before=f.inspect(),history=structuredClone(f.sources);
  await expect(f.invokeWithoutDecision(async view=>view.kind==='pending'
    ?{kind:'pending',binding:view.binding,choice:'review'}:respond('unused')(view)))
    .rejects.toThrow('POLICY_SOURCE_CHANGED');
  expect(f.inspect()).toEqual(before);expect(f.sources).toEqual(history);expect(f.requests).toHaveLength(1);
});
