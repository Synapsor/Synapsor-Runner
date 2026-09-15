// Source-owner setup of one new isolated copy of an original known case.
// No model, Runner authority mutation or application worker is invoked here.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';import {execFileSync,spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),lane=process.argv.find(a=>a.startsWith('--development-lane='))?.split('=')[1],O=process.argv.includes('--development')?path.join(plan.owned_root,'development',lane??''):plan.owned_root;
assert(!process.argv.includes('--development') || /^(terra|sol)(-repaired)?$/.test(lane??''),'Declare the development evidence lane; model choice stays in the public UI');
const runId=process.argv[2],selected=plan.case_sources[runId];assert(selected);
const caseId=selected.case,checkpoint=selected.checkpoint,original=path.join(plan.original_cases_root,caseId),owned=path.join(O,'runs',runId),previousRun=path.join(selected.root,'runs',selected.run);
const checkpointRoot=selected.checkpoint_root??path.join(previousRun,'checkpoints',checkpoint);
const previousState=previousRun?JSON.parse(await fs.readFile(path.join(previousRun,'run-state.json'))):undefined;
const F=plan.frozen_root;assert(!process.argv.includes('--development') || process.argv.includes('--fixture-only'));
const fixtureOnly=process.argv.includes('--fixture-only');
const candidate=fixtureOnly?null:JSON.parse(await fs.readFile(path.join(F,'installed-artifact-manifest.json')));
if(candidate)execFileSync(process.execPath,[path.join(F,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
else assert(!(await fs.stat(path.join(F,'installed-artifact-manifest.json')).catch(()=>null)),'Use the final candidate once it exists');
await fs.mkdir(path.join(O,'runs'),{recursive:true});
await fs.mkdir(owned,{recursive:false});
const originalManifest=JSON.parse(await fs.readFile(path.join(original,'frozen-input-manifest.json')));
const hash=file=>fs.readFile(file).then(b=>createHash('sha256').update(b).digest('hex'));
for(const r of originalManifest.records)assert.equal(await hash(path.join(original,r.path)),r.sha256);
for(const item of ['authoring-input','private','verifier','schema.sql','case.json','frozen-input-manifest.json'])await fs.cp(path.join(original,item),path.join(owned,item),{recursive:true,errorOnExist:true,force:false});
const project=path.join(owned,'project');
if(checkpoint)await fs.cp(path.join(checkpointRoot,'project'),project,{recursive:true,errorOnExist:true,force:false});else {await fs.mkdir(project);await fs.copyFile(path.join(owned,'authoring-input/policy.md'),path.join(project,'rules.txt'));}
// Verify both directions against the preserved checkpoint before any application open.
const expectedProject = JSON.parse(await fs.readFile(path.join(checkpointRoot,'project-manifest.json')));
async function projectFiles(dir) { const found=[];for(const n of await fs.readdir(dir)) {const p=path.join(dir,n),st=await fs.lstat(p);assert(!st.isSymbolicLink(),'A project restoration must not follow symlinks');if(st.isDirectory())found.push(...await projectFiles(p));else {assert(st.isFile());found.push(path.relative(project,p));}}return found; }
assert.deepEqual((await projectFiles(project)).sort(),expectedProject.map(r=>r.path).sort());
for(const record of expectedProject)assert.equal(await hash(path.join(project,record.path)),record.sha256);
if (selected.checkpoint_root) {
 // Independent handoff checkpoints are physically read-only. Restore only
 // owner write permissions in this newly owned whole copy, never the original.
 async function writableOwnedCopy(dir) {
  await fs.chmod(dir,0o700);
  for (const name of await fs.readdir(dir)) {
   const file=path.join(dir,name),stat=await fs.lstat(file);assert(!stat.isSymbolicLink());
   if(stat.isDirectory())await writableOwnedCopy(file);else {assert(stat.isFile());await fs.chmod(file,0o600|(stat.mode&0o100));}
  }
 }
 await writableOwnedCopy(project);
}
for(const dir of ['home','var-tmp','meter','logs','fixture-state'])await fs.mkdir(path.join(owned,dir));
const logicalCase=checkpoint?previousState.logicalCase:owned,logicalProject=path.join(logicalCase,'project');
const oldConnection=JSON.parse(await fs.readFile(checkpoint?path.join(previousRun,'private/connection.json'):path.join(path.dirname(plan.original_cases_root),'fixture-validation',caseId+'-private-connection.json')));
const mountPlan={mounts:[{logical:logicalCase,physical:owned}],owned_database_envs:['DATABASE_URL','WRITER_DATABASE_URL']};
// Keep exact reviewed project and store locators. A private whole-case bind maps
// them to this copy; the original socket locator maps to the new owned server.
await fs.writeFile(path.join(owned,'mount-plan.json'),JSON.stringify(mountPlan,null,2)+'\n',{flag:'wx'});
const c=JSON.parse(await fs.readFile(path.join(owned,'case.json'))),facts=JSON.parse(await fs.readFile(path.join(owned,'private/source-facts.json')));
const socketRoot=await fs.mkdtemp(path.join(os.tmpdir(),'synapsor-obligation-readiness-pg-')),socket=path.join(socketRoot,'socket');await fs.mkdir(socket,{mode:0o777});await fs.chmod(socket,0o777);
const name='synapsor-obligation-readiness-'+runId+'-'+randomUUID().slice(0,8),label='obligation-readiness-20260915';
const metadata={name,label,owned,socketRoot,socket,caseId,runId,checkpoint,created_at:new Date().toISOString(),network:'none',image:execFileSync('docker',['image','inspect','postgres:17','--format','{{.Id}}'],{encoding:'utf8'}).trim()};
await fs.writeFile(path.join(owned,'private/postgres-fixture.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
const {Client}=createRequire(fixtureOnly?path.resolve(E,'../../../package.json'):path.join(F,'installed/package.json'))('pg');
const database=oldConnection.database,uri=(role)=>`postgresql:///${database}?host=${encodeURIComponent(socket)}&user=${role}`;
let source;
try {
 metadata.id=execFileSync('docker',['run','--pull=never','-d','--network','none','--name',name,'--label','synapsor.qualification='+label,'--env','POSTGRES_DB='+database,'--env','POSTGRES_HOST_AUTH_METHOD=trust','--mount',`type=bind,source=${socket},target=/var/run/postgresql`,'postgres:17','-c','listen_addresses='],{encoding:'utf8'}).trim();
 for(let i=0;i<60;i++) {
  try {assert.equal(execFileSync('docker',['exec',name,'cat','/proc/1/comm'],{encoding:'utf8'}).trim(),'postgres');source=new Client({connectionString:uri('postgres'),connectionTimeoutMillis:1000});await source.connect();break;}
  catch(error){if(source)await source.end().catch(()=>{});source=undefined;await delay(500);}
 }
 assert(source,'Owned source did not become ready');assert.equal((await source.query('SELECT current_database() AS name')).rows[0].name,database);
 // Every recovery uses the matching whole-project checkpoint and source dump.
 // Original seed rows must never be restored beside a post-effect ledger.
 const reader=c.reader_role, writerEnv=oldConnection.env.WRITER_DATABASE_URL??oldConnection.env.SYNAPSOR_DATABASE_WRITE_URL;
 const dump=await fs.readFile(path.join(checkpointRoot,'source.dump'));
 const schemaView=spawnSync('docker',['exec','-i',name,'pg_restore','--schema-only','--file=-'],{input:dump});
 await fs.writeFile(path.join(owned,'logs/schema-preview.log'),schemaView.stderr,{flag:'wx'});
 assert.equal(schemaView.status,0,'Inspect the exact saved schema before creating its role prerequisites');
 await fs.writeFile(path.join(owned,'fixture-state/restored-schema.sql'),schemaView.stdout,{flag:'wx'});
 // pg_dump omits cluster roles. Retained ACLs can still name an older reviewed
 // writer after an outcome was removed; restore those prerequisites as well.
 // The original operator setup creates these roles, then explicitly enables
 // local login. Restoring the unchanged dump supplies their exact narrow ACLs.
 const writers=new Set([...schemaView.stdout.toString('utf8').matchAll(/\brunner_writer_[a-f0-9]+\b/g)].map(m=>m[0]));
 assert(/^[a-z_][a-z0-9_]+$/.test(reader));
 await source.query(`CREATE ROLE "${reader}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
 if(writerEnv) {
  const writer=new URL(writerEnv).searchParams.get('user');
  assert(/^runner_writer_[a-f0-9]+$/.test(writer));
  writers.add(writer);
 }
 for(const writer of writers) {
  await source.query(`CREATE ROLE "${writer}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
 }
 await fs.writeFile(path.join(owned,'fixture-state/source-role-prerequisites.json'),JSON.stringify({reader,writers:[...writers],basis:'exact saved schema ACLs and reviewed writer connection; unchanged dump restores permissions'},null,2)+'\n',{flag:'wx'});
 await fs.writeFile(path.join(owned,'fixture-state/restored-source.dump'),dump,{flag:'wx'});
 const restored=spawnSync('docker',['exec','-i',name,'pg_restore','-U','postgres','-d',database,'--exit-on-error'],{input:dump});
 await fs.writeFile(path.join(owned,'logs/source-restore.log'),Buffer.concat([restored.stdout,restored.stderr]));assert.equal(restored.status,0);
 const expected=JSON.parse(await fs.readFile(path.join(checkpointRoot,'source-readback.json')));
 for(const table of c.table_order)facts[table]=expected[table];
 await fs.writeFile(path.join(owned,'fixture-state/restored-baseline-source.json'),JSON.stringify(expected,null,2)+'\n',{flag:'wx'});
 await fs.writeFile(path.join(owned,'fixture-state/restoration-identity.json'),JSON.stringify({checkpoint:checkpointRoot,
  source_dump_sha256:await hash(path.join(checkpointRoot,'source.dump')),readback_sha256:await hash(path.join(checkpointRoot,'source-readback.json')),
  project_manifest_sha256:await hash(path.join(checkpointRoot,'project-manifest.json')),source:'matching preserved post-checkpoint state; no seed-row substitution'},null,2)+'\n',{flag:'wx'});
 const counts={};for(const table of c.table_order) {
  const actual=(await source.query(`SELECT * FROM ${c.schema}.${table}`)).rows,pk=Object.keys(facts[table][0])[0],sort=rows=>rows.slice().sort((a,b)=>a[pk].localeCompare(b[pk]));
  assert.deepEqual(JSON.parse(JSON.stringify(sort(actual))),sort(facts[table]));counts[table]=actual.length;
 }
 const version=(await source.query('SELECT version() AS version')).rows[0].version;
 metadata.ready_at=new Date().toISOString();metadata.counts=counts;metadata.version=version;
 const logicalSocket=checkpoint?(oldConnection.logicalSocket??oldConnection.socket):socket;
 const env=checkpoint?oldConnection.env:{DATABASE_URL:`postgresql:///${database}?host=${encodeURIComponent(logicalSocket)}&user=${c.reader_role}`};
 await fs.writeFile(path.join(owned,'private/connection.json'),JSON.stringify({container:name,container_id:metadata.id,label,socket,logicalSocket,database,adminUrl:uri('postgres'),env},null,2)+'\n',{flag:'wx'});
 await fs.writeFile(path.join(owned,'run-state.json'),JSON.stringify({runId,caseId,classification:checkpoint?'KNOWN-CASE checkpoint recovery':'fresh KNOWN-CASE regression',checkpoint,original,owned,logicalCase,logicalProject,prior_authoring_calls:'historical counters retained in previous run; this is a separately bounded task',prior_run:previousRun,original_stage_b:'NOT_PASSED',artifact_tree:candidate?.installed_tree_sha256??null,product_commit:candidate?.product_commit??null,artifact_directory:F,development_only:process.argv.includes('--development'),fixture_prepared_at:metadata.ready_at,source_rows_unchanged:true,source_baseline:'matching source.dump/source-readback and whole project checkpoint; original frozen inputs preserved separately',counts,initial_authoring_calls:0,maximum_initial_calls:19,maximum_total_shared_calls:25,reserved_restart_calls:6,reserved_editing_calls:0,phase:'setup',first_public_start:null,status:fixtureOnly?'PREPARED_AWAITING_FINAL_CANDIDATE':'PREPARED_NOT_EXECUTED'},null,2)+'\n',{flag:'wx'});
 for(const r of originalManifest.records)assert.equal(await hash(path.join(owned,r.path)),r.sha256);
 console.log(JSON.stringify({runId,status:fixtureOnly?'PREPARED_AWAITING_FINAL_CANDIDATE':'PREPARED_NOT_EXECUTED',caseId,counts,artifact_tree:candidate?.installed_tree_sha256??null,original_inputs_unchanged:true,container:name}));
} finally {
 if(source)await source.end().catch(()=>{});
 await fs.writeFile(path.join(owned,'private/postgres-fixture.json'),JSON.stringify(metadata,null,2)+'\n');
 const logs=spawnSync('docker',['logs',name],{encoding:'utf8'});await fs.writeFile(path.join(owned,'logs/postgres-startup.log'),logs.stdout+logs.stderr);
}
