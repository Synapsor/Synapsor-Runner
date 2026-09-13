import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
process.umask(0o077);
const evidence=path.dirname(fileURLToPath(import.meta.url));
const taskRoot='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/structured-save-repair-d422ca5-20260913';
const prior='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/proposal-receipt-scope-961d98c/insurance-recovery';
const caseName=process.argv[2];assert(['before_onboard','before_start','main','edit','replacement_first','admission_first'].includes(caseName));
const artifactRoot=caseName.startsWith('before_')?path.join("/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/publication-repair-779b2dc-20260912",'frozen'):path.join(taskRoot,'frozen');
const artifact=JSON.parse(await fs.readFile(path.join(artifactRoot,'installed-artifact-manifest.json')));
execFileSync(process.execPath,[path.join(artifactRoot,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
const fixture=JSON.parse(await fs.readFile(path.join(evidence,'postgres-fixture.json')));
const inspect=JSON.parse(execFileSync('docker',['inspect',fixture.name],{encoding:'utf8'}))[0];
assert(inspect.State.Running);assert.equal(inspect.Config.Labels['synapsor.qualification'],'structured-save-repair-20260913');
const owned=path.join(taskRoot,caseName.startsWith('before_')?'reproduction':'runtime',caseName), project=path.join(owned,'project');await fs.mkdir(owned,{recursive:true});
await fs.cp(path.join(prior,'project'),project,{recursive:true,preserveTimestamps:true,verbatimSymlinks:true,errorOnExist:true,force:false});
await fs.mkdir(path.join(owned,'home'));
const previous=JSON.parse(await fs.readFile(path.join(prior,'ownership.json'))),logical=previous.logical;
const database=`insurance_stagea_${caseName}`;
const require=createRequire(path.join(artifactRoot,'installed/package.json')),{Client}=require('pg');
const admin=new Client({connectionString:fixture.connectionString});await admin.connect();
try {assert.equal((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rowCount,0);await admin.query(`CREATE DATABASE "${database}"`);}finally{await admin.end();}
const uri=role=>`postgresql:///${database}?host=${encodeURIComponent(fixture.socket)}&user=${role}`;
const client=new Client({connectionString:uri('postgres')});await client.connect();
const psql=sql=>execFileSync('docker',['exec','-i',fixture.name,'psql','-X','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-v',`reader_password=${randomBytes(24).toString('hex')}`],{input:sql,stdio:'pipe'});
const hashes={};
for(const name of ['original-policy.txt','original-schema.sql','fixture-rows.mjs']) {const b=await fs.readFile(path.join(prior,name));hashes[name]=createHash('sha256').update(b).digest('hex');assert.equal(hashes[name],(previous.artifacts??previous.hashes)[name]);await fs.writeFile(path.join(owned,name),b,{flag:'wx'});}
let schema=await fs.readFile(path.join(owned,'original-schema.sql'),'utf8');
const roleAlreadyCreated=(await client.query("SELECT 1 FROM pg_roles WHERE rolname='insurance_reader'")).rowCount>0;
if(roleAlreadyCreated)schema=schema.replace(/^CREATE ROLE insurance_reader.*\n/m,'');
psql(schema);
const baseline=JSON.parse(await fs.readFile(path.join(prior,'replay-complete-source-readback.json')));
const insert=async(table,row)=>{const fields=Object.keys(row);await client.query(`INSERT INTO reserve_ops.${table} (${fields.join(',')}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));};
const additions={portfolios:[],claims:[]};
try {
 await client.query('BEGIN');for(const table of ['portfolios','claims','freezes'])for(const row of baseline[table])await insert(table,row);
 if(caseName==='overall') {
  // The original two insurers can consume at most six slots. Extend only this
  // owned fixture with a third insurer and distinct claims; never seed approvals.
  const id=n=>`b0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const portfolio={...baseline.portfolios.find(x=>x.portfolio_ref==='PF-OTHER-INSURER'),portfolio_id:id(1000),insurer_id:id(5),portfolio_ref:'PF-OVERALL-THIRD',version:1};
  additions.portfolios.push(portfolio);await insert('portfolios',portfolio);
  const template=baseline.claims.find(x=>x.claim_ref==='CL-701');
  for(const n of [1001,1002,1003])additions.claims.push({...template,claim_id:id(n),claim_ref:`CL-${n}`,portfolio_id:id(1000),insurer_id:id(5),version:1});
  for(const row of additions.claims)await insert('claims',row);
 }
 await client.query('COMMIT');
 const handoff=path.join(project,'.synapsor/writer-handoffs/review-iD2JAN');
 const requirements=JSON.parse(await fs.readFile(path.join(handoff,'requirements.json')));
 assert.equal(requirements.writer_env,'SYNAPSOR_WRITE_RESERVE_OPS_ADJUST_CLAIM_RESERVE_6DDD2DB6');
 const writerExists=(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[requirements.suggested_role])).rowCount>0;
 const grants={};for(const name of ['grants.sql','scoped-policies.sql']){const b=await fs.readFile(path.join(handoff,name));grants[name]=createHash('sha256').update(b).digest('hex');psql(writerExists&&name==='grants.sql'?b.toString().replace(/^CREATE ROLE .*\n/m,''):b);}
 await client.query(`ALTER ROLE "${requirements.suggested_role}" LOGIN`);
 const source={};for(const table of ['portfolios','claims','freezes'])source[table]=(await client.query(`SELECT * FROM reserve_ops.${table} ORDER BY 1`)).rows;
 for(const table of Object.keys(baseline))for(const old of baseline[table])assert.deepEqual(source[table].find(x=>x[Object.keys(old)[0]]===old[Object.keys(old)[0]]),old);
 await fs.writeFile(path.join(owned,'owner-source-baseline.json'),JSON.stringify(source,null,2)+'\n',{flag:'wx'});
 const owner={created_at:new Date().toISOString(),case:caseName,owned,project,logical,database,container:fixture.name,artifact_root:artifactRoot,artifact_tree:artifact.installed_tree_sha256,
  original_hashes:hashes,original_rows_preserved:40,additions,writer_handoff:grants,role_creation_omitted_because_task_fixture_role_already_exists:roleAlreadyCreated};
 await fs.writeFile(path.join(owned,'ownership.json'),JSON.stringify(owner,null,2)+'\n',{flag:'wx'});
 await fs.writeFile(path.join(owned,'private.json'),JSON.stringify({database,container:fixture.name,socket:fixture.socket,adminUrl:uri('postgres'),env:{DATABASE_URL:uri('insurance_reader'),[requirements.writer_env]:uri(requirements.suggested_role)}},null,2)+'\n',{flag:'wx',mode:0o600});
 await fs.writeFile(path.join(owned,'mount-plan.json'),JSON.stringify({mounts:[{logical:owned,physical:owned},{logical,physical:project}],owned_database_envs:['DATABASE_URL',requirements.writer_env]},null,2)+'\n');
 console.log(JSON.stringify({prepared:caseName,database,rows:Object.fromEntries(Object.entries(source).map(([t,r])=>[t,r.length])),original_rows_preserved:40,artifact_tree:owner.artifact_tree}));
}finally{await client.end();}
