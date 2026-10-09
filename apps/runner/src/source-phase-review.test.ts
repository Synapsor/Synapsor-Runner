import {derivedScopedResponse} from "./test-fixtures/coverage-derived.js";
import fs from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {parsePolicyCoverage,collectCoverageFeedback} from './authoring-policy-coverage.js';
const captured=JSON.parse(await fs.readFile(new URL('./test-fixtures/source-phase-review.json',import.meta.url),'utf8'));
function fixture(key:'A'|'B'){return structuredClone(captured[key]);}
function parse(f:any,args=f.arguments){return parsePolicyCoverage(args,f.source,f.draft,f.operator_messages,f.sources);}
describe('complete saved review source and phases',()=>{
 it('retains both exact A refusals and identifies the missing source range',()=>{
  const f=fixture('A');expect(()=>parse(f)).toThrow('OBLIGATION_OBSERVATION_UNESTABLISHED');
  expect(()=>parse(f,f.replacement)).toThrow('Unaccounted source lines: 22');
  const feedback=collectCoverageFeedback(f.replacement,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(feedback.findings).toContainEqual(expect.objectContaining({code:'COVERAGE_SOURCE_LINES_MISSING',missing_ranges:[{start:22,end:22}]}));
 });
 it('batches independently checkable source omission and receipt packaging without accepting either',()=>{
  const f=fixture('A');f.arguments.passages=f.arguments.passages.filter((p:any)=>p.start!==22);
  const feedback=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(feedback.findings.map(f=>f.code)).toEqual(expect.arrayContaining(['OBLIGATION_OBSERVATION_UNESTABLISHED','COVERAGE_SOURCE_LINES_MISSING']));
  expect(feedback.complete_validation).toBe(false);
 });
 it('identifies B privacy separately from its still-pending independent readback',()=>{
  const f=fixture('B');expect(f.arguments.passages[25].topic).toBe('Receipt privacy');
  expect(f.arguments.passages[28]).toMatchObject({disposition:'needs_decision',application_obligations:['independent_source_readback']});
  expect(()=>parse(f)).toThrow('OBLIGATION_OBSERVATION_UNESTABLISHED');
 });
});

import os from 'node:os';
import path from 'node:path';
import {vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {reviewPolicyCoverage} from './authoring-policy-coverage.js';
import {createModelAuthoringConversation} from './model-authoring-conversation.js';
import {policyReviewReadiness} from './authoring-review-readiness.js';
import {savePolicySources,loadPolicySources} from './authoring-policy-source.js';
import {ensurePreparedPolicyCoverage} from './authoring-prepared-policy-review.js';
import {buildBoundaryAuthoringResumeState,writeBoundaryAuthoringResumeState,
 assertBoundaryAuthoringResumeCurrent,assertBoundaryAuthoringResumeCurrentHeld} from './boundary-authoring-resume.js';
import {withHeldProjectAuthorityAccess,type ProjectAuthorityMutationPermit} from './project-authority-mutation.js';
import {loadRuntimeConfigFromFile} from '@synapsor-runner/mcp-server';
// Current native job ownership for these prepared Source-review fixtures. No
// model completion, reviewed meaning, active authority or source effect is made.
async function bindPhaseJob(root:string,f:ReturnType<typeof fixture>){
 await fs.chmod(root,0o700);await fs.mkdir(path.join(root,'.git'),{recursive:true});
 const config=path.join(root,'synapsor.runner.json');
 await fs.writeFile(config,JSON.stringify({version:1,mode:'read_only',capabilities:[],
  sources:{app:{engine:'postgres',read_url_env:'UNUSED_PHASE_FIXTURE_DB'}},
  trusted_context:{provider:'static_dev',values:{tenant_id:'fixture-private-org',principal:'fixture-private-person'}}}),{mode:0o600});
 loadRuntimeConfigFromFile(config);
 const resume=buildBoundaryAuthoringResumeState({binding:{boundary_name:f.draft.read.pack.name,
  generation_lock_fingerprint:f.draft.read.generation_lock_fingerprint,
  schema_fingerprint:canonicalJsonDigest('declared phase-review inspection'),role_posture_fingerprint:f.draft.read.role_posture_fingerprint},
  stage:'authority_review',jobIntent:'Review this exact retained Source and its current prepared evidence.',
  provider:'openai',model:'offline-not-called',policySourceSession:f.sources.id});
 await writeBoundaryAuthoringResumeState(root,resume,{expectedRevisionDigest:null});
 return {assertCurrent:()=>assertBoundaryAuthoringResumeCurrent(root,resume),
  assertCurrentHeld:(permit:ProjectAuthorityMutationPermit)=>assertBoundaryAuthoringResumeCurrentHeld(root,resume,permit)};
}

import * as receiptConfiguration from './authoring-receipt-configuration.js';
// The receipt configuration remains an explicit typed fixture, but its owner
// seam now requires and validates the real current project's live Held access.
function receiptFixture(configuration:any){
 let current=configuration;
 const reader=vi.spyOn(receiptConfiguration,'authoringReceiptConfigurationHeld')
  .mockImplementation((root,_sources,permit)=>withHeldProjectAuthorityAccess(root,permit,async()=>structuredClone(current)));
 return {reader,change:(next:any)=>{current=next;}};
}
const RECEIPT='/runner_evidence/runtime_contract/receipts';
const READ_EXCLUSION='/runner_evidence/runtime_contract/receipt_read_exclusion';
function correctedA(f:any) {
 const result=structuredClone(f.replacement);
 // DERIVED response: explicitly review only the omitted heading itself. Its
 // following privacy/receipt/duty clauses retain their original entries.
 result.passages.push({start:22,end:22,disposition:'background',interpretation:'Section heading identifying the following scope, privacy, receipt and duty requirements. Those clauses are reviewed individually below.',draft_paths:[]});
 return result;
}
function transport(f:any,submissions:any[],provider:'openai'|'openrouter'='openrouter') {
 const model=provider==='openai'?'gpt-5.6-terra':'openai/gpt-5.6-terra';
 if(provider==='openai') f.sources.approvals.push({digest:f.source.digest,destination:'openai[gpt-5.6-terra] at https://api.openai.com/v1'});
 const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
 const requests:any[]=[];
 const requestJson=vi.fn(async(r:any)=>{
  requests.push(structuredClone(r.body));const rawArgs=submissions[requests.length-1];
  const args=rawArgs instanceof Error?rawArgs:derivedScopedResponse(r.body,rawArgs);
  if(args instanceof Error)throw args;
  if(!args)throw new Error('No further derived response supplied');
  return {status:200,body:provider==='openai'?{output:[{type:'function_call',call_id:'local',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'local',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]}};
 });
 const session={provider,model,apiKey:'local-transport-only',conversation,dependencies:{requestJson}};
 return {session,requests,run:()=>reviewPolicyCoverage({source:f.source,draft:f.draft,session,sourceSession:f.sources})};
}
function question(r:any){return (r.input??r.messages).filter((m:any)=>m.role==='user').map((m:any)=>m.content).join('\n');}
describe('full replacement composed A review',()=>{
 it.each(['openai','openrouter'] as const)('%s preserves missing-source refusal without broadening a scoped correction',async provider=>{
  const f=fixture('A'),t=transport(f,[f.replacement,correctedA(f)],provider);
  await expect(t.run()).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
  expect(t.requests).toHaveLength(1);
  expect(question(t.requests[0])).toContain('"response_contract":"complete_replacement"');
  expect(collectCoverageFeedback(f.replacement,f.source,f.draft,f.operator_messages,undefined,f.sources).findings)
    .toContainEqual(expect.objectContaining({code:'COVERAGE_SOURCE_LINES_MISSING'}));
  // A separately labelled complete DERIVED first submission still validates;
  // it is not an accepted correction to the historical omitted-source report.
  expect(parse(f,correctedA(f)).passages).toHaveLength(correctedA(f).passages.length);
 });
 it('accepts a complete DERIVED first submission, preserving historical failed episodes, then saves/reopens BUSINESS review',async()=>{
  const f=fixture('A'),root=await fs.mkdtemp(path.join(os.tmpdir(),'source-phase-A-'));
  const t=transport(f,[correctedA(f)]),before=structuredClone(f.sources.coverage_episodes);
  receiptFixture(f.draft.runner_evidence.runtime_contract.receipt_configuration);
  try {
   await savePolicySources(root,f.sources);
   const native=await bindPhaseJob(root,f);
   const chooseOption=vi.fn(async()=> 'assign'),confirm=vi.fn(async()=>true);
   const input={projectRoot:root,sources:f.sources,modelSession:t.session,operatorSession:{chooseOption,confirm} as any,
    currentDraft:()=>f.draft,authorityDigest:f.sources.coverage_authority_digest,clarifications:[],...native,state:{}};
   const result=await ensurePreparedPolicyCoverage(input);expect(result.activity).toBe('provider');
   const saved=await loadPolicySources(root,f.sources.id);
   expect(saved.coverage_episodes?.slice(0,before.length)).toEqual(before);
   expect(policyReviewReadiness(f.source,saved.coverage,saved).ready).toBe(true);
   expect(saved.coverage?.passages.filter(p=>p.obligation_assessment?.family==='receipt_setup')).toHaveLength(1);
   t.session.conversation.policySources=saved;
   const again=await ensurePreparedPolicyCoverage({...input,sources:saved,state:{}});
   expect(again.activity).toBe('validated_reuse');expect(t.requests).toHaveLength(1);
  }finally{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});}
 });
});

describe('source completeness and residual controls',()=>{
 it.each([1,14,20,22,24])('an omitted normative/heading/definition/privacy line %s never defaults to background',line=>{
  const f=fixture('A'),args=correctedA(f);
  args.passages=args.passages.filter((p:any)=>!(p.start<=line&&p.end>=line));
  expect(()=>parse(f,args)).toThrow('Unaccounted source lines:');
  expect(collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources).findings[0]).toMatchObject({code:'COVERAGE_SOURCE_LINES_MISSING'});
 });
 it('malformed ranges leave completeness unevaluated rather than inventing missing claims',()=>{
  const f=fixture('A');f.arguments.passages[0].start='private-untrusted-value';
  const report=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(report.unevaluated).toContain('source-range completeness (invalid passage ranges)');
  expect(report.findings.some(x=>x.code==='COVERAGE_SOURCE_LINES_MISSING')).toBe(false);
  expect(JSON.stringify(report)).not.toContain('private-untrusted-value');
 });
 it('bounds a fragmented missing-range report and explicitly labels omitted ranges',()=>{
  const f=fixture('A');f.source.text=Array.from({length:100},(_,i)=>`Requirement ${i+1}`).join('\n');f.source.lines=100;
  const args={passages:Array.from({length:50},(_,i)=>({start:i*2+1,end:i*2+1,disposition:'background',interpretation:'Synthetic range only.',draft_paths:[]}))};
  const feedback=collectCoverageFeedback(args,f.source,f.draft,f.operator_messages,undefined,f.sources);
  expect(feedback.findings[0]?.missing_ranges).toHaveLength(16);expect(feedback.findings[0]?.omitted_range_count).toBe(34);
  expect(feedback.limited).toBe(true);expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThanOrEqual(8192);
 });
 it('permits reordered distinct overlapping claims, refuses exact duplicates and retains contrary claims',()=>{
  const f=fixture('A'),good=correctedA(f);good.passages.reverse();expect(()=>parse(f,good)).not.toThrow();
  good.passages.push(structuredClone(good.passages[0]));expect(()=>parse(f,good)).toThrow('COVERAGE_DUPLICATE_COMPONENT');good.passages.pop();
  good.passages.push({start:16,end:16,disposition:'conflict',responsibility:'runner',interpretation:'A separate required effect is not represented.',draft_paths:['/actions/0/effect']});
  const report=parse(f,good);expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false);
 });
 it('refuses unsupported affirmative receipt/readback observation rather than reclassifying it',()=>{
  const f=fixture('A'),good=correctedA(f);
  good.passages.push({start:26,end:26,disposition:'implemented',responsibility:'runner',interpretation:'The edited revision executed and its result was independently observed.',draft_paths:[RECEIPT]});
  expect(()=>parse(f,good)).toThrow('OBLIGATION_OBSERVATION_UNESTABLISHED');
  expect(collectCoverageFeedback(good,f.source,f.draft,f.operator_messages,undefined,f.sources).findings.at(-1)).toMatchObject({structural:false});
 });
 it('a corrected receipt claim cannot hide a wrong maximum or privacy comparison',()=>{
  for(const kind of ['maximum','privacy']) {
   const f=fixture('A'),good=correctedA(f);
   if(kind==='maximum')good.passages.push({start:20,end:20,disposition:'implemented',responsibility:'runner',interpretation:'Incorrect numeric comparison.',draft_paths:['/runner_evidence/actions/release.clear_assessment/automatic_limits/0'],evidence_checks:[{path:'/runner_evidence/actions/release.clear_assessment/automatic_limits/0/maximum',equals:99}]});
   else {const p=good.passages.find((p:any)=>p.field_checks?.length);p.field_checks[0].expectation=p.field_checks[0].expectation==='private'?'business_visible':'private';}
   expect(()=>parse(f,good)).toThrow(kind==='maximum'?'Mechanical evidence mismatch':'Field coverage mismatch');
  }
 });
 it('omitting counting detail or intrinsic client duties does not establish BUSINESS readiness',()=>{
  const f=fixture('A'),good=correctedA(f);
  for(const p of good.passages)if(p.counter_requirements){delete p.counter_requirements;p.disposition='background';}
  const report=parse(f,good);expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false);
  expect(report.client_duties?.duties?.length??Object.keys(report.client_duties??{}).length).toBeGreaterThan(0);
 });
});

import {receiptReadExclusion,reviewEvidencePhases} from './authoring-receipt-read-evidence.js';
import {rolePostureFingerprint,schemaFingerprintForInspection} from '@synapsor-runner/schema-inspector';
function preparedB(){
 const f=fixture('B'),config=f.draft.runner_evidence.runtime_contract.receipt_configuration;
 // Derived current preparation: new summary uses authentic restored reader
 // metadata and the exact existing configured destination's opaque identity.
 config.source_receipt_destinations=[f.configured_destination];
 f.draft.runner_evidence.runtime_contract.receipt_read_exclusion=receiptReadExclusion(f.draft.read,config,f.reader_evidence);
 f.draft.runner_evidence.runtime_contract.review_evidence_phases=reviewEvidencePhases(null,f.draft.read);
 return f;
}
function correctedB(f:any){const args=structuredClone(f.arguments);args.passages[25].draft_paths=[READ_EXCLUSION];return args;}
function refreshInspection(f:any){
 const e=f.reader_evidence;
 e.generationLock.schema_fingerprint=schemaFingerprintForInspection(e.inspection);
 e.generationLock.role_posture_fingerprint=rolePostureFingerprint(e.inspection);
 f.draft.read.generation_lock_fingerprint=canonicalJsonDigest(e.generationLock);
 f.draft.read.role_posture_fingerprint=e.generationLock.role_posture_fingerprint;
}
describe('exact B complete review with separately proven receipt Read exclusion',()=>{
 it('keeps raw B refused, exposes a typed correction only with current narrow proof, and completes the full replacement',()=>{
  const f=preparedB(),proof=f.draft.runner_evidence.runtime_contract.receipt_read_exclusion;
  expect(proof).toMatchObject({excluded:true,scope:'selected_read_graph',resource_count:4,destination_count:1});
  expect(JSON.stringify(proof)).not.toContain('synapsor_writeback_receipts');
  expect(()=>parse(f)).toThrow('COVERAGE_RECEIPT_REFERENCE_OVERBROAD');
  const finding=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages,undefined,f.sources).findings;
  expect(finding).toEqual([expect.objectContaining({code:'COVERAGE_RECEIPT_REFERENCE_OVERBROAD',structural:true,component:'/passages/25'})]);
  expect(finding[0]!.repair).toContain(READ_EXCLUSION);
  const report=parse(f,correctedB(f));
  expect(report.passages[25]!.interpretation).toBe(f.arguments.passages[25].interpretation);
  expect(report.passages[28]!.obligation_assessment).toMatchObject({family:'independent_source_readback',verified:false,state:'pending'});
  expect(report.passages.some(p=>p.obligation_assessment?.family==='receipt_setup')).toBe(true);
 });
 it.each(['openai','openrouter'] as const)('%s keeps B pending locally before another model opinion when source meaning is unconfirmed',async provider=>{
  const f=preparedB(),root=await fs.mkdtemp(path.join(os.tmpdir(),'source-phase-B-'));
  const t=transport(f,[f.arguments,correctedB(f)],provider),before=structuredClone(f.sources.coverage_episodes);
  const originalCoverage=structuredClone(f.sources.coverage),originalAssignments=structuredClone(f.sources.application_assignments);
  receiptFixture(f.draft.runner_evidence.runtime_contract.receipt_configuration);
  try {
   await savePolicySources(root,f.sources);
   const native=await bindPhaseJob(root,f);
   const input={projectRoot:root,sources:f.sources,modelSession:t.session,operatorSession:{chooseOption:async()=> 'assign',confirm:async()=>true} as any,
    currentDraft:()=>f.draft,authorityDigest:f.sources.coverage_authority_digest,clarifications:[],...native,state:{}};
   await expect(ensurePreparedPolicyCoverage(input)).rejects.toThrow('SOURCE_TRANSACTION_REVIEW_PENDING');
   expect(t.requests).toHaveLength(0);
   const saved=await loadPolicySources(root,f.sources.id);
   expect(saved.coverage).toEqual(originalCoverage);
   expect(saved.coverage_episodes?.slice(0,before.length)).toEqual(before);
   expect(saved.application_assignments).toEqual(originalAssignments);
   expect(saved.coverage_episodes).toEqual(before);
   if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR) await fs.writeFile(path.join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR,`B-${provider}-composed.json`),JSON.stringify({classification:'DERIVED local transport; historical phase missing current candidate; refused without BUSINESS completion',requests:t.requests,coverage:saved.coverage,latest_episode:saved.coverage_episodes?.at(-1)},null,2));
  }finally{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});}
 });
 it.each(['missing_selection','wrong_mode','wrong_source','destination_unknown','second_authority','partial_graph','view','renamed_alias','stale_read','stale_configuration','historical_substitution'])(
  '%s never supplies receipt Read-exclusion evidence',variant=>{
   const f=preparedB(),config=f.draft.runner_evidence.runtime_contract.receipt_configuration;
   if(variant==='missing_selection')config.status='absent';
   if(variant==='wrong_mode')config.modes[0].authority='runner_ledger';
   if(variant==='wrong_source')config.modes[0].source='different';
   if(variant==='destination_unknown')config.source_receipt_destinations[0].relation_digest=null;
   if(variant==='second_authority')config.modes.push({source:'other',authority:'source_db'});
   if(variant==='partial_graph')f.draft.read.pack.resources.pop();
   if(variant==='view'){f.reader_evidence.inspection.tables[0].type='view';refreshInspection(f);}
   if(variant==='renamed_alias'){f.draft.read.pack.resources[0].table='uninspected_alias';}
   if(variant==='stale_read')f.draft.read.generation_lock_fingerprint=canonicalJsonDigest('other');
   if(variant==='stale_configuration')config.status='unavailable';
   if(variant==='historical_substitution')delete config.source_receipt_destinations;
   expect(receiptReadExclusion(f.draft.read,config,f.reader_evidence)).toBeNull();
 });
 it('detects direct or renamed resource mapping to the configured receipt destination',()=>{
  for(const rename of [false,true]) {
   const f=preparedB(),config=f.draft.runner_evidence.runtime_contract.receipt_configuration;
   const resource=f.draft.read.pack.resources[0];
   config.source_receipt_destinations[0].relation_digest=canonicalJsonDigest({schema:resource.schema,table:resource.table});
   if(rename)resource.id='renamed.receipt_alias';
   expect(receiptReadExclusion(f.draft.read,config,f.reader_evidence)?.excluded).toBe(false);
  }
 });
 it.each(['read','configuration','graph','destination','false','missing','extra','numeric','privacy','duty','observation'])(
  'the narrow association refuses %s drift or residual claims',variant=>{
   const f=preparedB(),args=correctedB(f),proof=f.draft.runner_evidence.runtime_contract.receipt_read_exclusion;
   if(variant==='read')proof.selected_read_digest=canonicalJsonDigest('stale');
   if(variant==='configuration')proof.configuration_digest=canonicalJsonDigest('stale');
   if(variant==='graph')proof.graph_digest=canonicalJsonDigest('stale');
   if(variant==='destination')proof.destination_binding_digest=canonicalJsonDigest('stale');
   if(variant==='false')proof.excluded=false;
   if(variant==='missing')f.draft.runner_evidence.runtime_contract.receipt_read_exclusion=null;
   if(variant==='extra')args.passages[25].draft_paths.push('/read');
   if(variant==='numeric')args.passages[25].draft_paths.push('/actions/0/approval');
   if(variant==='privacy')args.passages[25].field_checks=[{resource:f.draft.read.pack.resources[0].id,field:'detail',expectation:'private'}];
   if(variant==='duty')args.passages[25].application_obligations=['independent_source_readback'];
   if(variant==='observation')args.passages[25].draft_paths.push(RECEIPT);
   expect(()=>parse(f,args)).toThrow();
  });
});

describe('saved replacement freshness and cleanup',()=>{
 it.each(['read','receipt','source','draft'])('a %s change between responses refuses reuse/correction of the old context',async change=>{
  const f=preparedB(),t=transport(f,[f.arguments,correctedB(f)]);
  await expect(reviewPolicyCoverage({source:f.source,draft:f.draft,session:t.session,sourceSession:f.sources,episode:{beforeSubmission:async()=>{},afterSubmission:async()=>{
   if(change==='read')f.draft.read.pack.resources.reverse();
   if(change==='receipt')f.draft.runner_evidence.runtime_contract.receipt_configuration.digest=canonicalJsonDigest('changed');
   if(change==='source')f.source.digest=canonicalJsonDigest('changed');
   if(change==='draft')f.draft.actions[0].approval.shared_limits[0].maximum++;
  }}})).rejects.toThrow('POLICY_COVERAGE_CONTEXT_CHANGED');
  expect(t.requests).toHaveLength(1);
 });
 it.each(['configuration','competing_save'])('a %s after production saves no new coverage or ownership',async failure=>{
  const f=fixture('A'),root=await fs.mkdtemp(path.join(os.tmpdir(),'source-phase-failure-')),t=transport(f,[correctedA(f)]);
  const mock=receiptFixture(f.draft.runner_evidence.runtime_contract.receipt_configuration);
  try {
   await savePolicySources(root,f.sources);
   const native=await bindPhaseJob(root,f);
   const oldCoverage=structuredClone(f.sources.coverage),oldOwnership=structuredClone(f.sources.application_assignments);
   if(failure==='competing_save') {
    const request=t.session.dependencies.requestJson;
    t.session.dependencies.requestJson=vi.fn(async(r:any)=>{
     const response=await request(r);
     // Competing writer completes while provider work is OUTSIDE coordination.
     // Do not invent a nested second writer inside the held save lock.
     await savePolicySources(root,{...f.sources,operator_messages:[...f.sources.operator_messages,'Synthetic competing decision.']});
     return response;
    });
   }
   const input={projectRoot:root,sources:f.sources,modelSession:t.session,operatorSession:{chooseOption:async()=> 'assign',confirm:async()=>true} as any,
    currentDraft:()=>f.draft,authorityDigest:f.sources.coverage_authority_digest,clarifications:[],state:{},assertCurrentHeld:native.assertCurrentHeld,assertCurrent:async()=>{
     await native.assertCurrent();
     if(t.requests.length){
      if(failure==='configuration')mock.change({...f.draft.runner_evidence.runtime_contract.receipt_configuration,digest:canonicalJsonDigest('changed')});
     }
    }};
   await expect(ensurePreparedPolicyCoverage(input)).rejects.toThrow(failure==='configuration'?'OBLIGATION_CONFIGURATION_CHANGED':'POLICY_SOURCE_CHANGED');
   const saved=await loadPolicySources(root,f.sources.id);expect(saved.coverage).toEqual(oldCoverage);expect(saved.application_assignments).toEqual(oldOwnership);
  }finally{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});}
 });
 it('keeps exact scope after renaming/reordering metadata and relationship bindings',()=>{
  const f=preparedB(),read=f.draft.read,config=f.draft.runner_evidence.runtime_contract.receipt_configuration;
  const names=new Map(read.pack.resources.map((r:any,i:number)=>[r.id,`permitted_${i}`]));
  for(const r of read.pack.resources){r.id=names.get(r.id);for(const link of r.relationships??[])link.target_resource=names.get(link.target_resource);}
  read.pack.resources.reverse();f.reader_evidence.inspection.tables.reverse();refreshInspection(f);
  expect(receiptReadExclusion(read,config,f.reader_evidence)).toMatchObject({excluded:true,resource_count:4});
 });
 it('phase meanings keep current configuration distinct from stale intent and absent applicable authorization',()=>{
  for(const key of ['A','B'] as const){
   const f=fixture(key),c=f.draft.runner_evidence.runtime_contract;
   expect(c.receipt_configuration.status).toBe('current');expect(c.receipt_configuration.reviewed_intent.status).toBe('stale');expect(c.saved_execution_review).toBeNull();
   const phases=reviewEvidencePhases('sha256:'+'a'.repeat(64),f.draft.read);
   expect(phases.configuration).toContain('stale intent does not erase');expect(phases.execution_authorization).toContain('not that an older revision never');
   expect(phases.historical_observations).toContain('No operation-bound historical receipts');expect(phases.pending).toContain('do not require a post-edit receipt before publication');
  }
 });
});
