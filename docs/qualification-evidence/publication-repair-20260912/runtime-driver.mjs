import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {EventEmitter,once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {qualificationSandboxArguments,qualificationEnvironment} from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/scripts/qualification-sandbox.mjs';
process.umask(0o077);
export const root=path.dirname(fileURLToPath(import.meta.url));
assert(['main','overall','collection','edit'].includes(process.env.SYNAPSOR_CASE));
export const owned=path.join(root,process.env.SYNAPSOR_CASE);
export const owner=JSON.parse(fs.readFileSync(path.join(owned,'ownership.json')));
const secrets=JSON.parse(fs.readFileSync(path.join(owned,'private.json')));
export const runtime=path.join(owned,'deterministic');fs.mkdirSync(runtime,{recursive:true});
export const log=(event,data={})=>fs.appendFileSync(path.join(runtime,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),host_pid:process.pid,event,...data})+'\n');
export const require=createRequire(path.join(owner.artifact_root,'installed/package.json'));
export const {Client}=require('pg');
export const admin=()=>new Client({connectionString:secrets.adminUrl,application_name:'qualification-observer'});
const budgetFile=path.join(root,'budget.json');
export function operation(kind,details){
 let plan=fs.existsSync(budgetFile)?JSON.parse(fs.readFileSync(budgetFile)):{started_at:new Date().toISOString(),deadline:new Date(Date.now()+90*60000).toISOString(),operations:0,maximum_operations:400,worker_invocations:0,schedules:{}};
 assert(Date.now()<Date.parse(plan.deadline)&&plan.operations<plan.maximum_operations,'Runtime budget exhausted');
 if(kind==='operator'&&details.args?.[0]==='worker'&&details.args?.[1]==='run'){plan.worker_invocations++;assert(plan.worker_invocations<=32,'Worker budget exhausted');}
 plan.operations++;fs.writeFileSync(budgetFile,JSON.stringify(plan,null,2)+'\n');log('operation',{index:plan.operations,kind,...details});
}
export function schedule(name){
 const plan=JSON.parse(fs.readFileSync(budgetFile));plan.schedules[name]=(plan.schedules[name]??0)+1;
 assert(plan.schedules[name]<=3,'Schedule repetition budget exhausted');fs.writeFileSync(budgetFile,JSON.stringify(plan,null,2)+'\n');log('schedule',{name,attempt:plan.schedules[name]});
}
export function timeout(p,ms=20000,label='operation'){
 let t;return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error(`${label} timed out`)),ms);})]).finally(()=>clearTimeout(t));
}
// A byte-preserving owned PG relay. It never writes queries or records payloads.
// Only query digests/type, backend PID (not cancellation secret), hold timing.
export class PgRelay extends EventEmitter {
 constructor(){super();this.connections=new Set();this.serial=0;this.armed=false;this.held=undefined;}
 async start(){
  this.server=net.createServer(front=>{
   const back=net.connect({path:path.join(secrets.socket,'.s.PGSQL.5432')});const c={id:++this.serial,front,back,clientBuffer:Buffer.alloc(0),serverBuffer:Buffer.alloc(0),startup:true,held:false,bytes:[],pid:null};
   this.connections.add(c);log('pg_connect',{connection:c.id});
   front.on('error',()=>{});back.on('error',()=>{});
   front.on('data',data=>{this.observeClient(c,data);back.write(data);});
   back.on('data',data=>{this.observeServer(c,data);if(c.held)c.bytes.push(data);else front.write(data);});
   front.on('close',()=>{back.destroy();this.connections.delete(c);});back.on('close',()=>front.destroy());
  });this.server.listen(0,'127.0.0.1');await once(this.server,'listening');return this.server.address().port;
 }
 observeClient(c,data){
  c.clientBuffer=Buffer.concat([c.clientBuffer,data]);
  for(;;){
   let b=c.clientBuffer;
   if(c.startup){if(b.length<4)return;const n=b.readInt32BE();if(b.length<n)return;assert(n>=8&&n<100000);c.clientBuffer=b.subarray(n);c.startup=false;continue;}
   if(b.length<5)return;const n=b.readInt32BE(1)+1;if(b.length<n)return;assert(n>=5&&n<1000000);
   const type=String.fromCharCode(b[0]),payload=b.subarray(5,n);c.clientBuffer=b.subarray(n);
   let query;
   if(type==='Q')query=payload.subarray(0,-1).toString();
   if(type==='P'){const start=payload.indexOf(0)+1,end=payload.indexOf(0,start);query=payload.subarray(start,end).toString();}
   if(query){const select=/^\s*SELECT\b/i.test(query),fact=select&&/reserve_ops/.test(query)&&/claims/.test(query);
    log('pg_query',{connection:c.id,backend_pid:c.pid,type,verb:query.trim().split(/\s/)[0],query_sha256:createHash('sha256').update(query).digest('hex'),fact_claims:fact});
    if(this.armed&&fact){this.armed=false;c.held=true;this.held=c;log('pg_hold',{connection:c.id,backend_pid:c.pid});this.emit('held',c);}
   }
  }
 }
 observeServer(c,data){
  c.serverBuffer=Buffer.concat([c.serverBuffer,data]);
  while(c.serverBuffer.length>=5){let b=c.serverBuffer,n=b.readInt32BE(1)+1;if(n<5||n>10000000){c.serverBuffer=Buffer.alloc(0);return;}if(b.length<n)return;
   if(b[0]===75){c.pid=b.readInt32BE(5);log('pg_backend',{connection:c.id,backend_pid:c.pid});}
   c.serverBuffer=b.subarray(n);
  }
 }
 arm(){assert(!this.held);this.armed=true;log('pg_arm');}
 release(){assert(this.held);const c=this.held;this.held=undefined;c.held=false;const count=c.bytes.reduce((s,b)=>s+b.length,0);for(const b of c.bytes)c.front.write(b);c.bytes=[];log('pg_release',{connection:c.id,backend_pid:c.pid,bytes_released:count});}
 async close(){if(this.held)this.release();for(const c of this.connections){c.front.destroy();c.back.destroy();}await new Promise(r=>this.server.close(r));}
}
class Inspector extends EventEmitter {
 constructor(url){super();this.ws=new WebSocket(url);this.next=0;this.pending=new Map();this.points=new Map();this.boundaries=[];this.ws.addEventListener('message',e=>void this.message(JSON.parse(e.data)));}
 async send(method,params={}){const id=++this.next;const result=new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));this.ws.send(JSON.stringify({id,method,params}));return timeout(result,10000,method);}
 async message(msg){
  if(msg.id){const p=this.pending.get(msg.id);this.pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);return;}
  if(msg.method!=='Debugger.paused')return;
  try{
   const p=msg.params,frame=p.callFrames[0],point=(p.hitBreakpoints??[]).map(id=>this.points.get(id)).find(Boolean);
   if(point){
    const result=await this.send('Debugger.evaluateOnCallFrame',{callFrameId:frame.callFrameId,expression:point.expression,returnByValue:true,throwOnSideEffect:true});
    assert(!result.exceptionDetails,'Observer expression must not change program state');
    const event={point:point.name,line:frame.location.lineNumber+1,function:frame.functionName,locals:result.result.value};
    this.boundaries.push(event);log('product_boundary',event);this.emit('boundary',event);
   }
  }catch(e){log('inspector_error',{message:e.message});this.emit('observer_error',e);}
  finally{await this.send('Debugger.resume').catch(()=>{});}
 }
 async ready(script){
  await new Promise((resolve,reject)=>{this.ws.addEventListener('open',resolve,{once:true});this.ws.addEventListener('error',reject,{once:true});});
  await this.send('Debugger.enable');
  const lines=fs.readFileSync(script,'utf8').split('\n');
  const start=lines.findIndex(s=>s==='async function withSubjectRequestTurn(store, request, operation) {');assert(start>0);
  for(const [name,needle,expression] of [
   ['subject_wait','    await previous;','({key: key2, waiting: previous !== undefined, size: turns.size})'],
   ['subject_recheck','    return await operation();','({key: key2, waited: previous !== undefined, size: turns.size})']
  ]){
   const lineNumber=lines.findIndex((s,i)=>i>start&&i<start+25&&s===needle);assert(lineNumber>0);
   const bp=await this.send('Debugger.setBreakpointByUrl',{lineNumber,url:pathToFileURL(script).href});this.points.set(bp.breakpointId,{name,expression});
   log('inspector_breakpoint',{name,resolved:bp.locations,line:lineNumber+1,script_sha256:createHash('sha256').update(fs.readFileSync(script)).digest('hex')});
  }
  await this.send('Runtime.runIfWaitingForDebugger');
 }
 close(){this.ws.close();}
}

// Only the task-owned Unix socket is rebound across the private /tmp mount.
async function sandboxArguments(options){
 const args=await qualificationSandboxArguments(options);
 const privateTmp=path.join(owned,'var-tmp');await fsp.mkdir(privateTmp,{recursive:true,mode:0o700});
 args.splice(args.length-1,0,'--ro-bind',secrets.socket,secrets.socket,'--bind',privateTmp,'/var/tmp','--setenv','NO_COLOR','1');
 return args;
}

export class PublicMcp {
 constructor(){this.next=0;this.pending=new Map();}
 async start({relay,inspector=true,identity}={}){
  execFileSync(process.execPath,[path.join(owner.artifact_root,'freeze-repair.mjs'),'--verify'],{stdio:'pipe'});
  const savedIdentity=JSON.parse(fs.readFileSync(path.join(owner.project,'.synapsor/local-test-runtime.json'))).values;
  this.env=qualificationEnvironment({...secrets.env,...savedIdentity,...identity,QUALIFICATION_MOUNT_PLAN:path.join(owned,'mount-plan.json')});
  if(relay){const url=new URL(this.env.DATABASE_URL);url.hostname='127.0.0.1';url.username=url.searchParams.get('user');url.searchParams.delete('user');url.searchParams.delete('host');url.port=String(relay.server.address().port);url.searchParams.set('sslmode','disable');this.env.DATABASE_URL=url.toString();}
  this.sandbox=await sandboxArguments({ownedRoot:owned,cwd:owner.logical,home:path.join(owned,'home'),mounts:[{logical:owner.logical,physical:owner.project}]});
  const args=['mcp','serve','--authoring','--project-root','.','--config','synapsor.runner.json'];
  const pre=spawnSync('bwrap',[...this.sandbox,process.execPath,path.join(root,'storage-preflight.mjs'),...args],{env:this.env,encoding:'utf8'});
  log('store_preflight',{args,status:pre.status,stdout:pre.stdout,stderr:pre.stderr});assert.equal(pre.status,0);
  const script=path.join(owner.artifact_root,'installed/node_modules/@synapsor/runner/dist/runner.mjs');
  this.child=spawn('bwrap',[...this.sandbox,process.execPath,...(inspector?['--inspect-brk=127.0.0.1:0']:[]),script,...args],{env:this.env,stdio:['pipe','pipe','pipe']});
  log('mcp_process',{pid:this.child.pid,store:path.join(owner.project,'.synapsor/local.db'),identity_source:'saved reviewed local identity',inspector});
  let stdout='',stderr='';const wsReady=new Promise(resolve=>this.child.stderr.on('data',data=>{stderr+=data.toString();fs.appendFileSync(path.join(runtime,'mcp-stderr.log'),data);const found=stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+/);if(found)resolve(found[0]);}));
  this.child.stdout.on('data',data=>{stdout+=data;let pos;while((pos=stdout.indexOf('\n'))>=0){const line=stdout.slice(0,pos);stdout=stdout.slice(pos+1);try{const msg=JSON.parse(line);log('mcp_receive',{message:msg});const pending=this.pending.get(msg.id);if(pending){this.pending.delete(msg.id);msg.error?pending.reject(Error(JSON.stringify(msg.error))):pending.resolve(msg.result);}}catch(e){log('mcp_parse_error',{message:e.message});}}});
  this.child.on('exit',(code,signal)=>{log('mcp_exit',{code,signal});for(const p of this.pending.values())p.reject(Error(`MCP exited ${code}/${signal}`));this.pending.clear();});
  if(inspector){this.inspector=new Inspector(await timeout(wsReady));await this.inspector.ready(script);}
  await this.rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'bounded-deterministic-qualification',version:'1'}});
  this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const listed=await this.rpc('tools/list',{});assert.deepEqual(listed.tools.map(t=>t.name).sort(),['app.describe_actions','app.describe_data','app.explore_data','app.request_change']);
  return this;
 }
 rpc(method,params){const id=++this.next;const p=new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));log('mcp_send',{message:{jsonrpc:'2.0',id,method,params}});this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return timeout(p,30000,`${method} ${id}`);}
 async call(name,args){operation('mcp',{name});const r=await this.rpc('tools/call',{name,arguments:args});return r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);}
 async close(){if(this.pending.size)await timeout(new Promise(resolve=>{const t=setInterval(()=>{if(!this.pending.size){clearInterval(t);resolve();}},10);setTimeout(()=>{clearInterval(t);resolve();},5000);}),6000).catch(()=>{});this.inspector?.close();if(this.child && this.child.exitCode===null){this.child.stdin.end();await timeout(once(this.child,'exit'),5000,'MCP close').catch(()=>this.child.kill('SIGTERM'));}}
}
export async function sourceSnapshot(name){const c=admin();await c.connect();try{const rows={};for(const table of ['portfolios','claims','freezes'])rows[table]=(await c.query(`SELECT * FROM reserve_ops.${table} ORDER BY 1`)).rows;await fsp.writeFile(path.join(runtime,name+'-source.json'),JSON.stringify(rows,null,2)+'\n',{flag:'wx'});return rows;}finally{await c.end();}}
export async function hostSnapshot(name){const c=admin();await c.connect();try{const rows=(await c.query("SELECT pid,usename,application_name,state,wait_event_type,wait_event,xact_start,query_start,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND application_name <> 'qualification-observer' ORDER BY pid")).rows;log('pg_host_snapshot',{name,rows});return rows;}finally{await c.end();}}
export function ledgerSnapshot(name){
 const db=new DatabaseSync(path.join(owner.project,'.synapsor/local.db'),{readOnly:true});const rows={};
 try{db.exec('BEGIN');for(const {name:table} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all())rows[table]=db.prepare(`SELECT * FROM "${table}"`).all();db.exec('COMMIT');}finally{db.close();}
 fs.writeFileSync(path.join(runtime,name+'-ledger.json'),JSON.stringify(rows,null,2)+'\n',{flag:'wx'});
 log('ledger_snapshot',{name,counts:Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.length]))});return rows;
}
export async function operator(args,identity={}){operation('operator',{args});const env=qualificationEnvironment({...secrets.env,SYNAPSOR_OPERATOR_ID:'local_operator',SYNAPSOR_OPERATOR_ROLES:'insurance_supervisor,writeback_operator',...JSON.parse(fs.readFileSync(path.join(owner.project,'.synapsor/local-test-runtime.json'))).values,...identity,QUALIFICATION_MOUNT_PLAN:path.join(owned,'mount-plan.json')});const sandbox=await sandboxArguments({ownedRoot:owned,cwd:owner.logical,home:path.join(owned,'home'),mounts:[{logical:owner.logical,physical:owner.project}]});const pre=spawnSync('bwrap',[...sandbox,process.execPath,path.join(root,'storage-preflight.mjs'),...args],{env,encoding:'utf8'});log('operator_preflight',{status:pre.status,stdout:pre.stdout,stderr:pre.stderr});assert.equal(pre.status,0);const child=spawn('bwrap',[...sandbox,process.execPath,path.join(owner.artifact_root,'installed/node_modules/@synapsor/runner/dist/cli.js'),...args],{env,stdio:['ignore','pipe','pipe']});log('operator_process',{pid:child.pid,args});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const [code,signal]=await timeout(once(child,'exit'),30000,'operator').catch(e=>{child.kill('SIGTERM');throw e;});log('operator_result',{pid:child.pid,args,code,signal,stdout:out,stderr:err});return {pid:child.pid,code,signal,stdout:out,stderr:err};}

export async function interactiveOperator(args){
 operation('operator',{args});
 const env=qualificationEnvironment({...secrets.env,SYNAPSOR_OPERATOR_ID:'local_operator',SYNAPSOR_OPERATOR_ROLES:'insurance_supervisor,writeback_operator',...JSON.parse(fs.readFileSync(path.join(owner.project,'.synapsor/local-test-runtime.json'))).values,QUALIFICATION_MOUNT_PLAN:path.join(owned,'mount-plan.json')});
 const sandbox=await sandboxArguments({ownedRoot:owned,cwd:owner.logical,home:path.join(owned,'home'),mounts:[{logical:owner.logical,physical:owner.project}]});
 const pre=spawnSync('bwrap',[...sandbox,process.execPath,path.join(root,'storage-preflight.mjs'),...args],{env,encoding:'utf8'});log('operator_preflight',{status:pre.status,stdout:pre.stdout,stderr:pre.stderr});assert.equal(pre.status,0);
 const child=spawn('bwrap',[...sandbox,process.execPath,path.join(owner.artifact_root,'installed/node_modules/@synapsor/runner/dist/cli.js'),...args],{env,stdio:'inherit'});log('interactive_operator_process',{pid:child.pid,args});
 const [code,signal]=await once(child,'exit');log('interactive_operator_result',{code,signal,args});process.exitCode=code??1;
}
