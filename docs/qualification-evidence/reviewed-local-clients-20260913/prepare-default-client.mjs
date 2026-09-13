import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {operator,owner,runtime,ledgerSnapshot} from './runtime-driver.mjs';
const result={case:'explicit legacy-default launcher update on owned control fixture',artifact:owner.artifact_tree,status:'running'};
try{
 const before=ledgerSnapshot('default-client-before');const identity=await fs.readFile(path.join(owner.project,'.synapsor/local-test-runtime.json'),'utf8');
 const args=['mcp','install','claude-code','--project','--authoring','--project-root','.'];result.preview=await operator([...args,'--dry-run','--json']);assert.equal(result.preview.code,0);
 result.install=await operator([...args,'--yes','--json']);assert.equal(result.install.code,0);const entries=JSON.parse(await fs.readFile(path.join(owner.project,'.mcp.json')));assert.equal(entries.mcpServers.synapsor.args[0],path.join(owner.artifact_root,'installed/node_modules/@synapsor/runner/dist/runner.mjs'));assert(entries.mcpServers.synapsor.args.includes('.synapsor/local-test-runtime.json'));
 result.diagnostic=await operator(['mcp','status','claude-code','--project','--project-root','.','--check-launch','--json']);assert.equal(result.diagnostic.code,0);assert(JSON.parse(result.diagnostic.stdout).launch.ok);
 const after=ledgerSnapshot('default-client-after');for(const table of ['proposals','approvals','worker_queue','writeback_jobs','writeback_receipts','control_policy_active','control_policy_revisions']){assert(Array.isArray(before[table]));assert.deepEqual(after[table],before[table]);}assert.equal(await fs.readFile(path.join(owner.project,'.synapsor/local-test-runtime.json'),'utf8'),identity);result.status='passed_explicit_default_update_and_launch';
}catch(e){result.status='failed_or_incomplete';result.error=e.stack;process.exitCode=1;}
finally{await fs.writeFile(path.join(runtime,'default-client-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));}
