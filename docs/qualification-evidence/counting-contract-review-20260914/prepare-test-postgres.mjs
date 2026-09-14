// Only this assignment's owned disposable test database; no provider credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
process.umask(0o077);
const E=path.dirname(new URL(import.meta.url).pathname), plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),O=plan.owned_root;
await fs.mkdir(path.join(O,'private'),{recursive:true});
const target=path.join(O,'private/live-postgres.json');
await assert.rejects(fs.stat(target),{code:'ENOENT'});
const root=await fs.mkdtemp(path.join(os.tmpdir(),'synapsor-counting-review-pg-')),socket=path.join(root,'socket');
await fs.mkdir(socket,{mode:0o777});await fs.chmod(socket,0o777);
const name='synapsor-counting-review-tests-'+randomUUID().slice(0,8), label='counting-contract-review-20260914';
const image=execFileSync('docker',['image','inspect','postgres:17','--format','{{.Id}}'],{encoding:'utf8'}).trim();
const data={name,label,socket,root,image,database:'policy_reconciliation_tests',created_at:new Date().toISOString(),network:'none',required_schema_table_transaction_lock_permissions:true};
await fs.writeFile(target,JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const id=execFileSync('docker',['run','--pull=never','-d','--network','none','--name',name,'--label','synapsor.qualification='+label,
'--env','POSTGRES_DB='+data.database,'--env','POSTGRES_HOST_AUTH_METHOD=trust','--mount',`type=bind,source=${socket},target=/var/run/postgresql`,
'postgres:17','-c','listen_addresses='],{encoding:'utf8'}).trim();
const connectionString=`postgresql:///${data.database}?host=${encodeURIComponent(socket)}&user=postgres`;
Object.assign(data,{id,connectionString});await fs.writeFile(target,JSON.stringify(data,null,2)+'\n');
const { Client }=createRequire(path.join(plan.evidence_root,'../../../package.json'))('pg');
let ready=false;
for(let attempt=0;attempt<40;attempt++) {
 const client=new Client({connectionString,connectionTimeoutMillis:1000});
 try {await client.connect();const row=(await client.query('SELECT current_database() AS database, current_user AS role')).rows[0];
  assert.equal(row.database,data.database);assert.equal(row.role,'postgres');ready=true;break;}
 catch {await delay(250);}finally{await client.end().catch(()=>{});}
}
assert(ready,'owned test postgres not ready');
await fs.writeFile(path.join(E,'postgres-test-fixture.json'),JSON.stringify({name,id,label,image,network:'none',database:data.database,socket,
 private_configuration:target,ready_at:new Date().toISOString(),credentials:'only scoped SYNAPSOR_TEST_POSTGRES_URL, no provider environment'},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({name,id,database:data.database,ready:true}));
