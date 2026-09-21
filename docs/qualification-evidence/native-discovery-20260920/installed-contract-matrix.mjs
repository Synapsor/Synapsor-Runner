// Real producer/SDK conformance on an owned deployed source. Discovery only.
import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const Ajv=createRequire(new URL('../../../apps/runner/package.json',import.meta.url))('ajv');
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
process.umask(0o077);
const plan=JSON.parse(await fs.readFile(process.argv[2],'utf8')),config=JSON.parse(await fs.readFile(process.argv[3],'utf8'));
const output=path.join(plan.owned_root,process.argv[4]);await fs.mkdir(output);
const entry=config.mcpServers[plan.selected_mcp_server],env=JSON.parse(await fs.readFile(plan.private_runtime_environment,'utf8'));
assert(entry.command==='/usr/bin/node'&&Object.keys(env).join()==='DATABASE_URL');
const observerPlan=path.join(output,'observer-plan.json');await fs.writeFile(observerPlan,JSON.stringify({command:entry.command,args:entry.args,installed_mcp_entrypoint:entry.args[0],ledger:plan.ledger,case_id:plan.case_id,role:'deterministic',capture_file:plan.logical_protocol_capture.replace('.jsonl','-'+process.argv[4]+'.jsonl')})+'\n');
const client=new Client({name:'installed-discovery-conformance',version:'1'});const transport=new StdioClientTransport({command:'bwrap',args:[...plan.sandbox_args,'/usr/bin/node',fileURLToPath(new URL('./mcp-observer.mjs',import.meta.url)),observerPlan],env:{PATH:process.env.PATH,HOME:plan.home,NO_COLOR:'1',...env},stderr:'pipe'});
const rows=[];try{await client.connect(transport);const catalog=await client.listTools();await fs.writeFile(path.join(output,'catalog.json'),JSON.stringify(catalog,null,2)+'\n');const ajv=new Ajv({strict:false,validateFormats:false});
for(const [tool,key,id] of [['app.describe_data','resource','release_ops.release_assessments'],['app.describe_actions','outcome','release.clear_assessment']]){
 const schema=catalog.tools.find(t=>t.name===tool).inputSchema,validate=ajv.compile(schema);
 const candidates=[['empty',{}],['listing',{query:'release',limit:1}],['detail',{[key]:id}],['strict-detail',{[key]:id,query:null,limit:null,cursor:null}],['strict-listing',{[key]:null,query:'release',limit:1,cursor:null}],['mixed-query',{[key]:id,query:'release'}],['mixed-limit',{[key]:id,limit:1}],['mixed-cursor',{[key]:id,cursor:'cur_'+'a'.repeat(43)}],['empty-cursor',{cursor:''}],['fabricated-cursor',{cursor:'cur_'+'a'.repeat(43)}],['unknown-key',{extra:null}],['wrong-type',{[key]:12}],['unavailable',{[key]:'unavailable.unknown'}]];
 if(key==='resource')candidates.push(['detail-neutral-zero',{boundary:null,resource:id,query:null,limit:0,cursor:0}],['boundary-detail',{boundary:'reviewed_staging',resource:id}],['boundary-listing',{boundary:'reviewed_staging',limit:1}]);
 for(const[label,args]of candidates){const wire=validate(args);const result=await client.callTool({name:tool,arguments:args});const value=result.structuredContent??{};const text=JSON.stringify(result.content??[]);const code=value.error_code??(result.isError?'SDK_ARGUMENT_REFUSAL':null);rows.push({tool,label,arguments:args,wire_valid:wire,host_success:result.isError!==true,host_code:code,client_retained:'measured separately by native-ingestion gate',response_keys:Object.keys(value)});
 const expectedSuccess=['empty','listing','detail','strict-detail','strict-listing','detail-neutral-zero','boundary-detail','boundary-listing'].includes(label);assert.equal(result.isError!==true,expectedSuccess,tool+' '+label);
 }
}
await fs.writeFile(path.join(output,'CONFORMANCE.json'),JSON.stringify({source_entrypoint:entry.args[0],rows,provider_calls:0,business_calls:0},null,2)+'\n');console.log(JSON.stringify({rows:rows.length,status:'PASS',output}));
}finally{await client.close();}
