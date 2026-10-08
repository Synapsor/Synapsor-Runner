/** Fresh process native recovery witness; no provider/public activation claim. */
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import assert from 'node:assert/strict';
import {Client,Pool} from 'pg';
import {ProposalStore} from '@synapsor-runner/proposal-store';
import {canonicalJsonDigest,parseWritebackJob} from '@synapsor-runner/protocol';
import {applyPostgresJob,inspectPostgresSourceCompletion} from '../../../packages/postgres/src/index.ts';
import {anchoredFixture} from './impact-jobs.mts';
import {freshLunaFixture} from './luna-impact-recipe.mts';
import {toExecutionReceipt} from '../../../apps/runner/src/writeback-domain.ts';
import {reconciliationReceipt,reconciliationSupportedOutcome} from '../../../apps/runner/src/writeback-setup.ts';
import {resolveAuthorizedOperatorIdentity,verifySignedOperatorProof} from '../../../apps/runner/src/operator-identity.ts';
import {semanticRequestLifecycle} from '../../../packages/mcp-server/src/semantic-request-lifecycle.ts';
const input=JSON.parse(await fs.readFile(process.argv[2],'utf8')),action=process.argv[3];
const job=parseWritebackJob(input.job),store=new ProposalStore(input.storePath);
const config={...input.config,databaseUrl:input.sourceUrl,writebackIntentStore:store};
if(input.family==='anchored_insert')config.semanticActionVerifier=anchoredFixture(input.now).verifier;
if(input.family==='luna_atomic')config.semanticActionVerifier=freshLunaFixture(input.now,input.declaredFacts).verifier;
const intentId='wbi:'+job.job_id;
const inspect=async()=>config.receipts.authority==='source_db'
 ? await inspectPostgresSourceCompletion(job,config,store.getWritebackIntent(intentId)?.source_completion_binding)
 : {status:'unknown',reason:'RUNNER_LEDGER_HAS_NO_ATOMIC_SOURCE_COMPLETION'};
const observation=completion=>({operation:job.operation,classification:completion.status==='proven'?'completion_proven':'outcome_unknown',
 target_identity:[job.target.primary_key],expected:{},observed:{},observed_digest:canonicalJsonDigest(completion),source_completion:completion});
async function reconcile(){
 const completion=await inspect();if(completion.status!=='proven')return {completion,mutation:false};
 const proposal=store.getProposal(job.proposal_id),reason='Recover the exact original Source completion without a business write.';
 const identity=await resolveAuthorizedOperatorIdentity({config:input.operatorConfig,configPath:input.operatorConfigPath,
   proposal,action:'reconcile',reason,actor:'fixture_reconciler',identity:'fixture_reconciler',privateKeyPath:input.reconcilePrivateKey,requiredRole:'source_reconciler',env:{}});
 if(!verifySignedOperatorProof(identity,await fs.readFile(input.reconcilePublicKey,'utf8')))throw new Error('Native signed RECONCILE verification failed');
 const observed=observation(completion),receipt=reconciliationReceipt(store.getWritebackIntent(intentId),observed,
   reconciliationSupportedOutcome(observed),identity.subject,reason);
 const result=store.reconcileWritebackIntent({intent_id:intentId,receipt,source_completion:completion.evidence,
   actor:identity.subject,reason,observation:observed,identity,require_verified_identity:true});
 return {completion,receipt,intent:result,identity_action:identity.decision.action,signature_verified:true,source_database_changed:false};
}
try{
 let result;const cleanupEvents=[];
 if(action==='apply'||action==='apply_cleanup'){
   if(action==='apply_cleanup'){const original=Pool.prototype.end;Pool.prototype.end=async function(...args){await original.apply(this,args);cleanupEvents.push({phase:'native_pool_end_complete_after_commit_ack',injected_error:true});throw new Error('Owned cleanup failure AFTER successful native pool end');};}
   const native=await applyPostgresJob(job,config),receipt=toExecutionReceipt(job,native,false);
   store.recordExecutionReceipt(receipt);
   if(native.status==='reconciliation_required')store.requireWorkerReconciliation({proposalId:job.proposal_id,
     workerId:'fresh_recovery_runner',leaseId:input.workerLeaseId,errorCode:'UNKNOWN_TRANSACTION_OUTCOME'});
   if(native.status==='applied')store.completeWorkerItem(job.proposal_id,'fresh_recovery_runner','applied',undefined,input.workerLeaseId);
   result={native,receipt,intent:store.getWritebackIntent(intentId),cleanupEvents};
 }else if(action==='inspect')result={completion:await inspect(),intent:store.getWritebackIntent(intentId)};
 else if(action==='reconcile')result=await reconcile();
 else if(action==='snapshot_local')result={snapshot:{intent:store.getWritebackIntent(intentId),proposal:store.getProposal(job.proposal_id),receipts:store.receipts(job.proposal_id),queue:store.getWorkerQueueItem(job.proposal_id),events:store.events(job.proposal_id),metrics:store.operationalMetrics()}};
 else if(action==='assert_local_rollback'){
   const before=JSON.parse(await fs.readFile(input.beforeLocalPath,'utf8')).result.snapshot;
   const after={intent:store.getWritebackIntent(intentId),proposal:store.getProposal(job.proposal_id),receipts:store.receipts(job.proposal_id),queue:store.getWorkerQueueItem(job.proposal_id),events:store.events(job.proposal_id),metrics:store.operationalMetrics()};
   assert.deepEqual(JSON.parse(JSON.stringify(after)),before);result={all_local_records_rolled_back:true,snapshot:after};
 }else if(action==='reconcile_before_commit_crash'){
   const append=store.appendEvent.bind(store);store.appendEvent=(...args)=>{const event=append(...args);if(args[1]==='writeback_worker_reconciled'){
     syncFs.writeFileSync(input.resultPath,JSON.stringify({action,pid:process.pid,phase:'native_control_transaction_after_queue_event_before_commit',source_business_sql:false})+'\n',{mode:0o600});process.kill(process.pid,'SIGKILL');}return event;};
   await reconcile();throw new Error('Control transaction interruption target was not reached');
 }
 else if(action==='reconcile_crash'){await reconcile();process.kill(process.pid,'SIGKILL');}
 else if(action==='quarantine')result={queue:store.requireWorkerReconciliation({proposalId:job.proposal_id,workerId:'fresh_recovery_runner',leaseId:input.workerLeaseId,errorCode:'UNKNOWN_TRANSACTION_OUTCOME'})};
 else if(action==='refuse_leased'){
   const snapshot=()=>({intent:store.getWritebackIntent(intentId),proposal:store.getProposal(job.proposal_id),receipts:store.receipts(job.proposal_id),queue:store.getWorkerQueueItem(job.proposal_id),events:store.events(job.proposal_id),metrics:store.operationalMetrics()});
   const before=snapshot();let code;try{await reconcile();}catch(e){code=e.code;}
   assert.equal(code,'SOURCE_COMPLETION_QUEUE_NOT_QUARANTINED');assert.deepEqual(snapshot(),before);result={refused_code:code,all_local_records_equal:true,before};
 }else if(action==='negative'){
   const completion=await inspect();assert.equal(completion.status,'proven');
   const proposal=store.getProposal(job.proposal_id),reason='Reject altered or missing exact Source completion.';
   const identity=await resolveAuthorizedOperatorIdentity({config:input.operatorConfig,configPath:input.operatorConfigPath,proposal,action:'reconcile',reason,actor:'fixture_reconciler',identity:'fixture_reconciler',privateKeyPath:input.reconcilePrivateKey,requiredRole:'source_reconciler',env:{}});
   assert(verifySignedOperatorProof(identity,await fs.readFile(input.reconcilePublicKey,'utf8')));
   const observed=observation(completion),receipt=reconciliationReceipt(store.getWritebackIntent(intentId),observed,'applied',identity.subject,reason);
   const snapshot=()=>({intent:store.getWritebackIntent(intentId),proposal:store.getProposal(job.proposal_id),receipts:store.receipts(job.proposal_id),queue:store.getWorkerQueueItem(job.proposal_id),events:store.events(job.proposal_id),metrics:store.operationalMetrics()});
   const before=snapshot(),controls=[];
   for(const status of ['applied','failed','conflict']){const {receipt_hash,...base}=receipt;const core=JSON.parse(JSON.stringify({...base,receipt_authority:'runner_ledger',status,...(status!=='applied'?{rows_affected:0,source_database_mutated:false,atomic_effects:undefined}:{})}));let code;try{store.reconcileWritebackIntent({intent_id:intentId,receipt:{...core,receipt_hash:canonicalJsonDigest(core)},actor:identity.subject,reason,observation:{},identity,require_verified_identity:true});}catch(e){code=e.code;}assert.equal(code,receipt.schema_version==='synapsor.execution-receipt.v5'?'RECONCILIATION_RECEIPT_VERSION_REQUIRED':'SOURCE_COMPLETION_PROOF_REQUIRED');controls.push({absent_proof_outcome:status,code});}
   for(const field of ['job_digest','binding_digest','result_digest']){let rejected=false;try{store.reconcileWritebackIntent({intent_id:intentId,receipt,source_completion:{...completion.evidence,[field]:'sha256:'+'0'.repeat(64)},actor:identity.subject,reason,observation:{},identity,require_verified_identity:true});}catch{rejected=true;}assert(rejected);controls.push({altered_evidence_field:field,rejected});}
   if(receipt.schema_version==='synapsor.execution-receipt.v2'){for(const version of [undefined,999]){let code;try{store.reconcileWritebackIntent({intent_id:intentId,receipt:{...receipt,new_version:version},source_completion:completion.evidence,actor:identity.subject,reason,observation:{},identity,require_verified_identity:true});}catch(e){code=e.code;}assert.equal(code,'SOURCE_COMPLETION_RECEIPT_MISMATCH');controls.push({altered_bookkeeping_version:version??'absent',code});}}
   const wrongScope=await inspectPostgresSourceCompletion(job,{...config,databaseScope:{...config.databaseScope,principal:'foreign_principal'}},store.getWritebackIntent(intentId).source_completion_binding);
   assert.equal(wrongScope.status,'unknown');controls.push({changed_scope:wrongScope});
   assert.deepEqual(snapshot(),before);result={controls,all_local_records_equal:true};
 }
 else if(action==='concurrent')result={resolutions:await Promise.all([reconcile(),reconcile()]),scope:'two concurrent native Source connections; one process, original control CAS'};
 else if(action==='ambient'){
   const u=new URL(input.sourceUrl);u.username='';process.env.PGUSER='impact_admin';process.env.PGPORT='5432';config.databaseUrl=u.toString();
   const client=new Client({connectionString:config.databaseUrl});await client.connect();
   try{result={actual_native_destination:(await client.query('SELECT current_user AS role,current_database() AS database')).rows[0],completion:await inspectPostgresSourceCompletion(job,config,store.getWritebackIntent(intentId)?.source_completion_binding)};}finally{await client.end();}
 }else if(action==='lifecycle'){
   const proposal=store.getProposal(job.proposal_id);result={lifecycle:await semanticRequestLifecycle(store,proposal),
     metrics:store.operationalMetrics(),receipts:store.receipts(job.proposal_id),events:store.events(job.proposal_id),queue:store.getWorkerQueueItem(job.proposal_id)};
 }else throw new Error('Unknown bounded native action');
 await fs.writeFile(input.resultPath,JSON.stringify({action,pid:process.pid,result},null,2)+'\n',{mode:0o600});
}finally{store.close();}
