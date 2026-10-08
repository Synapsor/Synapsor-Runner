/** One finite owned PostgreSQL process, serial fresh connector children.
 * Actual adapter/fault witness only; no public activation or actor is seeded. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {ProposalStore} from '@synapsor-runner/proposal-store';
import {canonicalJsonDigest,parseWritebackJob} from '@synapsor-runner/protocol';
import {buildDerivedChangeSet} from '../../../packages/mcp-server/src/proposal-builder.ts';
import {resolveAuthorizedOperatorIdentity,verifySignedOperatorProof,operatorPublicKeyFingerprint} from '../../../apps/runner/src/operator-identity.ts';
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
const allCases=[['luna_atomic','source_db'],['anchored_insert','source_db'],['ordinary_update','source_db'],['luna_atomic','runner_ledger']];
const variant=process.argv[4]??'standard';
const cases=process.argv[3]==='remaining'?allCases.slice(1):process.argv[3]&&process.argv[3]!=='all'?allCases.filter(([family,mode])=>family+':'+mode===process.argv[3]):allCases;
assert(cases.length>0,'Known bounded case required');
const summary={schema:'synapsor.dev.shared-commit-impact.v1',pid:process.pid,custody,container,socketParent,socket,started_at:new Date().toISOString(),
 variant,scope:'actual shared applyPostgresJob/createPostgresPool connector, fresh synthetic compiled test authorities; not public CLI/activation/authentication',
 historical_fixture_replay:false,provider_calls:0,sql_changed:false,results:[],stopped:false,preserved:true,volumes_removed:false};
const write=(name,value)=>fs.writeFile(path.join(capture,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});
const save=()=>write('GROUP.json',summary);
await fs.mkdir(capture,{mode:0o700,recursive:true});await fs.mkdir(socketParent,{mode:0o700});await fs.mkdir(socket,{mode:0o777});await fs.chmod(socket,0o777);
const command=async(args,name)=>{const r=await execute('docker',args,{maxBuffer:16*1024*1024});if(name)await write(name,r.stdout+r.stderr);return r.stdout;};
const url=(role,db,host=socket)=>`postgresql://${role}@localhost:5432/${db}?host=${encodeURIComponent(host)}`;
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
  const legacyReceiptSql=variant==='legacy_absent'?`CREATE SCHEMA impact_receipts;CREATE TABLE impact_receipts.synapsor_writeback_receipts(idempotency_key text PRIMARY KEY,job_id text UNIQUE NOT NULL,proposal_id text NOT NULL,status text NOT NULL,result_hash text,semantic_verification_json jsonb,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz);`:'';
  const rollbackFaultSql=variant==='rollback'?`CREATE FUNCTION telecom.b61_declared_companion_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Declared owned companion rollback fault' USING ERRCODE='23514';END$$;CREATE TRIGGER zz_b61_companion_rollback BEFORE UPDATE ON telecom.plan_change_offers FOR EACH ROW EXECUTE FUNCTION telecom.b61_declared_companion_failure();`:'';
  const sourceSql=schemaSql(family,facts)+legacyReceiptSql+rollbackFaultSql,grants=generatedMinimumGrants(role,relations,mode,variant==='legacy_unwritable'?['status','result_hash','semantic_verification_json','completed_at']:[]),policies=policySql(role,family,facts,relations);
  for(const [name,value] of [['fixture.sql',sourceSql],['generated-grants.sql',grants],['scoped-auth-policies.sql',policies]])await fs.writeFile(path.join(caseRoot,name),value,{mode:0o600});
  await admin(db,sourceSql);await admin(db,grants.replace(/^\\set.*$/gm,''));await admin(db,policies);
  const posture=(await admin(db,`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname='${role}'`)).rows;
  assert.equal(posture.length,1);assert.equal(posture[0].rolsuper,false);assert.equal(posture[0].rolbypassrls,false);assert.equal(posture[0].rolinherit,false);
  await fs.writeFile(path.join(caseRoot,'actual-writer-posture.json'),JSON.stringify(posture,null,2)+'\n',{mode:0o600});
  const before=await observe(db,caseRoot,'before'),now=new Date().toISOString(),proposalId='wrp_new_impact_'+randomUUID().replaceAll('-','');
  let job,decision;const pool=createPostgresPool(url(role,db));const client=await pool.connect();
  try{if(family==='ordinary_update')job=ordinaryJob(proposalId);else({job,decision}=await semanticJob(family==='luna_atomic'?freshLunaFixture(now):anchoredFixture(now),client,proposalId));}finally{client.release();await pool.end();}
  const storePath=path.join(caseRoot,'original-control.sqlite'),ledger=new ProposalStore(storePath);
  let change;
  if(decision)change=buildDerivedChangeSet({decision,context:{tenant_id:facts.tenant,principal:facts.principal,provenance:'static_dev'},
    proposalId,createdAt:now,evidenceBundleId:'ev_'+proposalId,queryFingerprint:canonicalJsonDigest({proposalId})});
  else {
    const beforeRow=before['ordinary_native.credits'].find(row=>row.id==='credit_impact');
    change={schema_version:'synapsor.change-set.v2',proposal_id:proposalId,proposal_version:1,action:'impact.ordinary_update',operation:'single_row_update',mode:'review_required',
      principal:{id:facts.principal,source:'static_dev'},scope:{tenant_id:facts.tenant,business_object:'credits',object_id:'credit_impact'},
      source:{kind:'external_postgres',source_id:job.source_id,schema:job.target.schema,table:job.target.table,primary_key:job.target.primary_key},
      before:beforeRow,patch:job.patch,after:{...beforeRow,...job.patch,version:8},guards:{tenant:job.target.tenant_guard,principal_scope:job.target.principal_scope,allowed_columns:job.allowed_columns,expected_version:{column:'version',value:7},version_advance:job.version_advance},
      evidence:{bundle_id:'ev_'+proposalId,query_fingerprint:canonicalJsonDigest({proposalId}),items:[]},approval:{status:'pending',required_role:'fixture_reviewer'},
      writeback:{status:'not_applied',mode:'trusted_worker_required',executor:'sql_update'},source_database_mutated:false,integrity:{proposal_hash:canonicalJsonDigest({proposalId,before:beforeRow,patch:job.patch})},created_at:now};
  }
  const proposal=ledger.createProposal(change),operatorConfigPath=path.join(caseRoot,'declared-operator-config.json');
  const operatorConfig={provider:'signed_key',apply_roles:['source_reconciler'],operators:{}};
  for(const [actor,roles]of [['fixture_reviewer',[change.approval.required_role]],['fixture_reconciler',['source_reconciler']]]){
    const pair=generateKeyPairSync('ed25519'),publicKey=pair.publicKey.export({type:'spki',format:'pem'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'});
    await fs.writeFile(path.join(caseRoot,actor+'.pub'),publicKey,{mode:0o600});await fs.writeFile(path.join(caseRoot,actor+'.key'),privateKey,{mode:0o600});
    operatorConfig.operators[actor]={public_key_path:actor+'.pub',public_key_fingerprint:operatorPublicKeyFingerprint(publicKey),roles};
  }
  await fs.writeFile(operatorConfigPath,JSON.stringify(operatorConfig,null,2)+'\n',{mode:0o600});
  const approval=await resolveAuthorizedOperatorIdentity({config:operatorConfig,configPath:operatorConfigPath,proposal,action:'approve',actor:'fixture_reviewer',identity:'fixture_reviewer',
    privateKeyPath:path.join(caseRoot,'fixture_reviewer.key'),requiredRole:change.approval.required_role,env:{}});
  assert(verifySignedOperatorProof(approval,await fs.readFile(path.join(caseRoot,'fixture_reviewer.pub'),'utf8')));
  ledger.approveProposal(proposalId,{approver:approval.subject,proposal_hash:proposal.proposal_hash,proposal_version:proposal.proposal_version,identity:approval,require_verified_identity:true});
  const contractDigest=canonicalJsonDigest({fixture:proposalId});ledger.enqueueWorkerProposal({proposal_id:proposalId,execution_mode:'supervised_worker',contract_digest:contractDigest});
  const workerLease=ledger.claimWorkerItem({workerId:'fresh_recovery_runner',executionMode:'supervised_worker',capability:proposal.action,contractDigest});assert(workerLease?.lease_id);
  job=parseWritebackJob(ledger.createWritebackJobFromProposal(proposalId));ledger.close();
  await fs.writeFile(path.join(caseRoot,'fresh-job.json'),JSON.stringify(job,null,2)+'\n',{mode:0o600});
  const targets=family==='luna_atomic'?[{operation:'UPDATE',schema:'telecom',table:'subscriptions'},{operation:'UPDATE',schema:'telecom',table:'plan_change_offers'}]:family==='ordinary_update'?[{operation:'UPDATE',schema:'ordinary_native',table:'credits'}]:[{operation:'INSERT',schema:'enquiry_native',table:'enquiries'}];
  let activeChild;
  const proxy=await createCommitAckProxy({backendSocket:socket,capture:caseRoot,targets,expectedEffects:targets.length,beforeWithhold:variant==='crash_adoption'?()=>{assert(activeChild?.pid);process.kill(activeChild.pid,'SIGSTOP');process.kill(activeChild.pid,'SIGKILL');}:undefined});
  const resultPath=path.join(caseRoot,'native-result.json'),inputPath=path.join(caseRoot,'child-input.json');
  const config={controlPlaneUrl:'http://127.0.0.1:1',runnerToken:'owned_test_no_external_call',runnerId:'fresh_impact_runner',sourceId:job.source_id,engine:'postgres',pollIntervalMs:100,statementTimeoutMs:5000,logLevel:'error',dryRun:false,stateDir:caseRoot,
   databaseScope:{mode:'postgres_rls',tenantSetting:'impact.tenant',principalSetting:'impact.principal',tenantId:facts.tenant,principal:facts.principal},receipts:{authority:mode,provisioning:'precreated',...(mode==='source_db'?{schema:'impact_receipts',table:'synapsor_writeback_receipts'}:{})}};
  await fs.writeFile(inputPath,JSON.stringify({family,now,job,config,sourceUrl:url(role,db,proxy.socketDirectory),ledgerUrl:url('impact_admin',controlDb),resultPath,lunaRecipe:family==='luna_atomic'?path.join(directory,'luna-impact-recipe.mts'):undefined,declaredFacts:facts},null,2)+'\n',{mode:0o600});
  const childInput={family,now,job,config,sourceUrl:url(role,db,proxy.socketDirectory),storePath,workerLeaseId:workerLease.lease_id,operatorConfig,operatorConfigPath,reconcilePrivateKey:path.join(caseRoot,'fixture_reconciler.key'),reconcilePublicKey:path.join(caseRoot,'fixture_reconciler.pub'),declaredFacts:facts,resultPath};
  childInput.config.sourceCompletionAdmission={execution_binding_digest:canonicalJsonDigest({declared:proposalId,source:db,mode}),writer_reference:'OWNED_RECOVERY_WRITE_URL'};
  await fs.writeFile(inputPath,JSON.stringify(childInput,null,2)+'\n',{mode:0o600});
  if(!['cleanup','legacy_unwritable','rollback'].includes(variant))proxy.arm();const startedAt=new Date().toISOString();const child=spawn(process.execPath,['--import',path.join(W,'node_modules/tsx/dist/loader.mjs'),path.join(directory,'recovery-child.mjs'),inputPath,variant==='cleanup'?'apply_cleanup':'apply'],{cwd:W,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,TSX_DISABLE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
  activeChild=child;
  await fs.writeFile(path.join(caseRoot,'CHILD-START.json'),JSON.stringify({pid:child.pid,startedAt,command:'node --import node_modules/tsx/dist/loader.mjs docs/development/b61-shared-commit-recovery/impact-child.mjs OWNED_INPUT',original_job_replay:false},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({state:'NATIVE_STARTED',family,mode,pid:child.pid,caseRoot}));
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const watchdog=setTimeout(()=>child.kill('SIGTERM'),45000);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(watchdog));
  await fs.writeFile(path.join(caseRoot,'native.stdout'),stdout,{mode:0o600});await fs.writeFile(path.join(caseRoot,'native.stderr'),stderr,{mode:0o600});
  const observed=proxy.observed();const after=await observe(db,caseRoot,'after');
  let nativeResult=null;try{nativeResult=JSON.parse(await fs.readFile(resultPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const cold=[];
  for(const action of ['inspect','ambient',...(variant==='crash_adoption'?['refuse_leased','quarantine']:[]),...(mode==='source_db'&&!['cleanup','legacy_absent','legacy_unwritable','rollback'].includes(variant)?['negative',...(variant==='crash_adoption'?['reconcile_crash']:variant==='process_concurrency'?['snapshot_local','reconcile_before_commit_crash','assert_local_rollback','two_os_reconcile']:['concurrent']),'reconcile']:[]),'lifecycle']){
    const coldInput={...childInput,beforeLocalPath:path.join(caseRoot,'cold-snapshot_local.json'),resultPath:path.join(caseRoot,'cold-'+action+'.json')},coldPath=path.join(caseRoot,'cold-'+action+'-input.json');
    await fs.writeFile(coldPath,JSON.stringify(coldInput,null,2)+'\n',{mode:0o600});
    const command=[process.execPath,'--import',path.join(W,'node_modules/tsx/dist/loader.mjs'),path.join(directory,'recovery-child.mjs'),coldPath,action];
    if(action==='two_os_reconcile'){
     const racers=await Promise.all([1,2].map(async n=>{
       const raceInput={...childInput,resultPath:path.join(caseRoot,'os-reconciler-'+n+'.json')},racePath=path.join(caseRoot,'os-reconciler-'+n+'-input.json');
       await fs.writeFile(racePath,JSON.stringify(raceInput,null,2)+'\n',{mode:0o600});
       const child=spawn(process.execPath,['--import',path.join(W,'node_modules/tsx/dist/loader.mjs'),path.join(directory,'recovery-child.mjs'),racePath,'reconcile'],{cwd:W,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,TSX_DISABLE_CACHE:'1'},stdio:['ignore','pipe','pipe']});
       let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const watch=setTimeout(()=>child.kill('SIGTERM'),45000);
       const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));}).finally(()=>clearTimeout(watch));
       await fs.writeFile(path.join(caseRoot,'os-reconciler-'+n+'.stderr'),stderr,{mode:0o600});assert.equal(exit.code,0);return JSON.parse(await fs.readFile(raceInput.resultPath,'utf8'));
     }));assert.notEqual(racers[0].pid,racers[1].pid);cold.push({action,scope:'two distinct concurrent fresh OS processes/native SQLite control CAS and Source connections',racers});continue;
    }
    let output;try{output=await execute(command[0],command.slice(1),{cwd:W,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,TSX_DISABLE_CACHE:'1'},maxBuffer:16*1024*1024,timeout:45000});}
    catch(e){if(!['reconcile_crash','reconcile_before_commit_crash'].includes(action)||e.signal!=='SIGKILL')throw e;output={stderr:e.stderr};cold.push({action,...(action==='reconcile_crash'?{local_completion_committed_before_result_ack:true}:{local_transaction_interrupted_before_commit:true,marker:JSON.parse(await fs.readFile(coldInput.resultPath,'utf8'))}),signal:e.signal});continue;}
    await fs.writeFile(path.join(caseRoot,'cold-'+action+'.stderr'),output.stderr,{mode:0o600});cold.push(JSON.parse(await fs.readFile(coldInput.resultPath,'utf8')));
  }
  const afterRecovery=await observe(db,caseRoot,'after-recovery');assert.deepEqual(afterRecovery,after,'Native recovery must make zero additional Source effect/receipt mutation');await proxy.close();
  const view=new ProposalStore(storePath);const intents=view.listWritebackIntents();const events=view.events(proposalId);const metrics=view.operationalMetrics();view.close();
  if(['cleanup','legacy_unwritable'].includes(variant)){assert.equal(observed.dropped,false);assert.equal(nativeResult?.result?.native?.status,'applied');}
  else if(variant==='rollback'){assert.equal(observed.dropped,false);assert.equal(nativeResult?.result?.native?.status,'failed');assert.deepEqual(after,before,'Companion exception must roll back every primary/companion/receipt effect');}
  else if(variant==='crash_adoption'){assert(observed.dropped);assert.equal(exit.signal,'SIGKILL');assert.equal(nativeResult,null);assert.equal(cold.find(x=>x.action==='refuse_leased').result.before.intent.status,'applying');assert.equal(cold.find(x=>x.action==='refuse_leased').result.before.intent.source_outcome_unknown,true);assert.equal(cold.find(x=>x.action==='refuse_leased').result.before.queue.status,'leased');}
  else {assert(observed.dropped);assert.equal(nativeResult?.result?.native?.status,'reconciliation_required');}
  assert(cold.find(x=>x.action==='ambient').result.completion.status==='unknown');
  const lifecycle=cold.find(x=>x.action==='lifecycle').result.lifecycle;
  if(mode==='source_db'&&!['cleanup','legacy_absent','legacy_unwritable','rollback'].includes(variant)){assert.equal(lifecycle.lifecycle.execution,'applied');assert.equal(events.filter(e=>e.kind==='writeback_reconciled').length,1);assert.equal(intents[0].status,'applied');}
  else if(['cleanup','legacy_unwritable'].includes(variant)){assert.equal(lifecycle.lifecycle.execution,'applied');assert.equal(intents[0].status,'applied');}
  else if(variant==='rollback'){assert.equal(lifecycle.lifecycle.execution,'failed');assert.equal(intents[0].status,'failed');}
  else{assert.equal(lifecycle.lifecycle.execution,'unknown');assert.equal(intents[0].status,'reconciliation_required');}
  const result={family,mode,db,role,pid:child.pid,exit,backend_commit_ack_dropped:observed.dropped,nativeResult,cold,
    source_unchanged_by_recovery:true,original_unknown_receipt_preserved_in_event:mode==='source_db'?events.find(e=>e.kind==='writeback_reconciled')?.payload.original_receipt:null,
    actual_source_changed:JSON.stringify(before)!==JSON.stringify(after),source_receipt_rows:after['impact_receipts.synapsor_writeback_receipts']??[],intent_statuses:intents.map(i=>i.status),metrics,ended_at:new Date().toISOString()};
  summary.results.push(result);await save();console.log(JSON.stringify({state:'NATIVE_CLOSED',family,mode,exit,backend_commit_ack_dropped:observed.dropped,actual_source_changed:result.actual_source_changed,intent_statuses:result.intent_statuses}));
  if(!['cleanup','legacy_unwritable','rollback'].includes(variant))assert(observed.dropped,'Fault target must reach actual backend COMMIT before impact credit');
 }
}catch(error){summary.failure={name:error.name,message:error.message,stack:error.stack};await save();throw error;}
finally{
 if(started){const actual=JSON.parse(await command(['inspect',container]));assert.equal(actual[0]?.Config?.Labels?.['synapsor.dev.custody'],custody);await command(['logs',container],'container-final.log');await command(['exec',container,'pg_dumpall','-U','impact_admin','--roles-only','--no-role-passwords'],'all-actual-roles.sql');await command(['stop','--time','10',container],'container-stop.txt');summary.stopped=true;}
 summary.ended_at=new Date().toISOString();await save();
}
