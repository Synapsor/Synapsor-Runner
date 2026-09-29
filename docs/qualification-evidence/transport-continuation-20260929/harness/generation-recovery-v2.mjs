// Single recovery owner for an immutable, pure, locally handled generation body.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {randomInt} from 'node:crypto';
import {traceOf,safeException} from './fresh-transport-v1.mjs';
import {hash,reserveRequest,markStarted,finishTransportFailure} from './continuation-budget-v1.mjs';
export function assertPureGeneration(bytes){
  const r=JSON.parse(bytes);assert(r.store===false,'RECOVERY_STORE_REQUIRED');
  for(const k of ['background','conversation','previous_response_id','webhook','webhooks'])assert(!Object.hasOwn(r,k),'RECOVERY_SHARED_STATE_REFUSED');
  assert(!r.tools||Array.isArray(r.tools),'RECOVERY_TOOL_SHAPE');
  for(const t of r.tools??[])assert(t.type==='function'&&typeof t.name==='string'&&t.parameters,'RECOVERY_HOSTED_TOOL_REFUSED');
}
const failures=new WeakMap();
export const guardedGenerationFailure=error=>failures.get(error);
export async function runGeneration({ledger,journey,invocation,firstItem,bytes,headers,url,forward,timeoutMs,responseBound,
  reissue=true,ownerSignal,currentness,saveDiagnostic,beforeRecovery,captureAttempt,event=()=>{},nextId,backoff=async n=>delay((n===1?2000:5000)+randomInt(0,251),undefined,{signal:ownerSignal})}){
  assertPureGeneration(bytes);assert(typeof currentness==='function'&&typeof saveDiagnostic==='function','RECOVERY_OBSERVERS_REQUIRED');
  const fixed=Buffer.from(bytes),root=firstItem.logical_operation_id??firstItem.id,deadline=Date.now()+timeoutMs;let item=firstItem,additional=0;
  while(true){
    let upstream;const chunks=[];let received=0;
    try{
      assert(!ownerSignal?.aborted,'OPERATION_CANCELLED');
      assert.equal(await currentness(),item.currentness_sha256,'CURRENT_CONTEXT_CHANGED');
      markStarted(ledger,item.id);
      event({kind:'upstream_start',id:item.id,logical_operation_id:root,request_sha256:hash(fixed),reserved_usd:item.reserved_usd});
      const remaining=deadline-Date.now();assert(remaining>0,'GENERATION_DEADLINE');const timeout=AbortSignal.timeout(remaining),signal=ownerSignal?AbortSignal.any([ownerSignal,timeout]):timeout;
      upstream=await forward(url,{method:'POST',headers:{...headers},body:Buffer.from(fixed),redirect:'error',signal,attemptId:item.id,logicalOperationId:root,responseBound});
      if(upstream.body)for await(const c of upstream.body){received+=c.length;assert(received<=responseBound,'RESPONSE_BOUND');chunks.push(Buffer.from(c));}
      await upstream.close?.();
      const raw=Buffer.concat(chunks);saveDiagnostic(item.id,{...upstream.trace,upstream_body_bytes:received,buffered_complete:true,downstream_bytes:0});
      return {item,upstream,raw};
    }catch(error){
      await upstream?.close?.();
      // A/B evidence is minted only by the actual socket transport, not by errors
      // supplied by callers. Any absent evidence, headers, cancellation or local
      // uncertainty is C and cannot receive a blind retry.
      let trace=traceOf(error);
      if(!trace)trace={classification:'C',retryable:false,cleanup_complete:upstream?.trace?.cleanup_complete??true,
        upstream_headers:!!upstream,upstream_body_bytes:received,downstream_bytes:0,error:safeException(error)};
      trace={...trace,local_effect_absent:true,logical_operation_id:root};
      if(ownerSignal?.aborted)trace={...trace,classification:'C',retryable:false,abort_origin:'owner_or_operation'};
      const diagnosticHash=saveDiagnostic(item.id,trace,Buffer.concat(chunks));
      // A pre-markStarted refusal leaves a reservation conservatively held. It
      // cannot be released or represented as an observed transport failure here.
      try{finishTransportFailure(ledger,item.id,trace,diagnosticHash);}catch(accountingError){event({kind:'recovery_accounting_refusal',id:item.id,reason:accountingError.message});throw accountingError;}
      event({kind:'transport_failure',id:item.id,classification:trace.classification,retryable:trace.retryable,evidence_sha256:diagnosticHash});
      if(!reissue){const ended=new Error('GUARDED_GENERATION_ENDED');failures.set(ended,{trace,item,diagnosticHash});throw ended;}
      if(!trace.retryable||trace.classification==='C')throw new Error('TRANSPORT_NOT_RECOVERABLE');
      additional++;
      assert(additional<=2,'LOGICAL_ATTEMPT_LIMIT');
      await backoff(additional);assert(!ownerSignal?.aborted,'OPERATION_CANCELLED');
      const now=await currentness();assert.equal(now,item.currentness_sha256,'CURRENT_CONTEXT_CHANGED');assertPureGeneration(fixed);
      const resourceHash=await beforeRecovery();assert(/^[a-f0-9]{64}$/.test(resourceHash??''),'RESOURCE_EVIDENCE');
      const id=nextId();captureAttempt(id);const details={request_sha256:hash(fixed),request_bytes:fixed.length,
        token_observation:item.token_observation,output_tokens:item.output_tokens,plan_sha256:item.plan_sha256,
        resource_evidence_sha256:resourceHash,logical_operation_id:root,currentness_sha256:now,
        recovery_of:item.id,recovery_class:trace.classification,recovery_evidence_sha256:diagnosticHash};
      item=reserveRequest(ledger,journey,invocation,id,details,item.reserved_usd);
    }
  }
}
