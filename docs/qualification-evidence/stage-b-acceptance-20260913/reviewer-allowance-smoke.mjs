// Bounded subset of the preserved shared-accounting matrix; no worker invocation.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {PublicMcp,owner,runtime,ledgerSnapshot,sourceSnapshot,schedule} from './runtime-driver.mjs';
import {contend} from './accounting-contention.mjs';
const profiles=JSON.parse(await fs.readFile(path.join(owner.owned,'reviewed-clients.json')));
const clients=[new PublicMcp(),new PublicMcp()];
const result={status:'running',artifact_tree:owner.artifact_tree,classification:'new external-review smoke only when actually executed by the separate reviewer',seed_requests:[],worker_invocations:0};
const automatic=l=>l.approvals.filter(a=>a.status==='approved'&&a.approver==='policy:reserve_ops.adjust_claim_reserve.approval'&&a.action_boundary_name==='reviewed_staging_actions');
const counted=l=>automatic(l).filter(a=>Date.parse(a.created_at)>=Date.now()-86400000&&Date.parse(a.created_at)<=Date.now());
const added=(a,b,t,k)=>b[t].filter(x=>!a[t].some(y=>x[k]===y[k]));
async function requestArgs(client,subject,desired){
 const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);
 const i=rows.data.findIndex(x=>x.claim_ref===subject);assert(i>=0);const ref=rows.subjects.find(s=>s.row_index===i)?.ref;assert(ref);
 return {outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:ref},inputs:{desired_cents:desired}};
}
try{
 assert(profiles.primary&&profiles.colleague);assert.notEqual(profiles.primary,profiles.colleague);
 const source=await sourceSnapshot('review-smoke-before'),initial=ledgerSnapshot('review-smoke-before');
 const primary=source.claims.find(x=>x.claim_ref==='CL-103'),other=source.claims.find(x=>x.claim_ref==='CL-801');assert.equal(primary.insurer_id,other.insurer_id);assert.notEqual(primary.adjuster_id,other.adjuster_id);
 assert.equal(automatic(initial).length,1,'Whole restore must retain the one legitimate original approval');
 const original=automatic(initial)[0];assert(initial.proposals.some(p=>p.proposal_id===original.proposal_id));assert(initial.writeback_receipts.some(r=>r.proposal_id===original.proposal_id&&r.status==='applied'&&r.source_database_mutated===1),'Original approval must have its own applied source-mutating receipt');
 result.original_approval={created_at:original.created_at,currently_counted:counted(initial).length,approval_id:original.approval_id};
 await clients[0].start({localClient:profiles.primary});await clients[1].start({localClient:profiles.colleague});
 for(const c of clients)await c.call('app.describe_actions',{});
 const subjects=[['CL-103',25000],['CL-902',2000]];
 for(const [subject,desired] of subjects){
  const before=ledgerSnapshot('review-seed-before-'+subject);if(counted(before).length===2)break;
  assert(counted(before).length<2);const response=await clients[0].call('app.request_change',await requestArgs(clients[0],subject,desired));assert(response.ok&&response.proposal.status==='approved');
  const after=ledgerSnapshot('review-seed-after-'+subject);assert.equal(added(before,after,'approvals','approval_id').length,1);assert.equal(added(before,after,'proposals','proposal_id').length,1);result.seed_requests.push({subject,response});
 }
 const before=ledgerSnapshot('review-contention-before');assert.equal(counted(before).length,2,'Two legitimately counted approvals required immediately before scheduling');
 const args=await Promise.all([requestArgs(clients[0],'CL-901',2000),requestArgs(clients[1],'CL-801',15000)]);
 schedule('external review shared insurer last slot');const contention=await contend(clients[0],args[0],clients[1],args[1]);const after=ledgerSnapshot('review-contention-after');
 assert(contention.responses.every(r=>r.ok));assert.equal(contention.responses.filter(r=>r.proposal.status==='approved').length,1);assert.equal(contention.responses.filter(r=>r.proposal.status==='pending_review').length,1);
 assert.equal(counted(after).length,3);assert.equal(added(before,after,'approvals','approval_id').length,1);assert.equal(added(before,after,'worker_queue','proposal_id').length,1);
 const proposals=added(before,after,'proposals','proposal_id');assert.equal(proposals.length,2);const pending=proposals.filter(p=>p.state==='pending_review');assert.equal(pending.length,1);
 assert(!after.approvals.some(a=>a.proposal_id===pending[0].proposal_id));assert(!after.worker_queue.some(q=>q.proposal_id===pending[0].proposal_id));
 for(const old of initial.approvals)assert.deepEqual(after.approvals.find(a=>a.approval_id===old.approval_id),old);
 assert.deepEqual(await sourceSnapshot('review-smoke-after'),source);
 result.status='passed_bounded_shared_allowance_smoke';result.contention=contention;result.counts={before:2,after:3};result.common_ledger=path.join(owner.logical,'.synapsor/local.db');result.history_retained=true;result.source_unchanged=true;
}catch(error){result.status='failed_or_incomplete';result.error=error.stack;process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.close()));ledgerSnapshot('review-smoke-final');await fs.writeFile(path.join(runtime,'review-smoke-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
