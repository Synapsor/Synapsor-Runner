import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import { captureBody, assertNoPrivateInput, sha } from './capture-redaction.mjs';
import { reserve, settle } from './provider-budget.mjs';

const root = process.env.QUALIFICATION_PROVIDER_METER;
if (root) {
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json')));
  const secrets = Object.entries(process.env).filter(([k,v]) => /KEY|TOKEN|PASSWORD|SECRET|DATABASE.*URL/.test(k) && v && v.length >= 8).map(([,v])=>v);
  const privateValues = JSON.parse(fs.readFileSync(plan.private_values_file));
  const log = value => fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,...value})+'\n',{mode:0o600});
  const save = (name, body) => fs.writeFileSync(path.join(root,name),body,{flag:'wx',mode:0o600});
  function begin(url, body) {
    assert.equal(url.hostname, 'openrouter.ai', 'Undeclared authoring endpoint');
    if (url.pathname === '/api/v1/models') { log({kind:'catalog',pathname:url.pathname}); return null; }
    assert.equal(url.pathname, '/api/v1/chat/completions');
    assertNoPrivateInput(body, [...privateValues, ...secrets]);
    const request=JSON.parse(body);
    assert.deepEqual(request.provider,{require_parameters:true,allow_fallbacks:false,data_collection:'deny'});
    assert(!('reasoning' in request) && !('temperature' in request), 'Undeclared authoring setting');
    const phase=JSON.parse(fs.readFileSync(plan.phase_file)).phase;
    // Preserve the safely disclosed prepared envelope even if accounting refuses
    // admission; this is not a provider transport and carries no cost claim.
    const reservation = Buffer.byteLength(body)*0.000004 + (request.max_tokens ?? request.max_output_tokens ?? request.max_completion_tokens)*0.000018;
    log({kind:'prepared_envelope',bytes:Buffer.byteLength(body),reservation_usd:reservation,request_sha256:sha(body)});
    fs.appendFileSync(path.join(root,'prepared-envelopes.jsonl'),captureBody(body,secrets)+'\n',{mode:0o600});
    const item=reserve(plan.ledger,plan.case_id,'authoring',phase,request);
    save(item.id+'-request.json',captureBody(body,secrets));
    log({kind:'transport',id:item.id,model:request.model,phase,request_sha256:sha(body),bytes:Buffer.byteLength(body)});
    return item;
  }
  function finish(item, status, body, truncated=false) {
    if (!item) return;
    let usage;
    if (!truncated) {
      save(item.id+'-response.txt',captureBody(body,secrets));
      try { usage=JSON.parse(body).usage; } catch {
        for (const line of body.split('\n')) if(line.startsWith('data:')) {
          try { const j=JSON.parse(line.slice(5)); if(j.usage)usage=j.usage; } catch {}
        }
      }
    }
    const cost=typeof usage?.cost==='number'?usage.cost:null;
    settle(plan.ledger,plan.case_id,item.id,cost,{http_status:status,capture_complete:!truncated,response_sha256:sha(body)});
    log({kind:'response',id:item.id,status,bytes:Buffer.byteLength(body),truncated,usage});
    if (truncated) fs.writeFileSync(path.join(root,'CAPTURE-INCOMPLETE'),'Stop: response exceeded the existing 8MiB wire capture bound.');
  }
  function requestUrl(args,protocol) {
    const first=args[0];if(typeof first==='string'||first instanceof URL)return new URL(first);
    const x=first??{};return new URL(`${x.protocol??protocol}//${x.hostname??x.host}${x.port?':'+x.port:''}${x.path??'/'}`);
  }
  for(const [module,protocol]of [[http,'http:'],[https,'https:']]){
    const original=module.request;
    module.request=function(...args){
      assert(!fs.existsSync(path.join(root,'CAPTURE-INCOMPLETE')),'Incomplete prior capture');
      const url=requestUrl(args,protocol);let item,bodyStarted=false;
      const request=original.apply(this,args),write=request.write,end=request.end;
      const firstBody=value=>{
        if(value==null)return;
        assert(!bodyStarted,'Measurement supports one complete JSON request body, not chunked authoring');
        bodyStarted=true;item=begin(url,Buffer.isBuffer(value)?value.toString():String(value));
      };
      request.write=function(value,...rest){firstBody(value);return write.call(this,value,...rest);};
      request.end=function(value,...rest){if(typeof value==='string'||Buffer.isBuffer(value))firstBody(value);return end.call(this,value,...rest);};
      request.once('response',res=>{const chunks=[];let bytes=0;
        res.on('data',chunk=>{bytes+=chunk.length;if(bytes<=8*1024*1024)chunks.push(Buffer.from(chunk));});
        res.once('end',()=>finish(item,res.statusCode,Buffer.concat(chunks).toString(),bytes>8*1024*1024));
        res.once('aborted',()=>log({kind:'response_aborted',id:item?.id}));
      });
      request.once('error',error=>log({kind:'transport_error',id:item?.id,code:error.code??error.name}));
      return request;
    };
    module.get=function(...args){const r=module.request(...args);r.end();return r;};
  }
  syncBuiltinESMExports();
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(input,options)=>{
    assert(!fs.existsSync(path.join(root,'CAPTURE-INCOMPLETE')),'Incomplete prior capture');
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    const body=options?.body?.toString()??(input instanceof Request?await input.clone().text():'');
    const item=begin(url,body);
    try{
      const response=await originalFetch(input,options);
      const reader=response.clone().body?.getReader();
      if(reader)void(async()=>{const chunks=[];let bytes=0;for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>8*1024*1024){void reader.cancel();break;}chunks.push(Buffer.from(r.value));}finish(item,response.status,Buffer.concat(chunks).toString(),bytes>8*1024*1024);})().catch(e=>log({kind:'capture_error',id:item?.id,error:e.name}));
      return response;
    }catch(error){log({kind:'transport_error',id:item?.id,error:error.name});throw error;}
  };
  log({kind:'instrumentation_ready',columns:process.stdout.columns??null,rows:process.stdout.rows??null});
}
