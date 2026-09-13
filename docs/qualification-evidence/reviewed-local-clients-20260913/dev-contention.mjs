import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {PublicMcp,owner,runtime,ledgerSnapshot,sourceSnapshot} from './runtime-driver.mjs';
import {contend} from './accounting-contention.mjs';
const profiles=JSON.parse(await fs.readFile(path.join(owner.owned,'reviewed-clients.json')));const clients=[new PublicMcp(),new PublicMcp()];
const result={case:'development only accounting observer validation',artifact:owner.artifact_tree,status:'running'};
try{
 await Promise.all(clients.map((c,i)=>c.start({localClient:profiles[i?'colleague':'primary']})));
 const args=[];for(let i=0;i<2;i++){await clients[i].call('app.describe_actions',{});const rows=await clients[i].call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});assert(rows.ok);const index=rows.data.findIndex(r=>r.claim_ref===(i?'CL-801':'CL-103'));assert(index>=0);args.push({outcome:'reserve_ops.adjust_claim_reserve',subject_refs:{selected_claim:rows.subjects.find(s=>s.row_index===index).ref},inputs:{desired_cents:i?15000:25000}});}
 const before=ledgerSnapshot('dev-contention-before'),source=await sourceSnapshot('dev-contention-before');assert.equal(before.approvals.length,1);
 result.contention=await contend(clients[0],args[0],clients[1],args[1]);assert(result.contention.responses.every(r=>r.ok&&r.proposal.status==='approved'));
 const after=ledgerSnapshot('dev-contention-after');assert.equal(after.approvals.length,3);assert.equal(after.proposals.length,before.proposals.length+2);assert.deepEqual(await sourceSnapshot('dev-contention-after'),source);result.status='pass_development_only';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.close()));ledgerSnapshot('dev-contention-final');await fs.writeFile(path.join(runtime,'dev-contention-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
