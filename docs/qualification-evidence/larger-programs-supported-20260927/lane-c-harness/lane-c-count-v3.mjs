// Version3: apply independent684 known-value response privacy rule to count bodies and identifiers.
// Qualification-only native Responses input counter. No model completion,
// project callback, request rewrite, retry, key discovery or product mutation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {hash,reserveTokenCount,markStarted,finishRequest,stopJourney} from './lane-c-budget-v3.mjs';
import {validateRequest,pricedUpper} from './lane-c-proxy-v5.mjs';
import {captureBody,assertNoPrivateInput} from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/source-phase-review-20260921/capture-redaction.mjs';

const fields=['model','instructions','input','tools','tool_choice','parallel_tool_calls','reasoning','text','truncation'];
const countUrl='https://api.openai.com/v1/responses/input_tokens';
const digestPattern=/^[a-f0-9]{64}$/;
const copy=x=>{const v=JSON.parse(JSON.stringify(x));const freeze=a=>{if(a&&typeof a==='object'){Object.values(a).forEach(freeze);Object.freeze(a);}return a;};return freeze(v);};

export function projectCountRequest(inferenceBytes,plan) {
  assert.equal(plan.provider,'openai','COUNT_PROVIDER');
  const {request}=validateRequest(inferenceBytes,plan);
  const excluded=['stream','store','max_output_tokens','include'];
  assert(Object.keys(request).every(k=>fields.includes(k)||excluded.includes(k)),'UNHANDLED_COUNT_RELEVANT_FIELD');
  // Only generation/storage selectors are omitted. Input/history/tool material
  // remains structurally identical; the count endpoint never executes tools.
  const projected=Object.fromEntries(fields.filter(k=>Object.hasOwn(request,k)).map(k=>[k,request[k]]));
  const bytes=Buffer.from(JSON.stringify(projected));validateCountRequest(bytes,plan);
  return {bytes,source_request_sha256:hash(inferenceBytes),projection_sha256:hash(bytes)};
}

export function validateCountRequest(bytes,plan) {
  assert(bytes.length<=plan.request_bytes,'COUNT_REQUEST_BYTES');const r=JSON.parse(bytes);
  assert(Object.keys(r).every(k=>fields.includes(k)),'COUNT_SCHEMA_FIELD');
  assert.equal(r.model,plan.model,'COUNT_MODEL');
  assert(typeof r.input==='string'||Array.isArray(r.input),'COUNT_INPUT');
  assert(r.instructions===undefined||typeof r.instructions==='string','COUNT_INSTRUCTIONS');
  assert(r.truncation===undefined||r.truncation==='disabled','COUNT_TRUNCATION');
  assert(r.parallel_tool_calls===undefined||r.parallel_tool_calls===false,'COUNT_PARALLEL');
  if(r.reasoning!==undefined)assert.deepEqual(r.reasoning,{effort:plan.reasoning_effort},'COUNT_REASONING');
  if(r.tools!==undefined){
    assert(Array.isArray(r.tools),'COUNT_TOOLS');
    for(const t of r.tools)assert(t.type==='function'&&typeof t.name==='string'&&t.parameters?.type==='object'&&!Object.hasOwn(t,'strict'),'COUNT_TOOL');
  }
  const visit=x=>{if(!x||typeof x!=='object')return;
    assert(!['input_image','input_audio','input_file','image_url','audio'].includes(x.type),'COUNT_NON_TEXT_INPUT');
    for(const value of Object.values(x))visit(value);};visit(r.input);
  return r;
}

export async function performTokenCount({ledger,journey,invocation,id,plan,approvals,
  inferenceBytes,root,key,privateValues=[],resourceCheck,forward,networkEnabled=false}) {
  plan=copy(plan);approvals=copy(approvals);inferenceBytes=Buffer.from(inferenceBytes);privateValues=[...privateValues];
  assert(plan.provider==='openai'&&plan.count_endpoint===countUrl,'COUNT_ENDPOINT');
  assert(Object.keys(plan.upstream_headers??{}).every(k=>['openai-project','openai-organization'].includes(k)),'COUNT_HEADER_SCOPE');
  assert(digestPattern.test(plan.count_profile_sha256??''),'COUNT_PROFILE');
  assert(typeof key==='string'&&key.length>0&&typeof resourceCheck==='function','COUNT_PREREQUISITE');
  const planHash=hash(JSON.stringify(plan));
  for(const role of ['Main','Tester']){
    const a=approvals?.[role];assert(a?.path&&a?.sha256,'COUNT_SIGNOFF');const b=fs.readFileSync(a.path);assert.equal(hash(b),a.sha256,'COUNT_SIGNOFF_CHANGED');
    const v=JSON.parse(b);assert(v.role===role&&v.accepted===true&&v.plan_sha256===planHash,'COUNT_SIGNOFF_BINDING');
  }
  if(!forward){assert(networkEnabled===true,'COUNT_NETWORK_NOT_AUTHORIZED');forward=fetch;}
  assert(!fs.existsSync(root),'COUNT_CAPTURE_COLLISION');fs.mkdirSync(root,{recursive:true,mode:0o700});
  const save=(name,value)=>fs.writeFileSync(path.join(root,name),value,{flag:'wx',mode:0o600});
  const projected=projectCountRequest(inferenceBytes,plan);try{assertNoPrivateInput(projected.bytes.toString('utf8'),[key,...privateValues]);}catch(e){stopJourney(ledger,journey,'QUALIFICATION_PRIVATE_INPUT_REFUSED',{shared:true});throw e;}
  const resource=await resourceCheck({capture_extra_upper:2*plan.request_bytes+262144,atomic_ledger_extra_upper:fs.statSync(ledger).size+262144,plan});
  assert(resource?.fits===true&&digestPattern.test(resource.evidence_sha256??''),'COUNT_RESOURCE');
  // There are no referenced remote conversations/response IDs in this profile.
  const estimate=projected.bytes.length+16000;
  const reservation=plan.count_documented_fee_usd??pricedUpper(estimate,0,plan);
    const headers={'content-type':'application/json','authorization':'Bearer '+key,...(plan.upstream_headers??{})};
    assert(Object.keys(headers).every(k=>['content-type','authorization','openai-project','openai-organization'].includes(k)),'COUNT_HEADERS');
  save('request.raw.json',projected.bytes);save('request.safe.json',captureBody(projected.bytes.toString('utf8'),[key]));
  const item=reserveTokenCount(ledger,journey,invocation,id,{noninference:true,no_model_output:true,
    projection_sha256:projected.projection_sha256,counter_profile_sha256:plan.count_profile_sha256,
    source_request_sha256:projected.source_request_sha256,request_bytes:projected.bytes.length,
    input_estimate_tokens:estimate,accounting_method:'owner-bytes-plus-planning',plan_sha256:planHash,
    resource_evidence_sha256:resource.evidence_sha256},reservation);
  let started=false;const chunks=[];let size=0;
  try {
    markStarted(ledger,id);started=true;
    const response=await forward(countUrl,{method:'POST',headers,body:projected.bytes,redirect:'error',signal:AbortSignal.timeout(plan.timeout_ms)});
    if(response.body)for await(const c of response.body){chunks.push(Buffer.from(c));size+=c.length;assert(size<=65536,'COUNT_RESPONSE_BYTES');}
    const raw=Buffer.concat(chunks);const requestId=response.headers.get('x-request-id')??response.headers.get('request-id');assert(![key,...privateValues].some(value=>value&&(raw.toString('utf8').includes(value)||requestId?.includes(value))),'SECRET_IN_RESPONSE');save('response.raw.json',raw);
    const v=JSON.parse(raw);assert(response.ok&&v.object==='response.input_tokens'&&Number.isSafeInteger(v.input_tokens)&&v.input_tokens>=0,'COUNT_RESPONSE_INVALID');
    assert(Object.keys(v).every(k=>['object','input_tokens'].includes(k)),'COUNT_UNEXPECTED_RESPONSE');
    const held=plan.count_documented_fee_usd??pricedUpper(v.input_tokens,0,plan);
    const result=finishRequest(ledger,id,{observedUpperUsd:held,details:{http_status:response.status,
      request_id:requestId,input_tokens:v.input_tokens,
      response_sha256:hash(raw),response_bytes:size,noninference:true,
      accounting_basis:plan.count_documented_fee_usd?'Documented count fee, provisional until request-specific settlement':'Returned input count at conservative tariff plus25percent; PROVISIONAL estimate, not invoice'}});
    const evidence={id,source_request_sha256:projected.source_request_sha256,projection_sha256:projected.projection_sha256,
      model:plan.model,input_tokens:v.input_tokens,result,noninference:true};
    save('RESULT.json',JSON.stringify(evidence,null,2)+'\n');
    assert(!result.stopped,'COUNT_FINANCIAL_STOP');
    return {...evidence,evidence_sha256:hash(fs.readFileSync(path.join(root,'RESULT.json')))};
  } catch(e) {
    const reason=typeof e.message==='string'&&/^[A-Z_]+$/.test(e.message)?e.message:'COUNT_TRANSPORT_FAILURE';
    if(chunks.length){const raw=Buffer.concat(chunks);if(![key,...privateValues].some(value=>value&&raw.toString('utf8').includes(value)))save('response-failed.raw.json',raw);}
    if(started)try{finishRequest(ledger,id,{details:{reason,unknown_count_cost:true}});}catch{}
    stopJourney(ledger,journey,reason,{shared:reason==='SECRET_IN_RESPONSE'});
    save('FAILURE.json',JSON.stringify({id,reason,started,hold_retained:started,reserved_usd:item.reserved_usd})+'\n');throw e;
  }
}
