// Apply only the exact inspected public writer handoff in this task's fixture.
// This is source-owner provisioning, never a model or Runner authority setter.
import fs from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
process.umask(0o077);const E=path.dirname(new URL(import.meta.url).pathname),plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),[id,relative,expectedHash]=process.argv.slice(2);
assert(['recovery-tournament-assisted','recovery-software'].includes(id));assert(/^\.synapsor\/writer-handoffs\/review-[A-Za-z0-9_-]+\/grants\.sql$/.test(relative));assert(/^[a-f0-9]{64}$/.test(expectedHash));
const R=path.join(plan.owned_root,'runs',id),state=JSON.parse(await fs.readFile(path.join(R,'run-state.json'))),c=JSON.parse(await fs.readFile(path.join(R,'private/connection.json'))),fixture=JSON.parse(await fs.readFile(path.join(R,'case.json')));
assert(Date.now()<Date.parse(state.setup_deadline));assert(!state.development_only);
const info=JSON.parse(execFileSync('docker',['inspect',c.container],{encoding:'utf8'}))[0];assert.equal(info.Id,c.container_id);assert.equal(info.Config.Labels['synapsor.qualification'],c.label);assert.equal(info.HostConfig.NetworkMode,'none');assert(info.State.Running);
const sql=await fs.readFile(path.join(R,'project',relative),'utf8'),hash=v=>createHash('sha256').update(v).digest('hex');assert.equal(hash(sql),expectedHash);
const roles=[...sql.matchAll(/CREATE ROLE "(runner_writer_[a-f0-9]+)" NOLOGIN/g)].map(m=>m[1]);assert.equal(roles.length,1);
assert(!/CREATE POLICY|ALTER POLICY|\bUPDATE\s+"?(?:tournament_ops|release_ops)/i.test(sql),'No policy or business fact repair in receipt/writer provisioning');
const psql=input=>execFileSync('docker',['exec','-i',c.container,'psql','-X','-U','postgres','-d',c.database,'-v','ON_ERROR_STOP=1','-A','-t'],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const parts=fixture.table_order.map(t=>`SELECT '${t}' n,json_agg(t ORDER BY t) v FROM ${fixture.schema}.${t} t`);
const query=`SELECT json_build_object('database',current_database(),'rows',(SELECT json_object_agg(n,v) FROM (${parts.join(' UNION ALL ')}) s),'policies',(SELECT json_agg(p ORDER BY tablename,policyname) FROM pg_policies p WHERE schemaname='${fixture.schema}'))::text;`;
const before=psql(query);await fs.writeFile(path.join(R,'private/provision-before.json'),before,{flag:'wx'});
await fs.writeFile(path.join(R,'logs/administrator-grants.log'),psql(sql),{flag:'wx'});
await fs.writeFile(path.join(R,'logs/administrator-local-login.log'),psql(`ALTER ROLE "${roles[0]}" LOGIN;`),{flag:'wx'});
const after=psql(query);await fs.writeFile(path.join(R,'private/provision-after.json'),after,{flag:'wx'});assert.equal(after,before);
const writer=new URL(c.adminUrl);writer.searchParams.set('user',roles[0]);writer.password='';writer.searchParams.set('host',c.logicalSocket);c.env.WRITER_DATABASE_URL=writer.href;
const admin=new URL(c.adminUrl);admin.searchParams.set('host',c.logicalSocket);c.adminLogicalUrl=admin.href;await fs.writeFile(path.join(R,'private/connection.json'),JSON.stringify(c,null,2)+'\n');
const result={at:new Date().toISOString(),artifact_tree:state.artifact_tree,container:c.container,container_id:c.container_id,sql_file:relative,sql_sha256:expectedHash,administrator:'authorized synthetic fixture owner',local_authentication:'network none, private Unix socket, dedicated LOGIN role',business_rows_and_original_policies_unchanged:true,baseline_sha256:hash(before),writer_reinspection:'PENDING',execution_enabled:false,source_execution:'NOT_RUN'};
await fs.writeFile(path.join(E,id+'-writer-provision.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
