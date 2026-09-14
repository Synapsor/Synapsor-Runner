import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createRequire} from 'node:module';import {randomUUID,createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import assert from 'node:assert/strict';
const E=path.dirname(fileURLToPath(import.meta.url)),p=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json'))),R=path.join(p.owned_root,'runs/recovery-software');
const cx=JSON.parse(await fs.readFile(path.join(R,'private/connection.json'))),ci=JSON.parse(execFileSync('docker',['inspect',cx.container],{encoding:'utf8'}))[0];assert.equal(ci.Id,cx.container_id);assert.equal(ci.Config.Labels['synapsor.qualification'],cx.label);assert.equal(ci.HostConfig.NetworkMode,'none');
const {Client}=createRequire(path.resolve(E,'../../../package.json'))('pg'),client=new Client({connectionString:cx.adminUrl});await client.connect();
try{
 assert.equal((await client.query('SELECT current_database() AS db')).rows[0].db,cx.database);
 const snapshot=async()=>{const rows={};for(const table of ['release_slots','build_candidates','build_checks'])rows[table]=(await client.query(`SELECT * FROM release_ops.${table} ORDER BY 1`)).rows;return {counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.length])),digest:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};};
 const before=await snapshot();const id=randomUUID();
 await client.query('BEGIN');
 const sql="INSERT INTO release_ops.release_slots(slot_id,tenant_id,principal_id,slot_ref,slot_state,version) SELECT $1,tenant_id,principal_id,$2,'ready',1 FROM release_ops.release_slots LIMIT 1";
 await client.query(sql,[id,'owned-unlinked-proof-'+randomUUID()]);
 const actual=(await client.query('SELECT s.slot_state, count(c.candidate_id)::int AS linked_candidates FROM release_ops.release_slots s LEFT JOIN release_ops.build_candidates c ON c.slot_id=s.slot_id WHERE s.slot_id=$1 GROUP BY s.slot_state',[id])).rows;
 assert.deepEqual(actual,[{slot_state:'ready',linked_candidates:0}]);await client.query('ROLLBACK');const after=await snapshot();assert.deepEqual(after,before);
 const result={classification:'derived fixture-owner transaction in a new owned post-effect copy; no application success claim',source_counts:before.counts,original_matching_source_sha256:before.digest,insert_statement:sql,probe:actual,rollback:true,post_rollback_source_sha256:after.digest,scope_conclusion:'An eligible own ready slot can exist without any candidate. Candidate-rooted retirement excludes this legal target; no narrowing or Read expansion implemented.',required_decision:'Explicitly review slot root/reference access or separately authorize an existing-contract-compatible reference capability; four runtime tools and current Read stay unchanged.'};
 await fs.writeFile(path.join(E,'software-domain-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
}finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
