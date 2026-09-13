// Source-owner setup of one new isolated copy of an original known case.
// No model, Runner authority mutation or application worker is invoked here.
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';import {execFileSync,spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root;
const schedules={
 'recovery-tournament-original':['tournament-ratification','unaided-clarification-refusal'],
 'recovery-tournament-assisted':['tournament-ratification','assisted-stopped'],
 'recovery-software':['software-release-sealing','budget-stopped'],
 'fresh-tournament':['tournament-ratification',null], 'fresh-software':['software-release-sealing',null],
};
const runId=process.argv[2];assert(Object.hasOwn(schedules,runId));
const [caseId,checkpoint]=schedules[runId],original=path.join(plan.previous_root,'cases',caseId),owned=path.join(O,'runs',runId);
const candidate=JSON.parse(await fs.readFile(path.join(O,'frozen/installed-artifact-manifest.json')));
execFileSync(process.execPath,[path.join(O,'frozen/freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
await fs.mkdir(path.join(O,'runs'),{recursive:true});
await fs.mkdir(owned,{recursive:false});
const originalManifest=JSON.parse(await fs.readFile(path.join(original,'frozen-input-manifest.json')));
const hash=file=>fs.readFile(file).then(b=>createHash('sha256').update(b).digest('hex'));
for(const r of originalManifest.records)assert.equal(await hash(path.join(original,r.path)),r.sha256);
for(const item of ['authoring-input','private','verifier','schema.sql','case.json','frozen-input-manifest.json'])await fs.cp(path.join(original,item),path.join(owned,item),{recursive:true,errorOnExist:true,force:false});
const project=path.join(owned,'project');
if(checkpoint)await fs.cp(path.join(original,'checkpoints',checkpoint,'project'),project,{recursive:true,errorOnExist:true,force:false});else {await fs.mkdir(project);await fs.copyFile(path.join(owned,'authoring-input/policy.md'),path.join(project,'rules.txt'));}
for(const dir of ['home','var-tmp','meter','logs','fixture-state'])await fs.mkdir(path.join(owned,dir));
const logicalCase=checkpoint?original:owned,logicalProject=path.join(logicalCase,'project');
const oldConnection=JSON.parse(await fs.readFile(path.join(plan.previous_root,'fixture-validation',caseId+'-private-connection.json')));
const mountPlan={mounts:[{logical:logicalCase,physical:owned}],owned_database_envs:['DATABASE_URL','WRITER_DATABASE_URL']};
// Keep exact reviewed project and store locators. A private whole-case bind maps
// them to this copy; the original socket locator maps to the new owned server.
await fs.writeFile(path.join(owned,'mount-plan.json'),JSON.stringify(mountPlan,null,2)+'\n',{flag:'wx'});
const c=JSON.parse(await fs.readFile(path.join(owned,'case.json'))),facts=JSON.parse(await fs.readFile(path.join(owned,'private/source-facts.json')));
const socketRoot=await fs.mkdtemp(path.join(os.tmpdir(),'synapsor-authoring-pg-')),socket=path.join(socketRoot,'socket');await fs.mkdir(socket,{mode:0o777});await fs.chmod(socket,0o777);
const name='synapsor-authoring-'+runId+'-'+randomUUID().slice(0,8),label='authoring-review-repair-20260913';
const metadata={name,label,owned,socketRoot,socket,caseId,runId,checkpoint,created_at:new Date().toISOString(),network:'none',image:execFileSync('docker',['image','inspect','postgres:17','--format','{{.Id}}'],{encoding:'utf8'}).trim()};
await fs.writeFile(path.join(owned,'private/postgres-fixture.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
const {Client}=createRequire(path.join(O,'frozen/installed/package.json'))('pg');
const database=oldConnection.database,uri=(role)=>`postgresql:///${database}?host=${encodeURIComponent(socket)}&user=${role}`;
let source;
try {
 metadata.id=execFileSync('docker',['run','--pull=never','-d','--network','none','--name',name,'--label','synapsor.qualification='+label,'--env','POSTGRES_DB='+database,'--env','POSTGRES_HOST_AUTH_METHOD=trust','--mount',`type=bind,source=${socket},target=/var/run/postgresql`,'postgres:17','-c','listen_addresses='],{encoding:'utf8'}).trim();
 for(let i=0;i<60;i++) {
  try {assert.equal(execFileSync('docker',['exec',name,'cat','/proc/1/comm'],{encoding:'utf8'}).trim(),'postgres');source=new Client({connectionString:uri('postgres'),connectionTimeoutMillis:1000});await source.connect();break;}
  catch(error){if(source)await source.end().catch(()=>{});source=undefined;await delay(500);}
 }
 assert(source,'Owned source did not become ready');assert.equal((await source.query('SELECT current_database() AS name')).rows[0].name,database);
 await source.query(await fs.readFile(path.join(owned,'schema.sql'),'utf8'));
 await source.query('BEGIN');
 for(const table of c.table_order)for(const row of facts[table]) {
  const keys=Object.keys(row);await source.query(`INSERT INTO ${c.schema}.${table} (${keys.map(k=>'"'+k+'"').join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
 }
 await source.query('COMMIT');
 const counts={};for(const table of c.table_order) {
  const actual=(await source.query(`SELECT * FROM ${c.schema}.${table}`)).rows,pk=Object.keys(facts[table][0])[0],sort=rows=>rows.slice().sort((a,b)=>a[pk].localeCompare(b[pk]));
  assert.deepEqual(sort(actual),sort(facts[table]));counts[table]=actual.length;
 }
 const version=(await source.query('SELECT version() AS version')).rows[0].version;
 metadata.ready_at=new Date().toISOString();metadata.counts=counts;metadata.version=version;
 const logicalSocket=checkpoint?oldConnection.socket:socket;
 const env=checkpoint?oldConnection.env:{DATABASE_URL:`postgresql:///${database}?host=${encodeURIComponent(logicalSocket)}&user=${c.reader_role}`};
 await fs.writeFile(path.join(owned,'private/connection.json'),JSON.stringify({container:name,container_id:metadata.id,label,socket,logicalSocket,database,adminUrl:uri('postgres'),env},null,2)+'\n',{flag:'wx'});
 await fs.writeFile(path.join(owned,'run-state.json'),JSON.stringify({runId,caseId,classification:checkpoint?'KNOWN-CASE checkpoint recovery':'fresh KNOWN-CASE regression',checkpoint,original,owned,logicalCase,logicalProject,prior_authoring_calls:checkpoint==='unaided-clarification-refusal'?16:checkpoint==='assisted-stopped'?24:checkpoint==='budget-stopped'?50:0,original_stage_b:'NOT_PASSED',artifact_tree:candidate.installed_tree_sha256,product_commit:candidate.product_commit,fixture_prepared_at:metadata.ready_at,source_rows_unchanged:true,counts,initial_authoring_calls:0,maximum_initial_calls:checkpoint?20:50,reserved_editing_calls:checkpoint?0:30,first_public_start:null,status:'PREPARED_NOT_EXECUTED'},null,2)+'\n',{flag:'wx'});
 for(const r of originalManifest.records)assert.equal(await hash(path.join(owned,r.path)),r.sha256);
 console.log(JSON.stringify({runId,status:'PREPARED_NOT_EXECUTED',caseId,counts,artifact_tree:candidate.installed_tree_sha256,original_inputs_unchanged:true,container:name}));
} finally {
 if(source)await source.end().catch(()=>{});
 await fs.writeFile(path.join(owned,'private/postgres-fixture.json'),JSON.stringify(metadata,null,2)+'\n');
 const logs=spawnSync('docker',['logs',name],{encoding:'utf8'});await fs.writeFile(path.join(owned,'logs/postgres-startup.log'),logs.stdout+logs.stderr);
}
