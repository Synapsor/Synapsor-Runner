// Bounded normal MCP client, kept connected across public operator editing.
// Inputs below drive existing public tools; no product setters or provider payload replacement.
import fs from 'node:fs/promises';import path from 'node:path';import readline from 'node:readline';import {PublicMcp,operator,sourceSnapshot,ledgerSnapshot,D,state,log} from './known-runtime.mjs';
const m=await new PublicMcp().start();console.log(JSON.stringify({event:'connected',pid:m.child.pid,artifact_tree:state.artifact_tree}));
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
try {for await(const line of lines){if(!line.trim())continue;const q=JSON.parse(line);try{if(q.kind==='quit')break;let result;
 if(q.kind==='call')result=await m.call(q.name,q.args??{});
 else if(q.kind==='worker')result=await operator(['worker','run','--supervised','--once','--yes','--config','synapsor.actions.runner.json','--worker-id','semantic_action_worker']);
 else if(q.kind==='snapshot'){const ledger=ledgerSnapshot(q.label),source=await sourceSnapshot(q.label);result={ledger_counts:Object.fromEntries(['proposals','approvals','worker_queue','writeback_receipts'].map(t=>[t,ledger[t].length])),source_counts:Object.fromEntries(Object.entries(source).map(([k,v])=>[k,v.length]))};}
 else throw Error('Unknown harness command');
 if(q.label)await fs.writeFile(path.join(D,q.label+'-result.json'),JSON.stringify({at:new Date().toISOString(),request:q,result},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({event:'result',label:q.label,result}));
 }catch(error){log('driver_failure',{request:q,error:String(error)});console.log(JSON.stringify({event:'failure',label:q.label,error:String(error)}));}}
}finally{await m.close();console.log(JSON.stringify({event:'closed'}));}
