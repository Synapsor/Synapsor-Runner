// Tester-owned qualification wiring. No execution on import; callers must provide accepted plans/signoffs.
import fs from 'node:fs';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';import {performTokenCount,projectCountRequest,validateCountRequest} from './continuation-count-v1.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pin=value=>{const result=JSON.parse(JSON.stringify(value));const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};return freeze(result);};
// No fallback globalfetch: the actual final egress must use the accepted transport.
export function createChargeableForward({ledger,plan,planHash,key,transport,onEvent=()=>{}}){
 plan=pin(plan);assert(typeof transport==='function','ACCEPTED_TRANSPORT_REQUIRED');
 return async(url,init)=>{
  assert([plan.upstream_url,plan.count_endpoint].filter(Boolean).includes(url),'FORWARD_URL');
  assert(Date.now()<Date.parse(plan.deadline),'FORWARD_DEADLINE');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  assert.equal(init.headers.authorization,'Bearer '+key,'FORWARD_KEY_SCOPE');
  const bytes=Buffer.from(init.body),l=JSON.parse(fs.readFileSync(ledger)).larger_programs_lane_c;
  const active=l.entries.filter(e=>e.started_at&&!e.completed_at);assert.equal(active.length,1,'FORWARD_GLOBAL_SERIAL');const e=active[0];
  assert.equal(e.status,'STARTED_COST_UNCERTAIN');assert.equal(l.invocations.find(x=>x.id===e.invocation)?.plan_sha256,planHash,'FORWARD_PLAN');
  assert.equal(e.plan_sha256,planHash,'FORWARD_ENTRY_PLAN');assert.equal(l.policy.journeys[e.journey].plan_sha256,planHash,'FORWARD_CURRENT_PLAN');
  assert(!l.stopped&&!l.stopped_journeys[e.journey],'FORWARD_STOPPED');
  assert.equal(e.kind,url===plan.count_endpoint?'token-count':'inference');assert.equal(e.kind==='token-count'?e.projection_sha256:e.request_sha256,sha(bytes),'FORWARD_FINAL_BYTES');
  assert(init.attemptId===undefined||init.attemptId===e.id,'FORWARD_ATTEMPT_CHANGED');
  onEvent({kind:'authorized_egress_start',url,body_sha256:sha(bytes),ledger_id:e.id,headers_in_capture:false});
  return transport(url,{...init,body:bytes,attemptId:e.id,logicalOperationId:e.logical_operation_id??e.id});
 };
}
function fullSourcePresent(request,plan){
 const source=fs.readFileSync(plan.initial_policy_source_path);assert.equal(sha(source),plan.initial_policy_source_sha256,'INITIAL_SOURCE_CHANGED');
 const strings=[];const visit=v=>{if(typeof v==='string')strings.push(v);else if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(request);
 const lines=source.toString('utf8').split(/\r?\n/).filter(s=>s.trim());
 return lines.every(line=>strings.some(s=>s.includes(line)))&&strings.some(s=>s.includes(plan.initial_job_text.trim()));
}
// History is read-only qualification evidence, separately bound into signed plan/packet.
// Exact keys contain the actual model and all count-relevant settings/payload bytes.
export function loadCountHistory({ledger,journey,plan,onEvent=()=>{}}){
 const cached=new Map();let initialEvidence=null;let fullPlannerCounted=false;
 if(!plan.count_history_path)return {cached,initialEvidence,fullPlannerCounted};
 const bytes=fs.readFileSync(plan.count_history_path);assert.equal(sha(bytes),plan.count_history_sha256,'COUNT_HISTORY_CHANGED');
 const history=JSON.parse(bytes);assert.equal(history.journey,journey,'COUNT_HISTORY_JOURNEY');
 const current=JSON.parse(fs.readFileSync(ledger)).larger_programs_lane_c;
 for(const row of history.rows){
  const e=row.entry;assert.equal(e.journey,journey,'COUNT_HISTORY_CROSS_LANE');
  const actual=current.entries.find(x=>x.id===e.id);assert.deepEqual(actual,e,'COUNT_HISTORY_LEDGER_CHANGED');
  assert(e.kind==='token-count'&&e.completed_at&&e.result?.http_status===200&&e.noninference&&e.no_model_output,'COUNT_HISTORY_NOT_SUCCESSFUL');
  const data={};for(const [name,file]of Object.entries(row.files)){const b=fs.readFileSync(file.path);assert.equal(sha(b),file.sha256,'COUNT_HISTORY_FILE_CHANGED');data[name]=b;}
  const projection=JSON.parse(data['request.raw.json']);const reply=JSON.parse(data['response.raw.json']);const result=JSON.parse(data['RESULT.json']);
  assert.equal(sha(data['request.raw.json']),e.projection_sha256,'COUNT_HISTORY_PROJECTION');assert.equal(sha(data['response.raw.json']),e.result.response_sha256,'COUNT_HISTORY_RESPONSE');
  assert.equal(reply.object,'response.input_tokens');assert.equal(reply.input_tokens,e.result.input_tokens);assert.equal(result.input_tokens,reply.input_tokens);assert.equal(result.id,e.id);assert.equal(result.projection_sha256,e.projection_sha256);assert.deepEqual(result.result.item,e);
  // A different model/settings is history, never exact evidence for this plan.
  if(projection.model!==plan.model||e.counter_profile_sha256!==plan.count_profile_sha256||projection.reasoning&&projection.reasoning.effort!==plan.reasoning_effort)continue;
  validateCountRequest(data['request.raw.json'],plan);
  const evidence=sha(data['RESULT.json']);cached.set(e.projection_sha256,{tokens:reply.input_tokens,evidence_sha256:evidence,projection_sha256:e.projection_sha256,source_request_sha256:e.source_request_sha256});initialEvidence??=evidence;
  if((projection.tools??[]).some(t=>t.name==='runner__plan_boundary_job')&&fullSourcePresent(projection,plan))fullPlannerCounted=true;
 }
 onEvent({kind:'successful_count_history_rehydrated',journey,matching_exact_counts:cached.size,initial_full_job_checked:fullPlannerCounted,history_sha256:sha(bytes)});
 return {cached,initialEvidence,fullPlannerCounted};
}
export function createContextCounter({ledger,journey,invocation,plan,approvals,root,key,privateValues,resourceCheck,forward,onEvent=()=>{}}){
 plan=pin(plan);approvals=pin(approvals);privateValues=[...(privateValues??[])];
 const history=loadCountHistory({ledger,journey,plan,onEvent});const cached=history.cached;let countSequence=0;let initialEvidence=history.initialEvidence;let fullPlannerCounted=history.fullPlannerCounted;const reviewNames=names=>names.includes('runner__review_policy_coverage');
 return async x=>{
  const cap=x.request.max_output_tokens??x.request.max_tokens;const names=(x.request.tools??[]).map(t=>(t.function??t).name??'');const estimate=x.bytes.length+16000;
  const base={validated:true,request_sha256:x.request_sha256,billing_output_upper_tokens:cap,output_bound_validated:true,output_bound_method:plan.output_contract_method,count_rpc_accounting:'none'};
  if(plan.provider==='openrouter'){const firstFull=!fullPlannerCounted&&names.includes('runner__plan_boundary_job');if(firstFull){const source=fs.readFileSync(plan.initial_policy_source_path);assert.equal(sha(source),plan.initial_policy_source_sha256,'INITIAL_SOURCE_CHANGED');const strings=[];const visit=v=>{if(typeof v==='string')strings.push(v);else if(v&&typeof v==='object')Object.values(v).forEach(visit);};visit(x.request);const lines=source.toString('utf8').split(/\r?\n/).filter(s=>s.trim());assert(lines.every(line=>strings.some(s=>s.includes(line))),'INITIAL_FULL_SOURCE_ABSENT');assert(strings.some(s=>s.includes(plan.initial_job_text.trim())),'INITIAL_FULL_JOB_ABSENT');fullPlannerCounted=true;onEvent({kind:'initial_full_job_projection_checked',request_sha256:x.request_sha256,source_sha256:plan.initial_policy_source_sha256,complete_source_lines:lines.length});}return {...base,method:'Owner136 complete encoded UTF8 bytes plus16000; outside context prohibited',input_estimate_tokens:estimate,accounting_method:'owner-bytes-plus-planning',outside_body_context_tokens:0,established_overflow:false};}
  const projected=projectCountRequest(x.bytes,plan);const projectionHash=sha(projected.bytes);let measured=cached.get(projectionHash);const near=estimate>=Math.floor(plan.max_input_tokens*0.75);const wholeReview=cap>=12000||reviewNames(names);const firstFullPlanner=!fullPlannerCounted&&names.includes('runner__plan_boundary_job');if(firstFullPlanner){const source=fs.readFileSync(plan.initial_policy_source_path);assert.equal(sha(source),plan.initial_policy_source_sha256,'INITIAL_SOURCE_CHANGED');const strings=[];const visit=x=>{if(typeof x==='string')strings.push(x);else if(x&&typeof x==='object')Object.values(x).forEach(visit);};visit(x.request);const lines=source.toString('utf8').split(/\r?\n/).filter(s=>s.trim());assert(lines.every(line=>strings.some(s=>s.includes(line))),'INITIAL_FULL_SOURCE_ABSENT');assert(strings.some(s=>s.includes(plan.initial_job_text.trim())),'INITIAL_FULL_JOB_ABSENT');onEvent({kind:'initial_full_job_projection_checked',request_sha256:x.request_sha256,source_sha256:plan.initial_policy_source_sha256,complete_source_lines:lines.length});}
  if(!measured&&(!initialEvidence||firstFullPlanner||near||wholeReview)){
   const id=invocation+'-count-'+String(++countSequence).padStart(4,'0');const result=await performTokenCount({ledger,journey,invocation,id,plan,approvals,inferenceBytes:x.bytes,root:root+'/'+id,key,privateValues,resourceCheck,forward,ownerSignal:x.signal});
   measured={tokens:result.input_tokens,evidence_sha256:sha(JSON.stringify(result)),projection_sha256:projectionHash,source_request_sha256:x.request_sha256};cached.set(projectionHash,measured);initialEvidence??=measured.evidence_sha256;onEvent({kind:'native_count_completed',projection_sha256:projectionHash,count_evidence_sha256:measured.evidence_sha256,input_tokens:measured.tokens,reason:countSequence===1?'initial-complete-input':firstFullPlanner?'initial-full-job-Source':near?'near-context':'materially-different-review'});
  }
  if(firstFullPlanner&&measured)fullPlannerCounted=true;
  if(measured)return {...base,method:'Actual native count of identical count-relevant projection/model; max output independently preserved',input_estimate_tokens:measured.tokens,accounting_method:'native-count',context_input_tokens:measured.tokens,context_method:'native-count',context_evidence_sha256:measured.evidence_sha256,count_rpc_accounting:'separately-recorded',count_projection_sha256:projectionHash};
  assert(initialEvidence,'DIRECT_INITIAL_COUNT_REQUIRED');onEvent({kind:'local_growth_estimate',request_sha256:x.request_sha256,encoded_bytes:x.bytes.length,input_estimate_tokens:estimate,near_context:near,material_review:wholeReview});
  return {...base,method:'Owner136 local complete encoded UTF8 growth estimate after successful initial nativecount',input_estimate_tokens:estimate,accounting_method:'owner-bytes-plus-planning',outside_body_context_tokens:0,established_overflow:false,initial_direct_count_verified:true,initial_direct_count_evidence_sha256:initialEvidence};
 };
}
export function readScopedKey(file,name){assert(['OPENAI_API_KEY','OPENROUTER_API_KEY'].includes(name),'KEY_NAME');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{assert(fs.fstatSync(fd).isFile(),'KEY_FILE_KIND');const source=fs.readFileSync(fd,'utf8');const line=source.split(/\r?\n/).find(s=>new RegExp('^\\s*(?:export\\s+)?'+name+'\\s*=').test(s));assert(line,'KEY_ABSENT');let value=line.slice(line.indexOf('=')+1).trim();if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);assert(value.length>=8&&!/[\u0000-\u0020\u007f]/.test(value),'KEY_FORMAT');return value;}finally{fs.closeSync(fd);}}
