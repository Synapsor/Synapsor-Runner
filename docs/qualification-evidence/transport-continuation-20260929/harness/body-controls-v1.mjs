// Regression for tester011 delayed consumption and untrusted stack path.
import fs from 'node:fs';import http from 'node:http';import zlib from 'node:zlib';import assert from 'node:assert/strict';
import {createFreshTransport,safeException,traceOf} from './fresh-transport-v1.mjs';
const root=process.argv[2];fs.mkdirSync(root,{mode:0o700});const results=[];
for(const encoding of ['identity','gzip','deflate','br']){
 const body=Buffer.from('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{text:'DERIVED é '.repeat(10000)}]}})+'\n\n');
 const wire=encoding==='gzip'?zlib.gzipSync(body):encoding==='deflate'?zlib.deflateSync(body):encoding==='br'?zlib.brotliCompressSync(body):body;
 const server=http.createServer(async(req,res)=>{for await(const c of req){}res.writeHead(200,{'content-type':'text/event-stream','content-encoding':encoding});res.end(wire);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/`;
 try{const t=createFreshTransport({allowedURLs:[url],localTest:true,env:{}});const r=await t(url,{method:'POST',redirect:'error',headers:{},body:Buffer.from('{}'),attemptId:'delayed-'+encoding,signal:AbortSignal.timeout(3000)});await new Promise(r=>setTimeout(r,50));const chunks=[];for await(const c of r.body)chunks.push(c);assert.deepEqual(Buffer.concat(chunks),body);assert.equal(r.trace.upstream_wire_body_bytes,wire.length);assert.equal(r.trace.upstream_body_bytes,body.length);assert(r.trace.cleanup_complete);results.push({encoding,wire_bytes:wire.length,decoded_bytes:body.length,result:'PASS'});}finally{await new Promise(r=>server.close(r));}
}
const e=new Error('FAKE_SENTINEL_SECRET_011');e.stack='Error\n at arbitrary (/tmp/FAKE_SENTINEL_SECRET_011:18:2)';e.cause=new Error('Authorization Bearer SECRET_KEY');assert(!JSON.stringify(safeException(e)).includes('FAKE_SENTINEL_SECRET_011'));assert(!JSON.stringify(safeException(e)).includes('SECRET_KEY'));results.push({name:'untrusted-stack-and-cause-redaction',result:'PASS'});
fs.writeFileSync(root+'/RESULT.json',JSON.stringify({classification:'DERIVED delayed actual HTTP body and redaction regression for independent011',results},null,2)+'\n');console.log(JSON.stringify({root,checks:results.length,result:'PASS'}));
