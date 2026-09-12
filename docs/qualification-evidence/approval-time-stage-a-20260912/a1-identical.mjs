import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {PublicMcp,PgRelay,operator,sourceSnapshot,ledgerSnapshot,hostSnapshot,runtime,timeout,schedule,log} from './runtime-driver.mjs';
const relay=new PgRelay(),client=new PublicMcp();const result={case:'A1 identical/replay',status:'running'};
try{
 await relay.start();await client.start({relay});
 await client.call('app.describe_actions',{});
 const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});
 assert(rows.ok);const index=rows.data.findIndex(x=>x.claim_ref==='CL-103');assert(index>=0);
 const ref=rows.subjects.find(x=>x.row_index===index).ref;
 const args={outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:ref},inputs:{desired_cents:25000}};
 const before=ledgerSnapshot('a1-before'),source=await sourceSnapshot('a1-before');assert.equal(before.approvals.length,1);schedule('A1 identical and replay');
 relay.arm();const held=once(relay,'held');const first=client.call('app.request_change',args);first.catch(()=>{});
 await timeout(held,10000,'first fact response hold');await hostSnapshot('a1-first-held');
 const waiting=new Promise(resolve=>{const listener=e=>{if(e.point==='subject_wait'&&e.locals.waiting){client.inspector.off('boundary',listener);resolve(e);}};client.inspector.on('boundary',listener);});
 const second=client.call('app.request_change',args);second.catch(()=>{});
 result.wait_boundary=await timeout(waiting,8000,'identical request entering product subject mutex');
 const during=ledgerSnapshot('a1-during');assert.equal(during.proposals.length,before.proposals.length,'No proposal before held first fact read returns');
 relay.release();result.responses=await Promise.all([first,second]);
 assert(result.responses.every(x=>x.ok),'Both public calls return valid results');
 assert.equal(result.responses[0].proposal_id,result.responses[1].proposal_id);
 const admitted=ledgerSnapshot('a1-admitted');
 for(const table of ['proposals','approvals','worker_queue'])assert.equal(admitted[table].length,before[table].length+1,table);
 assert.equal(admitted.writeback_receipts.length,before.writeback_receipts.length);
 assert.deepEqual(await sourceSnapshot('a1-before-worker'),source);
 result.worker=await operator(['worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--worker-id','semantic_action_worker']);assert.equal(result.worker.code,0);
 const executed=ledgerSnapshot('a1-executed');assert.equal(executed.writeback_receipts.length,before.writeback_receipts.length+1);
 const sourceAfter=await sourceSnapshot('a1-executed');
 const expected=structuredClone(source);const claim=expected.claims.find(x=>x.claim_ref==='CL-103');claim.reserve_cents=25000;claim.version++;
 assert.deepEqual(sourceAfter,expected);
 result.replay=await client.call('app.request_change',args);
 const replay=ledgerSnapshot('a1-replay');for(const table of ['proposals','approvals','worker_queue','writeback_receipts','writeback_jobs','control_policy_effect_admissions','control_policy_budget_requests'])assert.deepEqual(replay[table],executed[table],`Replay preserves ${table}`);
 assert.deepEqual(await sourceSnapshot('a1-replay'),sourceAfter);
 result.boundaries=client.inspector.boundaries;
 await client.close();const restarted=new PublicMcp();
 try {await restarted.start({inspector:false});result.restart_replay=await restarted.call('app.request_change',args);
 assert.equal(result.restart_replay.proposal_id,result.responses[0].proposal_id);const afterRestart=ledgerSnapshot('a1-restart');
 for(const table of ['proposals','approvals','worker_queue','writeback_receipts','writeback_jobs'])assert.deepEqual(afterRestart[table],executed[table]);
 assert.deepEqual(await sourceSnapshot('a1-restart'),sourceAfter);
 }finally{await restarted.close();}
 result.status='pass_single_process';result.counts={new_proposals:1,new_approvals:1,new_queue:1,new_receipts:1,new_source_effects:1};
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;log('a1_failure',{message:e.message});process.exitCode=1;}
finally{if(relay.held)relay.release();await client.close();await relay.close();await fs.writeFile(path.join(runtime,'a1-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));}
