/** One finite owned PostgreSQL process, serial fresh connector children.
 * Actual adapter/fault witness only; no public activation or actor is seeded. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {createPostgresPool} from '../../../packages/postgres/src/index.ts';
import {anchoredFixture,ordinaryJob,semanticJob,generatedMinimumGrants,trusted} from './impact-jobs.mts';
import {freshLunaFixture,lunaFacts} from './luna-impact-recipe.mts';
import {schemaSql,policySql} from './impact-schema.mjs';
import {createCommitAckProxy} from './commit-ack-proxy.mjs';
const execute=promisify(execFile),directory=path.dirname(fileURLToPath(import.meta.url));
const W=path.resolve(directory,'../../..'),capture=process.argv[2];
assert(process.env.SYNAPSOR_B61_RECOVERY_LEASE==='1','Explicit Main finite live-PG lease required');
assert(capture?.startsWith('/var/tmp/synapsor-b61-recovery-owned-')&&!capture.includes('..'));
const image='sha256:1edc8e87e53194e0cc8006c4e9df9b626c6c72cb43ad3385f0f34af7922065b1';
const custody=randomUUID().slice(0,8),container='synapsor-b61-recovery-'+custody;
const socketParent='/var/tmp/sb61r-'+custody,socket=socketParent+'/socket';
const allCases=[['luna_atomic','runner_ledger'],['anchored_insert','source_db'],['ordinary_update','source_db'],['anchored_insert','runner_ledger'],['ordinary_update','runner_ledger'],['luna_atomic','source_db']];
const cases=process.argv[3]==='remaining'?allCases.slice(1):process.argv[3]?allCases.filter(([family,mode])=>family+':'+mode===process.argv[3]):allCases;
assert(cases.length>0,'Known bounded case required');
const summary={schema:'synapsor.dev.shared-commit-impact.v1',pid:process.pid,custody,container,socketParent,socket,started_at:new Date().toISOString(),
 scope:'actual shared applyPostgresJob/createPostgresPool connector, fresh synthetic compiled test authorities; not public CLI/activation/authentication',
 historical_fixture_replay:false,provider_calls:0,sql_changed:false,results:[],stopped:false,preserved:true,volumes_removed:false};
const write=(name,value)=>fs.writeFile(path.join(capture,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});
const save=()=>write('GROUP.json',summary);
await fs.mkdir(capture,{mode:0o700,recursive:true});await fs.mkdir(socketParent,{mode:0o700});await fs.mkdir(socket,{mode:0o777});await fs.chmod(socket,0o777);
const command=async(args,name)=>{const r=await execute('docker',args,{maxBuffer:16*1024*1024});if(name)await write(name,r.stdout+r.stderr);return r.stdout;};
const url=(role,db,host=socket)=>`postgresql://${role}@localhost/${db}?host=${encodeURIComponent(host)}`;
let started=false;
async function admin(db,sql){const pool=createPostgresPool(url('impact_admin',db));try{return await pool.query(sql);}finally{await pool.end();}}
const relationsFor=family=>family==='anchored_insert'?[{schema:'enquiry_native',table:'customers',privileges:['select','update'],update_columns:[],lock_column:'customer_id'},{schema:'enquiry_native',table:'enquiries',privileges:['select','insert','update'],update_columns:[],lock_column:'enquiry_id'}]:family==='ordinary_update'?[{schema:'ordinary_native',table:'credits',privileges:['select','update'],update_columns:['amount_cents','version'],lock_column:'id'}]:[{schema:'telecom',table:'subscriptions',privileges:['select','update'],update_columns:['base_monthly_cents','data_policy','effective_from','included_lines','international_day_pass','plan_code','plan_display_name','version'],lock_column:'subscription_id'},{schema:'telecom',table:'plan_change_offers',privileges:['select','update'],update_columns:['plan_offer_id','status','version'],lock_column:'plan_offer_id'}];
async function observe(db,caseRoot,prefix) {
 const relationRows=(await admin(db,"SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname")).rows;
 const rows={};for(const r of relationRows){const q=`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${r.schema}"."${r.name}" t`;rows[r.schema+'.'+r.name]=(await admin(db,q)).rows[0].rows;}
 await fs.writeFile(path.join(caseRoot,prefix+'-actual-source.json'),JSON.stringify(rows,null,2)+'\n',{mode:0o600});
 const dump=await command(['exec',container,'pg_dump','-U','impact_admin','-d',db,'--data-only']);await fs.writeFile(path.join(caseRoot,prefix+'-all-source-data.sql'),dump,{mode:0o600});return rows;
}
try {
 await save();await command(['image','inspect',image],'cached-image.json');
 await command(['run','--detach','--name',container,'--label','synapsor.dev.lane=b61-recovery','--label','synapsor.dev.custody='+custody,'--network','none','--memory','256m','--cpus','1','--pids-limit','100','--mount',`type=bind,src=${socket},dst=/var/run/postgresql`,'-e','POSTGRES_USER=impact_admin','-e','POSTGRES_DB=impact_bootstrap','-e','POSTGRES_HOST_AUTH_METHOD=trust',image,'-c','listen_addresses=','-c','shared_buffers=32MB','-c','max_connections=20'],'container-create.txt');started=true;
 let ready=false;for(let n=0;n<80;n++){try{const pid1=(await command(['exec',container,'cat','/proc/1/comm'])).trim();const selected=(await command(['exec',container,'psql','-U','impact_admin','-d','impact_bootstrap','-Atc','SELECT current_database(),1'])).trim();if(pid1==='postgres'&&selected==='impact_bootstrap|1'){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
 assert(ready,'Final PID1 postgres + exact owned SELECT1 readiness required');summary.ready_at=new Date().toISOString();await save();
 for(const [family,mode] of cases){
  const caseId=family+'-'+mode,caseRoot=path.join(capture,caseId);await fs.mkdir(caseRoot,{mode:0o700});
  const db='impact_'+randomUUID().replaceAll('-','').slice(0,12),controlDb='control_'+randomUUID().replaceAll('-','').slice(0,12),role='runner_writer_'+createHash('sha256').update(db).digest('hex').slice(0,12);
  const facts=family==='luna_atomic'?lunaFacts:trusted,relations=relationsFor(family);
  const declared={family,mode,db,controlDb:mode==='runner_ledger'?controlDb:null,role,facts,relations,
   luna_recipe_scope:family==='luna_atomic'?'actual seven-field subscriptions + offer.status, composite FK, offer→subscription locks, repeatable_read/UTC, both reviewed BEFORE UPDATE version triggers; newly scoped direct principal policy; no historic memberships/activation imported':null};
  await fs.writeFile(path.join(caseRoot,'DECLARED.json'),JSON.stringify(declared,null,2)+'\n',{mode:0o600});
  await admin('impact_bootstrap',`CREATE DATABASE "${db}"`);if(mode==='runner_ledger')await admin('impact_bootstrap',`CREATE DATABASE "${controlDb}"`);
  const sourceSql=schemaSql(family,facts),grants=generatedMinimumGrants(role,relations,mode),policies=policySql(role,family,facts,relations);
  for(const [name,value] of [['fixture.sql',sourceSql],['generated-grants.sql',grants],['scoped-auth-policies.sql',policies]])await fs.writeFile(path.join(caseRoot,name),value,{mode:0o600});
  await admin(db,sourceSql);await admin(db,grants.replace(/^\\set.*$/gm,''));await admin(db,policies);
  const posture=(await admin(db,`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='${role}'`)).rows;
  assert.equal(posture.length,1);assert.equal(posture[0].rolsuper,false);assert.equal(posture[0].rolbypassrls,false);assert.equal(posture[0].rolinherit,false);
  await fs.writeFile(path.join(caseRoot,'actual-writer-posture.json'),JSON.stringify(posture,null,2)+'\n',{mode:0o600});
  const before=await observe(db,caseRoot,'before'),now=new Date().toISOString(),proposalId='wrp_new_impact_'+randomUUID().replaceAll('-','');
  let job,decision;const pool=createPostgresPool(url(role,db));const client=await pool.connect();
  try{if(family==='ordinary_update')job=ordinaryJob(proposalId);else({job,decision}=await semanticJob(family==='luna_atomic'?freshLunaFixture(now):anchoredFixture(now),client,proposalId));}finally{client.release();await pool.end();}
  await fs.writeFile(path.join(caseRoot,'fresh-job.json'),JSON.stringify(job,null,2)+'\n',{mode:0o600});
  if(decision)await fs.writeFile(path.join(caseRoot,'actual-eligibility-decision.json'),JSON.stringify(decision,null,2)+'\n',{mode:0o600});
  const targets=family==='luna_atomic'?[{operation:'UPDATE',schema:'telecom',table:'subscriptions'},{operation:'UPDATE',schema:'telecom',table:'plan_change_offers'}]:family==='ordinary_update'?[{operation:'UPDATE',schema:'ordinary_native',table:'credits'}]:[{operation:'INSERT',schema:'enquiry_native',table:'enquiries'}];
  const proxy=await createCommitAckProxy({backendSocket:socket,capture:caseRoot,targets,expectedEffects:targets.length});
  const resultPath=path.join(caseRoot,'native-result.json'),inputPath=path.join(caseRoot,'child-input.json');
  const config={controlPlaneUrl:'http://127.0.0.1:1',runnerToken:'owned_test_no_external_call',runnerId:'fresh_impact_runner',sourceId:job.source_id,engine:'postgres',pollIntervalMs:100,statementTimeoutMs:5000,logLevel:'error',dryRun:false,stateDir:caseRoot,
   databaseScope:{mode:'postgres_rls',tenantSetting:'impact.tenant',principalSetting:'impact.principal',tenantId:facts.tenant,principal:facts.principal},receipts:{authority:mode,provisioning:'precreated',...(mode==='source_db'?{schema:'impact_receipts',table:'synapsor_writeback_receipts'}:{})}};
  await fs.writeFile(inputPath,JSON.stringify({family,now,job,config,sourceUrl:url(role,db,proxy.socketDirectory),ledgerUrl:url('impact_admin',controlDb),resultPath,lunaRecipe:family==='luna_atomic'?path.join(directory,'luna-impact-recipe.mts'):undefined,declaredFacts:facts},null,2)+'\n',{mode:0o600});
  proxy.arm();const startedAt=new Date().toISOString();const child=spawn(process.execPath,['--import',path.join(W,'node_modules/tsx/dist/loader.mjs'),path.join(directory,'impact-child.mjs'),inputPath],{cwd:W,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,TSX_DISABLE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  await fs.writeFile(path.join(caseRoot,'CHILD-START.json'),JSON.stringify({pid:child.pid,startedAt,command:'node --import node_modules/tsx/dist/loader.mjs docs/development/b61-shared-commit-recovery/impact-child.mjs OWNED_INPUT',original_job_replay:false},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({state:'NATIVE_STARTED',family,mode,pid:child.pid,caseRoot}));
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const watchdog=setTimeout(()=>child.kill('SIGTERM'),45000);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(watchdog));
  await fs.writeFile(path.join(caseRoot,'native.stdout'),stdout,{mode:0o600});await fs.writeFile(path.join(caseRoot,'native.stderr'),stderr,{mode:0o600});
  const observed=proxy.observed();await proxy.close();const after=await observe(db,caseRoot,'after');
  let nativeResult=null;try{nativeResult=JSON.parse(await fs.readFile(resultPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const intents=mode==='runner_ledger'?(await admin(controlDb,'SELECT payload_json FROM impact_ledger.ledger_entries ORDER BY entry_key')).rows:[];
  await fs.writeFile(path.join(caseRoot,'actual-intent-bookkeeping.json'),JSON.stringify(intents,null,2)+'\n',{mode:0o600});
  const result={family,mode,db,role,pid:child.pid,exit,backend_commit_ack_dropped:observed.dropped,nativeResult,
   actual_source_changed:JSON.stringify(before)!==JSON.stringify(after),source_receipt_rows:after['impact_receipts.synapsor_writeback_receipts']??[],intent_statuses:intents.map(r=>r.payload_json.status),ended_at:new Date().toISOString()};
  summary.results.push(result);await save();console.log(JSON.stringify({state:'NATIVE_CLOSED',family,mode,exit,backend_commit_ack_dropped:observed.dropped,actual_source_changed:result.actual_source_changed,intent_statuses:result.intent_statuses}));
  assert(observed.dropped,'Fault target must reach actual backend COMMIT before impact credit');
 }
}catch(error){summary.failure={name:error.name,message:error.message,stack:error.stack};await save();throw error;}
finally{
 if(started){const actual=JSON.parse(await command(['inspect',container]));assert.equal(actual[0]?.Config?.Labels?.['synapsor.dev.custody'],custody);await command(['logs',container],'container-final.log');await command(['exec',container,'pg_dumpall','-U','impact_admin','--roles-only','--no-role-passwords'],'all-actual-roles.sql');await command(['stop','--time','10',container],'container-stop.txt');summary.stopped=true;}
 summary.ended_at=new Date().toISOString();await save();
}
