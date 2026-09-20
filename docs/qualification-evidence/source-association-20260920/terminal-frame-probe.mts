// Test-only trace of the real manual editor's writes; no product instrumentation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import headless from '@xterm/headless';
const {Terminal}=headless;
import {shellQuote} from '../../../apps/runner/src/cli-format.js';
const repo=process.cwd(), root=process.argv[2]!, columns=Number(process.argv[3]??48);
await fs.mkdir(root,{recursive:true});
const helper=path.join(repo,'apps/runner/src/test-fixtures/manual-activation-terminal.ts');
const terminal=new Terminal({cols:columns,rows:30,allowProposedApi:true});
const child=spawn('script',['-qefc',`stty cols ${columns} rows 30; ${shellQuote(path.join(repo,'node_modules/.bin/tsx'))} ${shellQuote(helper)} ${shellQuote(path.join(root,'project'))} oversized`,'/dev/null'],{env:{PATH:process.env.PATH,HOME:root,TMPDIR:'/var/tmp',NO_COLOR:'1',TERM:'xterm-256color',NODE_NO_WARNINGS:'1'},stdio:['pipe','pipe','pipe']});
let paint=Promise.resolve(),output='',chunks:any[]=[],header:any,complete:any;
const screen=()=>Array.from({length:30},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');
const exit=new Promise(resolve=>child.once('exit',resolve));
child.stdout.on('data',(chunk:Buffer)=>{output+=chunk.toString();chunks.push({at:Date.now(),bytes:chunk.length,text:chunk.toString()});paint=paint.then(()=>new Promise<void>(resolve=>terminal.write(chunk,()=>{const s=screen();if(!header&&s.includes('EDIT ACCESS'))header={at:Date.now(),screen:s,blocker_visible:s.includes('Inspect activation blocker')};if(!complete&&s.includes('Inspect activation blocker')){complete={at:Date.now(),screen:s};child.stdin.write('Q');}resolve();})));});
child.stderr.on('data',c=>{output+=String(c);});
const timeout=setTimeout(()=>child.kill('SIGTERM'),15000);await exit;clearTimeout(timeout);await paint;
// Replay the real complete output in a labelled split-transport control. A
// header paint completes before later bytes of the same frame are delivered.
const split=new Terminal({cols:columns,rows:30,allowProposedApi:true});const start=output.indexOf('EDIT ACCESS');const end=output.indexOf('\r\n',start)+2;
await new Promise<void>(r=>split.write(output.slice(0,end),r));
const prefix=Array.from({length:30},(_,i)=>split.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');
const result={classification:'Real owned PTY read-only editor trace plus labelled transport-split measurement control',columns,exit:child.exitCode,header,complete,split_control:{header_seen:prefix.includes('EDIT ACCESS'),blocker_seen:prefix.includes('Inspect activation blocker'),screen:prefix},write_chunks:chunks.length};
await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(root,'chunks.json'),JSON.stringify(chunks));
console.log(JSON.stringify({...result,header:header&&{blocker_visible:header.blocker_visible},complete:Boolean(complete),split_control:{header_seen:result.split_control.header_seen,blocker_seen:result.split_control.blocker_seen}}));terminal.dispose();split.dispose();
