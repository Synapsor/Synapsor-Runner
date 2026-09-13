import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PublicMcp,admin,operator,sourceSnapshot,ledgerSnapshot,hostSnapshot,runtime,timeout,schedule,log} from './runtime-driver.mjs';
const result={case:'A3 complete portfolio collection and owned source transaction',status:'running'};
const client=new PublicMcp();const workers=[];let blocker;
const runWorker=(onSpawn)=>{const work=operator(['worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--worker-id','semantic_action_worker'],{},onSpawn);workers.push(work);return work;};
async function waitForBlocked(pid,label){
 const observer=admin();await observer.connect();try{const end=Date.now()+12000;
 while(Date.now()<end){const r=await observer.query('SELECT pid,usename,application_name,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',[pid]);
  if(r.rows.length){log('source_lock_wait',{label,blocker:pid,rows:r.rows});return r.rows;}
  await new Promise(resolve=>setTimeout(resolve,20));}
 throw Error(`${label}: no owned source transaction wait observed`);
 }finally{await observer.end();}
}
try {
 await client.start({inspector:false});await client.call('app.describe_actions',{});
 const rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);
 const args=(claim,desired)=>{const i=rows.data.findIndex(r=>r.claim_ref===claim);assert(i>=0);return {outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:rows.subjects.find(s=>s.row_index===i).ref},inputs:{desired_cents:desired}};};
 const source=await sourceSnapshot('a3-before'),before=ledgerSnapshot('a3-before');schedule('A3 portfolio constraint');
 result.requests=await Promise.all(['CL-401','CL-402'].map(ref=>client.call('app.request_change',args(ref,60000))));
 assert(result.requests.every(r=>r.ok&&r.proposal.status==='pending_review'));
 const admitted=ledgerSnapshot('a3-admitted'),created=admitted.proposals.filter(p=>!before.proposals.some(b=>b.proposal_id===p.proposal_id));assert.equal(created.length,2);
 result.proposal_ids=[401,402].map(n=>{const found=created.filter(p=>p.object_id===`b0000000-0000-4000-8000-${String(n).padStart(12,'0')}`);assert.equal(found.length,1);const p=found[0];assert.equal(p.state,'pending_review');assert.equal(JSON.parse(p.change_set_json).patch.reserve_cents,60000);return p.proposal_id;});
 result.human=[];for(const proposal_id of result.proposal_ids){const r={proposal_id};const a=await operator(['proposals','approve',r.proposal_id,'--yes','--reason','Reviewed exact owned synthetic collection request for 60000 cents; original hard cap still applies','--config','synapsor.actions.runner.json']);assert.equal(a.code,0);result.human.push(a);}
 blocker=admin();await blocker.connect();const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await blocker.query('BEGIN');await blocker.query("SELECT portfolio_id FROM reserve_ops.portfolios WHERE portfolio_ref='PF-RACE' FOR UPDATE");
 const first=runWorker();result.first_source_wait=await waitForBlocked(pid,'collection worker');
 const spawned=new Promise(resolve=>{result.second_spawn_resolve=resolve;});
 const second=runWorker(pid=>result.second_spawn_resolve(pid));
 result.second_worker_pid=await timeout(spawned,1500,'second worker process launch');delete result.second_spawn_resolve;
 result.workers_before_release=await hostSnapshot('a3-second-worker-before-first-release');
 result.effect_scheduling='First effect transaction observed waiting; second process launched before release. Concurrency limit remains one; this observation does not establish overlapping effect transactions.';
 await blocker.query('COMMIT');await blocker.end();blocker=undefined;
 result.workers=await Promise.all([first,second]);assert(result.workers.every(w=>w.code===0));
 let after=ledgerSnapshot('a3-concurrent-workers');
 for(const proposal_id of result.proposal_ids){const r={proposal_id};const queued=after.worker_queue.find(q=>q.proposal_id===r.proposal_id);if(queued?.status==='queued'){result.workers.push(await runWorker());after=ledgerSnapshot('a3-drained-'+r.proposal_id);}}
 const applied=after.writeback_receipts.filter(r=>!before.writeback_receipts.some(b=>b.receipt_id===r.receipt_id));
 result.collection_receipts=applied;
 const sourceAfter=await sourceSnapshot('a3-collection-after');
 const claims=sourceAfter.claims.filter(c=>['CL-401','CL-402'].includes(c.claim_ref));assert.equal(claims.reduce((s,c)=>s+c.reserve_cents,0),90000);
 assert.equal(claims.filter(c=>c.reserve_cents===60000&&c.version===2).length,1);assert.equal(claims.filter(c=>c.reserve_cents===30000&&c.version===1).length,1);
 assert(applied.some(r=>r.status==='applied'));assert.equal(applied.filter(r=>r.status==='applied').length,1);
 const expected=structuredClone(source);const changed=claims.find(c=>c.reserve_cents===60000);Object.assign(expected.claims.find(c=>c.claim_ref===changed.claim_ref),changed);assert.deepEqual(sourceAfter,expected);
 // Separate owned competing UPDATE with the required version increment. The
 // worker must encounter the actual row lock before the owner commits.
 schedule('A3 owned source update');const externalBefore=ledgerSnapshot('a3-external-before');result.external_request=await client.call('app.request_change',args('CL-501',25000));assert(result.external_request.ok);
 const externalAdmitted=ledgerSnapshot('a3-external-admitted'),externalCreated=externalAdmitted.proposals.filter(p=>!externalBefore.proposals.some(b=>b.proposal_id===p.proposal_id));assert.equal(externalCreated.length,1);assert.equal(externalCreated[0].object_id,'b0000000-0000-4000-8000-000000000501');assert.equal(JSON.parse(externalCreated[0].change_set_json).patch.reserve_cents,25000);result.external_proposal_id=externalCreated[0].proposal_id;
 blocker=admin();await blocker.connect();const ownerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await blocker.query('BEGIN');await blocker.query("UPDATE reserve_ops.portfolios SET status='closed',version=version+1 WHERE portfolio_ref='PF-PENDING'");
 const external=runWorker();result.external_source_wait=await waitForBlocked(ownerPid,'source update worker');await blocker.query('COMMIT');await blocker.end();blocker=undefined;
 result.external_worker=await external;assert.equal(result.external_worker.code,0);
 const final=ledgerSnapshot('a3-final'),finalSource=await sourceSnapshot('a3-final');
 const ownerExpected=structuredClone(sourceAfter);const portfolio=ownerExpected.portfolios.find(p=>p.portfolio_ref==='PF-PENDING');portfolio.status='closed';portfolio.version++;
 assert.deepEqual(finalSource,ownerExpected);
 result.external_receipts=final.writeback_receipts.filter(r=>r.proposal_id===result.external_proposal_id);
 assert(result.external_receipts.length>0);assert(result.external_receipts.every(r=>r.status!=='applied'));
 result.status='pass_observed_source_coordination';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;log('a3_failure',{message:e.message});}
finally{if(blocker){await blocker.query('ROLLBACK').catch(()=>{});await blocker.end();}await Promise.allSettled(workers);await client.close();await fs.writeFile(path.join(runtime,'a3-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
