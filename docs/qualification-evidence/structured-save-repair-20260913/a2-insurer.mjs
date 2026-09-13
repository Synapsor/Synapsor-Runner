import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {PublicMcp,PgRelay,sourceSnapshot,ledgerSnapshot,hostSnapshot,runtime,timeout,schedule,log} from './runtime-driver.mjs';
const relay=new PgRelay(),client=new PublicMcp();const result={case:'A2 final insurer slot; same-principal safety subcase',status:'running',cross_principal_exercised:false};
try{
 await relay.start();await client.start({relay});await client.call('app.describe_actions',{});
 const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);
 const args=claim=>{const i=rows.data.findIndex(x=>x.claim_ref===claim);assert(i>=0);return {outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:rows.subjects.find(x=>x.row_index===i).ref},inputs:{desired_cents:2000}};};
 const before=ledgerSnapshot('a2-insurer-before'),source=await sourceSnapshot('a2-insurer-before');
 assert.equal(before.approvals.length,2,'Exactly two real original-policy automatic approvals precede last slot');
 assert(before.approvals.every(x=>x.action_boundary_name==='reviewed_staging_actions'&&x.status==='approved'));
 schedule('A2 final insurer slot');relay.arm();const held=once(relay,'held');
 const first=client.call('app.request_change',args('CL-901'));first.catch(()=>{});
 await timeout(held,10000,'first claimed fact read');
 result.first_held_host=await hostSnapshot('a2-insurer-first-held');
 const during=ledgerSnapshot('a2-insurer-held');assert.equal(during.approvals.length,2);
 result.second=await client.call('app.request_change',args('CL-902'));
 const secondDone=ledgerSnapshot('a2-insurer-second-completed-first-held');result.second_completed_while_first_held=Boolean(relay.held);
 assert(relay.held,'The first fact response must still be held while the competing result completes');
 result.overlap_host=await hostSnapshot('a2-insurer-second-completed-first-held');
 result.count_after_second=secondDone.approvals.length;
 relay.release();result.first=await first;
 const after=ledgerSnapshot('a2-insurer-after');result.count_after_both=after.approvals.length;result.boundaries=client.inspector.boundaries;
 result.new_approvals=after.approvals.filter(x=>!before.approvals.some(y=>y.approval_id===x.approval_id));
 assert.deepEqual(await sourceSnapshot('a2-insurer-after'),source,'Admission cannot change source');
 assert(result.first.ok&&result.second.ok,'Generic failure is not human-review success');
 assert(after.approvals.length<=3,'Original per-insurer maximum3 must not overshoot under supported single-process contention');
 assert.equal(after.approvals.length,3);assert.equal(after.proposals.length,before.proposals.length+2);
 const newP=after.proposals.filter(x=>!before.proposals.some(y=>x.proposal_id===y.proposal_id));assert.equal(newP.filter(x=>x.state==='pending_review').length,1);
 result.status='pass_same_principal_only';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;log('a2_failure',{message:e.message});process.exitCode=1;}
finally{if(relay.held)relay.release();await client.close();await relay.close();ledgerSnapshot('a2-insurer-final');await sourceSnapshot('a2-insurer-final');await fs.writeFile(path.join(runtime,'a2-insurer-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));}
