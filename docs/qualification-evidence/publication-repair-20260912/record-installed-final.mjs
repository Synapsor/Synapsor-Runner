import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ledgerSnapshot,sourceSnapshot,owner,runtime} from './runtime-driver.mjs';
const ledger=ledgerSnapshot('final-state'),source=await sourceSnapshot('final-state');
const result={case:owner.case,at:new Date().toISOString(),artifact_tree:owner.artifact_tree,counts:Object.fromEntries(Object.entries(ledger).map(([k,v])=>[k,v.length]))};
if(['edit','overall'].includes(owner.case)){
 const original=JSON.parse(await fs.readFile('/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/proposal-receipt-scope-961d98c/insurance-recovery/replay-complete-store-snapshot.json','utf8'));
 const sorted=rows=>rows.map(r=>JSON.stringify(r,Object.keys(r).sort())).sort();
 for(const table of ['control_policy_active','control_policy_drafts','control_policy_revisions','approvals','proposals','worker_queue','writeback_receipts'])assert.deepEqual(sorted(ledger[table]),sorted(original[table]),table);
 const before=JSON.parse(await fs.readFile(path.join(owner.owned,'owner-source-baseline.json'),'utf8'));assert.deepEqual(JSON.parse(JSON.stringify(source)),before);
 result.authority_decisions_queue_receipts_and_source_unchanged=true;
}
result.identity_file_sha256=createHash('sha256').update(await fs.readFile(path.join(owner.project,'.synapsor/local-test-runtime.json'))).digest('hex');
await fs.writeFile(path.join(runtime,'final-state-summary.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
