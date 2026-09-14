// Read-only host verifier of owned public results. It neither supplies application
// evidence nor sets any policy/review/status. Public CLI captures remain the oracle
// that the installed path performed the recheck; this reports its persisted state.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { canonicalJsonDigest } from '../../../packages/protocol/src/index.js';
import { activePolicySource, loadPolicySources, isDeferredSourceReadback } from '../../../apps/runner/src/authoring-policy-source.js';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.js';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'),'utf8'));
const [runId,label,mode='observe']=process.argv.slice(2);
assert(['recovery-tournament-assisted','recovery-tournament-original','edit-tournament','recovery-software'].includes(runId));
assert(/^[a-z0-9-]+$/.test(label));assert(['baseline','reviewed','edited','observe'].includes(mode));
const R=path.join(plan.owned_root,'runs',runId),P=path.join(R,'project');
assert.equal(await fs.realpath(P),P);assert(!(await fs.stat(path.join(plan.owned_root,'one-public-run.lock')).catch(()=>null)));
const state=JSON.parse(await fs.readFile(path.join(R,'run-state.json'),'utf8'));
const resume=JSON.parse(await fs.readFile(path.join(P,'.synapsor/boundary-authoring/resume.json'),'utf8'));
const sources=await loadPolicySources(P,resume.policy_source_session),source=activePolicySource(sources);assert(source);
const ready=policyReviewReadiness(source,sources.coverage,sources);
const dbPath=path.join(P,'.synapsor/local.db');assert.equal(await fs.realpath(dbPath),dbPath);
const db=new DatabaseSync(dbPath,{readOnly:true}),rawLedger:Record<string,any[]>={};
try {db.exec('BEGIN');for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[])
 rawLedger[name]=db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all();db.exec('COMMIT');}finally{db.close();}
// Normalize SQLite null-prototype rows and byte arrays identically before both snapshots/comparisons.
const ledger:Record<string,any[]>=JSON.parse(JSON.stringify(rawLedger));
const policies=(pointers:any[])=>pointers.filter(p=>p.revision_id!==null).map(p=>({pointer:p,record:ledger.control_policy_revisions.find(r=>['deployment_id','scope_key','kind','name','revision_id'].every(k=>r[k]===p[k]))}));
const active=policies(ledger.control_policy_active),drafts=policies(ledger.control_policy_drafts);
const action=(drafts.find(p=>p.pointer.kind==='action')??active.find(p=>p.pointer.kind==='action'));assert(action?.record);
const authority=JSON.parse(action.record.content_json);
const config=JSON.parse(await fs.readFile(path.join(P,'synapsor.actions.runner.json'),'utf8').catch(()=>'{"sources":{}}'));
const D=path.join(R,'deterministic');await fs.mkdir(D,{recursive:true});
const snapshot={resume,sources,active,drafts,authority,ledger,config};
const snapshotPath=path.join(D,'review-'+label+'-state.json');
await fs.writeFile(snapshotPath,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const snapshotHash=sha(await fs.readFile(snapshotPath));
const result:any={at:new Date().toISOString(),run:runId,label,mode,artifact_tree:state.artifact_tree,
 classification:mode==='baseline'?'candidate-neutral read-only restored-fixture baseline; no installed public operation executed':'read-only host verifier of persisted installed public-path state; no status setters or external-observation import',snapshot:snapshotPath,snapshot_sha256:snapshotHash,
 business_review_ready:ready.ready,readiness_summary:ready.summary,resume_stage:resume.stage,pending_instruction:resume.pending_action_revision??null,
 reconciliations:resume.reconciled_action_revisions??[],coverage_digest:canonicalJsonDigest(sources.coverage??null),
 counting_comparisons:sources.coverage?.passages.flatMap(p=>p.counting_components?.map(c=>c.resolution)??(p.counting_resolution?[p.counting_resolution]:[]))??[],
 pending_responsibilities:(sources.coverage?.passages??[]).filter(p=>!['implemented','background','overridden'].includes(p.disposition)),
 source_rows_in_authoring:false,source_readback_as_application_evidence:false,authority_revision:action.pointer.revision_id,
 history:Object.fromEntries(['proposals','approvals','worker_queue','writeback_receipts','writeback_jobs'].map(t=>[t,{rows:ledger[t]?.length??0,digest:canonicalJsonDigest(ledger[t]??[])}])),
 configured_receipt_modes:Object.values(config.sources??{}).map((s:any)=>s.receipts?.authority??'runner_ledger'), status:'observed'};
try {
 if(mode!=='baseline') {
  const before=JSON.parse(await fs.readFile(path.join(D,'review-baseline-state.json'),'utf8'));
  for(const table of ['proposals','approvals','worker_queue','writeback_receipts','writeback_jobs'])assert.deepEqual(ledger[table],before.ledger[table],`Preserve exact durable ${table}`);
  assert.deepEqual(active.filter(p=>p.pointer.kind!=='management'),before.active.filter((p:any)=>p.pointer.kind!=='management'),'No business authority publication is scheduled');
  assert.deepEqual(drafts,before.drafts,'Disabled business authority revisions remain exact');
  const management=active.filter(p=>p.pointer.kind==='management'),priorManagement=before.active.filter((p:any)=>p.pointer.kind==='management');
  assert.equal(management.length,priorManagement.length);
  for(const current of management) {
   const prior=priorManagement.find((p:any)=>p.pointer.name===current.pointer.name);assert(prior);
   for(const key of ['deployment_id','scope_key','kind','name'])assert.equal(current.pointer[key],prior.pointer[key]);
   const a=JSON.parse(prior.record.content_json),b=JSON.parse(current.record.content_json);
   if(current.pointer.name==='read_authoring') {
    assert.equal(a.entries.length,b.entries.length);
    for(let i=0;i<a.entries.length;i++) {
     assert(Number.isSafeInteger(b.entries[i].progress.revision)&&b.entries[i].progress.revision>=a.entries[i].progress.revision);
     assert(Number.isFinite(Date.parse(b.entries[i].progress.updated_at)));
     delete a.entries[i].progress.revision;delete b.entries[i].progress.revision;
     delete a.entries[i].progress.updated_at;delete b.entries[i].progress.updated_at;
    }
   }
   assert.deepEqual(b,a,'Only recorded management review progress revision/time may change');
  }
  assert.deepEqual(config,before.config,'No execution or identity setup is scheduled');
  assert.deepEqual(sources.snapshots,before.sources.snapshots,'Original attached policy versions are unchanged');
  assert.deepEqual((sources.operator_messages??[]).slice(0,before.sources.operator_messages?.length??0),before.sources.operator_messages??[],'Retain accepted owner messages');
  if(mode!=='edited')assert.deepEqual(authority,before.authority,'Keep exact saved Action program');
  else {
   const normalized=(a:any)=>{const x=structuredClone(a.authority.authority);delete x.digest;delete x.action_boundary.digest;for(const r of x.rules)delete r.activated_at;for(const r of x.action_boundary.rules)delete r.approval_policy_digest;return x;};
   const expected=normalized(before.authority),actual=normalized(authority);
   let changed=0;for(const c of expected.approval_classes)for(const limit of c.shared_limits??[])if(limit.scope==='tenant'&&limit.maximum===2){limit.maximum=1;changed++;}
   assert.equal(changed,1,'Exactly one saved tenant-two limit must be selected');assert.deepEqual(actual,expected,'Exact disabled two-to-one difference only');
  }
  if(mode==='reviewed'||mode==='edited') {
   if(runId==='recovery-tournament-assisted') {
    const comparisons=sources.coverage?.passages.flatMap(p=>p.counting_components?.map(c=>c.resolution)??(p.counting_resolution?[p.counting_resolution]:[]))??[];
    assert(comparisons.length>0,'Persist the exact conditional counting interpretation, not just a successful model opinion');
    for(const c of comparisons) {assert(c.domain.complete);assert.deepEqual(c.domain.proposed_outcomes,['league.result_ratification']);assert(c.domain.current_outcomes.every(o=>o==='league.result_ratification'));assert(c.domain.retained_automatic_outcomes.every(o=>o==='league.result_ratification'));assert(c.comparisons.every(x=>x.retained_capability===null&&x.required_capability==='league.result_ratification'));}
   }
   assert(ready.ready,'Business review must really finish; an unchanged program or guard refusal is not a pass');
   assert(!resume.pending_action_revision,'No obsolete or incomplete Action repair may remain pending');
   assert(sources.coverage?.passages.some(isDeferredSourceReadback),'Keep the independent after-execution readback obligation unverified');
   const overrides=sources.coverage?.passages.filter(p=>p.disposition==='overridden')??[];
   if(mode!=='edited')assert.equal(overrides.length,0,'Do not accept an unrequested override to obtain review readiness');
   else { const newStatements=(sources.operator_messages??[]).slice(before.sources.operator_messages?.length??0);
    assert(overrides.length<=1 && overrides.every(p=>p.start===7&&p.end===7&&p.operator_override&&newStatements.some(m=>m.includes(p.operator_override!))), 'Only the explicitly requested source-line-seven quota change may be an accepted override; exact program difference is checked above');
   }
   if(before.resume.pending_action_revision)assert(resume.reconciled_action_revisions?.some((r:any)=>JSON.stringify(r.pending)===JSON.stringify(before.resume.pending_action_revision)),'Preserve exact old instruction in reconciliation history');
  }
  result.status=mode==='observe'?'preservation_checked_observation':`passed_${mode}`;
 }else result.status='baseline_recorded';
}catch(error){result.status='failed_or_incomplete';result.error=String(error);process.exitCode=1;}
await fs.writeFile(path.join(E,runId+'-'+label+'-review.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({run:runId,label,status:result.status,ready:ready.ready,stage:resume.stage,pending:Boolean(resume.pending_action_revision),artifact_tree:state.artifact_tree,error:result.error}));
