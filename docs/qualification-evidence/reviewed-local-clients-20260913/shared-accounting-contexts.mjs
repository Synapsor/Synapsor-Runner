import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {PublicMcp,operator,owner,runtime,ledgerSnapshot,sourceSnapshot,schedule,log} from './runtime-driver.mjs';
import {contend} from './accounting-contention.mjs';
const profiles=JSON.parse(await fs.readFile(path.join(owner.owned,'reviewed-clients.json')));
const contexts=['primary','colleague','second-insurer','third-insurer'];const clients={};const references={};
const result={case:'A2 shared principal, joint, ample and overall; A4 configured contexts',artifact_tree:owner.artifact_tree,status:'running',new_setup_dependency:'Named reviewed local-client setup written in this assignment; not independently exercised outside this task',checks:{}};
const automatic=ledger=>ledger.approvals.filter(a=>a.status==='approved'&&a.approver==='policy:reserve_ops.adjust_claim_reserve.approval'&&a.action_boundary_name==='reviewed_staging_actions');
function counted(ledger){const approvals=automatic(ledger),byInsurer={};for(const a of approvals){assert(Date.parse(a.created_at)>=Date.now()-86400000);const p=ledger.proposals.find(p=>p.proposal_id===a.proposal_id);assert(p);byInsurer[p.tenant_id]=(byInsurer[p.tenant_id]??0)+1;}return {overall:approvals.length,by_insurer:byInsurer};}
function args(alias,claim,desired){const rows=references[alias];const i=rows.data.findIndex(r=>r.claim_ref===claim);assert(i>=0,alias+' '+claim);return {outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:rows.subjects.find(s=>s.row_index===i).ref},inputs:{desired_cents:desired}};}
function added(before,after,table,id){assert(Array.isArray(before[table])&&Array.isArray(after[table]));return after[table].filter(p=>!before[table].some(b=>b[id]===p[id]));}
function checkPair(before,after,responses,automaticCount){assert(responses.every(r=>r.ok),'Human-review loser must be a valid persisted outcome');assert.equal(responses.filter(r=>r.proposal.status==='approved').length,automaticCount);assert.equal(responses.filter(r=>r.proposal.status==='pending_review').length,2-automaticCount);const proposals=added(before,after,'proposals','proposal_id');assert.equal(proposals.length,2);assert.equal(proposals.filter(p=>p.state==='pending_review').length,2-automaticCount);assert.equal(added(before,after,'approvals','approval_id').length,automaticCount);assert.equal(added(before,after,'worker_queue','proposal_id').length,automaticCount);for(const p of proposals.filter(p=>p.state==='pending_review')){assert(!after.approvals.some(a=>a.proposal_id===p.proposal_id));assert(!after.worker_queue.some(q=>q.proposal_id===p.proposal_id));}return proposals;}
let source;
try{
 for(const alias of contexts){assert(profiles[alias]);const c=clients[alias]=new PublicMcp();await c.start({localClient:profiles[alias]});await c.call('app.describe_actions',{});references[alias]=await c.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(references[alias].ok);}
 source=await sourceSnapshot('shared-matrix-before');const before=ledgerSnapshot('shared-matrix-before');assert.equal(counted(before).overall,2,'A1 and original legitimate approval leave one insurer slot');
 const primaryRow=source.claims.find(r=>r.claim_ref==='CL-103'),colleagueRow=source.claims.find(r=>r.claim_ref==='CL-801');assert.equal(primaryRow.insurer_id,colleagueRow.insurer_id);assert.notEqual(primaryRow.adjuster_id,colleagueRow.adjuster_id);
 schedule('A2 different principals shared insurer last slot');
 const ownArgs={primary:args('primary','CL-901',2000),colleague:args('colleague','CL-801',15000)};
 const insurer=await contend(clients.primary,ownArgs.primary,clients.colleague,ownArgs.colleague);const afterInsurer=ledgerSnapshot('shared-insurer-after');
 result.checks.shared_principal={status:'passed',contention:insurer,before:counted(before),after:counted(afterInsurer),proposals:checkPair(before,afterInsurer,insurer.responses,1)};
 assert.equal(counted(afterInsurer).overall,3);assert.equal(counted(afterInsurer).by_insurer[primaryRow.insurer_id],3);
 const joint=await clients.primary.call('app.request_change',args('primary','CL-902',2000));assert(joint.ok&&joint.proposal.status==='pending_review');const jointAfter=ledgerSnapshot('shared-joint-after');assert.deepEqual(jointAfter.approvals,afterInsurer.approvals);result.checks.joint_limit={status:'passed',response:joint,overall_still_has_capacity:5};
 // Existing public cancellation only: each legitimate committed automatic
 // approval retains its slot although this owned unstarted effect is cancelled.
 result.history_cancellations=[];
 for(const desired of [15000,16000]){
  references['second-insurer']=await clients['second-insurer'].call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(references['second-insurer'].ok);
  const prior=ledgerSnapshot('shared-history-before-'+desired);const requestArgs=args('second-insurer','CL-701',desired);const response=await clients['second-insurer'].call('app.request_change',requestArgs);assert(response.ok&&response.proposal.status==='approved');
  const approved=ledgerSnapshot('shared-history-approved-'+desired);const proposals=added(prior,approved,'proposals','proposal_id');assert.equal(proposals.length,1);assert.equal(added(prior,approved,'approvals','approval_id').length,1);
  const cancel=await operator(['worker','cancel',proposals[0].proposal_id,'--yes','--reason','Reviewed synthetic history control; cancel unstarted execution without refunding approval allowance','--config','synapsor.actions.runner.json','--json']);assert.equal(cancel.code,0);
  const cancelled=ledgerSnapshot('shared-history-cancelled-'+desired);assert.deepEqual(cancelled.approvals,approved.approvals);assert.equal(cancelled.proposals.find(p=>p.proposal_id===proposals[0].proposal_id).state,'canceled');result.history_cancellations.push({proposal_id:proposals[0].proposal_id,response,cancel_exit:cancel.code,approval_retained:true});
 }
 assert.equal(counted(ledgerSnapshot('shared-five')).overall,5);
 const extra=clients.thirdConcurrent=new PublicMcp();await extra.start({localClient:profiles['third-insurer']});await extra.call('app.describe_actions',{});references.thirdConcurrent=await extra.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(references.thirdConcurrent.ok);
 schedule('A2 ample capacity');const beforeAmple=ledgerSnapshot('shared-ample-before');const ample=await contend(clients['third-insurer'],args('third-insurer','CL-1001',15000),extra,args('thirdConcurrent','CL-1002',15000));const afterAmple=ledgerSnapshot('shared-ample-after');
 result.checks.ample_capacity={status:'passed',contention:ample,before:counted(beforeAmple),after:counted(afterAmple),proposals:checkPair(beforeAmple,afterAmple,ample.responses,2)};
 assert.equal(counted(afterAmple).overall,7);assert(Object.values(counted(afterAmple).by_insurer).every(n=>n<=3));
 references['second-insurer']=await clients['second-insurer'].call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(references['second-insurer'].ok);
 ownArgs['second-insurer']=args('second-insurer','CL-701',17000);ownArgs['third-insurer']=args('third-insurer','CL-1003',15000);
 schedule('A2 last overall slot');const overall=await contend(clients['second-insurer'],ownArgs['second-insurer'],clients['third-insurer'],ownArgs['third-insurer']);const afterOverall=ledgerSnapshot('shared-overall-after');
 result.checks.overall={status:'passed',contention:overall,before:counted(afterAmple),after:counted(afterOverall),proposals:checkPair(afterAmple,afterOverall,overall.responses,1)};assert.equal(counted(afterOverall).overall,8);assert(Object.values(counted(afterOverall).by_insurer).every(n=>n<=3));
 const canonical=insurer.entry.concat(ample.entry,overall.entry).map(e=>e.locals.revision);assert.equal(new Set(canonical.map(x=>JSON.stringify(x))).size,1);result.shared_admission_revision=canonical[0];result.common_ledger=path.join(owner.logical,'.synapsor/local.db');
 result.canonical_history_selectors={inclusive_start_and_end:true,capability:'COALESCE(proposal.capability, proposal.action)',approval_actor:'policy:reserve_ops.adjust_claim_reserve.approval',action_boundary_name:'reviewed_staging_actions',tenant_source:'proposal.tenant_id; derived from trusted tenant binding',window_seconds:86400,profile_namespace:false,actor_note:'policy actor corroborates automatic origin; boundary rolling SQL selects approved status, boundary name, inclusive time, optional capability and trusted tenant, not profile reference'};
 // Own-context requests above used each client's normally issued references.
 // Reuse those same references under other reviewed contexts without weakening
 // issuer checks. Only the observed rejecting layer is claimed.
 schedule('A4 configured context references');result.own_context_replays={};for(const alias of contexts){const response=await clients[alias].call('app.request_change',ownArgs[alias]);assert(response.ok,'The exact reference/request must still work under its own configured client');result.own_context_replays[alias]=response;}const crossBefore=ledgerSnapshot('shared-cross-before');const cross=[];
 for(const [issuer,recipient] of [['primary','colleague'],['colleague','primary'],['primary','second-insurer'],['second-insurer','primary'],['third-insurer','second-insurer']]){
  const response=await clients[recipient].call('app.request_change',ownArgs[issuer]);assert.equal(response.ok,false);assert.equal(response.error_code,'SUBJECT_REFERENCE_UNAVAILABLE','Cross-context refusal must come from the reference guard, not a duplicate proposal or unrelated error');cross.push({issuer,recipient,response});
 }
 const crossAfter=ledgerSnapshot('shared-cross-after');for(const table of ['proposals','approvals','worker_queue','writeback_jobs','writeback_receipts','control_policy_effect_admissions','control_policy_budget_requests'])assert.deepEqual(crossAfter[table],crossBefore[table]);
 result.checks.context_isolation={status:'passed_observed_rejection_layer',cross,own_context_positive_responses:{primary:insurer.responses[0],colleague:insurer.responses[1],'second-insurer':overall.responses[0],'third-insurer':overall.responses[1]},no_unauthorized_durable_records:true};
 assert.deepEqual(await sourceSnapshot('shared-matrix-after'),source);result.status='passed_named_shared_matrix';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;log('shared_matrix_failure',{message:e.message});}
finally{await Promise.allSettled(Object.values(clients).map(c=>c.close()));ledgerSnapshot('shared-matrix-final');await fs.writeFile(path.join(runtime,'shared-matrix-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
