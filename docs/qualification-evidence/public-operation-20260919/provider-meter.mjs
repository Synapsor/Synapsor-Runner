import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

// Qualification preload, inherited by the public launcher and every Node child.
// Never records credential headers or query strings. Explicit test plans retain
// sanitized request JSON and bounded raw responses in private owned evidence;
// opaque continuation is never promoted to readable operator feedback.
const root = process.env.QUALIFICATION_PROVIDER_METER;
if (root) {
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
  const hosts = new Set(plan.hosts);
  const log = value => fs.appendFileSync(path.join(root, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, ...value }) + '\n');
  log({ type: 'instrumentation_ready', tty: Boolean(process.stdout.isTTY), columns: process.stdout.columns ?? null, rows: process.stdout.rows ?? null });
  const privateValues = JSON.parse(fs.readFileSync(process.env.QUALIFICATION_PRIVATE_VALUES_FILE ?? plan.private_values_file, 'utf8'));
  function guard(body) { if (!body) return; let text=String(body); try {text=JSON.stringify(JSON.parse(text));} catch {} if(privateValues.some(value=>text.includes(value))) { log({type:'private_input_refused_before_provider'}); throw new Error('QUALIFICATION_PRIVATE_INPUT_REFUSED'); } }
  const secrets = Object.entries(process.env).filter(([key,value]) => /KEY|TOKEN|PASSWORD|SECRET|DATABASE.*URL/.test(key) && value && value.length >= 8).map(([,value])=>value);
  function capture(index, body) {
    if (index === undefined || !plan.capture_sanitized_inputs || !body) return;
    try {
      if (Buffer.byteLength(body) > 2*1024*1024) {log({type:'input_not_captured',index,reason:'capture_size_limit'});return;}
      let serialized=JSON.stringify(JSON.parse(body));
      for(const secret of secrets)serialized=serialized.split(secret).join('[REDACTED]');
      serialized=serialized.replace(/postgres(?:ql)?:\/\/[^\s"\\]+/gi,'[REDACTED_DATABASE_URL]')
        .replace(/sk-[A-Za-z0-9_-]{16,}/g,'[REDACTED_KEY]');
      fs.writeFileSync(path.join(root,`input-${String(index).padStart(4,'0')}.json`),JSON.stringify({index,
        evidence:'actual transport request; credentials redacted; headers and responses excluded',request:JSON.parse(serialized)},null,2),{flag:'wx',mode:0o600});
    } catch(error) {log({type:'input_not_captured',index,reason:error.code??error.name});}
  }
  function begin(url, transport) {
    if (!hosts.has(url.hostname)) { if(['localhost','127.0.0.1','::1'].includes(url.hostname))return undefined; log({type:'unrelated_endpoint_refused',host:url.hostname});throw new Error('QUALIFICATION_UNRELATED_ENDPOINT'); }
    // Model-list discovery is a setup request, not an authoring attempt. Keep
    // its response separately while reserving the finite authoring sequence.
    if (url.pathname === '/v1/models') {
      for (let n=1;n<=32;n++) {
        const index='catalog-'+String(n).padStart(4,'0');
        try { fs.writeFileSync(path.join(root,`attempt-${index}.json`),JSON.stringify({index,at:new Date().toISOString(),transport,host:url.hostname,pathname:url.pathname}),{flag:'wx',mode:0o600});
          log({type:'catalog_attempt',index,transport,host:url.hostname,pathname:url.pathname}); return index;
        } catch(error) { if(error.code!=='EEXIST') throw error; }
      }
      throw new Error('QUALIFICATION_CATALOG_ATTEMPTS');
    }
    if (Date.now() > Date.parse(plan.deadline)) {
      log({ type: 'budget_refusal', reason: 'deadline' }); throw new Error('QUALIFICATION_PROVIDER_DEADLINE');
    }
    for (let index = 1; index <= Math.min(plan.maximum_attempts, Number(process.env.QUALIFICATION_PROVIDER_CEILING ?? plan.maximum_attempts)); index++) {
      try {
        // O_EXCL gives one global sequence across the launcher and SDK children.
        fs.writeFileSync(path.join(root, `attempt-${String(index).padStart(4, '0')}.json`), JSON.stringify({
          index, at: new Date().toISOString(), pid: process.pid, transport, host: url.hostname, pathname: url.pathname,
        }), { flag: 'wx', mode: 0o600 });
        log({ type: 'transport_attempt', index, transport, host: url.hostname, pathname: url.pathname }); return index;
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    log({ type: 'budget_refusal', reason: 'attempts' }); throw new Error('QUALIFICATION_PROVIDER_ATTEMPTS');
  }
  function requestUrl(args, protocol) {
    const first = args[0];
    if (typeof first === 'string' || first instanceof URL) return new URL(first);
    const options = first ?? {};
    return new URL(`${options.protocol ?? protocol}//${options.hostname ?? options.host ?? 'localhost'}${options.port ? ':' + options.port : ''}${options.path ?? '/'}`);
  }
  for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
    const original = module.request;
    module.request = function (...args) {
      const index = begin(requestUrl(args, protocol), 'node.request');
      const request = original.apply(this, args);
      if (index !== undefined) {
        if(plan.capture_sanitized_inputs) {
          const chunks=[];let bytes=0;
          const collect=(value,encoding)=>{if(typeof value==='string'||Buffer.isBuffer(value)){const chunk=Buffer.from(value,typeof encoding==='string'?encoding:undefined);bytes+=chunk.length;if(bytes<=2*1024*1024)chunks.push(chunk);}};
          const write=request.write, end=request.end;
          request.write=function(value,encoding,...rest){guard(value);collect(value,encoding);return write.call(this,value,encoding,...rest);};
          request.end=function(value,encoding,...rest){guard(value);collect(value,encoding);if(bytes<=2*1024*1024)capture(index,Buffer.concat(chunks).toString());else log({type:'input_not_captured',index,reason:'capture_size_limit'});return end.call(this,value,encoding,...rest);};
        }
        request.once('response', response => {
          log({type:'response',index,status:response.statusCode});
          const chunks=[];let size=0;
          response.on('data',chunk=>{size+=chunk.length;if(size<=2*1024*1024)chunks.push(Buffer.from(chunk));});
          response.once('end',()=>{log({type:'response_complete',index,bytes:size});if(size>2*1024*1024){log({type:'response_not_captured',index,reason:'size_limit'});return;}let body=Buffer.concat(chunks).toString();for(const secret of secrets)body=body.split(secret).join('[REDACTED]');fs.writeFileSync(path.join(root,`output-${String(index).padStart(4,'0')}.txt`),body,{flag:'wx',mode:0o600});});
          response.once('aborted',()=>log({type:'response_aborted',index}));
        });
        request.once('error', error => log({ type: 'transport_error', index, code: error.code ?? error.name }));
      }
      return request;
    };
    module.get = function (...args) { const request = module.request(...args); request.end(); return request; };
  }
  syncBuiltinESMExports();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (input, options) {
    if(typeof options?.body==='string'||Buffer.isBuffer(options?.body))guard(options.body); else if(input instanceof Request)guard(await input.clone().text());
    const index = begin(new URL(typeof input === 'string' || input instanceof URL ? input : input.url), 'fetch');
    if(index!==undefined && plan.capture_sanitized_inputs) {
      if(typeof options?.body==='string'||Buffer.isBuffer(options?.body))capture(index,options.body.toString());
      else if(input instanceof Request) {try {capture(index,await input.clone().text());}catch(error){log({type:'input_not_captured',index,reason:error.name});}}
    }
    try {
      const response = await originalFetch(input, options);
      if (index !== undefined) { log({ type: 'response', index, status: response.status }); response.clone().text().then(body=>{ let redacted=body;for(const secret of secrets)redacted=redacted.split(secret).join('[REDACTED]');fs.writeFileSync(path.join(root,`output-${String(index).padStart(4,'0')}.txt`),redacted,{flag:'wx',mode:0o600}); }).catch(error=>log({type:'response_capture_error',index,reason:error.name})); }
      return response;
    } catch (error) {
      if (index !== undefined) log({ type: 'transport_error', index, code: error.code ?? error.name });
      throw error;
    }
  };
}
