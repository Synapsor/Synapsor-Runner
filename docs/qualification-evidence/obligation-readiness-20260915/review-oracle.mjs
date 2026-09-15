// Independent read-only preservation oracle; never supplies application attestations.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
const E=path.dirname(new URL(import.meta.url).pathname),plan=JSON.parse(fs.readFileSync(path.join(E,'assignment-plan.json'),'utf8'));
const [runId,label]=process.argv.slice(2);assert(plan.case_sources[runId]&&/^[a-z0-9-]+$/.test(label));
const lane=process.argv.find(a=>a.startsWith('--development-lane='))?.split('=')[1];assert(!process.argv.includes('--development')||/^(terra|sol)(-repaired)?$/.test(lane??''));
const R=path.join(plan.owned_root,...(process.argv.includes('--development')?['development',lane]:[]),'runs',runId),P=path.join(R,'project'),old=plan.case_sources[runId],baseline=path.join(old.root,'runs',old.run,'checkpoints',old.checkpoint,'project');
const sha=s=>createHash('sha256').update(s).digest('hex');
function files(dir){return fs.readdirSync(dir).flatMap(n=>{const f=path.join(dir,n),s=fs.lstatSync(f);assert(!s.isSymbolicLink());return s.isDirectory()?files(f):[f];});}
const ledgers=[];
for(const original of files(baseline)){
 if(!fs.readFileSync(original).subarray(0,16).equals(Buffer.from('SQLite format 3\0')))continue;
 const rel=path.relative(baseline,original),current=path.join(P,rel),before=new DatabaseSync(original,{readOnly:true}),after=new DatabaseSync(current,{readOnly:true});
 try{const tables=before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r=>r.name),records=[];
 for(const t of tables){const query='SELECT * FROM "'+t.replaceAll('"','""')+'"';const normalize=db=>db.prepare(query).all().map(r=>JSON.stringify(r)).sort();const a=normalize(before),b=normalize(after),unchanged=JSON.stringify(a)===JSON.stringify(b);
  if(['proposals','approvals','worker_queue','writeback_receipts'].includes(t))assert(unchanged,'Business/approval/queue/receipt mutation: '+t);
  records.push({table:t,before_rows:a.length,after_rows:b.length,before_sha256:sha(JSON.stringify(a)),after_sha256:sha(JSON.stringify(b)),unchanged});
 }ledgers.push({path:rel,tables:records});}finally{before.close();after.close();}
}
const resume=JSON.parse(fs.readFileSync(path.join(P,'.synapsor/boundary-authoring/resume.json'),'utf8'));
const session=JSON.parse(fs.readFileSync(path.join(P,'.synapsor/boundary-authoring/policy-sources',resume.policy_source_session+'.json'),'utf8'));
const report=session.coverage,source=session.snapshots.find(s=>s.version===session.active);
const events=fs.readFileSync(path.join(R,'meter/events.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const result={at:new Date().toISOString(),artifact_tree:plan.artifact_tree,runId,label,source:{digest:source.digest,version:source.version},coverage_authority_digest:session.coverage_authority_digest,
 coverage_source_digest:report?.source_digest,coverage_draft_digest:report?.draft_digest,counting_inventory:report?.counting_inventory,
 counting_decisions:session.counting_decisions??[],counting_passages:report?.passages.filter(p=>p.counting_requirement_bindings?.length||p.counter_requirements?.length),
 nonimplemented_passages:report?.passages.filter(p=>!['implemented','background','overridden'].includes(p.disposition)),application_assignments:session.application_assignments??[],
 obligation_passages:report?.passages.filter(p=>p.obligation_assessment),

 maintenance_passages:report?.passages.filter(p=>p.source_counter_obligation||JSON.stringify(p).includes('source_counter_maintenance')),completed_reviews:resume.completed_policy_reviews,resume_model:resume.model,
 resume_stage:resume.stage,pending:Object.keys(resume).filter(k=>k.startsWith('pending_')&&resume[k]!=null),ledgers,actual_authoring_calls:events.filter(e=>e.type==='transport_attempt'&&e.pathname!=='/v1/models').length,
 public_effects_or_workers_run:false,readiness:'Inspect public review result together with these persisted records; this oracle grants no application attestation.'};
fs.writeFileSync(path.join(E,runId+'-'+(lane?lane+'-':'')+label+'-oracle.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({runId,label,actual_authoring_calls:result.actual_authoring_calls,pending:result.pending,ledger_changes:ledgers.flatMap(l=>l.tables.filter(t=>!t.unchanged).map(t=>({store:l.path,...t}))),inventory:result.counting_inventory}));
