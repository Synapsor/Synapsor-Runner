import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {secureAskJsonRequest} from './model-ask.js';
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { parsePolicyCoverage, collectCoverageFeedback, reviewPolicyCoverage } from './authoring-policy-coverage.js';
import { assessReviewObligation, RECEIPT_PATH } from './authoring-obligation-review.js';
import { deferredReviewObligation, bindPolicyCoverage, savePolicySources, loadPolicySources, authoringDestination } from './authoring-policy-source.js';
import { policyReviewReadiness } from './authoring-review-readiness.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';
const captures = JSON.parse(await fs.readFile(new URL('./test-fixtures/receipt-review-association.json', import.meta.url),'utf8'));
const CONFIG='/runner_evidence/runtime_contract/receipt_configuration';
function fixture(c:'A'|'B') { return structuredClone(captures[c]); }
function parse(f:any,args=f.arguments) { return parsePolicyCoverage(args,f.source,f.draft,f.sources.operator_messages); }
function receipt(report:any) { return report.passages.find((p:any)=>p.obligation_assessment?.family==='receipt_setup'); }
function correctedA(f:any) {
 const args=structuredClone(f.arguments), p=args.passages[14];
 // DERIVED controlled response. The original is retained byte-for-byte.
 p.draft_paths=p.draft_paths.filter((p:string)=>p!==RECEIPT_PATH);
 args.passages.push({start:p.start,end:p.end,disposition:'needs_decision',responsibility:'deployment',issue_kind:'missing_configuration',
  draft_paths:[RECEIPT_PATH],interpretation:'The required Runner-ledger guarantee is supported. Receipt setup remains pending and no receipt or source readback is established.',topic:'Receipt setup',next_step:'Perform separate reviewed setup after authority review.'});
 return args;
}
describe('receipt review association through exact final complete captures',()=>{
 it('keeps original A invalid while delivering a precise structural finding; B acquires only its pending association',()=>{
  const a=fixture('A');expect(()=>parse(a)).toThrow('OBLIGATION_OBSERVATION_UNESTABLISHED');
  const feedback=collectCoverageFeedback(a.arguments,a.source,a.draft,a.sources.operator_messages);
  expect(feedback.findings).toEqual([expect.objectContaining({code:'OBLIGATION_OBSERVATION_UNESTABLISHED',component:'/passages/14',structural:true})]);
  expect(feedback.unevaluated).toContain('/passages/14');
  const b=fixture('B'), report=parse(b), pending=receipt(report);
  expect(pending.draft_paths).toEqual([CONFIG]);expect(pending.disposition).toBe('needs_decision');
  expect(pending.interpretation).toBe(b.arguments.passages.find((p:any)=>p.draft_paths.length===1&&p.draft_paths[0]===CONFIG).interpretation);
  expect(pending.obligation_assessment).toMatchObject({origin:'HOST-RESOLVED',requirement:'source_db',state:'pending',verified:false,association:{kind:'reviewed_receipt_configuration',submitted_path:CONFIG}});
  expect(deferredReviewObligation(pending)?.family).toBe('receipt_setup');
  expect(policyReviewReadiness(b.source,report,b.sources).summary.join(' ')).toContain('Receipt requirement: source_db.');
  expect(policyReviewReadiness(b.source,report,b.sources).items?.filter(i=>i.blocksReview).map(i=>i.title)).toEqual([]);
 });
 it.each(['draft','compiled','reordered'] as const)('keeps equivalent %s capability roots in the same strict correction class',root=>{
  const f=fixture('A');
  if(root!=='draft')f.arguments.passages[14].draft_paths[0]='/runner_evidence/actions/release.clear_assessment/effect';
  if(root==='reordered')f.arguments.passages[14].draft_paths.reverse();
  expect(()=>parse(f)).toThrow('OBLIGATION_OBSERVATION_UNESTABLISHED');
  expect(collectCoverageFeedback(f.arguments,f.source,f.draft,f.sources.operator_messages).findings).toEqual([expect.objectContaining({code:'OBLIGATION_OBSERVATION_UNESTABLISHED',structural:true})]);
 });
 it.each(['A','B'] as const)('save/reload and exact recheck retain %s pending setup; competing save installs no partial review',async c=>{
  const f=fixture(c),root=await fs.mkdtemp(path.join(os.tmpdir(),'receipt-association-'));
  try {
   const report=parse(f,c==='A'?correctedA(f):f.arguments);
   expect(receipt(report)?.obligation_assessment).toMatchObject({verified:false,state:'pending'});
   bindPolicyCoverage(f.sources,report,canonicalJsonDigest(f.draft.actions));await savePolicySources(root,f.sources,{expectedDigest:null});
   const restored=await loadPolicySources(root,f.sources.id);
   expect(parse(f,{passages:restored.coverage!.passages})).toEqual(report);
   const competing=structuredClone(restored);competing.operator_messages!.push('A separately saved test decision.');
   await savePolicySources(root,competing,{expectedDigest:canonicalJsonDigest(restored)});
   await expect(savePolicySources(root,restored,{expectedDigest:canonicalJsonDigest(restored)})).rejects.toThrow('POLICY_SOURCE_CHANGED');
   expect(await loadPolicySources(root,f.sources.id)).toEqual(competing);
  } finally {await fs.rm(root,{recursive:true,force:true});}
 });
 it('configuration and duty forms agree after persistence-ready full validation, including reordering',()=>{
  const f=fixture('B'),original=parse(f), args=structuredClone(f.arguments);
  const p=args.passages.find((p:any)=>p.draft_paths.length===1&&p.draft_paths[0]===CONFIG);p.draft_paths=[RECEIPT_PATH];args.passages.reverse();
  const duty=parse(f,args);
  const a=receipt(original).obligation_assessment,b=receipt(duty).obligation_assessment;
  expect({...a,association:undefined}).toEqual(b);
  expect(policyReviewReadiness(f.source,original,f.sources).ready).toBe(policyReviewReadiness(f.source,duty,f.sources).ready);
  expect(parse(f,{passages:original.passages})).toEqual(original);
  expect(parse(f,{passages:duty.passages})).toEqual(duty);
 });
 it.each(['missing','stale','outcome','source','read','action','binding','revision','ambiguous','mode','unknown','unsupported','unavailable'])(
  'does not associate %s selection evidence or change its pending requirement',variant=>{
   const f=fixture('B'),p=f.arguments.passages.find((p:any)=>p.draft_paths.length===1&&p.draft_paths[0]===CONFIG),contract=f.draft.runner_evidence.runtime_contract;
   const intent=contract.receipt_configuration.reviewed_intent, entry=intent.outcomes[0];
   if(variant==='missing')delete contract.receipt_configuration.reviewed_intent;
   if(variant==='stale')intent.status='stale';
   if(variant==='outcome')entry.outcome='other.outcome';
   if(variant==='source')entry.source='other_source';
   if(variant==='read')entry.read_digest=canonicalJsonDigest('other');
   if(variant==='action')entry.action_digest=canonicalJsonDigest('other');
   if(variant==='binding')delete entry.binding_digest;
   if(variant==='revision')delete entry.revision_id;
   if(variant==='ambiguous')intent.outcomes.push(structuredClone(entry));
   if(variant==='mode')entry.mode='runner_ledger';
   if(variant==='unknown')f.source.text=f.source.text.replace('source_db receipt','durability receipt');
   if(variant==='unsupported')contract.deployment_prerequisites.runner_execution_setup.receipt_modes_supported=[];
   if(variant==='unavailable')contract.receipt_configuration.status='unavailable';
   expect(assessReviewObligation(p,f.source,f.draft)).toBeUndefined();
  });
 it.each(['path','field','counter','evidence','implemented','runner','host','host_path'])(
  'does not discharge a configuration component with %s',variant=>{
   const f=fixture('B'),p=structuredClone(receipt(parse(f)));
   if(variant==='path')p.draft_paths.push('/actions/0/approval');
   if(variant==='field')p.field_checks=[{resource:'private',field:'secret',expectation:'private'}];
   if(variant==='counter')p.counter_requirements=[{path:'/actions/0/approval',current_capability:null,required_capability:null}];
   if(variant==='evidence')p.evidence_checks=[{path:CONFIG,equals:true}];
   if(variant==='implemented')p.disposition='implemented';
   if(variant==='runner')p.responsibility='runner';
   if(variant==='host')delete p.obligation_assessment.association;
   if(variant==='host_path')p.obligation_assessment.association.submitted_path=RECEIPT_PATH;
   expect(deferredReviewObligation(p)).toBeUndefined();
  });
 it.each(['unknown','mismatch','missing','observation','private','typed_verified','unrelated'])(
  'does not give A %s a structural opinion retry',variant=>{
   const f=fixture('A'),p=f.arguments.passages[14];
   if(variant==='unknown')f.source.text=f.source.text.replace(/runner[-_ ]ledger/giu,'unknown');
   if(variant==='mismatch')f.draft.runner_evidence.runtime_contract.receipt_configuration.reviewed_intent.outcomes[0].mode='source_db';
   if(variant==='missing')delete f.draft.runner_evidence.runtime_contract.receipt_configuration.reviewed_intent;
   if(variant==='observation')p.draft_paths=[RECEIPT_PATH];
   if(variant==='private')p.field_checks=[{resource:'unavailable',field:'private_value',expectation:'private'}];
   if(variant==='typed_verified')p.evidence_checks=[{path:'/runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup/verified',equals:true}];
   if(variant==='unrelated')p.draft_paths.push('/actions/0/approval');
   if(variant==='unknown')expect(assessReviewObligation(p,f.source,f.draft)).toBeUndefined();
   else {try{assessReviewObligation(p,f.source,f.draft);throw Error('expected refusal');}catch(e:any){expect(e.code).toBe('OBLIGATION_OBSERVATION_UNESTABLISHED');expect(e.structural).toBe(false);}}
  });
 it('keeps true mode conflicts and unrelated business/privacy claims blocking beside valid setup',()=>{
  const f=fixture('B'), args=structuredClone(f.arguments);
  args.passages.push({start:18,end:18,disposition:'conflict',responsibility:'runner',issue_kind:'contradiction',interpretation:'A separate maximum is unresolved.',draft_paths:['/actions/0/approval']});
  const report=parse(f,args);expect(receipt(report)).toBeTruthy();expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false);
  f.draft.runner_evidence.runtime_contract.receipt_configuration={status:'current',modes:[{authority:'runner_ledger'}]};
  expect(()=>parse(f)).toThrow('OBLIGATION_RECEIPT_MODE_MISMATCH');
 });
 it('invalidates saved association after selection, candidate or source drift',()=>{
  const f=fixture('B'),report=parse(f);
  for(const variant of ['source','action','selection']) {
   const changed=fixture('B');
   if(variant==='source')changed.source.digest=canonicalJsonDigest('other');
   if(variant==='action')changed.draft.actions[0].ttl_seconds++;
   if(variant==='selection')changed.draft.runner_evidence.runtime_contract.receipt_configuration.reviewed_intent.outcomes[0].revision_id='policy:'+'a'.repeat(64);
   expect(()=>parse(changed,{passages:report.passages})).toThrow();
  }
 });
 it.each(['openai','openrouter'] as const)('transmits A correction through actual %s request encoding and validates a full replacement',async provider=>{
  const f=fixture('A'),conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
  const requests:any[]=[],session={provider,model:provider==='openrouter'?'openai/gpt-5.6-terra':'gpt-5.6-terra',apiKey:'synthetic-test-only',conversation,dependencies:{requestJson:async(r:any)=>{
   requests.push(structuredClone(r.body));const args=requests.length===1?f.arguments:correctedA(f);
   return {status:200,body:provider==='openai'?{output:[{type:'function_call',call_id:'capture',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}:
    {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'capture',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]}};
  }}};
  f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
  const report=await reviewPolicyCoverage({session,source:f.source,draft:f.draft});expect(requests).toHaveLength(2);
  const wire=JSON.stringify(requests[1]);expect(wire).toContain('OBLIGATION_OBSERVATION_UNESTABLISHED');expect(wire).toContain('Separate the compiled capability claim');expect(wire).toContain('Do not change source policy, program, receipt mode');
  expect(receipt(report).obligation_assessment.verified).toBe(false);
  expect(report.passages[14]!.disposition).toBe('implemented');expect(report.passages[14]!.draft_paths).not.toContain(RECEIPT_PATH);
 });
 it.each(['openai','openrouter'] as const)('streams A structural feedback across local %s HTTP without private continuation',async provider=>{
  const f=fixture('A'),conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
  const wire:any[]=[],events:any[]=[];let incomplete=false;
  const server=createServer(async(req,res)=>{
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));wire.push(JSON.parse(Buffer.concat(chunks).toString()));
   const args=wire.length===1?f.arguments:correctedA(f);res.setHeader('content-type','text/event-stream');
   if(provider==='openai'){
    res.write(`data: ${JSON.stringify({type:'response.output_item.added',item:{type:'function_call',name:'runner__review_policy_coverage'}})}\n\n`);
    res.end(`data: ${JSON.stringify({type:incomplete?'response.incomplete':'response.completed',response:{status:incomplete?'incomplete':'completed',output:[{type:'function_call',name:'runner__review_policy_coverage',call_id:'wire',arguments:JSON.stringify(args)}]}})}\n\n`);
   }else{
    res.write(`data: ${JSON.stringify({choices:[{delta:{reasoning_details:[{type:'reasoning.encrypted',data:'opaque-test-continuation',index:0}],tool_calls:[{index:0,id:'wire',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]})}\n\n`);
    res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:incomplete?'length':'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
   }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const session={provider,model:provider==='openrouter'?'openai/gpt-5.6-terra':'gpt-5.6-terra',apiKey:'synthetic',conversation,dependencies:{
    requestJson:(r:any)=>secureAskJsonRequest({...r,headers:{},endpoint:new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/test`),scope:'custom_loopback'}),onStream:(e:any)=>events.push(e)}};
   f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
   const report=await reviewPolicyCoverage({session,source:f.source,draft:f.draft});expect(wire).toHaveLength(2);
   const correction=JSON.stringify(wire[1]);expect(correction).toContain('Separate the compiled capability claim');expect(correction).toContain('OBLIGATION_OBSERVATION_UNESTABLISHED');
   expect(correction).not.toContain('opaque-test-continuation');expect(JSON.stringify(events)).not.toContain('opaque-test-continuation');
   expect(receipt(report).obligation_assessment.verified).toBe(false);
   incomplete=true;let submitted=0;
   await expect(reviewPolicyCoverage({session,source:f.source,draft:f.draft,episode:{beforeSubmission:async()=>{},afterSubmission:async()=>{submitted++;}}})).rejects.toMatchObject({code:provider==='openai'?'ASK_PROVIDER_RESPONSE_INVALID':'ASK_PROVIDER_RESPONSE_INCOMPLETE'});
   expect(submitted).toBe(0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 it.each([false,true])('retains a known configuration-linked duty when annotations are omitted, missing selection=%s',async missing=>{
  const f=fixture('B'),conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
  if(missing)delete f.draft.runner_evidence.runtime_contract.receipt_configuration.reviewed_intent;
  const omitted=structuredClone(f.arguments);for(const p of omitted.passages)if(p.draft_paths.length===1&&p.draft_paths[0]===CONFIG){p.disposition='background';p.draft_paths=[];delete p.responsibility;delete p.issue_kind;}
  const session={provider:'openai' as const,model:'gpt-5.6-terra',apiKey:'synthetic',conversation,dependencies:{requestJson:async()=>({status:200,body:{output:[{type:'function_call',call_id:'omitted',name:'runner__review_policy_coverage',arguments:JSON.stringify(omitted)}]}})}};
  f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
  const report=await reviewPolicyCoverage({session,source:f.source,draft:f.draft,previousReport:f.sources.coverage});
  if(missing){expect(receipt(report)).toBeUndefined();expect(report.passages.some(p=>p.draft_paths.length===1&&p.draft_paths[0]===CONFIG&&p.disposition==='needs_decision')).toBe(true);expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false);}
  else expect(receipt(report).obligation_assessment).toMatchObject({requirement:'source_db',state:'pending',verified:false});
 });
});
