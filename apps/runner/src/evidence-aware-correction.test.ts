import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {describe,it,expect,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {collectCoverageFeedback,parsePolicyCoverage,reviewPolicyCoverage} from './authoring-policy-coverage.js';
import {createModelAuthoringConversation} from './model-authoring-conversation.js';
import {secureAskJsonRequest} from './model-ask.js';
import {ensurePreparedPolicyCoverage} from './authoring-prepared-policy-review.js';
import {savePolicySources,loadPolicySources,authoringDestination} from './authoring-policy-source.js';
import {policyReviewReadiness} from './authoring-review-readiness.js';
import {coverageFinding} from './authoring-coverage-feedback.js';
import * as receiptConfiguration from './authoring-receipt-configuration.js';
import {receiptComponentMeanings} from './authoring-scoped-receipt-components.js';
import {receiptCouplingInterpretation,receiptCouplingPaths} from './authoring-obligation-review.js';
import {derivedScopedResponse} from './test-fixtures/coverage-derived.js';
import {withDerivedSourceTransactionReview} from './test-fixtures/source-transaction-derived.js';
const capture=JSON.parse(await fs.readFile(new URL('./test-fixtures/evidence-aware-correction.json',import.meta.url),'utf8'));
const READ='/runner_evidence/runtime_contract/receipt_read_exclusion';
const CONFIG='/runner_evidence/runtime_contract/receipt_configuration';
const RECEIPTS='/runner_evidence/runtime_contract/receipts';
const fixture=()=>withDerivedSourceTransactionReview(capture);
const parse=(f:any,args=f.arguments)=>parsePolicyCoverage(args,f.source,f.draft,f.operator_messages,f.sources);
function separated(f:any){
 // DERIVED complete response, not historical model output. No business/source edits.
 const args=structuredClone(f.arguments);
 for(const p of args.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
 const i=args.passages.findIndex((p:any)=>p.draft_paths.includes(READ)),p=args.passages[i];
 const meanings=receiptComponentMeanings(f.draft),outcome=f.draft.actions[0].outcome;
 const component=(category:'compiled_effect'|'receipt_configuration'|'receipt_read_exclusion',draft_paths:string[])=>({
  start:p.start,end:p.end,disposition:'implemented',responsibility:'runner',issue_kind:'coverage_link',interpretation:meanings[category]![0],draft_paths});
 args.passages.splice(i,1,
  component('compiled_effect',p.draft_paths.filter((x:string)=>x!==READ&&x!==CONFIG&&x!==RECEIPTS)),
  component('receipt_configuration',[CONFIG]),
  {start:p.start,end:p.end,disposition:'implemented',responsibility:'runner',issue_kind:'coverage_link',receipt_component:'source_transaction_coupling',interpretation:receiptCouplingInterpretation(outcome),draft_paths:receiptCouplingPaths(outcome)},
  component('receipt_read_exclusion',[READ]));
 return args;
}
function transport(f:any,replies:any[],provider:'openai'|'openrouter'='openrouter'){
 const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const requests:any[]=[];
 const session={provider,model:provider==='openai'?'gpt-5.6-terra':'openai/gpt-5.6-terra',apiKey:'local-only',conversation,
 dependencies:{requestJson:vi.fn(async(r:any)=>{requests.push(structuredClone(r.body));let args=replies[requests.length-1];if(args instanceof Error)throw args;if(!args)throw new Error('No response permitted');
 if(typeof args==='function')args=args(r.body);
 else if(requests.length>1&&canonicalJsonDigest(args)!==canonicalJsonDigest(f.arguments))args=derivedScopedResponse(r.body,args);
 return {status:200,body:provider==='openai'?{output:[{type:'function_call',call_id:'test',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'test',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]}};})}};
 f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
 return {session,requests,run:()=>reviewPolicyCoverage({session,source:f.source,draft:f.draft,sourceSession:f.sources})};
}
function correction(body:any){
 const all=(body.messages??body.input).map((m:any)=>m.content).filter((x:any)=>typeof x==='string').join('\n');
 const marker='Correct this structural coverage problem: ';
 return JSON.parse(all.split('\n').find((s:string)=>s.startsWith(marker))!.slice(marker.length));
}
describe('captured current-proof correction',()=>{
 it('keeps the exact full response invalid and batches all three eligible findings without rewriting it',()=>{
  const f=fixture(),old=structuredClone(f.arguments);expect(()=>parse(f)).toThrow('COUNTING_SUPPORT_MISMATCH');
  const fb=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(fb.findings.map(x=>[x.code,x.component,x.structural])).toEqual([
   ['COUNTING_SUPPORT_MISMATCH','/passages/18/counter_requirements/0',true],
   ['COUNTING_SUPPORT_MISMATCH','/passages/19/counter_requirements/0',true],
   ['RECEIPT_READ_EXCLUSION_UNESTABLISHED','/passages/21',true]]);
  expect(fb.complete_validation).toBe(false);expect(f.arguments).toEqual(old);
 });
 it('separates valid components while retaining all source clauses, pending duties and positive counting basis',()=>{
  const f=fixture(),report=parse(f,separated(f));
  expect(report.passages.some(p=>p.draft_paths.length===1&&p.draft_paths[0]===READ&&p.disposition==='implemented')).toBe(true);
  expect(report.passages.filter(p=>p.obligation_assessment).every(p=>p.obligation_assessment!.verified===false)).toBe(true);
  expect(report.passages.some(p=>p.application_obligations?.includes('independent_source_readback'))).toBe(true);
  expect(report.counting_inventory?.paths).toHaveLength(2);
 });
 it.each(['openai','openrouter'] as const)('%s actually serializes both support instructions and narrow exclusion correction',async provider=>{
  const f=fixture(),t=transport(f,[f.arguments,separated(f)],provider);await t.run();expect(t.requests).toHaveLength(2);
  const fb=correction(t.requests[1]);expect(fb.findings).toHaveLength(3);
  for(const finding of fb.findings.slice(0,2))expect(finding.repair).toContain('omit the OPTIONAL counter operator_message_id');
  expect(JSON.stringify(t.requests[1])).toContain('Host repair scope');expect(fb.findings[2].repair).toContain(READ);
  expect(fb.findings[2].repair).toContain('separately supported claims');
  expect(JSON.stringify(t.requests[0])).toContain('Never choose an unrelated message merely to fill it');
 });
 it('does not make a plain error string or model-asserted eligibility structural',()=>{
  expect(coverageFinding(new Error('RECEIPT_READ_EXCLUSION_UNESTABLISHED: current_proof_mixed_component'),'/passages/0',{}).structural).toBe(false);
  const f=fixture();f.arguments.passages[21].correction_eligible=true;
  expect(()=>parse(f)).toThrow(); // strict old counter checks still run
  const g=separated(f);g.passages.find((p:any)=>p.draft_paths.includes(READ)).correction_eligible=true;expect(()=>parse(f,g)).toThrow();
 });
 it.each(['missing','false','stale_read','stale_graph','stale_configuration','stale_namespace','wrong_source','runner_ledger','wrong_action','unknown_child','mixed_field','mixed_observation','mixed_counter','duplicate_only','duplicate_companion'])('%s cannot acquire isolation eligibility',kind=>{
  const f=fixture(),runtime=f.draft.runner_evidence.runtime_contract,p=f.arguments.passages[21],proof=runtime.receipt_read_exclusion;
  if(kind==='missing')runtime.receipt_read_exclusion=null;
  if(kind==='false')proof.excluded=false;
  if(kind==='stale_read')proof.selected_read_digest=canonicalJsonDigest('old');
  if(kind==='stale_graph')proof.graph_digest=canonicalJsonDigest('old');
  if(kind==='stale_configuration')runtime.receipt_configuration.status='unavailable';
  if(kind==='stale_namespace')proof.destination_binding_digest=canonicalJsonDigest('old');
  if(kind==='wrong_source')runtime.receipt_configuration.modes[0].source='other';
  if(kind==='runner_ledger')runtime.receipt_configuration.modes[0].authority='runner_ledger';
  if(kind==='wrong_action')f.draft.actions[0].effect.target_resource='other';
  if(kind==='unknown_child')p.draft_paths.push(READ+'/excluded');
  if(kind==='mixed_field')p.field_checks=[{resource:'private-unknown',field:'private-sensitive',expectation:'private'}];
  if(kind==='mixed_observation')p.draft_paths.push(RECEIPTS);
  if(kind==='duplicate_only')p.draft_paths=[READ,READ];
  if(kind==='duplicate_companion')p.draft_paths.push(CONFIG);
  if(kind==='mixed_counter'){p.counter_requirements=structuredClone(f.arguments.passages[18].counter_requirements);delete p.counter_requirements[0].operator_message_id;p.draft_paths.push(p.counter_requirements[0].path.slice(0,-'/capability'.length));}
  const report=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(report.findings.find(x=>x.component==='/passages/21')?.structural).not.toBe(true);
  expect(()=>parse(f)).toThrow();expect(JSON.stringify(report)).not.toContain('private-sensitive');
 });
 it('renamed outcome and reordered passages keep the same typed decision without fixture constants',()=>{
  let f=fixture();const old=f.draft.actions[0].outcome;f=JSON.parse(JSON.stringify(f).split(old).join('tenant.finish_cycle'));
  // Rebind host-only counter review digests by retaining this as a receipt-only
  // component assessment; full original order control below retains exact support.
  const p=f.arguments.passages[21];
  const fb=collectCoverageFeedback({passages:[p]},f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(fb.findings.find(x=>x.code==='RECEIPT_READ_EXCLUSION_UNESTABLISHED')).toMatchObject({structural:true});
  f=fixture();f.arguments.passages.reverse();const reordered=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(reordered.findings.filter(x=>x.code==='COUNTING_SUPPORT_MISMATCH')).toHaveLength(2);
  expect(reordered.findings.find(x=>x.code==='RECEIPT_READ_EXCLUSION_UNESTABLISHED')).toMatchObject({structural:true});
 });
 it.each(['missing_support','stale_support','wrong_citation','heading','privacy','obligation','false_observation'])('complete replacement retains %s refusal or pending result',kind=>{
  const f=fixture(),good=separated(f);
  if(kind==='missing_support')f.draft.runner_evidence.counting_decisions=[];
  if(kind==='stale_support')for(const d of f.draft.runner_evidence.counting_decisions)d.source_digest=canonicalJsonDigest('old');
  if(kind==='wrong_citation')good.passages.find((p:any)=>p.counter_requirements).counter_requirements[0].operator_message_id=2;
  if(kind==='heading'||kind==='privacy'){
   const line=kind==='heading'?1:17;good.passages=good.passages.filter((p:any)=>!(p.start<=line&&p.end>=line));
  }
  if(kind==='obligation'){good.passages=good.passages.filter((p:any)=>!p.application_obligations);}
  if(kind==='false_observation')good.passages.push({start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'A completed receipt proves independent readback.',draft_paths:[RECEIPTS]});
  if(['missing_support','stale_support','wrong_citation','heading','privacy','false_observation'].includes(kind))expect(()=>parse(f,good)).toThrow();
  else if(kind==='obligation')expect(policyReviewReadiness(f.source,parse(f,good),{...f.sources,application_assignments:[]} as any).ready).toBe(false);
 });
 it('unchanged historical full reply is refused by the scoped envelope without a third call',async()=>{
  const f=fixture(),t=transport(f,[f.arguments,f.arguments,separated(f)]);await expect(t.run()).rejects.toThrow('POLICY_COVERAGE_INVALID');expect(t.requests).toHaveLength(2);
 });
 it('correct first reply has no extra opinion call',async()=>{const f=fixture(),t=transport(f,[separated(f)]);await t.run();expect(t.requests).toHaveLength(1);});
});

describe('current-proof complete save and restart',()=>{
 async function prepared(replies:(f:any)=>any[]){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'evidence-correction-')),f=fixture(),t=transport(f,replies(f));
  vi.spyOn(receiptConfiguration,'authoringReceiptConfiguration').mockResolvedValue(f.draft.runner_evidence.runtime_contract.receipt_configuration);
  await savePolicySources(root,f.sources);
  const input={projectRoot:root,sources:f.sources,modelSession:t.session,operatorSession:{chooseOption:vi.fn(async()=> 'assign'),confirm:vi.fn(async()=>true)} as any,
   currentDraft:()=>f.draft,authorityDigest:f.sources.coverage_authority_digest,clarifications:[],assertCurrent:async()=>{},state:{},onValidated:vi.fn()};
  return {root,f,t,input};
 }
 it.each(['openai','openrouter'] as const)('%s loopback SSE drives preparation, full correction, persistence and unchanged reuse',async provider=>{
  const x=await prepared(f=>[f.arguments,separated(f)]),wire:any[]=[],stream:any[]=[],previous=structuredClone(x.f.sources.coverage_episodes);
  const server=createServer(async(req,res)=>{
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));wire.push(JSON.parse(Buffer.concat(chunks).toString()));
   const args=wire.length===1?x.f.arguments:derivedScopedResponse(wire.at(-1),separated(x.f));res.setHeader('content-type','text/event-stream');
   if(provider==='openai'){
    res.write(`data: ${JSON.stringify({type:'response.output_item.added',item:{type:'function_call',name:'runner__review_policy_coverage'}})}\n\n`);
    res.end(`data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[{type:'function_call',call_id:'local',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}})}\n\n`);
   }else{
    const text=JSON.stringify(args),mid=Math.floor(text.length/2);
    res.write(`data: ${JSON.stringify({choices:[{delta:{reasoning_details:[{type:'reasoning.encrypted',data:'opaque-local-private-continuation',index:0}],tool_calls:[{index:0,id:'local',type:'function',function:{name:'runner__review_policy_coverage',arguments:text.slice(0,mid)}}]}}]})}\n\n`);
    res.write(`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:text.slice(mid)}}]}}]})}\n\n`);
    res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
   }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const address=server.address();if(!address||typeof address==='string')throw new Error('local address missing');
   const session={...x.t.session,provider,model:provider==='openai'?'gpt-5.6-terra':'openai/gpt-5.6-terra',dependencies:{
    requestJson:(r:any)=>secureAskJsonRequest({...r,headers:{},endpoint:new URL(`http://127.0.0.1:${address.port}/test`),scope:'custom_loopback'}),onStream:(e:any)=>stream.push(e)}};
   x.f.sources.approvals.push({digest:x.f.source.digest,destination:authoringDestination(session)});await savePolicySources(x.root,x.f.sources);
   const input={...x.input,modelSession:session};const result=await ensurePreparedPolicyCoverage(input);
   expect(result.activity).toBe('provider');expect(wire).toHaveLength(2);
   expect(correction(wire[1]).findings.map((x:any)=>x.code)).toEqual(['COUNTING_SUPPORT_MISMATCH','COUNTING_SUPPORT_MISMATCH','RECEIPT_READ_EXCLUSION_UNESTABLISHED']);
   expect(correction(wire[1]).findings.every((x:any)=>x.structural)).toBe(true);
   expect(JSON.stringify(wire[1])).not.toContain('opaque-local-private-continuation');expect(JSON.stringify(stream)).not.toContain('opaque-local-private-continuation');
   const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage_episodes?.slice(0,previous.length)).toEqual(previous);expect(saved.coverage_episodes?.at(-1)?.submissions).toHaveLength(2);
   expect(saved.coverage_episodes?.at(-1)?.submissions.map(s=>s.validated)).toEqual([false,true]);
   expect(policyReviewReadiness(x.f.source,saved.coverage,saved).ready).toBe(true);
   expect(saved.application_assignments?.every(a=>a.verified===false)).toBe(true);
   const duties=saved.coverage!.passages.filter(p=>p.obligation_assessment);expect(duties.length).toBeGreaterThan(0);expect(duties.every(p=>p.obligation_assessment!.verified===false)).toBe(true);
   session.conversation.policySources=saved;
   const recheck=await ensurePreparedPolicyCoverage({...input,sources:saved,state:{}});expect(recheck.activity).toBe('validated_reuse');expect(wire).toHaveLength(2);
   expect(x.input.onValidated).toHaveBeenCalledTimes(2);
  }finally{await new Promise<void>(r=>server.close(()=>r()));vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
 it.each(['repeated','transport','residual','failed_save','concurrent_source','drift_read','drift_action','drift_selection','drift_decision'])('%s preserves prior coverage and no partial ownership',async mode=>{
  const x=await prepared(f=>mode==='repeated'?[f.arguments,f.arguments]:mode==='transport'?[f.arguments,new Error('local transport refused')]:mode==='residual'?[f.arguments,(body:any)=>{
   const response=derivedScopedResponse(body,separated(f));
   response.groups.find((g:any)=>g.passage_replacements.length).passage_replacements[0].fragments.push({category:'compiled_effect',
    passage:{start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'Invented observation',draft_paths:[RECEIPTS]}});
   return response;
  }]:[f.arguments,separated(f)]);
  const priorCoverage=structuredClone(x.f.sources.coverage),priorOwners=structuredClone(x.f.sources.application_assignments);
  try{
   if(mode==='failed_save')vi.spyOn(fs,'rename').mockRejectedValue(new Error('controlled save failed'));
   if(mode==='concurrent_source')x.input.assertCurrent=async()=>{await savePolicySources(x.root,{...x.f.sources,operator_messages:[...x.f.sources.operator_messages,'separate changed decision']});};
   if(mode.startsWith('drift_')){
    const original=x.t.session.dependencies.requestJson;x.t.session.dependencies.requestJson=vi.fn(async(r:any)=>{
     const response=await original(r);
     if(x.t.requests.length===2){
      if(mode==='drift_read')x.f.draft.read.name='changed Read';
      if(mode==='drift_action')x.f.draft.actions[0].effect.operation='changed';
      if(mode==='drift_selection')x.f.draft.runner_evidence.runtime_contract.receipt_configuration.digest=canonicalJsonDigest('changed');
      if(mode==='drift_decision')await savePolicySources(x.root,{...x.f.sources,operator_messages:[...x.f.sources.operator_messages,'changed decision']});
     }return response;
    });
   }
   await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow();
   vi.restoreAllMocks();const saved=await loadPolicySources(x.root,x.f.sources.id);
   expect(saved.coverage).toEqual(priorCoverage);expect(saved.application_assignments).toEqual(priorOwners);expect(x.input.onValidated).not.toHaveBeenCalled();
   if(['failed_save','concurrent_source'].includes(mode))expect(x.t.requests).toHaveLength(0);
   else expect(x.t.requests).toHaveLength(2);
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
});
