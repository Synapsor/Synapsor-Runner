import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(new URL('../../../package.json',import.meta.url));const {Terminal}=require('@xterm/headless');
const [source,out]=process.argv.slice(2);const terminal=new Terminal({cols:100,rows:30,allowProposedApi:true,scrollback:10000});
const input=fs.readFileSync(source,'utf8').replace(/^Script started[^\n]*\n/,'');await new Promise(r=>terminal.write(input,r));
const lines=Array.from({length:30},(_,i)=>terminal.buffer.active.getLine(terminal.buffer.active.baseY+i)?.translateToString(true)??'');
fs.writeFileSync(out+'.json',JSON.stringify({source,columns:100,rows:30,lines},null,2));fs.writeFileSync(out+'.txt',lines.join('\n')+'\n');terminal.dispose();
