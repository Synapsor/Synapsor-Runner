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
  assert.equal(policy.campaign_usd,'60');assert.equal(policy.combined_usd,'40');
  assert(Object.keys(policy.journeys).length===2);
  for(const j of Object.values(policy.journeys)){assert.equal(j.usd,'20');assert.equal(j.transports,400);assert.equal(j.transient_retries,2);}
  state.larger_programs_lane_c={version:1,seed_sha256:expectedSeedHash,seed_path:seed,
    policy,policy_sha256:hash(JSON.stringify(policy)),baseline:{settled:state.settled_spend_usd,
      campaign_hold:state.uncertain_hold_usd,external_hold:state.older_hold_already_reflected_usd,
      historical_transports:(state.new_provider_transports??[]).length},invocations:[],entries:[],stopped:false};
  const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(state,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
const amount = entry => entry.settled_usd??entry.observed_upper_usd??entry.reserved_usd;
export function summary(state) {
  const lane=state.larger_programs_lane_c;assert(lane,'MISSING_LANE');
  const newCharge=add(lane.entries.map(amount));const baseline=add([lane.baseline.settled,lane.baseline.campaign_hold,lane.baseline.external_hold]);
  return {campaign:dollars(baseline+newCharge),combined:dollars(newCharge),by_journey:Object.fromEntries(Object.keys(lane.policy.journeys).map(k=>[k,dollars(add(lane.entries.filter(x=>x.journey===k).map(amount)))]))};
}
function checkLimits(state,journey,extra=0n) {
  const lane=state.larger_programs_lane_c,s=summary(state);assert(!lane.stopped,'LANE_STOPPED');
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
    assert(lane.invocations.some(x=>x.id===invocation&&x.journey===journey),'UNKNOWN_INVOCATION');
    assert(!lane.entries.some(x=>x.id===requestId),'REQUEST_COLLISION');assert(Date.now()<Date.parse(lane.policy.deadline),'DEADLINE');
    // Count uncertain-started calls conservatively; reserved but demonstrably unsent
    // requests remain holds and do not magically become consented retries.
    const calls=lane.entries.filter(x=>x.journey===journey&&x.started_at);
    const reserved=lane.entries.filter(x=>x.journey===journey&&x.status==='RESERVED');
    assert(calls.length+reserved.length<policy.transports,'TRANSPORT_LIMIT');
    if(details.retry_of){assert(lane.entries.find(x=>x.id===details.retry_of&&x.journey===journey&&x.started_at),'UNKNOWN_RETRY_PARENT');assert([...calls,...reserved].filter(x=>x.retry_of).length<policy.transient_retries,'RETRY_LIMIT');}
    const n=units(reservation);assert(n>0n,'INVALID_RESERVATION');checkLimits(state,journey,n);
    assert(!Object.keys(details).some(k=>['status','started_at','completed_at','settled_usd','observed_upper_usd'].includes(k)),'ACCOUNTING_FIELDS_FORBIDDEN');
    const item={...details,id:requestId,journey,invocation,reserved_usd:dollars(n),status:'RESERVED',reserved_at:new Date().toISOString()};lane.entries.push(item);return item;});
}
export function markStarted(file,id) {
  return update(file,state=>{const lane=state.larger_programs_lane_c,item=lane.entries.find(x=>x.id===id);assert(item?.status==='RESERVED','NOT_RESERVED');
    assert(Date.now()<Date.parse(lane.policy.deadline),'DEADLINE');checkLimits(state,item.journey);
    if(item.retry_of)assert(lane.entries.filter(x=>x.journey===item.journey&&x.started_at&&x.retry_of).length<lane.policy.journeys[item.journey].transient_retries,'RETRY_LIMIT');
    item.status='STARTED_COST_UNCERTAIN';item.started_at=new Date().toISOString();return {...item};});
}
export function finishRequest(file,id,{settledUsd,observedUpperUsd,details}) {
  return update(file,state=>{const lane=state.larger_programs_lane_c,item=lane.entries.find(x=>x.id===id);assert(item?.started_at,'NO_STARTED_REQUEST');
    assert(!item.completed_at,'ALREADY_FINISHED');assert(!(settledUsd!=null&&observedUpperUsd!=null),'AMBIGUOUS_SETTLEMENT');
    if(settledUsd!=null){item.settled_usd=dollars(units(settledUsd));item.status='REQUEST_COST_SETTLED';}
    else if(observedUpperUsd!=null){item.observed_upper_usd=dollars(units(observedUpperUsd));item.status='COMPLETE_USAGE_UPPER_HELD_NOT_SETTLED';}
    else item.status='UNKNOWN_COST_RESERVED';
    item.completed_at=new Date().toISOString();item.result=details;
    if(units(amount(item))>units(item.reserved_usd)){item.over_reservation=true;lane.stopped=true;lane.stop_reason='PROVIDER_COST_OR_USAGE_EXCEEDED_RESERVATION';}
    const s=summary(state);if(units(s.campaign)>units(lane.policy.campaign_usd)||units(s.combined)>units(lane.policy.combined_usd)||units(s.by_journey[item.journey])>units(lane.policy.journeys[item.journey].usd)){lane.stopped=true;lane.stop_reason='FINANCIAL_LIMIT_EXCEEDED';}
    return {item,summary:s,stopped:lane.stopped};});
}
export function releaseDemonstrablyUnsent(file,id,evidence) {
  return update(file,state=>{const item=state.larger_programs_lane_c.entries.find(x=>x.id===id);assert(item?.status==='RESERVED'&&!item.started_at,'POSSIBLE_SEND_NO_RELEASE');
    assert(typeof evidence==='string'&&/^[a-f0-9]{64}$/.test(evidence),'EVIDENCE_REQUIRED');
    item.status='DEMONSTRABLY_UNSENT_CLOSED';item.settled_usd='0';item.local_no_send_evidence_sha256=evidence;});
}
