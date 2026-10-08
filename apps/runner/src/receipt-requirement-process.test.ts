import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root,{recursive:true,force:true}); });
const driver = fileURLToPath(new URL('../../../docs/development/b60-production-host/restart-driver.mjs', import.meta.url));

it.each(['raw_answer','proposal','confirmation','source_projection','acknowledgement'])
('reopens %s in a fresh OS process through the production host and native Source/Resume writers',async point=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'receipt-process-'));roots.push(root);await fs.chmod(root,0o700);
  const run=async(operation:string,fault='none')=>{
    const invocation=randomUUID();
    let exit=0,stderr='';
    try { await execute('bwrap',['--die-with-parent','--unshare-net','--ro-bind','/','/','--bind',root,root,
      '--proc','/proc','--dev','/dev',process.execPath,driver,root,operation,fault],{timeout:15_000,
      env:{PATH:process.env.PATH,HOME:root,TMPDIR:root,RECEIPT_PROOF_INVOCATION:invocation}}); }
    catch(error){exit=(error as {code?:number}).code??-1;stderr=String((error as {stderr?:string}).stderr??'');}
    const result=JSON.parse(await fs.readFile(path.join(root,`result-${invocation}.json`),'utf8'));
    expect(result.invocation).toBe(invocation);expect(result.operation).toBe(operation);expect(result.fault).toBe(fault);
    return {exit,stderr,...result};
  };
  expect((await run('init')).exit).toBe(0);
  const first=await run('run',point);expect(first.exit).toBe(78);expect(first.error).toBe(`DECLARED_INTERRUPTION:${point}`);
  const before=await fs.readFile(path.join(root,'model-calls.jsonl'),'utf8').catch(()=> '');
  const second=await run('run');expect(second.exit).toBe(0);expect(second.pid).not.toBe(first.pid);
  expect(second.result.kind).toBe('saved');expect(second.questions).toHaveLength(1);
  expect(second.questions[0].raw_answer).toEqual(first.questions[0].raw_answer);
  expect(second.questions[0].confirmation).toBeDefined();expect(second.source_reviews.at(-1).decision).toBe('confirmed');
  const after=await fs.readFile(path.join(root,'model-calls.jsonl'),'utf8');
  expect(after.trim().split('\n')).toHaveLength(1);
  if(point!=='raw_answer')expect(after).toBe(before);
  expect(second.prompts).toBe(0);
  expect(second.decisions).toBe(['raw_answer','proposal'].includes(point)?1:0);
  const third=await run('run');expect(third.exit).toBe(0);expect(third.pid).not.toBe(second.pid);
  expect(third.result).toEqual({kind:'saved',disposition:'reused'});
  expect(third.questions).toEqual(second.questions);expect(third.prompts).toBe(0);expect(third.decisions).toBe(0);
  expect(await fs.readFile(path.join(root,'model-calls.jsonl'),'utf8')).toBe(after);
});
