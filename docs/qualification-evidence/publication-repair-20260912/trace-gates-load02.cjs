// Read-only test observer: actual native gate acquisition, owners/readers and fsync timing.
const sqlite = require('node:sqlite'), fs = require('node:fs'), path = require('node:path');
const {performance} = require('node:perf_hooks');
if (!sqlite.DatabaseSync.prototype[Symbol.for('synapsor.qualification.gate-observer')]) {
Object.defineProperty(sqlite.DatabaseSync.prototype, Symbol.for('synapsor.qualification.gate-observer'), {value:true});
const folder=process.env.SYNAPSOR_TEST_EVIDENCE_DIR;
const record=(event,detail)=>{if(folder)fs.appendFileSync(path.join(folder,`gate-trace-${process.pid}.jsonl`),JSON.stringify({at:new Date().toISOString(),monotonic_ms:performance.now(),pid:process.pid,event,...detail})+'\n');};
let serial=0;const handles=new WeakMap(),statements=new WeakMap(),held=new Map();
const exec=sqlite.DatabaseSync.prototype.exec,prepare=sqlite.DatabaseSync.prototype.prepare,close=sqlite.DatabaseSync.prototype.close;
function metadata(db){if(handles.has(db))return handles.get(db);let file;try{file=prepare.call(db,'PRAGMA database_list').all().find(r=>r.name==='main')?.file;}catch{}const m={id:++serial,file,gate:typeof file==='string'&&/(runtime-admission|authority-write-lock)\.sqlite$/.test(file)};handles.set(db,m);return m;}
sqlite.DatabaseSync.prototype.exec=function(sql){const m=metadata(this),start=performance.now();const measuredStore=String(m.file).includes("synapsor-policy-migration-")&&String(m.file).endsWith("control.db");if(measuredStore)record("store_exec_start",{...m,sql:String(sql).slice(0,160)});if(m.gate)record('gate_exec_start',{...m,sql,held:[...held.values()],stack:new Error().stack.split('\n').slice(2,6)});
 try{const result=exec.call(this,sql);if(measuredStore)record("store_exec_end",{...m,sql:String(sql).slice(0,160),elapsed_ms:performance.now()-start});if(m.gate){if(/^BEGIN/.test(sql))held.set(m.id,{...m,mode:sql});if(/^(ROLLBACK|COMMIT)/.test(sql))held.delete(m.id);record('gate_exec_end',{...m,sql,elapsed_ms:performance.now()-start,transaction:this.isTransaction,held:[...held.values()]});}return result;}
 catch(e){if(m.gate)record('gate_exec_error',{...m,sql,elapsed_ms:performance.now()-start,code:e.code,errcode:e.errcode,transaction:this.isTransaction,held:[...held.values()]});throw e;}};
sqlite.DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql),m=metadata(this);if(m.gate)statements.set(statement,{...m,sql});return statement;};
const get=sqlite.StatementSync.prototype.get;
sqlite.StatementSync.prototype.get=function(...args){const m=statements.get(this),start=performance.now();try{const result=get.apply(this,args);if(m)record('gate_read',{...m,elapsed_ms:performance.now()-start,held:[...held.values()]});return result;}catch(e){if(m)record('gate_read_error',{...m,elapsed_ms:performance.now()-start,code:e.code,errcode:e.errcode,held:[...held.values()]});throw e;}};
sqlite.DatabaseSync.prototype.close=function(){const m=metadata(this);try{return close.call(this);}finally{if(m.gate){held.delete(m.id);record('gate_close',{...m,held:[...held.values()]});}}};
const promises=fs.promises,open=promises.open;
promises.open=async function(file,...args){const h=await open.call(this,file,...args);if(String(file).includes('synapsor-policy-migration-')){const sync=h.sync;h.sync=async function(){const start=performance.now();record('fsync_start',{file:String(file)});try{return await sync.call(this);}finally{record('fsync_end',{file:String(file),elapsed_ms:performance.now()-start});}};}return h;};
require('node:module').syncBuiltinESMExports();
record('observer_ready',{execArgv:process.execArgv});

}
