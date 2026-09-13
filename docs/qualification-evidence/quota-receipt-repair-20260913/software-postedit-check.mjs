// Existing known-case edit controls on the unchanged final installation.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {PublicMcp,D,state,sourceSnapshot,ledgerSnapshot,operator} from './known-runtime.mjs';
assert.equal(state.runId,'fresh-software');const norm=x=>JSON.parse(JSON.stringify(x)),snap=n=>norm(ledgerSnapshot('postedit-'+n)),client=new PublicMcp();
const r={at:new Date().toISOString(),artifact_tree:state.artifact_tree,status:'incomplete'};
try {
 const before=JSON.parse(await fs.readFile(path.join(D,'old-work-after-ledger.json'))),source=JSON.parse(await fs.readFile(path.join(D,'old-work-after-source.json'))),l=snap('before-worker');
 assert.equal(l.proposals.length,4);assert.equal(l.approvals.length,2);assert.deepEqual(l.approvals,before.approvals);assert.deepEqual(l.writeback_receipts,before.writeback_receipts);
 const p=l.proposals.find(x=>x.object_id===source.build_candidates.find(y=>y.candidate_ref==='primary-B18').candidate_id);assert.equal(p.state,'pending_review');assert(!l.approvals.some(x=>x.proposal_id===p.proposal_id));assert(!l.worker_queue.some(x=>x.proposal_id===p.proposal_id));
 const oldId=JSON.parse(await fs.readFile(path.join(D,'old-work-result.json'))).old_proposal_id,old=l.worker_queue.find(x=>x.proposal_id===oldId);assert.equal(old.status,'queued');assert.equal(old.lease_id,null);
 const config=JSON.parse(await fs.readFile(path.join(state.owned,'project/synapsor.actions.runner.json'))),policy=config.supervised_worker.outcomes[0];assert.notEqual(old.contract_digest,policy.action_boundary_digest);
 r.old_work_age_seconds=(Date.now()-Date.parse(l.proposals.find(x=>x.proposal_id===oldId).created_at))/1000;assert(r.old_work_age_seconds<policy.proposal_ttl_seconds);r.queue_ttl_seconds=policy.proposal_ttl_seconds;r.old_contract=old.contract_digest;r.current_contract=policy.action_boundary_digest;
 r.worker=await operator(['worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--worker-id','semantic_action_worker']);assert.equal(r.worker.code,0);
 const after=snap('after-worker');for(const t of ['proposals','approvals','worker_queue','writeback_receipts','writeback_jobs'])assert.deepEqual(after[t],l[t]);assert.deepEqual(norm(await sourceSnapshot('postedit-after-worker')),source);
 await client.start();const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'release_ops.build_candidates',select:['candidate_ref','candidate_state']}});assert(rows.ok);r.restarted_own_rows=rows.data.length;assert.equal(rows.data.length,29);
 const i=rows.data.findIndex(x=>x.candidate_ref==='primary-B03');assert(i>=0);const ref=rows.subjects.find(x=>x.row_index===i)?.ref;assert(ref);
 r.current_fast_request=await client.call('app.request_change',{outcome:'release_ops.seal_candidate',subject_refs:{candidate:ref}});assert(r.current_fast_request.ok);
 const final=snap('final'),fresh=final.proposals.find(x=>x.object_id===source.build_candidates.find(y=>y.candidate_ref==='primary-B03').candidate_id);assert.equal(fresh.state,'approved');
 assert.equal(final.proposals.length,5);assert.equal(final.approvals.length,3);assert(final.approvals.find(x=>x.proposal_id===fresh.proposal_id)?.approver.startsWith('policy:'));
 for(const a of before.approvals)assert.deepEqual(final.approvals.find(x=>x.approval_id===a.approval_id),a);
 assert.deepEqual(final.worker_queue.find(x=>x.proposal_id===oldId),old);assert.deepEqual(final.writeback_receipts,before.writeback_receipts);assert.deepEqual(norm(await sourceSnapshot('postedit-final')),source);
 r.status='passed_90_second_current_human_40_second_current_automatic_retained_history_source_receipt_and_old_work_not_dispatched';r.counts={proposals:5,automatic_approvals:3,human_review_pending:2,control_receipts:1,source_receipts:1};r.old_work_limit='unstarted old 90-second approval remains unleased and unexecuted under current worker contract; not an already-dispatched test';r.current_fast_limit='new 40-second approval queued under current authority; no second source effect requested';
}catch(error){r.status='failed_or_incomplete';r.error=error.stack;process.exitCode=1;try{snap('stop');await sourceSnapshot('postedit-stop');}catch{}}
finally{await client.close();await fs.writeFile(path.join(D,'postedit-result.json'),JSON.stringify(r,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:r.status,error:r.error,counts:r.counts,path:path.join(D,'postedit-result.json')}));}
