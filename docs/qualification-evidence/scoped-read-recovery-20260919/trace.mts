import fs from 'node:fs/promises';
import { inspectDatabase } from '@synapsor-runner/schema-inspector';
import { buildAutoBoundary, reviewExplorationBoundaryCandidate, assertStoredExplorationPolicy, CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION } from '../../../apps/runner/src/auto-boundary.js';
import { recommendedBoundaryReviewCandidate } from '../../../apps/runner/src/boundary-candidate.js';
const root = '/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/scoped-read-recovery-515d260-20260919';
const db = JSON.parse(await fs.readFile(root+'/database-private.json','utf8'));
const out = root+'/trace-configured-before'; await fs.mkdir(out,{recursive:true});
for (const schema of ['returns_ops','refunds','v_scope3_norls','v_rename3b','v_rename3a']) {
 const inspection=await inspectDatabase({databaseUrlEnv:'DATABASE_URL', schema,env:{DATABASE_URL:db.reader_url}});
 const build=buildAutoBoundary({inspection,project:{root:'/tmp/project',frameworks:[],schema_inputs:[],database_env_names:['DATABASE_URL']},sourceEnv:'DATABASE_URL',inspectedSchema:schema,configuredTrustedContext:{schema_version:CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,provider:'environment',tenant_binding:'tenant_id',tenant_env:'SYNAPSOR_TENANT_ID',principal_env:'SYNAPSOR_PRINCIPAL'}});
 const full=structuredClone(build.exploration_boundary), candidate=recommendedBoundaryReviewCandidate(full);
 const results:any={schema,graph:build.graph.resources.map(r=>({id:r.id,status:r.status,tenant:r.tenant_key,principal:r.principal_key}))};
 for (const [name,boundary] of Object.entries({full,candidate})) {
  if (!boundary.pack.resources.length) {results[name]={metadata_only:true};continue;}
  const normalized=reviewExplorationBoundaryCandidate(boundary,structuredClone(boundary)).candidate;
  const diff:any[]=[];
  const walk=(a:any,b:any,path:string)=>{if(JSON.stringify(a)===JSON.stringify(b))return; if(a&&b&&typeof a==='object'&&typeof b==='object'){for(const k of new Set([...Object.keys(a),...Object.keys(b)]))walk(a[k],b[k],path+'/'+k);} else diff.push({path,before:a,after:b});};
  walk(boundary,normalized,'');
  let refusal;try{assertStoredExplorationPolicy(boundary,build.lock);}catch(e){refusal=String(e);}
  results[name]={diff,refusal,resources:boundary.pack.resources.map(r=>r.id)};
  await fs.writeFile(`${out}/${schema}-${name}.json`,JSON.stringify({boundary,normalized},null,2));
 }
 await fs.writeFile(`${out}/${schema}-inspection.json`,JSON.stringify(inspection,null,2));
 await fs.writeFile(`${out}/${schema}-result.json`,JSON.stringify(results,null,2));
 console.log(JSON.stringify({schema, full:results.full?.refusal, candidate:results.candidate?.refusal, resources:full.pack.resources.length}));
}
