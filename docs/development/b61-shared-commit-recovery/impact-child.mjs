/** Actual native Pool/Client lifetime; no error handler is installed by this baseline witness. */
import fs from 'node:fs/promises';
import {applyPostgresJob,createPostgresPool} from '../../../packages/postgres/src/index.ts';
import {PostgresWritebackIntentStore} from '@synapsor-runner/proposal-store';
import {parseWritebackJob} from '@synapsor-runner/protocol';
import {anchoredFixture} from './impact-jobs.mts';
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const job=parseWritebackJob(input.job);
const config={...input.config,databaseUrl:input.sourceUrl};
let store;
if(config.receipts.authority==='runner_ledger') {
 store=new PostgresWritebackIntentStore({pool:createPostgresPool(input.ledgerUrl),schema:'impact_ledger',autoMigrate:true,closePool:true});config.writebackIntentStore=store;
}
if(input.family==='anchored_insert')config.semanticActionVerifier=anchoredFixture(input.now).verifier;
if(input.family==='luna_atomic') {
 if(!input.lunaRecipe)throw new Error('Exact immutable Luna recipe not supplied; do not substitute generic atomic fixture.');
 const recipe=await import(input.lunaRecipe);config.semanticActionVerifier=(await recipe.freshLunaFixture(input.now,input.declaredFacts)).verifier;
}
try {
 const result=await applyPostgresJob(job,config);
 await fs.writeFile(input.resultPath,JSON.stringify({result,pid:process.pid},null,2)+'\n',{mode:0o600});
}finally {await store?.close();}
