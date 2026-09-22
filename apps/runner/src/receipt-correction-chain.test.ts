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
import {policyReadinessItems,policyReviewReadiness} from './authoring-review-readiness.js';
import {CoverageReceiptConfigurationError,CoverageReceiptDutyError,coverageFinding} from './authoring-coverage-feedback.js';
import * as receiptConfiguration from './authoring-receipt-configuration.js';
const capture=JSON.parse(await fs.readFile(new URL('./test-fixtures/receipt-correction-chain.json',import.meta.url),'utf8'));
const READ='/runner_evidence/runtime_contract/receipt_read_exclusion';
const CONFIG='/runner_evidence/runtime_contract/receipt_configuration';
const RECEIPTS='/runner_evidence/runtime_contract/receipts';
const fixture=()=>structuredClone(capture);
const EFFECT='/runner_evidence/actions/energy_ops.finalize_settlement_cycle/effect';
const parse=(f:any,args=f.arguments)=>parsePolicyCoverage(args,f.source,f.draft,f.operator_messages);
function separated(f:any){
 // DERIVED complete response, not a historical model reply. Same policy/draft.
 const args=structuredClone(f.arguments);
 for(const p of args.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
 const i=args.passages.findIndex((p:any)=>p.draft_paths.includes(CONFIG)&&p.draft_paths.includes(RECEIPTS)),p=args.passages[i];
 args.passages.splice(i,1,
  {...p,topic:'Compiled effect',interpretation:'The compiled effect supports the listed updates in one guarded transaction. This is capability, not an observation of execution.',draft_paths:p.draft_paths.filter((x:string)=>x!==RECEIPTS&&x!==CONFIG)},
  {...p,topic:'Configured receipt mode',interpretation:'Current reviewed configuration selects the source-required source_db mode. This proves neither current provisioning, a performed receipt nor independent readback.',draft_paths:[CONFIG]},
  {start:p.start,end:p.end,topic:'Receipt setup and production',disposition:'needs_decision',responsibility:'deployment',issue_kind:'missing_configuration',interpretation:'Keep the required source-atomic receipt guarantee. Applicable writer/provisioning review, execution permission and a performed receipt require their own evidence; no new receipt is observed here.',draft_paths:[RECEIPTS]});
 return args;
}
function transport(f:any,replies:any[],provider:'openai'|'openrouter'='openrouter'){
 const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const requests:any[]=[];
 const session={provider,model:provider==='openai'?'gpt-5.6-terra':'openai/gpt-5.6-terra',apiKey:'local-only',conversation,
 dependencies:{requestJson:vi.fn(async(r:any)=>{requests.push(structuredClone(r.body));const args=replies[requests.length-1];if(args instanceof Error)throw args;if(!args)throw new Error('No response permitted');
 return {status:200,body:provider==='openai'?{output:[{type:'function_call',call_id:'test',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{id:'test',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]}};})}};
 f.sources.approvals.push({digest:f.source.digest,destination:authoringDestination(session)});
 return {session,requests,run:()=>reviewPolicyCoverage({session,source:f.source,draft:f.draft})};
}
function correction(body:any){
 const all=(body.messages??body.input).map((m:any)=>m.content).filter((x:any)=>typeof x==='string').join('\n');
 const marker='Correct this structural coverage problem: ';
 return JSON.parse(all.split('\n').find((s:string)=>s.startsWith(marker))!.slice(marker.length));
}
describe('complete captured configuration correction chain',()=>{
 it('retains full original invalidity and batches the exact two counter problems plus eligible configuration grouping',()=>{
  const f=fixture(),before=structuredClone(f.arguments);expect(f.arguments.passages).toHaveLength(35);
  expect(()=>parse(f)).toThrow('COUNTING_SUPPORT_MISMATCH');
  const report=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages);
  expect(report.findings.map(x=>[x.code,x.component,x.structural])).toEqual([
   ['COUNTING_SUPPORT_MISMATCH','/passages/21/counter_requirements/0',true],
   ['COUNTING_SUPPORT_MISMATCH','/passages/22/counter_requirements/0',true],
   ['OBLIGATION_CONFIGURATION_COMPONENT_MIXED','/passages/25',true]]);
  expect(report.complete_validation).toBe(false);expect(f.arguments).toEqual(before);
 });
 it('validates ALL separated passages and preserves receipt and readback duties',()=>{
  const f=fixture(),report=parse(f,separated(f));
  expect(report.passages.filter(p=>p.obligation_assessment).every(p=>p.obligation_assessment!.verified===false)).toBe(true);
  expect(report.passages.some(p=>p.application_obligations?.includes('independent_source_readback'))).toBe(true);
  expect(report.counting_inventory?.paths).toHaveLength(2);
  const blockers=policyReadinessItems(report,f.sources).filter(x=>x.blocksReview);
  expect(blockers.length).toBeGreaterThan(0);expect(blockers.every(x=>Boolean(x.clientDuty))).toBe(true); // exact renewed ownership is performed by prepared-review tests below
 });
 it.each(['openai','openrouter'] as const)('%s serializes the actual complete correction request',async provider=>{
  const f=fixture(),t=transport(f,[f.arguments,separated(f)],provider);await t.run();expect(t.requests).toHaveLength(2);
  const fb=correction(t.requests[1]);expect(fb.findings).toHaveLength(3);
  expect(fb.findings.every((x:any)=>x.structural)).toBe(true);
  expect(fb.findings[0].repair).toContain('omit the OPTIONAL counter operator_message_id');
  expect(fb.findings[2].repair).toContain('COMPLETE REPLACEMENT');expect(fb.findings[2].repair).toContain(CONFIG);
 });
 it.each(['effect','overview','triple','reordered','duplicate_only','duplicate_companion','unknown_child','foreign_effect','observation','missing','stale','mode','source','destination','read','action','requirement','field','counter','unsupported_setup','setup_outcome','setup_missing','setup_duplicate','setup_mode'])('classifies %s with an explicit evidence-grounded disposition',kind=>{
  const f=fixture(),c=f.draft.runner_evidence.runtime_contract,p=f.arguments.passages[25];
  if(kind==='effect')p.draft_paths=[CONFIG,EFFECT];
  if(kind==='overview')p.draft_paths=[CONFIG,RECEIPTS];
  if(kind==='reordered')p.draft_paths.reverse();
  if(kind==='duplicate_only')p.draft_paths=[CONFIG,CONFIG];
  if(kind==='duplicate_companion')p.draft_paths.push(CONFIG);
  if(kind==='unknown_child')p.draft_paths.push(CONFIG+'/status');
  if(kind==='foreign_effect')p.draft_paths.push('/read');
  if(kind==='observation')p.draft_paths.push('/runner_evidence/runtime_contract/application_obligations/independent_source_readback');
  if(kind==='missing')delete c.receipt_configuration;
  if(kind==='stale')c.receipt_configuration.status='unavailable';
  if(kind==='mode')c.receipt_configuration.modes[0].authority='runner_ledger';
  if(kind==='source')c.receipt_configuration.modes[0].source='other';
  if(kind==='destination')c.receipt_configuration.source_receipt_destinations[0].relation_digest=canonicalJsonDigest('other');
  if(kind==='read')f.draft.read.name='other';
  if(kind==='action')f.draft.actions[0].effect.target_binding='other';
  if(kind==='requirement')f.source.text=f.source.text.replace('source_db receipt','different receipt');
  if(kind==='field')p.field_checks=[{resource:'private-unknown',field:'private-sensitive',expectation:'private'}];
  if(kind==='counter'){p.counter_requirements=structuredClone(f.arguments.passages[21].counter_requirements);delete p.counter_requirements[0].operator_message_id;p.draft_paths.push(p.counter_requirements[0].path.slice(0,-'/capability'.length));}
  if(kind==='unsupported_setup')c.deployment_prerequisites.runner_execution_setup.supported=false;
  if(kind==='setup_outcome')c.deployment_prerequisites.runner_execution_setup.outcomes[0].outcome='other.outcome';
  if(kind==='setup_missing')c.deployment_prerequisites.runner_execution_setup.outcomes=[];
  if(kind==='setup_duplicate')c.deployment_prerequisites.runner_execution_setup.outcomes.push(structuredClone(c.deployment_prerequisites.runner_execution_setup.outcomes[0]));
  if(kind==='setup_mode')c.deployment_prerequisites.runner_execution_setup.outcomes[0].configured_mode='proposal_only';
  const report=collectCoverageFeedback({passages:[p]},f.source,f.draft,f.operator_messages);
  const relevant=report.findings.filter(x=>x.component==='/passages/0');
  if(kind==='overview')expect(relevant).toHaveLength(0); // existing accepted narrow selection + overview; pending duty remains separate
  else if(['effect','triple','reordered'].includes(kind))expect(relevant).toEqual([expect.objectContaining({code:'OBLIGATION_CONFIGURATION_COMPONENT_MIXED',structural:true})]);
  else expect(relevant.some(x=>x.structural)).toBe(false);
  expect(JSON.stringify(report)).not.toContain('private-sensitive');
 });
 it('separate nonrepairable observation prevents retry and no partial report is accepted',async()=>{
  const f=fixture();f.arguments.passages.push({start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'An actual source receipt proves independent readback.',draft_paths:[RECEIPTS]});
  const t=transport(f,[f.arguments,separated(f)]);await expect(t.run()).rejects.toThrow('POLICY_COVERAGE_INVALID');expect(t.requests).toHaveLength(1);
 });
 it.each(['no_support','wrong_support','heading','condition','duty','false_scalar','false_observation'])('full replacement retains %s blocking',kind=>{
  const f=fixture(),args=separated(f);
  if(kind==='no_support')f.draft.runner_evidence.counting_decisions=[];
  if(kind==='wrong_support')args.passages.find((p:any)=>p.counter_requirements).counter_requirements[0].operator_message_id=2;
  if(kind==='heading'||kind==='condition'){const line=kind==='heading'?1:9;args.passages=args.passages.filter((p:any)=>!(p.start<=line&&p.end>=line));}
  if(kind==='duty')args.passages=args.passages.filter((p:any)=>!p.application_obligations);
  if(kind==='false_scalar')args.passages[25].evidence_checks=[{path:EFFECT+'/target_resource',equals:'different'}];
  if(kind==='false_observation')args.passages.push({start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'Invented observation',draft_paths:[RECEIPTS]});
  if(kind==='duty')expect(policyReviewReadiness(f.source,parse(f,args),{...f.sources,application_assignments:[]} as any).ready).toBe(false);
  else expect(()=>parse(f,args)).toThrow();
 });
 it('equivalent passage/pointer order and renamed identifiers preserve receipt disposition',()=>{
  const f=fixture();f.arguments.passages.reverse();for(const p of f.arguments.passages)p.draft_paths.reverse();
  expect(collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages).findings.map(x=>x.code).sort()).toEqual(['COUNTING_SUPPORT_MISMATCH','COUNTING_SUPPORT_MISMATCH','OBLIGATION_CONFIGURATION_COMPONENT_MIXED'].sort());
  const g=JSON.parse(JSON.stringify(f).split('energy_ops.finalize_settlement_cycle').join('tenant.complete_cycle'));
  const p=g.arguments.passages.find((x:any)=>x.draft_paths.includes(CONFIG)&&x.draft_paths.includes(RECEIPTS));
  expect(collectCoverageFeedback({passages:[p]},g.source,g.draft,g.operator_messages).findings.find(x=>x.code==='OBLIGATION_CONFIGURATION_COMPONENT_MIXED')).toMatchObject({structural:true});
 });
 it.each(['source_requirement_unestablished','selection_unavailable','mode_mismatch','component_not_isolatable','current_selection_mixed_component'] as const)('maps typed configuration reason %s exhaustively; identical plain text stays conservative',reason=>{
  const e=new CoverageReceiptConfigurationError(reason),finding=coverageFinding(e,'/passages/0',{});
  expect(finding.code).not.toBe('COVERAGE_VALIDATION_INCOMPLETE');expect(finding.structural).toBe(reason==='current_selection_mixed_component');
  expect(coverageFinding(new Error(e.message),'/passages/0',{}).structural).toBe(false);
 });
 it.each(['readback_unestablished','setup_unestablished','evidence_stale'] as const)('maps early typed %s without a generic retry',reason=>{
  const finding=coverageFinding(new CoverageReceiptDutyError(reason),'/passages/0',{});
  expect(finding.structural).toBe(false);expect(finding.code).not.toBe('COVERAGE_VALIDATION_INCOMPLETE');
 });
 it.each(['readback','setup','stale'])('real %s validator exposes explicit nonstructural receipt evidence failure',kind=>{
  const f=fixture(),args=separated(f);
  if(kind==='readback')f.draft.runner_evidence.runtime_contract.application_obligations.independent_source_readback.phase='before_execution';
  if(kind==='setup')f.draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.supported=false;
  if(kind==='stale'){
   const saved=parse(f,args);args.passages=saved.passages;const p=args.passages.find((p:any)=>p.obligation_assessment);p.obligation_assessment.dependencies_digest=canonicalJsonDigest('stale');
  }
  const report=collectCoverageFeedback(args,f.source,f.draft,f.operator_messages);
  const code=kind==='readback'?'OBLIGATION_READBACK_UNESTABLISHED':kind==='setup'?'OBLIGATION_SETUP_UNESTABLISHED':'OBLIGATION_EVIDENCE_STALE';
  expect(report.findings.find(x=>x.code===code)).toMatchObject({structural:false});expect(()=>parse(f,args)).toThrow();
 });
 it('repeated invalid response stops without replenishing its correction budget',async()=>{const f=fixture(),t=transport(f,[f.arguments,f.arguments,separated(f)]);await expect(t.run()).rejects.toThrow('POLICY_COVERAGE_INVALID');expect(t.requests).toHaveLength(2);});
 it('a valid first response requires no extra opinion',async()=>{const f=fixture(),t=transport(f,[separated(f)]);await t.run();expect(t.requests).toHaveLength(1);});
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
   const args=wire.length===1?x.f.arguments:separated(x.f);res.setHeader('content-type','text/event-stream');
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
   expect(correction(wire[1]).findings.map((x:any)=>x.code)).toEqual(['COUNTING_SUPPORT_MISMATCH','COUNTING_SUPPORT_MISMATCH','OBLIGATION_CONFIGURATION_COMPONENT_MIXED']);
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
 it.each(['repeated','transport','residual','cancel','failed_save','concurrent_source','drift_read','drift_action','drift_selection','drift_decision'])('%s preserves prior coverage and no partial ownership',async mode=>{
  const x=await prepared(f=>mode==='repeated'?[f.arguments,f.arguments]:mode==='transport'?[f.arguments,new Error('local transport refused')]:mode==='residual'?[f.arguments,{passages:[...separated(f).passages,{start:18,end:18,disposition:'implemented',responsibility:'runner',interpretation:'Invented observation',draft_paths:[RECEIPTS]}]}]:[f.arguments,separated(f)]);
  const priorCoverage=structuredClone(x.f.sources.coverage),priorOwners=structuredClone(x.f.sources.application_assignments);
  try{
   if(mode==='cancel')x.input.operatorSession.confirm.mockResolvedValue(false);
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
   if(['cancel','failed_save','concurrent_source'].includes(mode))expect(x.t.requests).toHaveLength(0);
   else expect(x.t.requests).toHaveLength(2);
  }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
 });
});
