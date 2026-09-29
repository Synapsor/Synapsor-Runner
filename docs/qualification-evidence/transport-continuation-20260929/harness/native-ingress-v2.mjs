// Owned test launcher: this ingress cannot itself make provider requests.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
export async function createNativeIngress({socket,inferenceEndpoint,proxyUrl,proxyPath,metadataEndpoints=[],metadataHandler,captureRequest,privateValues=[],onEvent=()=>{}}){
 assert(!fs.existsSync(socket),'INGRESS_COLLISION');
 const allowedMetadata=new Set(metadataEndpoints);
 const active=new Set();
 const server=http.createServer((req,res)=>{
  let upstream;const disconnected=()=>{if(!res.writableFinished)upstream?.destroy(new Error('OWNER_DISCONNECTED'));};res.once('close',disconnected);req.once('aborted',disconnected);
  const work=(async()=>{try{
   assert(req.method==='POST'&&req.url==='/native','INGRESS_METHOD_PATH');
   const url=req.headers['x-tester-native-url'];const method=req.headers['x-tester-native-method'];
   assert(typeof url==='string'&&typeof method==='string','INGRESS_HEADERS');
   assert((method==='POST'&&url===inferenceEndpoint)||(method==='GET'&&allowedMetadata.has(url)),'INGRESS_NATIVE_ENDPOINT');
   let size=0;const chunks=[];for await(const c of req){size+=c.length;assert(size<=1048576,'INGRESS_BYTES');chunks.push(c);}
   const bytes=Buffer.concat(chunks);
   if(method==='GET'){
    assert(bytes.length===0&&typeof metadataHandler==='function','INGRESS_METADATA');
    const response=await metadataHandler(url);
    const b=Buffer.from(await response.arrayBuffer());assert(b.length<=8388608,'INGRESS_METADATA_BYTES');assert(!privateValues.some(v=>v&&b.toString('utf8').includes(v)),'INGRESS_METADATA_PRIVATE_VALUE');res.writeHead(response.status,{'content-type':'application/json'});res.end(b);onEvent({kind:'metadata',url,status:response.status});return;
   }
   assert(!privateValues.some(v=>v&&bytes.toString('utf8').includes(v)),'INGRESS_INPUT_PRIVATE_VALUE');if(captureRequest)await captureRequest({url,bytes:Buffer.from(bytes)});
   // Only a fixed local guarded proxy target is reachable from this server.
   const target=new URL(proxyPath,proxyUrl);assert(target.hostname==='127.0.0.1'&&target.protocol==='http:','INGRESS_LOCAL_PROXY');
   await new Promise((resolve,reject)=>{
    assert(!res.destroyed,'OWNER_DISCONNECTED');
    const up=upstream=http.request(target,{method:'POST',headers:{'content-type':req.headers['content-type']||'application/json','content-length':String(bytes.length),...Object.fromEntries(['accept','openai-project','openai-organization'].filter(k=>typeof req.headers[k]==='string').map(k=>[k,req.headers[k]]))}},response=>{
     res.writeHead(response.statusCode,{'content-type':response.headers['content-type']||'application/json',...Object.fromEntries(['x-request-id','request-id'].filter(k=>typeof response.headers[k]==='string').map(k=>[k,response.headers[k]]))});
     response.on('error',reject);response.on('end',resolve);response.pipe(res);
    });up.on('error',reject);up.end(bytes);
   });onEvent({kind:'native_forward_to_guard',url,bytes:size});
  }catch(e){onEvent({kind:'ingress_refusal',reason:/^[A-Z_]+$/.test(e.message)?e.message:'INGRESS_BOUNDARY_FAILURE'});if(!res.headersSent)res.writeHead(503,{'content-type':'application/json'});if(!res.destroyed)res.end(JSON.stringify({error:{code:'TESTER_INGRESS_REFUSED'}}));}})();
  active.add(work);work.finally(()=>{active.delete(work);res.removeListener('close',disconnected);req.removeListener('aborted',disconnected);});
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});fs.chmodSync(socket,0o600);
 return {socket,async close(){await new Promise(resolve=>server.close(resolve));await Promise.allSettled([...active]);if(fs.existsSync(socket))fs.unlinkSync(socket);}};
}
