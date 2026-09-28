// Test-only final-encoding proxy. No request edits, callbacks, inference retries,
// API-key discovery, or Runner state access. Caller owns consent and credentials.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import {hash,units,dollars,reserveRequest,markStarted,finishRequest,registerInvocation} from './lane-c-budget-v1.mjs';
import {captureBody,assertNoPrivateInput} from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/source-phase-review-20260921/capture-redaction.mjs';

const immutableCopy = value => {
  const copy=JSON.parse(JSON.stringify(value));
  const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
  return freeze(copy);
};

export function validateRequest(bytes,plan) {
  assert(bytes.length<=1048576&&bytes.length<=plan.request_bytes,'REQUEST_BYTES');
  const r=JSON.parse(bytes);assert.equal(r.model,plan.model,'MODEL_CHANGED');assert.equal(r.stream,plan.stream,'STREAM_CHANGED');
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
    assert.equal(r.store,false,'STORE_CHANGED');assert.equal(r.parallel_tool_calls,false,'PARALLEL_CHANGED');
    assert.equal(r.reasoning?.effort,plan.reasoning_effort,'REASONING_CHANGED');
    for(const k of ['background','conversation','previous_response_id','service_tier','prompt_cache_options','prompt_cache_retention'])assert(!Object.hasOwn(r,k),'UNDECLARED_MODE');
  } else {
    assert.deepEqual(r.provider,plan.provider_preferences,'PRIVACY_ROUTING_CHANGED');
    for(const k of ['parallel_tool_calls','reasoning','reasoning_effort','response_format'])assert(!Object.hasOwn(r,k),'UNDECLARED_MODE');
  }
  return {request:r,request_sha256:hash(bytes),output_tokens:output,tool_names:names};
}
export function pricedUpper(input,output,plan) {
  assert(Number.isSafeInteger(input)&&input>0&&Number.isSafeInteger(output)&&output>0,'INVALID_TOKENS');
  let maxIn=0n,maxOut=0n;
  assert(plan.eligible_tariffs.length>0,'MISSING_TARIFF');
  for(const route of plan.eligible_tariffs) {
    const rates=[route,...(route.overrides??[])].filter(x=>x.min_prompt_tokens==null||input>=x.min_prompt_tokens);
    for(const rate of rates) {
      for(const key of ['prompt','input_cache_write'])if(rate[key]!=null)maxIn=maxIn>units(rate[key])?maxIn:units(rate[key]);
      assert(rate.completion!=null,'MISSING_OUTPUT_RATE');maxOut=maxOut>units(rate.completion)?maxOut:units(rate.completion);
    }
  }
  assert(maxIn>0n&&maxOut>0n,'MISSING_RATE');
  return dollars(BigInt(input)*maxIn+BigInt(output)*maxOut);
}
function observe(body,provider,httpStatus) {
  let objects=[];
  try {objects=[JSON.parse(body)];}catch {
    for(const line of body.split('\n'))if(line.startsWith('data:'))try{objects.push(JSON.parse(line.slice(5)));}catch{}
  }
  let usage=null,complete=false,tier=null,lateError=false;
  for(const x of objects) {
    if(x.error||x.type==='error'||x.type==='response.failed'){lateError=true;continue;}
    const response=x.response??x;
    if(response.usage){usage=response.usage;tier=response.service_tier??tier;}
    if(provider==='openai')complete ||= ['response.completed','response.incomplete'].includes(x.type)||['completed','incomplete'].includes(response.status);
    else complete ||= !!x.usage&&body.includes('[DONE]');
  }
  if(httpStatus<200||httpStatus>=300)complete=false;
  return {usage,complete:complete&&!lateError,service_tier:tier,late_error:lateError};
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
  let sequence=0;const active=new Set();const records=[];
  const save=(name,data)=>fs.writeFileSync(path.join(root,name),data,{flag:'wx',mode:0o600});
  const event=x=>fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({utc:new Date().toISOString(),...x})+'\n',{mode:0o600});
  const server=http.createServer((req,res)=>{
    const work=(async()=>{let item;let started=false;
      try {
        assert(req.method==='POST'&&req.url===plan.local_path,'UNDECLARED_ENDPOINT');
        const chunks=[];let size=0;for await(const c of req){size+=c.length;assert(size<=plan.request_bytes,'REQUEST_BYTES');chunks.push(c);}
        const bytes=Buffer.concat(chunks);const body=bytes.toString('utf8');assertNoPrivateInput(body,[key,...privateValues]);
        const checked=validateRequest(bytes,plan);
        const token=immutableCopy(await tokenCounter({bytes:Buffer.from(bytes),request:immutableCopy(checked.request),request_sha256:checked.request_sha256,plan}));
        assert(token?.request_sha256===checked.request_sha256,'TOKEN_CONTEXT_CHANGED');
        assert(token.validated===true&&typeof token.method==='string'&&token.method.length>0,'TOKEN_METHOD_UNESTABLISHED');
        assert(token.output_bound_validated===true&&typeof token.output_bound_method==='string'&&token.output_bound_method.length>0,'OUTPUT_BOUND_UNESTABLISHED');
        assert(Number.isSafeInteger(token.billing_output_upper_tokens)&&token.billing_output_upper_tokens>=checked.output_tokens,'INVALID_OUTPUT_UPPER');
        // This hook must have its own count-RPC consent, reservation/counter and
        // evidence. Invoking it is not implicitly free or excluded from transports.
        assert(token.count_rpc_accounting==='none'||token.count_rpc_accounting==='separately-recorded'||token.count_rpc_accounting==='within-transport-ceiling','COUNT_RPC_ACCOUNTING_UNESTABLISHED');
        assert(Number.isSafeInteger(token.input_upper_tokens)&&token.input_upper_tokens>0,'INVALID_INPUT_UPPER');
        assert(token.input_upper_tokens<=plan.max_input_tokens,'MODEL_INPUT_BOUND');
        assert(token.input_upper_tokens+checked.output_tokens<=plan.context_tokens,'MODEL_CONTEXT_BOUND');
        const resource=await resourceCheck({capture_extra_upper:plan.request_bytes+plan.stream_bytes,plan});
        assert(resource?.fits===true&&typeof resource.evidence_sha256==='string'&&/^[a-f0-9]{64}$/.test(resource.evidence_sha256),'RESOURCE_UNESTABLISHED');
        const reservation=pricedUpper(token.input_upper_tokens,token.billing_output_upper_tokens,plan);
        const id=`${invocation}-${String(++sequence).padStart(4,'0')}`;
        item=reserveRequest(ledger,journey,invocation,id,{request_sha256:checked.request_sha256,request_bytes:size,
          token_observation:token,output_tokens:checked.output_tokens,plan_sha256:planHash,resource_evidence_sha256:resource.evidence_sha256},reservation);
        // Exact raw bodies remain private. Existing audience-safe capture mechanism
        // withholds model-private continuation; it does not change forwarded bytes.
        save(id+'-request.raw.gz',zlib.gzipSync(bytes));save(id+'-request.safe.json',captureBody(body,[key]));
        markStarted(ledger,id);started=true;event({kind:'upstream_start',id,request_sha256:checked.request_sha256,request_bytes:size,reserved_usd:reservation});
        const headers={'content-type':'application/json','accept':req.headers.accept??'application/json','authorization':'Bearer '+key};
        for(const h of ['openai-project','openai-organization'])if(req.headers[h])headers[h]=req.headers[h];
        const upstream=await forward(plan.upstream_url,{method:'POST',headers,body:bytes,redirect:'error',signal:AbortSignal.timeout(plan.timeout_ms)});
        res.statusCode=upstream.status;
        for(const h of ['content-type','x-request-id','request-id']){const v=upstream.headers.get(h);if(v)res.setHeader(h,v);}
        const responseChunks=[];let received=0;
        if(upstream.body)for await(const c of upstream.body){received+=c.length;assert(received<=plan.stream_bytes,'RESPONSE_BOUND');responseChunks.push(Buffer.from(c));if(!res.destroyed)res.write(c);}
        if(!res.destroyed)res.end();
        const raw=Buffer.concat(responseChunks);const text=raw.toString('utf8');const noSecret=!text.includes(key);
        if(noSecret)save(id+'-response.raw.gz',zlib.gzipSync(raw));save(id+'-response.safe.txt',captureBody(text,[key]));
        const observed=observe(text,plan.provider,upstream.status);let settledUsd,observedUpperUsd;
        // Only a complete, request-specific provider cost is settled. Direct token
        // usage is a held tariff upper, explicitly not an actual billed amount.
        if(observed.complete&&plan.provider==='openrouter'&&observed.usage?.cost!=null)settledUsd=String(observed.usage.cost);
        else if(observed.complete&&Number.isSafeInteger(observed.usage?.input_tokens)&&Number.isSafeInteger(observed.usage?.output_tokens))observedUpperUsd=pricedUpper(observed.usage.input_tokens,Math.max(1,observed.usage.output_tokens),plan);
        const details={http_status:upstream.status,response_bytes:received,response_sha256:hash(raw),usage:observed.usage,
          complete_usage:observed.complete,service_tier:observed.service_tier,no_secret_in_response:noSecret,
          accounting_basis:settledUsd!=null?'Request-specific complete provider cost':observedUpperUsd!=null?'Complete usage at conservative eligible tariff, NOT settled cost':'Unknown cost retains full original reservation'};
        const result=finishRequest(ledger,id,{settledUsd,observedUpperUsd,details});records.push(result);event({kind:'upstream_complete',id,...details});
        if(result.stopped||!noSecret||observed.late_error)onStop({reason:result.stopped?'FINANCIAL_STOP':!noSecret?'SECRET_IN_RESPONSE':'UPSTREAM_LATE_ERROR',id});
      } catch(e) {
        const reason=typeof e.message==='string'&&/^[A-Z_]+$/.test(e.message)?e.message:'QUALIFICATION_BOUNDARY_FAILURE';
        event({kind:'refusal',reason,id:item?.id??null,started});
        if(started)try{finishRequest(ledger,item.id,{details:{reason,unknown_transport_cost:true}});}catch{event({kind:'accounting_failure_hold_retained',id:item.id});}
        if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});
        if(!res.destroyed)res.end(JSON.stringify({error:{code:'QUALIFICATION_PREFLIGHT_REFUSED'}}));
        onStop({reason,id:item?.id??null,started});
      }
    })();active.add(work);work.finally(()=>active.delete(work));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,records,plan_sha256:planHash,
    async close(){await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...active]);}};
}
