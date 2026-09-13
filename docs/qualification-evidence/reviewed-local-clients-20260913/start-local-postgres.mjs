import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
const evidence=path.dirname(new URL(import.meta.url).pathname);
const owned=await fs.mkdtemp(path.join(os.tmpdir(),'synapsor-reviewed-clients-pg-'));
const socket=path.join(owned,'socket');await fs.mkdir(socket,{mode:0o777});await fs.chmod(socket,0o777);
const name=`synapsor-reviewed-clients-${randomUUID().slice(0,8)}`;
const metadata={name,owned,socket,created_at:new Date().toISOString(),network:'none',auto_remove:false,fixture_database:'synapsor_reviewed_clients',authentication:'New isolated synthetic fixture, trusted Unix socket inside private task-owned parent; no pre-existing credentials.',image:execFileSync('docker',['image','inspect','postgres:17','--format','{{.Id}}'],{encoding:'utf8'}).trim()};
await fs.writeFile(path.join(evidence,'postgres-fixture.json'),JSON.stringify(metadata,null,2)+'\n');
try {
 metadata.id=execFileSync('docker',['run','--pull=never','-d','--network','none','--name',name,'--label','synapsor.qualification=reviewed-clients-repair-20260913','--env','POSTGRES_DB=synapsor_reviewed_clients','--env','POSTGRES_HOST_AUTH_METHOD=trust','--mount',`type=bind,source=${socket},target=/var/run/postgresql`,'postgres:17','-c','listen_addresses='],{encoding:'utf8'}).trim();
 const connectionString=`postgresql:///synapsor_reviewed_clients?host=${encodeURIComponent(socket)}&user=postgres`;
 const pool=new Pool({connectionString,connectionTimeoutMillis:1500});
 let ready=false;const attempts=[];
 try {
  for(let i=0;i<60;i++){
   try {if(execFileSync('docker',['exec',name,'cat','/proc/1/comm'],{encoding:'utf8'}).trim()!=='postgres')throw new Error('Waiting for final server after initialization');const r=await pool.query('SELECT current_database() AS database, current_user AS role, version() AS version');metadata.query=r.rows[0];ready=true;break;}
   catch(error){attempts.push({at:new Date().toISOString(),code:error.code,message:error.message});await delay(500);}
  }
  if(!ready)throw new Error('Owned PostgreSQL fixture never became ready');
  await pool.query('BEGIN');await pool.query('CREATE SCHEMA qualification_permission_probe');await pool.query('CREATE TABLE qualification_permission_probe.checks (id integer PRIMARY KEY)');await pool.query('INSERT INTO qualification_permission_probe.checks VALUES (1)');await pool.query('SELECT pg_advisory_xact_lock(9120912)');await pool.query('ROLLBACK');
  metadata.ready_at=new Date().toISOString();metadata.required_schema_table_transaction_lock_permissions=true;metadata.connectionString=connectionString;
 }finally{await pool.end();metadata.readiness_attempts=attempts;}
} finally {
 for(const [file,args] of [['postgres-inspect-initial.json',['inspect',name]],['postgres-startup.log',['logs',name]]]){
  const saved=spawnSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  await fs.writeFile(path.join(evidence,file),saved.stdout+saved.stderr);
 }
 await fs.writeFile(path.join(evidence,'postgres-fixture.json'),JSON.stringify(metadata,null,2)+'\n');
 console.log(JSON.stringify({name,ready_at:metadata.ready_at,query:metadata.query}));
}
