import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {resolveSynapsorProject} from '../../../apps/runner/src/project-resolution.js';
const [logical,physical]=process.argv.slice(2);
assert(logical && physical);
const resolved=await resolveSynapsorProject(logical);
if (!resolved) {
 assert.equal(logical,'/tmp/project');
 assert.equal((await fs.readdir(physical)).filter(n=>n!== 'handbook.txt').length,0);
 console.log(JSON.stringify({ok:true,logical_project:logical,physical_owned_project:physical,fresh:true,effective_external_store:false}));
 process.exit(0);
}
assert.equal(resolved?.project_root,logical);
assert.equal(resolved?.store_path,path.join(logical,'.synapsor/local.db'));
const migration=JSON.parse(await fs.readFile(path.join(logical,'.synapsor/control-policy/migration.json'),'utf8'));
const text=JSON.stringify(migration);
assert(text.includes(path.join(logical,'.synapsor/local.db')));
for(const relative of ['.synapsor/local.db','synapsor.runner.json','.synapsor/control-policy/migration.json']) {
 const [a,b]=await Promise.all([fs.stat(path.join(logical,relative)),fs.stat(path.join(physical,relative))]);
 assert.equal(a.dev,b.dev);assert.equal(a.ino,b.ino);
}
console.log(JSON.stringify({ok:true,logical_project:logical,physical_owned_project:physical,effective_store:resolved!.store_path,whole_directory_mount:true}));
