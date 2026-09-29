// Continuation v1: retained v5 ledger/accounting plus explicit bounded A/B recovery. No new allocation.
// Qualification ledger adapter. Reuses the existing bounded exclusive lock;
// never changes Runner records or clears historical charges/holds.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
  try {const state=JSON.parse(fs.readFileSync(file,'utf8'));const result=callback(state);atomicWrite(file,state);return result;}
  finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function initialize(file,seed,expectedSeedHash,policy) {
  assert(!fs.existsSync(file),'LEDGER_ALREADY_EXISTS');const bytes=fs.readFileSync(seed);assert.equal(hash(bytes),expectedSeedHash,'SEED_CHANGED');
  const state=JSON.parse(bytes);assert.equal(state.active_operation,null,'OLD_OPERATION_OPEN');assert(!state.larger_programs_lane_c,'ALREADY_INITIALIZED');
  assert.equal(policy.campaign_usd,'60');assert.equal(policy.combined_usd,'40');assert.equal(policy.serial_chargeable_egress,true,'SERIAL_REQUIRED');
  assert(Object.keys(policy.journeys).length===2);
  for(const j of Object.values(policy.journeys)){assert.equal(j.usd,'20');assert.equal(j.transports,400);assert.equal(j.transient_retries,2);assert.equal(j.token_count_calls,100);assert(Number.isSafeInteger(j.historical_token_count_calls)&&j.historical_token_count_calls>=0&&j.historical_token_count_calls<=100);}
  state.larger_programs_lane_c={version:1,seed_sha256:expectedSeedHash,seed_path:seed,
    policy,policy_sha256:hash(JSON.stringify(policy)),stopped_journeys:{},baseline:{settled:state.settled_spend_usd,
      campaign_hold:state.uncertain_hold_usd,external_hold:state.older_hold_already_reflected_usd,
      historical_transports:(state.new_provider_transports??[]).length},invocations:[],entries:[],stopped:false};
  for(const x of policy.carried_liabilities??[]){
    assert(laneJourney(policy,x.journey)&&typeof x.id==='string'&&/^[a-f0-9]{64}$/.test(x.evidence_sha256),'CARRIED_LIABILITY_BINDING');
    assert(!state.larger_programs_lane_c.entries.some(e=>e.id===x.id),'CARRIED_LIABILITY_COLLISION');
    assert(units(x.usd)>0n,'INVALID_CARRIED_LIABILITY');
    state.larger_programs_lane_c.entries.push({id:x.id,journey:x.journey,kind:x.kind??'token-count',historical:true,status:'CARRIED_PROVISIONAL_LIABILITY',observed_upper_usd:dollars(units(x.usd)),evidence_sha256:x.evidence_sha256});
  }
  for(const journey of Object.keys(policy.journeys))checkLimits(state,journey);
  const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
const laneJourney=(policy,journey)=>Object.hasOwn(policy.journeys,journey);
const outstanding=entry=>entry.status==='RESERVED'||(entry.started_at&&!entry.completed_at);
const amount = entry => entry.settled_usd??entry.observed_upper_usd??entry.reserved_usd;
export function summary(state) {
  const lane=state.larger_programs_lane_c;assert(lane,'MISSING_LANE');
  const newCharge=add(lane.entries.map(amount));const baseline=add([lane.baseline.settled,lane.baseline.campaign_hold,lane.baseline.external_hold]);
  return {campaign:dollars(baseline+newCharge),combined:dollars(newCharge),by_journey:Object.fromEntries(Object.keys(lane.policy.journeys).map(k=>[k,dollars(add(lane.entries.filter(x=>x.journey===k).map(amount)))]))};
}
function checkLimits(state,journey,extra=0n) {
  const lane=state.larger_programs_lane_c,s=summary(state);assert(!lane.stopped,'SHARED_LANES_STOPPED');assert(!lane.stopped_journeys?.[journey],'JOURNEY_STOPPED');
  assert(units(s.campaign)+extra<=units(lane.policy.campaign_usd),'CAMPAIGN_MONEY_LIMIT');
  assert(units(s.combined)+extra<=units(lane.policy.combined_usd),'COMBINED_MONEY_LIMIT');
  assert(units(s.by_journey[journey])+extra<=units(lane.policy.journeys[journey].usd),'JOURNEY_MONEY_LIMIT');
}
export function registerInvocation(file,journey,id,planHash) {
  return update(file,state=>{const lane=state.larger_programs_lane_c;assert(lane?.policy.journeys[journey],'UNKNOWN_JOURNEY');
    assert(!lane.invocations.some(x=>x.id===id),'INVOCATION_COLLISION');checkLimits(state,journey);
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
    const kind=details.kind??'inference';assert(['inference','token-count'].includes(kind),'UNKNOWN_TRANSPORT_KIND');
    const same=x=>x.journey===journey&&(x.kind??'inference')===kind;
    const calls=lane.entries.filter(x=>same(x)&&x.started_at);
    const reserved=lane.entries.filter(x=>same(x)&&x.status==='RESERVED');
    const carried=kind==='token-count'?policy.historical_token_count_calls:0;
    assert(carried+calls.length+reserved.length<(kind==='token-count'?policy.token_count_calls:policy.transports),kind==='token-count'?'TOKEN_COUNT_CALL_LIMIT':'TRANSPORT_LIMIT');
    assert(kind!=='token-count'||!details.retry_of,'TOKEN_COUNT_RETRY_NOT_AUTHORIZED');
    if(details.retry_of){assert(lane.entries.find(x=>x.id===details.retry_of&&x.journey===journey&&x.started_at),'UNKNOWN_RETRY_PARENT');assert([...calls,...reserved].filter(x=>x.retry_of).length<policy.transient_retries,'RETRY_LIMIT');}
    checkRecoveryAdmission(state,journey,details);
    const n=units(reservation);assert(n>0n,'INVALID_RESERVATION');checkLimits(state,journey,n);
    assert(!Object.keys(details).some(k=>['status','started_at','completed_at','settled_usd','observed_upper_usd'].includes(k)),'ACCOUNTING_FIELDS_FORBIDDEN');
    const item={...details,kind,id:requestId,journey,invocation,reserved_usd:dollars(n),status:'RESERVED',reserved_at:new Date().toISOString()};lane.entries.push(item);return item;});
}
export function markStarted(file,id) {
  return update(file,state=>{const lane=state.larger_programs_lane_c,item=lane.entries.find(x=>x.id===id);assert(item?.status==='RESERVED','NOT_RESERVED');assert(!lane.entries.some(x=>x.id!==id&&outstanding(x)),'CHARGEABLE_REQUEST_OUTSTANDING');
    assert(Date.now()<Date.parse(lane.policy.deadline),'DEADLINE');checkLimits(state,item.journey);
    if(item.retry_of)assert(lane.entries.filter(x=>x.journey===item.journey&&x.started_at&&x.retry_of).length<lane.policy.journeys[item.journey].transient_retries,'RETRY_LIMIT');
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

// Owner170 is a specific amendment to an existing stopped experiment. It is not
// an initializer, refund engine, retry authorization or generic stop override.
export function applyOwner170(file,amendment,signoffs) {
  const digest=hash(JSON.stringify(amendment));
  for(const role of ['Main','Tester']) {
    const s=signoffs?.[role];assert(s?.path&&s?.sha256,'AMENDMENT_SIGNOFF_REQUIRED');
    const b=fs.readFileSync(s.path);assert.equal(hash(b),s.sha256,'AMENDMENT_SIGNOFF_CHANGED');
    const a=JSON.parse(b);assert(a.role===role&&a.accepted===true&&a.amendment_sha256===digest,'AMENDMENT_SIGNOFF_MISMATCH');
  }
  return update(file,state=>{
    assert.equal(hash(fs.readFileSync(file)),amendment.expected_ledger_sha256,'AMENDMENT_LEDGER_CHANGED');
    assert(/^[a-f0-9]{64}$/.test(amendment.owner_evidence_sha256??''),'OWNER_EVIDENCE_REQUIRED');
    const l=state.larger_programs_lane_c;assert(!l.stopped&&!l.entries.some(outstanding),'AMENDMENT_NOT_QUIESCENT');
    assert(!l.amendment_events?.some(e=>e.id===amendment.id),'AMENDMENT_COLLISION');
    assert.equal(l.policy_sha256,amendment.expected_policy_sha256,'AMENDMENT_POLICY_CHANGED');
    assert(/^[a-f0-9]{64}$/.test(amendment.headroom_evidence_sha256??''),'HEADROOM_AUTHORITY_REQUIRED');
    const p=amendment.policy;
    assert.equal(p.campaign_usd,'80');assert.equal(p.combined_usd,'60');assert.equal(p.deadline,'2026-10-01T23:59:00Z');
    assert.equal(p.serial_chargeable_egress,true);assert.deepEqual(Object.keys(p.journeys).sort(),['direct','mini','or']);
    assert.deepEqual({...p,journeys:undefined,campaign_usd:undefined,combined_usd:undefined,deadline:undefined},
      {...l.policy,journeys:undefined,campaign_usd:undefined,combined_usd:undefined,deadline:undefined},'UNAUTHORIZED_POLICY_CHANGE');
    for(const [j,cap] of Object.entries({direct:'30',or:'20',mini:'10'})) {
      const q=p.journeys[j];assert.equal(q.usd,cap);assert.equal(q.transports,800);assert.equal(q.token_count_calls,100);assert.equal(q.transient_retries,2);
      assert(/^[a-f0-9]{64}$/.test(q.plan_sha256),'MISSING_PLAN_BINDING');
      assert.equal(q.historical_token_count_calls,j==='mini'?0:l.policy.journeys[j].historical_token_count_calls);
      if(j!=='mini')assert.deepEqual({...q,usd:undefined,transports:undefined,plan_sha256:undefined},{...l.policy.journeys[j],usd:undefined,transports:undefined,plan_sha256:undefined},'OLD_LANE_LIMIT_CHANGED');
    }
    const candidates=l.entries.filter(e=>e.journey==='direct'&&e.kind==='inference'&&!e.historical);
    assert.equal(amendment.reconciliations.length,candidates.length,'RECONCILIATION_INVENTORY');
    assert.equal(new Set(amendment.reconciliations.map(r=>r.id)).size,candidates.length,'RECONCILIATION_DUPLICATE');
    const changes=[];
    for(const r of amendment.reconciliations) {
      const e=candidates.find(e=>e.id===r.id);assert(e&&e.status==='COMPLETE_USAGE_UPPER_HELD_NOT_SETTLED'&&e.completed_at,'NOT_RECONCILABLE');
      assert.equal(hash(JSON.stringify(e)),r.expected_entry_sha256,'RECONCILIATION_ENTRY_CHANGED');
      assert.equal(e.result.response_sha256,r.response_sha256,'RECONCILIATION_RESPONSE_CHANGED');
      assert(/^[a-f0-9]{64}$/.test(r.evidence_sha256??''),'RECONCILIATION_EVIDENCE_REQUIRED');
      const v=units(r.computed_usd);assert(v<=units(e.reserved_usd)&&v<=units(amount(e)),'RECONCILIATION_INCREASE_REQUIRES_STOP');
      changes.push({id:e.id,prior:JSON.parse(JSON.stringify(e)),new_computed_usd:dollars(v),released_usd:dollars(units(amount(e))-v),evidence_sha256:r.evidence_sha256});
      e.settled_usd=dollars(v);e.status='USAGE_COST_COMPUTED_NOT_INVOICE';e.reconciliation_event=amendment.id;
    }
    const oldStop=l.stopped_journeys.direct;
    assert(!oldStop||oldStop.reason==='JOURNEY_MONEY_LIMIT','SUBSTANTIVE_STOP_NOT_REOPENED');
    (l.amendment_events??=[]).push({id:amendment.id,at:new Date().toISOString(),amendment_sha256:digest,owner_evidence_sha256:amendment.owner_evidence_sha256,headroom_evidence_sha256:amendment.headroom_evidence_sha256,prior_policy:l.policy,prior_policy_sha256:l.policy_sha256,prior_direct_stop:oldStop??null,reconciliations:changes,signoffs});
    l.policy=p;l.policy_sha256=hash(JSON.stringify(p));delete l.stopped_journeys.direct;
    for(const j of Object.keys(p.journeys))if(!l.stopped_journeys[j])checkLimits(state,j);
    return {amendment_sha256:digest,summary:summary(state),counters:transportSummary(state)};
  });
}

const digestOK=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function checkRecoveryAdmission(state,journey,d,exclude){
  const l=state.larger_programs_lane_c,r=l.transport_continuation;
  if(!d.recovery_of){assert(!d.recovery_class&&!d.historical_resume,'UNBOUND_RECOVERY');return;}
  assert(r?.journey===journey,'RECOVERY_NOT_AUTHORIZED');assert(!d.retry_of,'NESTED_RETRY_OWNER');
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
    assert(l.transport_continuation?.journey===e.journey,'CONTINUATION_REQUIRED');
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
// Specific owner continuation: retain all entries and prior stops; reopen ONLY retest.
export function applyTransportContinuation(file,a,signoffs){
  const digest=hash(JSON.stringify(a));
  for(const role of ['Main','Tester']){const s=signoffs?.[role];assert(s?.path&&digestOK(s.sha256),'SIGNOFF_REQUIRED');const b=fs.readFileSync(s.path);assert.equal(hash(b),s.sha256,'SIGNOFF_CHANGED');const v=JSON.parse(b);assert(v.role===role&&v.accepted===true&&v.amendment_sha256===digest,'SIGNOFF_MISMATCH');}
  return update(file,state=>{
    assert.equal(hash(fs.readFileSync(file)),a.expected_ledger_sha256,'LEDGER_CHANGED');const l=state.larger_programs_lane_c;
    assert(!l.stopped&&!l.entries.some(outstanding)&&!l.transport_continuation,'CONTINUATION_NOT_QUIESCENT');
    assert.equal(a.owner_sha256,'d67614f539b907953e8655081a5535dbc7ec9a2b643096ab2cbe698ef86bdf17','OWNER_CHANGED');
    assert.equal(a.journey,'input_agenda_retest');assert.equal(a.deadline,'2026-09-30T18:47:55Z');
    assert(digestOK(a.plan_sha256)&&digestOK(a.resume_binding_sha256)&&digestOK(a.local_state_evidence_sha256),'CONTINUATION_BINDINGS');
    const p=l.policy.journeys[a.journey];assert.equal(units(p.usd),units('20'));assert.equal(p.transports,800);assert.equal(p.token_count_calls,100);
    const e=l.entries.find(x=>x.id===a.historical_request);assert(e?.journey===a.journey&&e.status==='UNKNOWN_COST_RESERVED'&&e.completed_at,'HISTORICAL_STATE');
    assert.equal(e.request_sha256,'a1b202084944850862536d2b989532e10405f086afaa2478aa19c17cb7d9959a');
    assert.equal(units(e.reserved_usd),units('2.7900625'));assert.equal(hash(JSON.stringify(e)),a.historical_entry_sha256,'HISTORICAL_ENTRY_CHANGED');
    assert(l.stopped_journeys[a.journey]?.reason==='UNRESOLVED_FINANCIAL_TRANSPORT','OTHER_STOP_NOT_REOPENED');
    (l.amendment_events??=[]).push({id:a.id,at:new Date().toISOString(),amendment_sha256:digest,amendment:a,signoffs,prior_policy:structuredClone(l.policy),prior_stop:structuredClone(l.stopped_journeys[a.journey])});
    l.policy.deadline=a.deadline;p.plan_sha256=a.plan_sha256;l.policy_sha256=hash(JSON.stringify(l.policy));
    l.transport_continuation={journey:a.journey,owner_sha256:a.owner_sha256,historical_request:a.historical_request,resume_binding_sha256:a.resume_binding_sha256,max_recoveries:6,max_B:3,max_attempts:3,max_B_per_logical:1};
    delete l.stopped_journeys[a.journey];checkLimits(state,a.journey);
    return {amendment_sha256:digest,summary:summary(state),counters:transportSummary(state)};
  });
}
