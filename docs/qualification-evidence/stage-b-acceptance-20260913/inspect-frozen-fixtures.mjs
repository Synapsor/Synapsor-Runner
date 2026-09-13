// Source-owner fixture preparation only. Never invokes Runner or a model.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root;
const H=path.join(O,'fixture-validation'),metadata=JSON.parse(await fs.readFile(path.join(H,'postgres-fixture.json')));
const inspect=JSON.parse(execFileSync('docker',['inspect',metadata.name],{encoding:'utf8'}))[0];assert.equal(inspect.Id,metadata.id);assert.equal(inspect.Config.Labels['synapsor.qualification'],'stage-b-fixture-preparation-20260913');assert.equal(inspect.HostConfig.NetworkMode,'none');assert(inspect.State.Running);
const {Client}=createRequire(path.join(plan.prior_owned_root,'frozen/installed/package.json'))('pg');
const selection=JSON.parse(await fs.readFile(path.join(E,'case-selection.json'))),results=[];
const uri=(database,role)=>`postgresql:///${database}?host=${encodeURIComponent(metadata.socket)}&user=${role}`;
for(const item of selection.cases){
 const root=item.root,manifest=JSON.parse(await fs.readFile(path.join(root,'frozen-input-manifest.json'))),c=JSON.parse(await fs.readFile(path.join(root,'case.json')));
 for(const rec of manifest.records)assert.equal(createHash('sha256').update(await fs.readFile(path.join(root,rec.path))).digest('hex'),rec.sha256);
 assert.deepEqual(await fs.readdir(path.join(root,'project')),[],'No Runner authority before external acceptance');
 const database='stageb_'+c.id.replaceAll('-','_'),admin=new Client({connectionString:metadata.connectionString});await admin.connect();
 try{assert.equal((await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[database])).rowCount,0);await admin.query(`CREATE DATABASE "${database}"`);}finally{await admin.end();}
 const source=new Client({connectionString:uri(database,'postgres')});await source.connect();let result={case:c.id,database,classification:'source-owner synthetic fixture inspection, not installed/model qualification',status:'running',candidate_tree:plan.candidate_tree};
 try{
  assert.equal((await source.query('SELECT current_database() AS database')).rows[0].database,database);
  await source.query(await fs.readFile(path.join(root,'schema.sql'),'utf8'));
  const facts=JSON.parse(await fs.readFile(path.join(root,'private/source-facts.json')));await source.query('BEGIN');
  for(const table of c.table_order)for(const row of facts[table]){const keys=Object.keys(row);await source.query(`INSERT INTO ${c.schema}.${table} (${keys.map(k=>'"'+k+'"').join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));}
  await source.query('COMMIT');
  const tables=(await source.query('SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind=$2 ORDER BY c.relname',[c.schema,'r'])).rows;
  assert.equal(tables.length,c.table_order.length);assert(tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
  const foreignKeys=(await source.query("SELECT conname, condeferrable, condeferred, convalidated, array_length(conkey,1) AS pairs, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1) AND contype='f' ORDER BY conname",[c.schema])).rows;
  assert(foreignKeys.length>0);assert(foreignKeys.every(k=>!k.condeferrable&&!k.condeferred&&k.convalidated&&k.pairs===3));
  const keys=(await source.query("SELECT conrelid::regclass::text AS resource,array_length(conkey,1) AS columns FROM pg_constraint WHERE connamespace=(SELECT oid FROM pg_namespace WHERE nspname=$1) AND contype='p' ORDER BY resource",[c.schema])).rows;assert(keys.every(k=>k.columns===1));assert.equal(keys.length,c.table_order.length);
  const role=(await source.query('SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles WHERE rolname=$1',[c.reader_role])).rows[0];assert(role&&!role.rolsuper&&!role.rolbypassrls&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolinherit);
  const owners=(await source.query('SELECT tableowner FROM pg_tables WHERE schemaname=$1',[c.schema])).rows;assert(owners.every(x=>x.tableowner!==c.reader_role));
  const snapshot={};for(const t of c.table_order){const rows=(await source.query(`SELECT * FROM ${c.schema}.${t}`)).rows;const pk=Object.keys(facts[t][0])[0];const sorted=a=>a.slice().sort((x,y)=>x[pk].localeCompare(y[pk]));assert.deepEqual(sorted(rows),sorted(facts[t]));snapshot[t]=rows;}
  const read=new Client({connectionString:uri(database,c.reader_role)});await read.connect();const contexts=JSON.parse(await fs.readFile(path.join(root,'private/reviewed-context-inputs.json'))),counts={};
  try{
   for(const t of c.table_order)assert.equal((await read.query(`SELECT * FROM ${c.schema}.${t}`)).rowCount,0,'Absent trusted context cannot see source rows');
   for(const [alias,scope] of Object.entries(contexts)){
    await read.query('BEGIN');await read.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.principal_id',$2,true)",[scope.tenant_id,scope.principal_id]);counts[alias]={};
    for(const t of c.table_order){const rows=(await read.query(`SELECT * FROM ${c.schema}.${t}`)).rows;assert(rows.length>0);assert(rows.every(x=>x.tenant_id===scope.tenant_id&&x.principal_id===scope.principal_id));assert.equal(rows.length,facts[t].filter(x=>x.tenant_id===scope.tenant_id&&x.principal_id===scope.principal_id).length);counts[alias][t]=rows.length;}
    await read.query('ROLLBACK');
   }
  }finally{await read.end();}
  const eligible={};
  for(const [alias,scope] of Object.entries(contexts)){
   if(c.id==='tournament-ratification')eligible[alias]=facts.results.filter(r=>r.tenant_id===scope.tenant_id&&r.principal_id===scope.principal_id&&r.result_state==='finished'&&r.stage==='qualifying'&&r.winner_game_wins===2&&[0,1].includes(r.loser_game_wins)&&!r.integrity_hold&&facts.events.find(e=>e.event_id===r.event_id).operating_state==='open').length;
   else eligible[alias]=facts.build_candidates.filter(r=>{
    const children=facts.build_checks.filter(x=>x.candidate_id===r.candidate_id),seconds=children.reduce((sum,x)=>sum+x.elapsed_seconds,0);
    return r.tenant_id===scope.tenant_id&&r.principal_id===scope.principal_id&&r.candidate_state==='staged'&&!r.security_hold&&facts.release_slots.find(x=>x.slot_id===r.slot_id).slot_state==='ready'&&children.length>=2&&children.length<=12&&children.every(x=>x.check_state==='passed')&&seconds<=120;
   }).length;
   assert(eligible[alias]>=16,'Enough distinct eligible subjects required before the schedule');
  }
  assert.equal(contexts.primary.tenant_id,contexts.colleague.tenant_id);assert.notEqual(contexts.primary.principal_id,contexts.colleague.principal_id);assert.equal(new Set(Object.values(contexts).map(x=>x.tenant_id)).size,3);
  await fs.writeFile(path.join(H,c.id+'-source-readback.json'),JSON.stringify(snapshot,null,2)+'\n',{flag:'wx'});
  await fs.writeFile(path.join(H,c.id+'-private-connection.json'),JSON.stringify({database,adminUrl:uri(database,'postgres'),env:{DATABASE_URL:uri(database,c.reader_role)},socket:metadata.socket,container:metadata.name,container_id:metadata.id},null,2)+'\n',{flag:'wx'});
  result={...result,status:'passed_fixture_structure_only',tables,foreignKeys,primaryKeys:keys,readerRole:role,source_rows_unchanged:true,counts,initial_automatic_eligible_subjects:eligible,three_organizations:true,different_principals_in_first_organization:true,canonical_budget:'NOT_CREATED: must be one project ledger, checked after reviewed public setup',runner_authority_created:false,installed_public_context_checks:'NOT_RUN',source_owner_version_maintenance:'declared fixture-owner contract; no claim about untested external writers'};
 }catch(error){result.status='fixture_preparation_failed';result.error=error.stack;process.exitCode=1;}
 finally{await source.end();results.push(result);await fs.writeFile(path.join(H,c.id+'-inspection.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
 if(process.exitCode)break;
}
await fs.writeFile(path.join(E,'fixture-inspection.json'),JSON.stringify({at:new Date().toISOString(),classification:'fixture-only; no onboarding or Stage B runtime execution',results},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(results.map(r=>({case:r.case,status:r.status,eligible:r.initial_automatic_eligible_subjects}))));
