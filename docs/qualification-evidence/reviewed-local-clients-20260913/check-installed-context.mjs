import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PublicMcp,operator,owner,runtime} from './runtime-driver.mjs';
const client=new PublicMcp(),result={case:'configured local identity prerequisite',status:'running'};
try {
 const bytes=await fs.readFile(path.join(owner.project,'.synapsor/local-test-runtime.json'));
 result.identity_file_sha256=createHash('sha256').update(bytes).digest('hex');
 result.reviewed_bindings=JSON.parse(bytes).bindings;
 result.doctor=await operator(['doctor','--config','synapsor.actions.runner.json','--json']);assert.equal(result.doctor.code,0);
 await client.start({inspector:false});result.describe=await client.call('app.describe_data',{});
 result.rows=await client.call('app.explore_data',{plan:{kind:'rows',resource:'reserve_ops.claims',select:['claim_ref','reserve_cents']}});
 assert(result.rows.ok);assert(result.rows.data.some(r=>r.claim_ref==='CL-103'));
 assert(!result.rows.data.some(r=>r.claim_ref==='CL-701'));
 result.status='pass_configured_original_context';
} catch(e) {result.status='blocked_or_failed_prerequisite';result.error=e.stack;process.exitCode=1;}
finally{await client.close();await fs.writeFile(path.join(runtime,'identity-prerequisite.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
