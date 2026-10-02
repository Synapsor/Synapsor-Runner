// Continuation v1: retained v5 ledger/accounting plus explicit bounded A/B recovery. No new allocation.
// Qualification ledger adapter. Reuses the existing bounded exclusive lock;
// never changes Runner records or clears historical charges/holds.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const statePaths=new WeakMap();
import {acquireBudgetLock} from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/source-phase-review-20260921/provider-budget.mjs';

export const hash = x => createHash('sha256').update(x).digest('hex');
const SCALE = 1000000000000n;
export function units(value) {
  const text=String(value); assert(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text),'INVALID_MONEY');
  const [mantissa, exponent='0']=text.toLowerCase().split('e');
  const [whole,fraction='']=mantissa.split('.'); const shift=12+Number(exponent)-fraction.length;
  assert(Number.isSafeInteger(shift)&&Math.abs(shift)<100,'MONEY_RANGE');
  const n=BigInt(whole+fraction);
  return shift>=0?n*10n**BigInt(shift):(n+10n**BigInt(-shift)-1n)/10n**BigInt(-shift);
}
export function dollars(n) { assert(n>=0n);return `${n/SCALE}.${String(n%SCALE).padStart(12,'0')}`; }
const add = values => values.reduce((n,v)=>n+units(v),0n);
function atomicWrite(file,state) {
  const temp=file+`.${process.pid}.tmp`; let fd;
  try {fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  finally {if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function update(file,callback) {
  const lock=file+'.lock',fd=acquireBudgetLock(lock);
  try {const state=JSON.parse(fs.readFileSync(file,'utf8'));statePaths.set(state,path.resolve(file));const result=callback(state);atomicWrite(file,state);return result;}
  finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
const laneJourney=(policy,journey)=>Object.hasOwn(policy.journeys,journey);
const outstanding=entry=>entry.status==='RESERVED'||(entry.started_at&&!entry.completed_at);
const amount = entry => entry.settled_usd??entry.observed_upper_usd??entry.reserved_usd;
export function summary(state) {
  const lane=state.larger_programs_lane_c;assert(lane,'MISSING_LANE');
  const newCharge=add(lane.entries.map(amount));const baseline=add([lane.baseline.settled,lane.baseline.campaign_hold,lane.baseline.external_hold]);
  return {campaign:dollars(baseline+newCharge),combined:dollars(newCharge),by_journey:Object.fromEntries(Object.keys(lane.policy.journeys).map(k=>[k,dollars(add(lane.entries.filter(x=>x.journey===k).map(amount)))]))};
}
// Dead-end lab extension: same accounting/lock; live admission requires explicit joint preflight.
export function checkPhaseGroups(state,extra=0n,journey) {
 const lane=state.larger_programs_lane_c,p=lane.dead_end_lab;
 assert(p?.id==='authoring-dead-end-lab-20261002','LAB_REGISTRATION_REQUIRED');
 checkMode(p,statePaths.get(state));
 assert.deepEqual(p.prior_retest_journeys,['input_agenda_retest','planned_mini_candidate3_830'],'LAB_RETEST_MEMBERSHIP');
 assert.equal(p.retest_total_usd,'50.64');assert.equal(p.campaign_total_usd,'70.32');
 assert.equal(p.owner034_campaign_anchor_usd,'30.31628470');assert.equal(p.owner034_max_new_usd,'40');
 assert.equal(p.lab_total_usd,'8');assert.equal(p.baseline_total_usd,'4');assert.equal(p.protected_main_usd,'20');
 assert(Array.isArray(p.cases)&&p.cases.length<=10&&new Set(p.cases.map(c=>c.journey)).size===p.cases.length,'LAB_CASE_INVENTORY');
 assert(p.cases.filter(c=>c.wave==='baseline').length<=6&&p.cases.filter(c=>c.wave==='postfix').length<=4,'LAB_WAVE_INVENTORY');
 for(const c of p.cases){assert(['baseline','postfix'].includes(c.wave)&&lane.policy.journeys[c.journey],'LAB_CASE_BINDING');
  assert(!p.prior_retest_journeys.includes(c.journey),'LAB_HISTORY_RENAME');
  const q=lane.policy.journeys[c.journey];assert.equal(q.transports,200);assert.equal(q.token_count_calls,20);}
 const ids=p.cases.map(c=>c.journey),baseline=p.cases.filter(c=>c.wave==='baseline').map(c=>c.journey);
 const s=summary(state),retest=add(lane.entries.filter(e=>[...p.prior_retest_journeys,...ids].includes(e.journey)).map(amount));
 const lab=add(lane.entries.filter(e=>ids.includes(e.journey)).map(amount)),base=add(lane.entries.filter(e=>baseline.includes(e.journey)).map(amount));
 assert(retest+extra<=units(p.retest_total_usd),'LAB_RETEST_MONEY_LIMIT');
 assert(units(s.campaign)+extra<=units(p.campaign_total_usd),'LAB_CAMPAIGN_MONEY_LIMIT');
 assert(units(s.campaign)+extra<=units(p.owner034_campaign_anchor_usd)+units(p.owner034_max_new_usd),'LAB_OWNER034_NEW_MONEY_LIMIT');
 assert(lab+extra<=units(p.lab_total_usd),'LAB_TOTAL_MONEY_LIMIT');
 assert(base+(baseline.includes(journey)?extra:0n)<=units(p.baseline_total_usd),'LAB_BASELINE_MONEY_LIMIT');
 const headrooms=[units(p.retest_total_usd)-retest-extra,units(p.campaign_total_usd)-units(s.campaign)-extra,
  units(p.owner034_campaign_anchor_usd)+units(p.owner034_max_new_usd)-units(s.campaign)-extra];
 assert(headrooms.every(v=>v>=units(p.protected_main_usd)),'LAB_PROTECTED_MAIN_HEADROOM');
 return {retest:dollars(retest),campaign:s.campaign,lab:dollars(lab),baseline:dollars(base),main_protection_is_liability:false};
}
function checkLimits(state,journey,extra=0n) {
 const lane=state.larger_programs_lane_c,s=summary(state);
 checkMode(lane.dead_end_lab,statePaths.get(state));
 assert.equal(objectHash(lane.policy),lane.policy_sha256,'POLICY_CONTENT_CHANGED');
 assert.equal(lane.policy.deadline,'2026-10-05T04:36:53Z','LAB_DEADLINE_CHANGED');
 for(const c of lane.dead_end_lab?.cases??[]){
  validateBoundCase(c,lane.dead_end_lab.inventory,!lane.dead_end_lab.disposable_fake_only);
  assert.deepEqual(lane.policy.journeys[c.journey],{...c.limits,plan_sha256:c.plan_sha256},'LIVE_CASE_LIMITS_CHANGED');
  assert.deepEqual(lane.dead_end_lab.recovery_contexts[c.journey],{journey:c.journey,plan_sha256:c.plan_sha256,consent_sha256:c.job_retry_consent_sha256,max_recoveries:6,max_B:3,max_attempts:3,max_B_per_logical:1},'RECOVERY_BOUNDS_CHANGED');
 }
 assert(!lane.stopped,'SHARED_LANES_STOPPED');assert(!lane.stopped_journeys?.[journey],'JOURNEY_STOPPED');
 assert(lane.dead_end_lab?.cases.some(c=>c.journey===journey),'HISTORICAL_JOURNEY_INERT');
 assert(units(s.campaign)+extra<=units(lane.policy.campaign_usd),'CAMPAIGN_MONEY_LIMIT');
 assert(units(s.combined)+extra<=units(lane.policy.combined_usd),'COMBINED_MONEY_LIMIT');
 assert(units(s.by_journey[journey])+extra<=units(lane.policy.journeys[journey].usd),'JOURNEY_MONEY_LIMIT');
 checkPhaseGroups(state,extra,journey);
}
function checkLabCounts(state,kind,extra=1){
 const l=state.larger_programs_lane_c,ids=l.dead_end_lab.cases.map(c=>c.journey);
 const counted=l.entries.filter(e=>ids.includes(e.journey)&&(e.kind??'inference')===kind&&(e.started_at||e.status==='RESERVED')).length;
 const carried=kind==='token-count'?ids.reduce((n,id)=>n+l.policy.journeys[id].historical_token_count_calls,0):0;
 assert(counted+carried+extra<=(kind==='token-count'?100:1200),kind==='token-count'?'LAB_COUNT_LIMIT':'LAB_INFERENCE_LIMIT');
}
export function registerInvocation(file,journey,id,planHash) {
  return update(file,state=>{const lane=state.larger_programs_lane_c;assert(lane?.policy.journeys[journey],'UNKNOWN_JOURNEY');
    assert(!lane.invocations.some(x=>x.id===id),'INVOCATION_COLLISION');checkLimits(state,journey);checkCaseBinding(state,journey);
    assert(Date.now()<Date.parse(lane.policy.deadline),'DEADLINE');
    assert.equal(planHash,lane.policy.journeys[journey].plan_sha256,'PLAN_CHANGED');
    lane.invocations.push({id,journey,plan_sha256:planHash,at:new Date().toISOString()});return id;});
}
export function reserveRequest(file,journey,invocation,requestId,details,reservation) {
  return update(file,state=>{const lane=state.larger_programs_lane_c,policy=lane.policy.journeys[journey];assert(policy,'UNKNOWN_JOURNEY');
    assert(lane.invocations.some(x=>x.id===invocation&&x.journey===journey&&x.plan_sha256===policy.plan_sha256),'UNKNOWN_OR_STALE_INVOCATION');
    assert(!lane.entries.some(x=>x.id===requestId),'REQUEST_COLLISION');assert(!lane.entries.some(outstanding),'CHARGEABLE_REQUEST_OUTSTANDING');assert(Date.now()<Date.parse(lane.policy.deadline),'DEADLINE');
    // Count uncertain-started calls conservatively; reserved but demonstrably unsent
    // requests remain holds and do not magically become consented retries.
    checkCaseBinding(state,journey,details);
    const kind=details.kind??'inference';assert(['inference','token-count'].includes(kind),'UNKNOWN_TRANSPORT_KIND');
    const same=x=>x.journey===journey&&(x.kind??'inference')===kind;
    const calls=lane.entries.filter(x=>same(x)&&x.started_at);
    const reserved=lane.entries.filter(x=>same(x)&&x.status==='RESERVED');
    const carried=kind==='token-count'?policy.historical_token_count_calls:0;
    assert(carried+calls.length+reserved.length<(kind==='token-count'?policy.token_count_calls:policy.transports),kind==='token-count'?'TOKEN_COUNT_CALL_LIMIT':'TRANSPORT_LIMIT');
    assert(kind!=='token-count'||!details.retry_of,'TOKEN_COUNT_RETRY_NOT_AUTHORIZED');
    checkLabCounts(state,kind);
    assert(!details.retry_of,'LEGACY_RETRY_OWNER_FORBIDDEN');
    checkRecoveryAdmission(state,journey,details);
    const n=units(reservation);assert(n>0n,'INVALID_RESERVATION');checkLimits(state,journey,n);
    assert(!Object.keys(details).some(k=>['status','started_at','completed_at','settled_usd','observed_upper_usd'].includes(k)),'ACCOUNTING_FIELDS_FORBIDDEN');
    const item={...details,kind,id:requestId,journey,invocation,reserved_usd:dollars(n),status:'RESERVED',reserved_at:new Date().toISOString()};lane.entries.push(item);return item;});
}
export function markStarted(file,id) {
  return update(file,state=>{const lane=state.larger_programs_lane_c,item=lane.entries.find(x=>x.id===id);assert(item?.status==='RESERVED','NOT_RESERVED');assert(!lane.entries.some(x=>x.id!==id&&outstanding(x)),'CHARGEABLE_REQUEST_OUTSTANDING');
    assert(Date.now()<Date.parse(lane.policy.deadline),'DEADLINE');checkLimits(state,item.journey);checkCaseBinding(state,item.journey,item);
    assert(!item.retry_of,'LEGACY_RETRY_OWNER_FORBIDDEN');
    if(item.recovery_of) checkRecoveryAdmission(state,item.journey,item,item.id);
    item.status='STARTED_COST_UNCERTAIN';item.started_at=new Date().toISOString();return {...item};});
}
export function finishRequest(file,id,{settledUsd,observedUpperUsd,details}) {
  return update(file,state=>{const lane=state.larger_programs_lane_c,item=lane.entries.find(x=>x.id===id);assert(item?.started_at,'NO_STARTED_REQUEST');
    assert(!item.completed_at,'ALREADY_FINISHED');assert(!(settledUsd!=null&&observedUpperUsd!=null),'AMBIGUOUS_SETTLEMENT');
    if(settledUsd!=null){item.settled_usd=dollars(units(settledUsd));item.status='REQUEST_COST_SETTLED';}
    else if(observedUpperUsd!=null){item.observed_upper_usd=dollars(units(observedUpperUsd));item.status='COMPLETE_USAGE_UPPER_HELD_NOT_SETTLED';}
    else {item.status='UNKNOWN_COST_RESERVED';lane.stopped_journeys[item.journey]={reason:'UNRESOLVED_FINANCIAL_TRANSPORT',id,at:new Date().toISOString()};}
    item.completed_at=new Date().toISOString();item.result=details;
    if(units(amount(item))>units(item.reserved_usd)){item.over_reservation=true;lane.stopped_journeys[item.journey]={reason:'PROVIDER_COST_OR_USAGE_EXCEEDED_RESERVATION',id,at:new Date().toISOString()};}
    try{checkPhaseGroups(state);}catch{lane.stopped=true;lane.stop_reason='PHASE_FINANCIAL_LIMIT_EXCEEDED';}
    const s=summary(state);if(units(s.campaign)>units(lane.policy.campaign_usd)||units(s.combined)>units(lane.policy.combined_usd)){lane.stopped=true;lane.stop_reason='FINANCIAL_LIMIT_EXCEEDED';}
    return {item,summary:s,stopped:lane.stopped||!!lane.stopped_journeys[item.journey],shared_stopped:lane.stopped};});
}
export function releaseDemonstrablyUnsent(file,id,evidence) {
  return update(file,state=>{const item=state.larger_programs_lane_c.entries.find(x=>x.id===id);assert(item?.status==='RESERVED'&&!item.started_at,'POSSIBLE_SEND_NO_RELEASE');
    assert(typeof evidence==='string'&&/^[a-f0-9]{64}$/.test(evidence),'EVIDENCE_REQUIRED');
    item.status='DEMONSTRABLY_UNSENT_CLOSED';item.settled_usd='0';item.local_no_send_evidence_sha256=evidence;});
}

// Non-inference counters share money, but not the inference transport pool.
// Endpoint/privacy/no-model-output proof belongs to the separately accepted
// count adapter. This wrapper cannot perform HTTP or authorize a generation.
export function reserveTokenCount(file,journey,invocation,id,details,reservation) {
  assert(details.noninference===true&&details.no_model_output===true,'COUNT_CONTRACT_REQUIRED');
  assert(/^[a-f0-9]{64}$/.test(details.projection_sha256??'')&&/^[a-f0-9]{64}$/.test(details.counter_profile_sha256??''),'COUNT_BINDING_REQUIRED');
  return reserveRequest(file,journey,invocation,id,{...details,kind:'token-count'},reservation);
}
export function transportSummary(state) {
  const lane=state.larger_programs_lane_c;
  return Object.fromEntries(Object.entries(lane.policy.journeys).map(([k,p])=>[k,{inference_started:lane.entries.filter(x=>x.journey===k&&(x.kind??'inference')==='inference'&&x.started_at).length,token_count_started:p.historical_token_count_calls+lane.entries.filter(x=>x.journey===k&&x.kind==='token-count'&&x.started_at).length,token_count_reserved:lane.entries.filter(x=>x.journey===k&&x.kind==='token-count'&&x.status==='RESERVED').length}]));
}

// A completed transport with uncertain cost preserves its hold and stops only
// that journey. Shared integrity/privacy failures stop both; there is no reset.
export function stopJourney(file,journey,reason,{shared=false}={}) {
  assert(/^[A-Z_]+$/.test(reason),'UNSAFE_STOP_REASON');
  return update(file,state=>{const lane=state.larger_programs_lane_c;assert(laneJourney(lane.policy,journey),'UNKNOWN_JOURNEY');
    const record={reason,at:new Date().toISOString()};
    if(shared){lane.stopped=true;lane.stop_reason=reason;}else lane.stopped_journeys[journey]??=record;
    return {shared_stopped:lane.stopped,journey_stopped:!!lane.stopped_journeys[journey]};});
}

const digestOK=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function checkRecoveryAdmission(state,journey,d,exclude){
  const l=state.larger_programs_lane_c,r=l.dead_end_lab?.recovery_contexts?.[journey];
  if(!d.recovery_of){assert(!d.recovery_class&&!d.historical_resume,'UNBOUND_RECOVERY');return;}
  assert(r?.journey===journey,'RECOVERY_NOT_AUTHORIZED');assert(!d.retry_of,'NESTED_RETRY_OWNER');
  const sharedIds=[...l.dead_end_lab.prior_retest_journeys,...l.dead_end_lab.cases.map(c=>c.journey)];
  const shared=l.entries.filter(e=>e.id!==exclude&&sharedIds.includes(e.journey)&&e.recovery_of);
  assert(shared.length<6,'LAB_SHARED_RECOVERY_LIMIT');
  assert(shared.filter(e=>e.recovery_class==='B').length+(d.recovery_class==='B'?1:0)<=3,'LAB_SHARED_B_LIMIT');

  assert(['A','B'].includes(d.recovery_class),'RECOVERY_CLASS');assert((d.kind??'inference')==='inference','COUNT_RECOVERY_FORBIDDEN');
  const parent=l.entries.find(e=>e.id===d.recovery_of&&e.journey===journey);
  assert(parent?.started_at&&parent.completed_at,'RECOVERY_PARENT_INCOMPLETE');
  assert(!l.entries.some(e=>e.id!==exclude&&e.recovery_of===parent.id),'RECOVERY_PARENT_HAS_DESCENDANT');
  const root=parent.logical_operation_id??parent.id;assert(d.logical_operation_id===root,'LOGICAL_OPERATION_CHANGED');
  const descendants=l.entries.filter(e=>e.id!==exclude&&e.journey===journey&&e.recovery_of);
  assert(descendants.length<r.max_recoveries,'RECOVERY_TOTAL_LIMIT');
  assert(descendants.filter(e=>e.recovery_class==='B').length+(d.recovery_class==='B'?1:0)<=r.max_B,'RECOVERY_B_TOTAL_LIMIT');
  const family=l.entries.filter(e=>e.id!==exclude&&(e.id===root||e.logical_operation_id===root));
  assert(family.length<r.max_attempts,'LOGICAL_ATTEMPT_LIMIT');
  assert(!family.some(e=>e.recovery_class==='B')||d.recovery_class!=='B','LOGICAL_B_LIMIT');
  assert(digestOK(d.currentness_sha256)&&digestOK(d.recovery_evidence_sha256),'RECOVERY_CURRENTNESS_REQUIRED');
  if(d.historical_resume){
    assert(d.recovery_of===r.historical_request&&d.recovery_class==='B','HISTORICAL_RECOVERY_SCOPE');
    assert(d.resume_binding_sha256===r.resume_binding_sha256,'RESUME_BINDING_CHANGED');
    assert(digestOK(d.prepared_parent_sha256),'PREPARED_PARENT_REQUIRED');
  }else{
    assert(parent.transport_failure?.classification===d.recovery_class&&parent.transport_failure.retryable===true,'PARENT_NOT_RECOVERABLE');
    assert(parent.transport_failure.cleanup_complete===true,'PARENT_NOT_QUARANTINED');
    assert(parent.request_sha256===d.request_sha256&&parent.plan_sha256===d.plan_sha256,'RECOVERY_BODY_OR_PLAN_CHANGED');
    assert(parent.currentness_sha256===d.currentness_sha256,'RECOVERY_CONTEXT_CHANGED');
  }
}
// Called only after actual transport cleanup. Persist failure/hold BEFORE any retry.
export function finishTransportFailure(file,id,trace,evidenceHash){
  assert(digestOK(evidenceHash),'DIAGNOSTIC_EVIDENCE_REQUIRED');
  return update(file,state=>{
    const l=state.larger_programs_lane_c,e=l.entries.find(e=>e.id===id);
    assert(e?.started_at&&!e.completed_at,'TRANSPORT_ALREADY_FINISHED');
    assert(l.dead_end_lab?.recovery_contexts?.[e.journey]?.journey===e.journey,'CONTINUATION_REQUIRED');
    assert(trace.cleanup_complete===true,'TRANSPORT_NOT_QUARANTINED');
    assert(['A','B','C'].includes(trace.classification),'TRANSPORT_CLASS');
    if(trace.classification==='A')assert(trace.proven_no_api_dispatch===true&&!trace.api_request_created&&!trace.upstream_headers&&!trace.upstream_body_bytes,'NO_EGRESS_NOT_PROVED');
    if(trace.classification==='B')assert(!trace.upstream_headers&&!trace.upstream_body_bytes&&!trace.downstream_bytes&&trace.local_effect_absent===true,'B_LOCAL_EFFECT_NOT_ABSENT');
    e.completed_at=new Date().toISOString();e.transport_failure={...trace,evidence_sha256:evidenceHash};
    if(trace.classification==='A'){e.status='PROVEN_NO_API_DISPATCH';e.settled_usd='0';}
    else e.status='UNKNOWN_COST_RESERVED';
    if(trace.classification==='C'||!trace.retryable)l.stopped_journeys[e.journey]={reason:'TRANSPORT_NOT_RECOVERABLE',id,at:e.completed_at};
    return {item:e,summary:summary(state)};
  });
}

// Append-only mode-specific registration. No credentials or upstream transport here.
const objectHash=x=>hash(JSON.stringify(x));
function checkImports(){
 const bytes=fs.readFileSync(new URL('./IMPORT-PINS.json',import.meta.url));
 assert.equal(hash(bytes),'54d823e17fd2ad02afe34d4ee5eff402bba7c8bf686461da96f2ee113b16e06f','IMPORT_MANIFEST_CHANGED');
 for(const pin of JSON.parse(bytes))assert.equal(hash(fs.readFileSync(pin.path)),pin.sha256,'IMPORTED_GUARD_CHANGED');
}
checkImports();
export function registerDisposableLab(file,proposal,signoffs){
 assert(proposal.disposable_fake_only===true,'LIVE_REGISTRATION_NOT_IMPLEMENTED');
 return registerLab(file,proposal,signoffs,false);
}
export function registerLiveLab(file,proposal,signoffs){return registerLab(file,proposal,signoffs,true);}
function registerLab(file,proposal,signoffs,live){
 const signature=objectHash(proposal);
 const receipt=checkRegistration(file,proposal,signoffs,live);
 return update(file,state=>{
  assert.equal(hash(fs.readFileSync(file)),proposal.expected_ledger_sha256,'REGISTRATION_LEDGER_CHANGED');
  const l=state.larger_programs_lane_c;
  assert(!state.active_operation&&!l.stopped&&!l.entries.some(outstanding),'REGISTRATION_NOT_QUIESCENT');
  assert(!l.dead_end_lab,'ALREADY_REGISTERED');
  assert.equal(l.policy_sha256,proposal.expected_policy_sha256,'REGISTRATION_POLICY_CHANGED');
  assert.equal(objectHash(l.policy),l.policy_sha256,'POLICY_CONTENT_CHANGED');
  assert.equal(proposal.deadline,'2026-10-05T04:36:53Z','DEADLINE_CHANGED');
  assert.equal(objectHash(l.entries),proposal.expected_entries_sha256,'ENTRIES_CHANGED');
  assert.equal(objectHash(l.stopped_journeys),proposal.expected_stops_sha256,'STOPS_CHANGED');
  assert.equal(objectHash(l.invocations),proposal.expected_invocations_sha256,'INVOCATIONS_CHANGED');
  assert.equal(objectHash(l.transport_continuation),proposal.expected_recovery_sha256,'RECOVERY_HISTORY_CHANGED');
  const prior=structuredClone(l.policy), group=structuredClone(proposal.group);
  assert(group.disposable_fake_only===!live&&group.cases.length===1,'FIRST_CASE_ONLY');
  if(live)group.live_registration=receipt;
  assert.deepEqual(group.inventory,SEALED_INVENTORY,'SEALED_INVENTORY_CHANGED');
  assert.equal(group.cases[0].journey,SEALED_INVENTORY[0].journey,'FIRST_CASE_REQUIRED');
  assert.equal(group.id,'authoring-dead-end-lab-20261002');
  assert(!Object.hasOwn(group,'recovery_contexts'),'UNREVIEWED_RECOVERY_CONTEXTS');
  assert.deepEqual(group.cases.map(c=>c.order),group.cases.map((_,i)=>i+1),'CASE_ORDER');
  group.recovery_contexts={};group.closed_cases={};
  for(const c of group.cases){
   validateBoundCase(c,group.inventory,live);
   assert(!Object.hasOwn(prior.journeys,c.journey),'HISTORICAL_JOURNEY_COLLISION');
   assert(c.wave==='baseline'&&c.state===boundState(live),'CASE_NOT_BOUND');
   for(const k of ['plan_sha256','checkpoint_sha256','job_retry_consent_sha256','currentness_sha256','policy_sha256','job_sha256','case_order_sha256','guard_integration_sha256','privacy_sha256','financial_evidence_sha256'])assert(digestOK(c[k]),'CASE_BINDING_REQUIRED:'+k);
   assert.equal(c.limits.usd,'8');assert.equal(c.limits.transports,200);assert.equal(c.limits.token_count_calls,20);assert.equal(c.limits.historical_token_count_calls,0);assert.equal(c.limits.transient_retries,2);
   l.policy.journeys[c.journey]={...c.limits,plan_sha256:c.plan_sha256};
   group.recovery_contexts[c.journey]={journey:c.journey,plan_sha256:c.plan_sha256,consent_sha256:c.job_retry_consent_sha256,max_recoveries:6,max_B:3,max_attempts:3,max_B_per_logical:1};
  }
  l.policy.deadline=proposal.deadline;l.policy_sha256=objectHash(l.policy);l.dead_end_lab=group;
  for(const c of group.cases)checkLimits(state,c.journey);
  assert.deepEqual({...l.policy,deadline:prior.deadline,journeys:prior.journeys},prior,'UNEXPECTED_POLICY_CHANGE');
  (l.amendment_events??=[]).push({id:proposal.id,at:new Date().toISOString(),synthetic_test_only:!live,proposal_sha256:signature,signoffs,prior_policy:prior,prior_policy_sha256:proposal.expected_policy_sha256,preserved_entries_sha256:proposal.expected_entries_sha256});
  return {proposal_sha256:signature,policy_sha256:l.policy_sha256,summary:summary(state)};
 });
}
function checkCaseBinding(state,journey,request){
 const l=state.larger_programs_lane_c,g=l.dead_end_lab,c=g?.cases.find(x=>x.journey===journey);
 checkMode(g,statePaths.get(state));
 assert(c?.state===boundState(!g.disposable_fake_only),'CASE_NOT_BOUND');
 if(!g.disposable_fake_only){
  const receipt=c.live_registration??g.live_registration;checkReceipt(receipt,statePaths.get(state));
  const expected=receipt.proposal.case??receipt.proposal.group.cases.find(x=>x.journey===journey);
  const actual={...c};delete actual.live_registration;
  assert.deepEqual(actual,expected,'LIVE_CASE_CHANGED');
 }
 assert(!g.closed_cases?.[journey],'CASE_CLOSED');
 for(const earlier of g.inventory.filter(x=>x.order<c.order))assert(g.closed_cases?.[earlier.journey],'EARLIER_CASE_UNCLOSED');
 assert.equal(l.policy.journeys[journey].plan_sha256,c.plan_sha256,'CASE_PLAN_CHANGED');
 if(request){
  assert.equal(request.plan_sha256,c.plan_sha256,'REQUEST_PLAN_CHANGED');
  assert.equal(request.consent_sha256,c.job_retry_consent_sha256,'REQUEST_CONSENT_CHANGED');
  // Currentness is freshly measured per operation; case checkpoint is not a stale substitute.
  assert(digestOK(request.currentness_sha256)&&digestOK(request.request_sha256),'REQUEST_BINDING_REQUIRED');
 }
}
export function closeDisposableCase(file,journey,evidence,reason){return closeCase(file,journey,evidence,reason,false);}
export function closeLiveCase(file,journey,evidence,reason){return closeCase(file,journey,evidence,reason,true);}
function closeCase(file,journey,evidence,reason,live){
 assert(digestOK(evidence),'CLOSURE_EVIDENCE_REQUIRED');assert(['COMPLETED','TERMINAL_STOP','PRE_SEND_SKIP'].includes(reason),'CLOSURE_REASON');
 return update(file,state=>{const l=state.larger_programs_lane_c,g=l.dead_end_lab;
  assert(g?.disposable_fake_only===!live,'CLOSURE_MODE_MISMATCH');checkMode(g,path.resolve(file));
  const c=g.inventory.find(x=>x.journey===journey);assert(c&&!g.closed_cases[journey],'CASE_UNKNOWN_OR_CLOSED');
  for(const earlier of g.inventory.filter(x=>x.order<c.order))assert(g.closed_cases[earlier.journey],'EARLIER_CASE_UNCLOSED');
  assert(reason==='PRE_SEND_SKIP'||g.cases.some(x=>x.journey===journey),'UNBOUND_CASE_CANNOT_COMPLETE');
  assert(!l.entries.some(outstanding),'REQUEST_OUTSTANDING');
  if(reason==='PRE_SEND_SKIP')assert(!l.entries.some(e=>e.journey===journey),'CASE_ALREADY_ATTEMPTED');
  g.closed_cases[journey]={at:new Date().toISOString(),evidence_sha256:evidence,reason};
 });
}

const SEALED_INVENTORY=JSON.parse(fs.readFileSync(new URL('../guard-registration-136/SEALED-INVENTORY.json',import.meta.url)));
const identity=c=>Object.fromEntries(['case_id','journey','order','wave','entry','family','policy_sha256','job_sha256','case_order_sha256'].map(k=>[k,c[k]]));
function validateBoundCase(c,inventory,live=false){
 const expected=inventory.find(x=>x.journey===c.journey);assert(expected,'UNDECLARED_CASE');
 assert.deepEqual(identity(c),expected,'CASE_IDENTITY_CHANGED');
 assert.equal(c.state,boundState(live),'CASE_NOT_BOUND');
 for(const k of ['plan_sha256','checkpoint_sha256','job_retry_consent_sha256','currentness_sha256','guard_integration_sha256','privacy_sha256','financial_evidence_sha256'])assert(digestOK(c[k]),'CASE_BINDING_REQUIRED:'+k);
 assert.deepEqual(c.limits,{usd:'8',transports:200,token_count_calls:20,historical_token_count_calls:0,transient_retries:2},'CASE_LIMITS_CHANGED');
}
export function appendDisposableBoundCase(file,a,signoffs){
 assert(a.disposable_fake_only===true,'LIVE_APPEND_NOT_IMPLEMENTED');
 return appendBoundCase(file,a,signoffs,false);
}
export function appendLiveBoundCase(file,a,signoffs){return appendBoundCase(file,a,signoffs,true);}
function appendBoundCase(file,a,signoffs,live){
 const digest=objectHash(a),receipt=checkRegistration(file,a,signoffs,live);
 return update(file,state=>{
  assert.equal(hash(fs.readFileSync(file)),a.expected_ledger_sha256,'APPEND_LEDGER_CHANGED');
  const l=state.larger_programs_lane_c,g=l.dead_end_lab;
  assert(g?.disposable_fake_only===!live&&!state.active_operation&&!l.stopped&&!l.entries.some(outstanding),'APPEND_NOT_QUIESCENT');
  assert.equal(l.policy_sha256,a.expected_policy_sha256,'APPEND_POLICY_CHANGED');assert.equal(objectHash(l.policy),l.policy_sha256,'POLICY_CONTENT_CHANGED');
  assert.equal(objectHash(g.inventory),a.expected_inventory_sha256,'APPEND_INVENTORY_CHANGED');assert.deepEqual(g.inventory,SEALED_INVENTORY,'SEALED_INVENTORY_CHANGED');
  assert(Date.now()<Date.parse(l.policy.deadline),'DEADLINE');
  checkMode(g,path.resolve(file));
  const c=structuredClone(a.case);validateBoundCase(c,g.inventory,live);if(live)c.live_registration=receipt;
  assert(!g.cases.some(x=>x.journey===c.journey)&&!l.policy.journeys[c.journey]&&!g.closed_cases[c.journey],'CASE_ALREADY_BOUND_OR_CLOSED');
  for(const earlier of g.inventory.filter(x=>x.order<c.order))assert(g.closed_cases[earlier.journey],'EARLIER_CASE_UNCLOSED');
  const priorPolicy=structuredClone(l.policy);
  l.policy.journeys[c.journey]={...c.limits,plan_sha256:c.plan_sha256};l.policy_sha256=objectHash(l.policy);
  g.cases.push(c);g.recovery_contexts[c.journey]={journey:c.journey,plan_sha256:c.plan_sha256,consent_sha256:c.job_retry_consent_sha256,max_recoveries:6,max_B:3,max_attempts:3,max_B_per_logical:1};
  checkLimits(state,c.journey);
  (l.amendment_events??=[]).push({id:a.id,at:new Date().toISOString(),synthetic_test_only:!live,kind:'APPEND_BOUND_CASE',proposal_sha256:digest,signoffs,prior_policy:priorPolicy,prior_policy_sha256:a.expected_policy_sha256});
  return {journey:c.journey,policy_sha256:l.policy_sha256,summary:summary(state)};
 });
}

// Experiment harness only. These records are attributed review acknowledgments,
// not cryptographic user signatures and not Runner consent/authority.
const boundState=live=>live?'BOUND_REVIEWED_LIVE':'BOUND_DISPOSABLE_ONLY';
const guardDigest=()=>hash(fs.readFileSync(fileURLToPath(import.meta.url)));
function checkRegistration(file,proposal,signoffs,live){
 assert.equal(proposal.disposable_fake_only,!live,'REGISTRATION_MODE_MISMATCH');
 if(!live)assert.equal(path.basename(file),'DISPOSABLE-LEDGER.json','DISPOSABLE_PATH_REQUIRED');
 if(live){
  assert.equal(proposal.ledger_path,path.resolve(file),'LIVE_LEDGER_PATH_CHANGED');
  assert.equal(proposal.guard_sha256,guardDigest(),'LIVE_GUARD_CHANGED');
  assert(digestOK(proposal.preflight_sha256),'LIVE_PREFLIGHT_REQUIRED');
  assert(proposal.preflight?.path&&hash(fs.readFileSync(proposal.preflight.path))===proposal.preflight_sha256,'LIVE_PREFLIGHT_CHANGED');
 }
 const receipt={proposal:structuredClone(proposal),signoffs:structuredClone(signoffs)};
 checkSignoffs(receipt,live);
 return receipt;
}
function checkSignoffs(receipt,live){
 const {proposal,signoffs}=receipt,digest=objectHash(proposal),seen=new Set();
 for(const role of ['Main','Tester']){
  const ref=signoffs?.[role];assert(ref?.path&&digestOK(ref.sha256),'REGISTRATION_SIGNOFF_REQUIRED');
  const bytes=fs.readFileSync(ref.path);assert.equal(hash(bytes),ref.sha256,'SIGNOFF_CHANGED');
  const s=JSON.parse(bytes);
  assert(s.role===role&&s.accepted===true&&s.synthetic_test_only===!live&&s.proposal_sha256===digest,'SIGNOFF_BINDING');
  if(live){
   assert(typeof s.session_id==='string'&&s.session_id.length>0&&!seen.has(s.session_id),'INDEPENDENT_SESSION_REQUIRED');seen.add(s.session_id);
   assert(s.scope==='LAB_CASE_PAID_PREFLIGHT'&&s.preflight_sha256===proposal.preflight_sha256,'LIVE_SIGNOFF_SCOPE');
   assert(s.ledger_path===proposal.ledger_path&&s.guard_sha256===proposal.guard_sha256,'LIVE_SIGNOFF_TARGET');
  }
 }
}
function checkReceipt(receipt,file){
 checkImports();
 assert(receipt?.proposal,'LIVE_REGISTRATION_REQUIRED');const p=receipt.proposal;
 assert(p.disposable_fake_only===false,'LIVE_REGISTRATION_MODE');
 assert.equal(p.guard_sha256,guardDigest(),'LIVE_GUARD_CHANGED');
 if(file)assert.equal(p.ledger_path,file,'LIVE_LEDGER_PATH_CHANGED');
 assert(p.preflight?.path&&hash(fs.readFileSync(p.preflight.path))===p.preflight_sha256,'LIVE_PREFLIGHT_CHANGED');
 checkSignoffs(receipt,true);
}
function checkMode(group,file){
 assert(group,'LAB_REGISTRATION_REQUIRED');
 if(group.disposable_fake_only===true)return;
 assert(group.disposable_fake_only===false,'LAB_MODE_REQUIRED');
 checkReceipt(group.live_registration,file);
}
