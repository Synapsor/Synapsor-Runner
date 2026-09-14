// Save a quiescent owned public attempt. Read-only SQLite inspection and an
// independent source-owner readback do not supply any application authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url));
const plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root;
const [runId,label,expectedReadback]=process.argv.slice(2);
assert(/^(counting-wording-control|recovery-tournament-(original|assisted)|recovery-software|edit-tournament|prepared-software|fresh-(tournament|software))$/.test(runId));
assert(/^[a-z0-9-]+$/.test(label));
assert(!(await fs.stat(path.join(O,'one-public-run.lock')).catch(()=>null)),'Stop the public CLI before taking a whole-directory checkpoint');
const R=path.join(O,'runs',runId),P=path.join(R,'project'),dest=path.join(R,'checkpoints',label);
await fs.mkdir(path.dirname(dest),{recursive:true});await fs.mkdir(dest);
const state=JSON.parse(await fs.readFile(path.join(R,'run-state.json')));
const connection=JSON.parse(await fs.readFile(path.join(R,'private/connection.json')));
const container=JSON.parse(execFileSync('docker',['inspect',connection.container],{encoding:'utf8'}))[0];
assert.equal(container.Id,connection.container_id);assert.equal(container.Config.Labels['synapsor.qualification'],connection.label);assert.equal(container.HostConfig.NetworkMode,'none');assert(container.State.Running);
const require=createRequire(path.join(state.artifact_directory??path.join(O,'frozen'),'installed/package.json')),{Client}=require('pg');
await fs.cp(P,path.join(dest,'project'),{recursive:true,force:false,errorOnExist:true});
const hashes=[];const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function files(dir){const result=[];for(const name of await fs.readdir(dir)){const p=path.join(dir,name),s=await fs.lstat(p);assert(!s.isSymbolicLink(),'Project checkpoint must not follow external symlinks');if(s.isDirectory())result.push(...await files(p));else result.push(p);}return result;}
const stores={};
for(const file of await files(P)){
 const rel=path.relative(P,file),copy=path.join(dest,'project',rel),bytes=await fs.readFile(file);assert.equal(digest(bytes),digest(await fs.readFile(copy)));
 hashes.push({path:rel,sha256:digest(bytes),bytes:bytes.length});
 if(bytes.subarray(0,16).equals(Buffer.from('SQLite format 3\0'))){
  assert((await fs.realpath(file)).startsWith(P+'/'));const db=new DatabaseSync(file,{readOnly:true});
  try{const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();stores[rel]=Object.fromEntries(tables.map(({name})=>[name,db.prepare('SELECT count(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n]));}finally{db.close();}
 }
}
if(expectedReadback) assert(/^deterministic\/[a-z0-9-]+-source\.json$/.test(expectedReadback),'Select an owned independently verified readback');
const facts=JSON.parse(await fs.readFile(path.join(R,expectedReadback??'fixture-state/restored-baseline-source.json'))),c=JSON.parse(await fs.readFile(path.join(R,'case.json')));
const source=new Client({connectionString:connection.adminUrl,connectionTimeoutMillis:3000});await source.connect();const rows={},counts={};
try{
 assert.equal((await source.query('SELECT current_database() AS name')).rows[0].name,connection.database);
 for(const table of c.table_order){rows[table]=(await source.query(`SELECT * FROM ${c.schema}.${table}`)).rows;const pk=Object.keys(facts[table][0])[0],sort=v=>v.slice().sort((a,b)=>a[pk].localeCompare(b[pk]));assert.deepEqual(JSON.parse(JSON.stringify(sort(rows[table]))),sort(facts[table]));counts[table]=rows[table].length;}
}finally{await source.end();}
await fs.writeFile(path.join(dest,'source-readback.json'),JSON.stringify(rows,null,2)+'\n',{flag:'wx'});
await fs.writeFile(path.join(dest,'source.dump'),execFileSync('docker',['exec',connection.container,'pg_dump','-U','postgres','-Fc',connection.database]),{flag:'wx'});
const invocations=(await fs.readFile(path.join(R,'public-invocations.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
const events=(await fs.readFile(path.join(R,'meter/events.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
const resumePath=path.join(P,'.synapsor/boundary-authoring/resume.json'),resume=JSON.parse(await fs.readFile(resumePath).catch(()=>'null'));
const answer='Yes. Each tenant is exactly one league, and each principal is an assigned referee within that league. Referees in the same league share the limit of two automatic ratifications in the rolling 24 hours; all leagues share the overall limit of six.';
const answerPaths=[];function walk(value,p=''){if(Array.isArray(value))value.forEach((v,i)=>walk(v,p+'['+i+']'));else if(value&&typeof value==='object')Object.entries(value).forEach(([k,v])=>walk(v,p+'.'+k));else if(value===answer)answerPaths.push(p);}walk(resume);
const result={at:new Date().toISOString(),runId,label,classification:state.classification,artifact_tree:state.artifact_tree,prior_calls:state.prior_authoring_calls,new_authoring_calls:events.filter(e=>e.type==='transport_attempt').length,complete_response_captures:events.filter(e=>e.type==='response_complete').length,response_capture_files:(await fs.readdir(path.join(R,'meter'))).filter(name=>/^output-\d+\.txt$/.test(name)).length,cli_exits:invocations.filter(e=>e.event==='exit').map(e=>e.code),preflight_exits:invocations.filter(e=>e.event==='preflight').map(e=>e.code),resume_stage:resume?.stage,exact_original_answer_paths:answerPaths,stores,source_counts:counts,source_unchanged_relative_to_matching_task_baseline:!expectedReadback,source_matches_selected_independent_oracle:true,source_oracle:expectedReadback??(runId==='prepared-software'?'exact independently checked successful B01 effect; other original business rows unchanged; receipt rollback/control snapshots preserved':'matching restored checkpoint source-readback, not the original seed facts'),project_copy_sha256:digest(JSON.stringify(hashes.sort((a,b)=>a.path.localeCompare(b.path)))),checkpoint:dest};
await fs.writeFile(path.join(dest,'project-manifest.json'),JSON.stringify(hashes,null,2)+'\n',{flag:'wx'});
await fs.writeFile(path.join(dest,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
await fs.writeFile(path.join(E,runId+'-'+label+'.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
