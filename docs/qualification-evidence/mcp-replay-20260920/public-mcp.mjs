// Zero model calls. Ordinary four-tool client; exact generated reviewed launcher.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawn,execFileSync} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';
process.umask(0o077);
const E=path.dirname(fileURLToPath(import.meta.url)),R='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/mcp-replay-7be8d2a-20260920';
const [name,label,file]=process.argv.slice(2);assert(['r0','r1','t0','t1'].includes(name)&&/^[a-z0-9-]+$/.test(label));
const D=path.join(R,'operational',name,'mcp-'+label);fs.mkdirSync(D);const project=path.join(R,'operational',name,'project');
const entry=JSON.parse(fs.readFileSync(path.join(project,'.mcp.json'))).mcpServers.synapsor;
assert.equal(entry.args[0],path.join(R,'frozen/installed/node_modules/@synapsor/runner/dist/runner.mjs'));assert(entry.args.includes('--local-test-runtime'));assert.equal(path.resolve(project,entry.args[entry.args.indexOf('--project-root')+1]),project);
const log=(type,data)=>fs.appendFileSync(path.join(D,'protocol.jsonl'),JSON.stringify({at:new Date().toISOString(),type,...data})+'\n');
const child=spawn('python3',[path.join(E,'public-launch.py'),name,...entry.args.slice(1)],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH}});let seq=0,buffer='',waiters=new Map();
child.stderr.on('data',x=>fs.appendFileSync(path.join(D,'stderr.log'),x));child.stdout.on('data',x=>{buffer+=x;let i;while((i=buffer.indexOf('\n'))>=0){const s=buffer.slice(0,i);buffer=buffer.slice(i+1);let m;try{m=JSON.parse(s);}catch{log('nonprotocol',{text:s});continue;}log('receive',{message:m});const w=waiters.get(m.id);if(w){clearTimeout(w.timer);waiters.delete(m.id);m.error?w.reject(Error(JSON.stringify(m.error))):w.resolve(m.result);}}});
function rpc(method,params){const id=++seq;log('send',{id,method,params});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiters.delete(id);reject(Error('MCP bounded 60s wait'));},60000);waiters.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
const records=[];let latestRows;let result={status:'incomplete',provider_calls:0};
try{
 await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'owned-worker-operational-check',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const list=await rpc('tools/list',{});assert.deepEqual(list.tools.map(t=>t.name).sort(),['app.describe_actions','app.describe_data','app.explore_data','app.request_change']);fs.writeFileSync(path.join(D,'tools.json'),JSON.stringify(list,null,2));
 const plan=JSON.parse(fs.readFileSync(file));assert(plan.length<=10);
 for(const original of plan){
  let step=original;
  if(original.operation==='request_predeclared_subject'){
   const expected=JSON.parse(fs.readFileSync(path.join(R,'operational/subjects-private.json')))[name].candidate.candidate_ref;
   assert(latestRows?.ok&&Array.isArray(latestRows.data));const i=latestRows.data.findIndex(x=>x.candidate_ref===expected);assert(i>=0);
   const issued=latestRows.subjects.filter(x=>x.row_index===i);assert.equal(issued.length,1);assert(/^obj_/.test(issued[0].ref));
   step={name:'app.request_change',arguments:{outcome:'release.seal_candidate',subject_refs:{candidate:issued[0].ref}},expected:'ok'};
  }
  if(original.operation==='replay_previous_request'){
   const previous=records.findLast(x=>x.step.name==='app.request_change');assert(previous);
   step={...original,name:'app.request_change',arguments:previous.step.arguments,expected:'ok',replay:true};
  }
  assert(list.tools.some(t=>t.name===step.name));
  const snap=side=>execFileSync('python3',[path.join(E,'snapshot-operational.py'),name,`replay-${label}-${records.length}-${side}`],{stdio:['ignore','pipe','pipe']});
  if(step.replay)snap('before');
  if(step.name==='app.request_change'){
   const f=path.join(R,'counters.json'),c=JSON.parse(fs.readFileSync(f));assert(++c.request_change<=12);
   if(!c.final_started_at){c.final_started_at=new Date().toISOString();c.final_deadline=new Date(Date.now()+5400000).toISOString();}
   assert(Date.now()<Date.parse(c.final_deadline));fs.writeFileSync(f,JSON.stringify(c,null,2));
  }
  const response=await rpc('tools/call',{name:step.name,arguments:step.arguments});records.push({step,response});fs.writeFileSync(path.join(D,'results.json'),JSON.stringify(records,null,2));
  const v=response.structuredContent??JSON.parse(response.content.find(x=>x.type==='text').text);
  assert.deepEqual(JSON.parse(response.content.find(x=>x.type==='text').text),v,'MCP text/structured mismatch');
  if(step.replay){
   const index=records.length-1;
   execFileSync('python3',[path.join(E,'snapshot-operational.py'),name,`replay-${label}-${index}-after`],{stdio:['ignore','pipe','pipe']});
   execFileSync('python3',[path.join(E,'compare-readonly.py'),name,`replay-${label}-${index}-before`,`replay-${label}-${index}-after`],{stdio:['ignore','pipe','pipe']});
  }
  if(step.expected_projection){
   const check=(actual,expected)=>{for(const[k,x]of Object.entries(expected)){if(x&&typeof x==='object'&&!Array.isArray(x)){assert(actual?.[k]&&typeof actual[k]==='object');check(actual[k],x);}else assert.deepEqual(actual?.[k],x,`projection ${k}`)}};check(v,step.expected_projection);
  }
  if(step.name==='app.explore_data')latestRows=v;if(step.expected==='ok')assert(!response.isError&&v.ok!==false, 'Public operation refused; inspect captured safe result');
 }
 result.status='completed';result.calls=records.length;
}catch(e){result.status='failed';result.error=e.message;process.exitCode=1;}
finally{fs.writeFileSync(path.join(D,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));child.stdin.end();await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode===null)child.kill('SIGTERM');for(const w of waiters.values())clearTimeout(w.timer);}
