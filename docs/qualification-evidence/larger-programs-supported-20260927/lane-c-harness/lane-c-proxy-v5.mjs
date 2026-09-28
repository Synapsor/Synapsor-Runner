// Version5 fixes independent684: withhold the bounded upstream body until privacy scan and accounting.
// Test-only final-encoding proxy. No request edits, callbacks, inference retries,
// API-key discovery, or Runner state access. Caller owns consent and credentials.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {hash,units,dollars,reserveRequest,markStarted,finishRequest,registerInvocation,stopJourney,reserveTokenCount} from './lane-c-budget-v3.mjs';
import {captureBody,assertNoPrivateInput} from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/source-phase-review-20260921/capture-redaction.mjs';

const immutableCopy = value => {
  const copy=JSON.parse(JSON.stringify(value));
  const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
  return freeze(copy);
};

export function validateRequest(bytes,plan) {
  assert(bytes.length<=1048576&&bytes.length<=plan.request_bytes,'REQUEST_BYTES');
  const r=JSON.parse(bytes);assert.equal(r.model,plan.model,'MODEL_CHANGED');assert.equal(r.stream,plan.stream,'STREAM_CHANGED');assert(r.truncation===undefined||r.truncation==='disabled','TRUNCATION_CHANGED');assert(r.transforms===undefined||(Array.isArray(r.transforms)&&r.transforms.length===0),'COMPRESSION_CHANGED');
  const output=r.max_output_tokens??r.max_tokens;
  assert(Number.isSafeInteger(output)&&output>0&&plan.product_output_caps.includes(output),'OUTPUT_CHANGED');
  assert(!('max_completion_tokens' in r),'UNDECLARED_OUTPUT_FIELD');
  assert(r.tools===undefined||Array.isArray(r.tools),'INVALID_TOOLS');
  const tools=r.tools??[];
  assert(tools.length>0||plan.tool_free_output_caps?.includes(output),'UNDECLARED_TOOL_FREE_STAGE');
  const names=tools.map(t=>{
    const f=plan.provider==='openai'?t:t.function;
    assert(f&&typeof f.name==='string'&&f.parameters?.type==='object','FUNCTION_DECLARATION');
    assert(!Object.hasOwn(f,'strict'),'STRICT_MODE_CHANGED');return f.name;
  });
  assert(new Set(names).size===names.length,'DUPLICATE_TOOL');
  const forced=typeof r.tool_choice==='object'?(r.tool_choice.name??r.tool_choice.function?.name):null;
  assert(forced?names.includes(forced):(r.tool_choice===undefined||r.tool_choice==='auto'||(!names.length&&r.tool_choice==='none')),'TOOL_CHOICE_CHANGED');
  if(plan.provider==='openai') {
    assert.equal(r.store,false,'STORE_CHANGED');assert(tools.length?r.parallel_tool_calls===false:r.parallel_tool_calls===undefined||r.parallel_tool_calls===false,'PARALLEL_CHANGED');
    assert.equal(r.reasoning?.effort,plan.reasoning_effort,'REASONING_CHANGED');
    for(const k of ['background','conversation','previous_response_id','service_tier','prompt_cache_options','prompt_cache_retention'])assert(!Object.hasOwn(r,k),'UNDECLARED_MODE');
  } else {
    assert.deepEqual(r.provider,plan.provider_preferences,'PRIVACY_ROUTING_CHANGED');
    for(const k of ['parallel_tool_calls','reasoning','reasoning_effort','response_format'])assert(!Object.hasOwn(r,k),'UNDECLARED_MODE');
  }
  return {request:r,request_sha256:hash(bytes),output_tokens:output,tool_names:names};
}
// Owner136 practical estimate. Tariffs are USD/token, never per-million here.
// Every allowed route/long-context band participates; no cache discount assumed.
export function pricedCost(input,output,plan,{margin=false}={}) {
  assert(Number.isSafeInteger(input)&&input>=0&&Number.isSafeInteger(output)&&output>=0,'INVALID_TOKENS');
  let maxIn=0n,maxOut=0n,maxFee=0n;assert(plan.eligible_tariffs.length>0,'MISSING_TARIFF');
  for(const route of plan.eligible_tariffs)for(const rate of [route,...(route.overrides??[])]){
    const prompt=rate.prompt??route.prompt,completion=rate.completion??route.completion;
    assert(prompt!=null&&completion!=null,'MISSING_RATE');
    for(const value of [prompt,rate.input_cache_write??route.input_cache_write??prompt])maxIn=maxIn>units(value)?maxIn:units(value);
    maxOut=maxOut>units(completion)?maxOut:units(completion);
    const fee=units(rate.request_fee??rate.request??route.request_fee??route.request??'0');maxFee=maxFee>fee?maxFee:fee;
  }
  assert(maxIn>0n&&maxOut>0n,'MISSING_RATE');const base=BigInt(input)*maxIn+BigInt(output)*maxOut+maxFee;
  return dollars(margin?(base*5n+3n)/4n:base);
}
export const pricedUpper=(input,output,plan)=>pricedCost(input,output,plan,{margin:true});
export function validateTokenObservation(token,checked,bytes,plan) {
  assert(token?.request_sha256===checked.request_sha256,'TOKEN_CONTEXT_CHANGED');
  assert(token.validated===true&&typeof token.method==='string'&&token.method.length>0,'TOKEN_METHOD_UNESTABLISHED');
  assert(token.output_bound_validated===true&&typeof token.output_bound_method==='string'&&token.output_bound_method.length>0,'OUTPUT_CONTRACT_UNESTABLISHED');
  assert(Number.isSafeInteger(token.billing_output_upper_tokens)&&token.billing_output_upper_tokens>=checked.output_tokens,'INVALID_OUTPUT_ALLOWANCE');
  assert(['none','separately-recorded'].includes(token.count_rpc_accounting),'COUNT_RPC_ACCOUNTING_UNESTABLISHED');
  assert(Number.isSafeInteger(token.input_estimate_tokens)&&token.input_estimate_tokens>0,'INVALID_INPUT_ESTIMATE');
  assert(['native-count','matched-tokenizer','owner-bytes-plus-planning'].includes(token.accounting_method),'ACCOUNTING_METHOD');
  if(token.accounting_method==='owner-bytes-plus-planning'){
    assert(Number.isSafeInteger(token.outside_body_context_tokens)&&token.outside_body_context_tokens>=0,'RETAINED_CONTEXT_UNMEASURED');
    assert(token.input_estimate_tokens>=bytes.length+16000+token.outside_body_context_tokens,'ACCOUNTING_FALLBACK_TOO_SMALL');
  }
  if(token.context_input_tokens!=null){
    assert(Number.isSafeInteger(token.context_input_tokens)&&token.context_input_tokens>=0,'INVALID_CONTEXT_COUNT');
    assert(token.context_input_tokens<=plan.max_input_tokens&&token.context_input_tokens+checked.output_tokens<=plan.context_tokens,'MODEL_CONTEXT_OVERFLOW');
    assert(['native-count','matched-tokenizer'].includes(token.context_method),'CONTEXT_METHOD');
    assert(token.input_estimate_tokens>=token.context_input_tokens,'ESTIMATE_BELOW_KNOWN_COUNT');
    assert(/^[a-f0-9]{64}$/.test(token.context_evidence_sha256??''),'CONTEXT_EVIDENCE');
  } else {
    assert(token.accounting_method==='owner-bytes-plus-planning','UNSUPPORTED_EXACT_COUNT_CLAIM');
    assert(token.established_overflow===false,'CONTEXT_OVERFLOW_UNRESOLVED');
    assert(plan.provider==='openrouter'||token.initial_direct_count_verified===true,'DIRECT_INITIAL_COUNT_REQUIRED');
    if(plan.provider==='openai')assert(/^[a-f0-9]{64}$/.test(token.initial_direct_count_evidence_sha256??''),'DIRECT_INITIAL_COUNT_EVIDENCE');
  }
  assert(Buffer.byteLength(JSON.stringify(token))<=65536,'TOKEN_PROOF_BYTES');
}
export function observe(body,provider,httpStatus) {
  let objects=[];
  try {objects=[JSON.parse(body)];}catch {
    for(const line of body.split('\n'))if(line.startsWith('data:'))try{objects.push(JSON.parse(line.slice(5)));}catch{}
  }
  let usage=null,complete=false,tier=null,lateError=false,responseId=null,incomplete=false;
  for(const x of objects) {
    if(x.error||x.type==='error'||x.type==='response.failed'){lateError=true;continue;}
    const response=x.response??x;if(typeof response.id==='string'&&response.id.length<=512)responseId=response.id;incomplete ||= response.status==='incomplete'||(response.choices??[]).some(c=>['length','content_filter','error'].includes(c.finish_reason));
    if(response.usage){usage={};for(const k of ['input_tokens','output_tokens','prompt_tokens','completion_tokens','total_tokens','cost']){const v=response.usage[k];if(typeof v==='number'&&Number.isFinite(v)&&v>=0)usage[k]=v;}for(const [name,value] of [['reasoning_tokens',response.usage.output_tokens_details?.reasoning_tokens??response.usage.completion_tokens_details?.reasoning_tokens],['cached_tokens',response.usage.input_tokens_details?.cached_tokens??response.usage.prompt_tokens_details?.cached_tokens]])if(Number.isFinite(value)&&value>=0)usage[name]=value;tier=typeof response.service_tier==='string'&&['default','flex','priority','auto'].includes(response.service_tier)?response.service_tier:tier;}
    if(provider==='openai')complete ||= ['response.completed','response.incomplete'].includes(x.type)||['completed','incomplete'].includes(response.status);
    else complete ||= !!x.usage&&(body.includes('[DONE]')||Array.isArray(x.choices)&&x.choices.every(c=>c.finish_reason!=null));
  }
  if(httpStatus<200||httpStatus>=300)complete=false;
  return {usage,complete:complete&&!lateError,service_tier:tier,late_error:lateError,response_id:responseId,incomplete};
}
export async function createProxy({ledger,journey,invocation,plan,approvals,root,key,privateValues=[],tokenCounter,resourceCheck,networkEnabled=false,forward,onStop=()=>{}}) {
  // Detach the approved operation from all caller-owned mutable references.
  plan=immutableCopy(plan);approvals=immutableCopy(approvals);privateValues=[...privateValues];
  assert(typeof tokenCounter==='function'&&typeof resourceCheck==='function','MISSING_PREFLIGHT_HOOKS');
  assert.equal(plan.candidate,'f20e8633b352528fe216adfca6ca45a47a351e27');
  assert.equal(plan.request_bytes,1048576,'PRODUCT_BYTE_BOUND');assert.equal(plan.stream_bytes,8388608,'PRODUCT_STREAM_BOUND');
  const planHash=hash(JSON.stringify(plan));
  for(const role of ['Main','Tester']) {
    const a=approvals?.[role];assert(a?.path&&a?.sha256,'MISSING_JOINT_SIGNOFF');
    const bytes=fs.readFileSync(a.path);assert.equal(hash(bytes),a.sha256,'SIGNOFF_CHANGED');
    const record=JSON.parse(bytes);assert.equal(record.role,role,'SIGNOFF_ROLE');assert.equal(record.plan_sha256,planHash,'SIGNOFF_PLAN_CHANGED');assert.equal(record.accepted,true,'SIGNOFF_NOT_ACCEPTED');
  }
  assert(key&&typeof key==='string','MISSING_KEY');
  if(!forward){assert(networkEnabled===true,'NETWORK_NOT_AUTHORIZED');forward=fetch;}
  assert(!fs.existsSync(root),'CAPTURE_COLLISION');fs.mkdirSync(root,{recursive:true,mode:0o700});
  registerInvocation(ledger,journey,invocation,planHash);
  let sequence=0,halted=false;const active=new Set();const records=[];
  const save=(name,data)=>fs.writeFileSync(path.join(root,name),data,{flag:'wx',mode:0o600});
  const event=x=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({utc:new Date().toISOString(),...x})+'\n',{mode:0o600});
  const stop=x=>{halted=true;const shared=['SECRET_IN_RESPONSE','QUALIFICATION_PRIVATE_INPUT_REFUSED','PRIVACY_ROUTING_CHANGED','MODEL_CHANGED','TOKEN_CONTEXT_CHANGED','TRUNCATION_CHANGED','COMPRESSION_CHANGED','PLAN_CHANGED'].includes(x.reason);stopJourney(ledger,journey,x.reason,{shared});try{onStop(x);}catch{event({kind:'stop_observer_failed',reason:x.reason});}};
  const safeCapture=(body,bound)=>{const safe=captureBody(body,[key,...privateValues]);return Buffer.byteLength(safe)<=bound?safe:JSON.stringify({safe_projection_withheld_for_capture_bound:true,raw_sha256:hash(body),safe_bytes:Buffer.byteLength(safe)});};
  const rawCapture=(id,part,bytes)=>{const compressed=zlib.gzipSync(bytes);if(compressed.length<=bytes.length+65536)save(id+'-'+part+'.raw.gz',compressed);else save(id+'-'+part+'.raw',bytes);};
  const server=http.createServer((req,res)=>{
    const work=(async()=>{let item;let started=false;const responseChunks=[];let received=0;
      try {
        assert(!halted,'PROXY_STOPPED');
        assert(req.method==='POST'&&req.url===plan.local_path,'UNDECLARED_ENDPOINT');
        const chunks=[];let size=0;for await(const c of req){size+=c.length;assert(size<=plan.request_bytes,'REQUEST_BYTES');chunks.push(c);}
        const bytes=Buffer.concat(chunks);const body=bytes.toString('utf8');assertNoPrivateInput(body,[key,...privateValues]);
        const checked=validateRequest(bytes,plan);
        const token=immutableCopy(await tokenCounter({bytes:Buffer.from(bytes),request:immutableCopy(checked.request),request_sha256:checked.request_sha256,plan}));
        validateTokenObservation(token,checked,bytes,plan);
        const ledgerBytes=fs.statSync(ledger).size;
        // Raw gzip has a checked64KiB overhead/fallback; safe projections are
        // capped with an explicit withholding marker, never wire substitution.
        // Include per-request metadata/FS headroom and atomic ledger coexistence.
        const captureUpper=2*(plan.request_bytes+plan.stream_bytes)+1048576;
        const resource=await resourceCheck({capture_extra_upper:captureUpper,atomic_ledger_extra_upper:ledgerBytes+262144,plan});
        assert(resource?.fits===true&&typeof resource.evidence_sha256==='string'&&/^[a-f0-9]{64}$/.test(resource.evidence_sha256),'RESOURCE_UNESTABLISHED');
        assert(!halted,'PROXY_STOPPED');
        const headers={'content-type':'application/json','accept':req.headers.accept??'application/json','authorization':'Bearer '+key};
        for(const h of ['openai-project','openai-organization']){assert((req.headers[h]??null)===(plan.upstream_headers?.[h]??null),'UPSTREAM_PROJECT_CHANGED');if(plan.upstream_headers?.[h])headers[h]=plan.upstream_headers[h];}
        const reservation=pricedUpper(token.input_estimate_tokens,token.billing_output_upper_tokens,plan);
        const id=`${invocation}-${String(++sequence).padStart(4,'0')}`;
        // Exact raw bodies remain private. Existing audience-safe capture mechanism
        // withholds model-private continuation; it does not change forwarded bytes.
        rawCapture(id,'request',bytes);save(id+'-request.safe.json',safeCapture(body,plan.request_bytes));
        item=reserveRequest(ledger,journey,invocation,id,{request_sha256:checked.request_sha256,request_bytes:size,
          token_observation:token,output_tokens:checked.output_tokens,plan_sha256:planHash,resource_evidence_sha256:resource.evidence_sha256},reservation);
        assert(!halted,'PROXY_STOPPED');
        markStarted(ledger,id);started=true;event({kind:'upstream_start',id,request_sha256:checked.request_sha256,request_bytes:size,reserved_usd:reservation});
        const upstream=await forward(plan.upstream_url,{method:'POST',headers,body:bytes,redirect:'error',signal:AbortSignal.timeout(plan.timeout_ms)});
        const responseHeaders={};for(const h of ['content-type','x-request-id','request-id']){const v=upstream.headers.get(h);if(v)responseHeaders[h]=v;}
        if(upstream.body)for await(const c of upstream.body){received+=c.length;assert(received<=plan.stream_bytes,'RESPONSE_BOUND');responseChunks.push(Buffer.from(c));}
        const raw=Buffer.concat(responseChunks);const text=raw.toString('utf8');const noSecret=![key,...privateValues].some(value=>value&&(text.includes(value)||JSON.stringify(responseHeaders).includes(value)));
        if(noSecret)rawCapture(id,'response',raw);save(id+'-response.safe.txt',safeCapture(text,plan.stream_bytes));
        const observed=observe(text,plan.provider,upstream.status);let settledUsd,observedUpperUsd;
        // Only a complete, request-specific provider cost is settled. Direct token
        // usage is a held tariff upper, explicitly not an actual billed amount.
        if(observed.complete&&plan.provider==='openrouter'&&observed.usage?.cost!=null)settledUsd=String(observed.usage.cost);
        else if(observed.complete&&Number.isSafeInteger(observed.usage?.input_tokens)&&Number.isSafeInteger(observed.usage?.output_tokens))observedUpperUsd=pricedCost(observed.usage.input_tokens,observed.usage.output_tokens,plan);
        else if(observed.complete&&Number.isSafeInteger(observed.usage?.prompt_tokens)&&Number.isSafeInteger(observed.usage?.completion_tokens))observedUpperUsd=pricedCost(observed.usage.prompt_tokens,observed.usage.completion_tokens,plan);
        const details={http_status:upstream.status,response_bytes:received,response_sha256:hash(raw),usage:observed.usage,
          complete_usage:observed.complete,request_id:noSecret?(upstream.headers.get('x-request-id')??upstream.headers.get('request-id')??observed.response_id)?.slice(0,512):null,response_id:noSecret?observed.response_id:null,service_tier:observed.service_tier,no_secret_in_response:noSecret,
          accounting_basis:settledUsd!=null?'Request-specific complete provider cost':observedUpperUsd!=null?'Complete usage at conservative eligible tariff, NOT settled cost':'Unknown cost retains full original reservation'};
        const result=finishRequest(ledger,id,{settledUsd,observedUpperUsd,details});records.push(result);event({kind:'upstream_complete',id,...details});
        if(result.stopped||!noSecret||observed.late_error||observed.incomplete)stop({reason:!noSecret?'SECRET_IN_RESPONSE':result.stopped?'FINANCIAL_STOP':observed.incomplete?'UPSTREAM_INCOMPLETE':'UPSTREAM_LATE_ERROR',id});
        if(!noSecret){if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});if(!res.destroyed)res.end(JSON.stringify({error:{code:'QUALIFICATION_PRIVATE_RESPONSE_REFUSED'}}));return;}
        if(!res.destroyed){res.writeHead(upstream.status,responseHeaders);res.end(raw);}
      } catch(e) {
        const reason=typeof e.message==='string'&&/^[A-Z_]+$/.test(e.message)?e.message:'QUALIFICATION_BOUNDARY_FAILURE';
        event({kind:'refusal',reason,id:item?.id??null,started});
        if(started&&responseChunks.length){const partial=Buffer.concat(responseChunks);if(![key,...privateValues].some(value=>value&&partial.toString('utf8').includes(value)))rawCapture(item.id,'response-partial',partial);save(item.id+'-response-partial.safe.txt',safeCapture(partial.toString('utf8'),plan.stream_bytes));}
        if(started)try{finishRequest(ledger,item.id,{details:{reason,unknown_transport_cost:true}});}catch{event({kind:'accounting_failure_hold_retained',id:item.id});}
        if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});
        if(!res.destroyed)res.end(JSON.stringify({error:{code:'QUALIFICATION_PREFLIGHT_REFUSED'}}));
        stop({reason,id:item?.id??null,started});
      }
    })();active.add(work);work.finally(()=>active.delete(work));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,records,plan_sha256:planHash,
    async close(){await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...active]);}};
}
