// Final installed normal MCP controls: retain one legitimate 90-second approval
// before the reviewed 120 -> 60 edit. Never dispatch it with stale authority.
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {PublicMcp,D,state,sourceSnapshot,ledgerSnapshot} from './known-runtime.mjs';
assert.equal(state.runId,'fresh-software');const client=new PublicMcp();
const norm=x=>JSON.parse(JSON.stringify(x)),r={at:new Date().toISOString(),artifact_tree:state.artifact_tree,status:'incomplete'};
try {
 await client.start();const before=norm(ledgerSnapshot('old-work-before')),source=norm(await sourceSnapshot('old-work-before'));
 assert.equal(before.proposals.length,2);assert.equal(before.approvals.length,1);
 r.private_collection=await client.call('app.explore_data',{plan:{kind:'rows',resource:'release_ops.build_checks',select:['check_state']}});assert.equal(r.private_collection.ok,false);
 const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'release_ops.build_candidates',select:['candidate_ref','candidate_state']}});assert(rows.ok);
 const i=rows.data.findIndex(x=>x.candidate_ref==='primary-B17');assert(i>=0);const ref=rows.subjects.find(x=>x.row_index===i)?.ref;assert(ref);
 r.request=await client.call('app.request_change',{outcome:'release_ops.seal_candidate',subject_refs:{candidate:ref}});assert(r.request.ok);
 const after=norm(ledgerSnapshot('old-work-after'));assert.equal(after.proposals.length,3);assert.equal(after.approvals.length,2);
 const candidate=source.build_candidates.find(x=>x.candidate_ref==='primary-B17'),p=after.proposals.find(x=>x.object_id===candidate.candidate_id);assert.equal(p.state,'approved');
 const a=after.approvals.find(x=>x.proposal_id===p.proposal_id);assert(a.approver.startsWith('policy:'));
 const q=after.worker_queue.find(x=>x.proposal_id===p.proposal_id);assert.equal(q.status,'queued');assert.equal(q.lease_id,null);
 assert.deepEqual(after.writeback_receipts,before.writeback_receipts);assert.deepEqual(norm(await sourceSnapshot('old-work-after')),source);
 r.old_proposal_id=p.proposal_id;r.old_contract=q.contract_digest;r.counts={proposals:3,automatic_approvals:2,control_receipts:1,source_receipts:1};r.status='passed_legitimate_old_90_second_approval_and_private_collection_refusal';
}catch(error){r.status='failed_or_incomplete';r.error=error.stack;process.exitCode=1;try{ledgerSnapshot('old-work-stop');await sourceSnapshot('old-work-stop');}catch{}}
finally{await client.close();await fs.writeFile(path.join(D,'old-work-result.json'),JSON.stringify(r,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:r.status,error:r.error,path:path.join(D,'old-work-result.json')}));}
