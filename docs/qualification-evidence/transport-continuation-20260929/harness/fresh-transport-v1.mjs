// External qualification transport, not Runner. One fresh verified socket per attempt.
// No SDK, automatic retry, redirect, provider-hosted tool, or global dispatcher mutation.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import {Transform} from 'node:stream';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const sha=x=>createHash('sha256').update(Buffer.isBuffer(x)?x:String(x)).digest('hex');
const traces=new WeakMap();
const knownCodes=new Set(['ECONNRESET','ECONNREFUSED','EPIPE','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ERR_STREAM_PREMATURE_CLOSE','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ABORT_ERR']);
const knownNames=new Set(['Error','TypeError','AbortError','TimeoutError','AssertionError']);
export function safeException(error){
  const seen=new Set(),chain=[];
  for(let e=error;e&&typeof e==='object'&&!seen.has(e)&&chain.length<5;e=e.cause){
    seen.add(e);const code=String(e.code??'');
    chain.push({name:knownNames.has(e.name)?e.name:'OtherError',code:knownCodes.has(code)?code:null,
      original_name_sha256:sha(e.name??''),original_code_sha256:sha(code),message_sha256:sha(e.message??''),message:'withheld',
      stack_locations:String(e.stack??'').split('\n').slice(1,9).map(line=>{const m=line.match(/(?:\/|node:)([^\s()]+):(\d+):(\d+)\)?$/);return m?{file_sha256:sha(m[1]),line:Number(m[2]),column:Number(m[3])}:{frame_sha256:sha(line)};})});
  }
  return chain;
}
export const traceOf=error=>traces.get(error)??null;
export function assertDirectRouteEnvironment(env=process.env){
  const names=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_USE_ENV_PROXY','GLOBAL_AGENT_HTTP_PROXY','GLOBAL_AGENT_HTTPS_PROXY'];
  assert(!names.some(n=>env[n]),'PROXY_CONFIGURATION_REQUIRES_REVIEW');
  assert(!/use-env-proxy|--require|--import/.test(env.NODE_OPTIONS??''),'PROCESS_NETWORK_HOOK_REQUIRES_REVIEW');
  assert(env.NODE_TLS_REJECT_UNAUTHORIZED!=='0','INSECURE_TLS_REFUSED');
}
export function createFreshTransport({allowedURLs,localTest=false,onEvent=()=>{},env=process.env,tlsCA}={}){
  assertDirectRouteEnvironment(env);assert(Array.isArray(allowedURLs)&&allowedURLs.length,'ENDPOINT_ALLOWLIST_REQUIRED');
  const allow=new Set(allowedURLs);let active=false;
  return async function forward(url,init){
    assert(allow.has(String(url)),'ENDPOINT_REFUSED');const u=new URL(url);
    assert(u.protocol==='https:'||(localTest&&u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)),'TLS_REQUIRED');
    assert(!u.username&&!u.password&&!u.hash,'ENDPOINT_CREDENTIALS_REFUSED');
    assert(!active,'TRANSPORT_ALREADY_ACTIVE');assert(init.method==='POST'&&init.redirect==='error','TRANSPORT_MODE');
    assert(Buffer.isBuffer(init.body),'IMMUTABLE_BYTES_REQUIRED');assert(init.signal,'ATTEMPT_SIGNAL_REQUIRED');
    assert(typeof init.attemptId==='string'&&/^[A-Za-z0-9_.:-]{1,180}$/.test(init.attemptId),'ATTEMPT_ID');
    const body=Buffer.from(init.body),start=performance.now();let socket,agent,req,response,meter,decoder,closed=false,abortOrigin=null;
    const trace={attempt_id:init.attemptId,logical_operation_id:init.logicalOperationId??init.attemptId,
      connection_id:randomUUID(),connection_reused:false,route:'direct-fresh',api_request_created:false,
      upstream_headers:false,upstream_body_bytes:0,downstream_bytes:0,callback_boundary:'not_owned_by_transport',
      body_bytes:body.length,body_sha256:sha(body),events:[],cleanup_complete:false};
    const event=(phase,data={})=>{const e={phase,at:new Date().toISOString(),elapsed_ms:performance.now()-start,...data};trace.events.push(e);try{onEvent({attempt_id:trace.attempt_id,connection_id:trace.connection_id,...e});}catch{}};
    const close=async()=>{if(closed)return;closed=true;init.signal.removeEventListener('abort',abort);decoder?.destroy();meter?.destroy();response?.destroy();req?.destroy();if(socket&&!socket.closed){const wait=new Promise(resolve=>socket.once('close',resolve));socket.destroy();await wait;}agent?.destroy();trace.cleanup_complete=true;active=false;event('owned_connection_closed');};
    const abort=()=>{abortOrigin=init.signal.reason?.name==='TimeoutError'?'attempt_timeout':'owner_or_operation';event('abort',{origin:abortOrigin});const e=new Error('TRANSPORT_ABORTED');e.name='AbortError';e.code='ABORT_ERR';req?.destroy(e);socket?.destroy(e);};
    const fail=async e=>{trace.abort_origin=abortOrigin;trace.error=safeException(e);await close();
      trace.proven_no_api_dispatch=!trace.api_request_created; // request is constructed ONLY after verified connect.
      trace.classification=abortOrigin==='owner_or_operation'||trace.upstream_headers?'C':trace.proven_no_api_dispatch?'A':'B';
      trace.retryable=trace.classification==='B'||trace.classification==='A'&&['ECONNREFUSED','EAI_AGAIN','ETIMEDOUT','ECONNRESET'].includes(e.code);
      const safe=new Error('QUALIFICATION_TRANSPORT_FAILURE');traces.set(safe,trace);return safe;};
    active=true;
    try{
      if(init.signal.aborted){abortOrigin='owner_or_operation';throw Object.assign(new Error('ALREADY_ABORTED'),{name:'AbortError',code:'ABORT_ERR'});}
      init.signal.addEventListener('abort',abort,{once:true});event('connect_begin');
      socket=await new Promise((resolve,reject)=>{
        const opts={host:u.hostname,port:Number(u.port)||(u.protocol==='https:'?443:80)};
        const s=u.protocol==='https:'?tls.connect({...opts,servername:net.isIP(u.hostname)?undefined:u.hostname,rejectUnauthorized:true,...(localTest&&tlsCA?{ca:tlsCA}:{})}):net.connect(opts);
        socket=s;s.once('error',reject);s.once(u.protocol==='https:'?'secureConnect':'connect',()=>{s.removeListener('error',reject);s.on('error',()=>{});resolve(s);});
      });
      if(init.signal.aborted)throw Object.assign(new Error('ABORTED'),{code:'ABORT_ERR'});
      event(u.protocol==='https:'?'tls_verified':'test_tcp_connected');
      const Agent=u.protocol==='https:'?https.Agent:http.Agent;agent=new Agent({keepAlive:false,maxSockets:1,maxCachedSessions:0});agent.createConnection=()=>socket;
      response=await new Promise((resolve,reject)=>{
        const headers={...init.headers,'accept-encoding':'identity','X-Client-Request-Id':init.attemptId};
        trace.api_request_created=true;event('api_request_handoff',{semantics:'HTTP request can now dispatch; not proof of provider receipt'});
        req=(u.protocol==='https:'?https:http).request(u,{method:'POST',headers,agent},res=>{trace.upstream_headers=true;trace.http_status=res.statusCode;event('response_headers',{status:res.statusCode,status_origin:'upstream'});resolve(res);});
        req.on('error',reject);req.on('finish',()=>event('request_finish',{semantics:'Node writable finished; not provider receipt',application_body_bytes:body.length}));req.end(body);
      });
      const headers=new Headers();for(const [k,v]of Object.entries(response.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):v);
      const encoding=String(response.headers['content-encoding']??'identity').trim().toLowerCase();
      assert(['identity','gzip','deflate','br'].includes(encoding),'UNSUPPORTED_CONTENT_ENCODING');
      trace.response_encoding=encoding;trace.upstream_wire_body_bytes=0;
      // Never attach a data listener to the source: it would consume bytes before
      // a delayed caller starts reading. A bounded transform retains backpressure.
      meter=new Transform({transform(chunk,encoding,callback){trace.upstream_wire_body_bytes+=chunk.length;
        if(trace.upstream_wire_body_bytes>(init.responseBound??8388608))callback(new Error('WIRE_RESPONSE_BOUND'));else callback(null,chunk);}});
      response.on('error',e=>meter.destroy(e));meter.on('error',e=>{decoder?.destroy(e);response.destroy();});
      if(encoding!=='identity'){decoder=encoding==='gzip'?zlib.createGunzip():encoding==='br'?zlib.createBrotliDecompress():zlib.createInflate();decoder.on('error',()=>{});meter.pipe(decoder);}
      response.pipe(meter);
      return {status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,headers,trace,close,body:(async function*(){try{for await(const chunk of decoder??meter){trace.upstream_body_bytes+=chunk.length;yield Buffer.from(chunk);}event('response_complete',{body_bytes:trace.upstream_body_bytes});}catch(e){throw await fail(e);}finally{await close();}})()};
    }catch(e){throw await fail(e);}
  };
}
