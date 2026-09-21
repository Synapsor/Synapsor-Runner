// Synthetic qualification-accounting regression; no provider/product operation.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import {acquireBudgetLock,provisionRuntimeUsage} from './provider-budget.mjs';
assert(process.argv[2]);const root=path.resolve(process.argv[2]);fs.mkdirSync(root,{mode:0o700});
const file=path.join(root,'ledger.json');
fs.writeFileSync(file,JSON.stringify({case_allocations:[{case_id:'SYNTHETIC',transports:[{id:'SYNTHETIC-1',role:'runtime'}]}]}),{mode:0o600});
const child=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';const p=process.argv[1],fd=fs.openSync(p,'wx',0o600);process.stdout.write('ready');setTimeout(()=>{fs.closeSync(fd);fs.unlinkSync(p)},150);`,file+'.lock'],{stdio:['ignore','pipe','inherit']});
const finished=once(child,'exit');await once(child.stdout,'data');const start=performance.now();
provisionRuntimeUsage(file,'SYNTHETIC','SYNTHETIC-1',{input_tokens:2,cache_creation_input_tokens:11799,cache_read_input_tokens:0,output_tokens:159});
const waited=performance.now()-start;await finished;assert(waited>=75&&waited<500);
const fd=fs.openSync(file+'.lock','wx',0o600),blocked=performance.now();
assert.throws(()=>acquireBudgetLock(file+'.lock'),{code:'EEXIST'});const bounded=performance.now()-blocked;
assert(bounded>=500&&bounded<1000);assert(fs.existsSync(file+'.lock'));fs.closeSync(fd);fs.unlinkSync(file+'.lock');
const result={verdict:'PASS',classification:'synthetic measurement ledger only',provider_calls:0,product_calls:0,short_write_wait_ms:waited,abandoned_lock_refusal_ms:bounded,lock_never_reclaimed:true};
fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
