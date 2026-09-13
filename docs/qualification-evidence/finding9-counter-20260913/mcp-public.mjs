// Headless public MCP client against the frozen, network-isolated installed CLI.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const owned='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/finding9-counter-454a0d2-20260913';
const installed=owned+'/frozen/installed/node_modules';
const {Client}=await import(pathToFileURL(installed+'/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
const {StdioClientTransport}=await import(pathToFileURL(installed+'/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'));
const [label,requestFile]=process.argv.slice(2);
if(!/^[a-z0-9-]+$/.test(label))throw new Error('unique log label required');
const log=fs.createWriteStream(owned+'/logs/mcp-'+label+'.jsonl',{flags:'wx',mode:0o600});
const err=fs.createWriteStream(owned+'/logs/mcp-'+label+'.stderr',{flags:'wx',mode:0o600});
const client=new Client({name:'finding9-model-free-fixture',version:'1.0.0'});
const transport=new StdioClientTransport({command:'python3',args:[process.cwd()+'/docs/qualification-evidence/finding9-counter-20260913/launch-installed.py','mcp','serve','--authoring','--project-root','.'],stderr:'pipe'});
transport.stderr?.pipe(err);
try {
 await client.connect(transport);
 const list=await client.listTools();log.write(JSON.stringify({method:'tools/list',result:list})+'\n');
 for (const input of JSON.parse(fs.readFileSync(requestFile,'utf8'))) {
  const result=await client.callTool(input,undefined,{timeout:30000});
  log.write(JSON.stringify({input,result})+'\n');console.log(JSON.stringify({input,result}));
 }
} finally { await client.close();log.end();err.end(); }
