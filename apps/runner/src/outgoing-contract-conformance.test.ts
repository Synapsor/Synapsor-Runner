import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInactiveSemanticActionRuntime, semanticActionInputSchema } from '@synapsor-runner/mcp-server';
import { semanticActionCatalogSchema } from '../../../packages/mcp-server/src/semantic-action-schema.js';
import { outgoingToolSchemaIssue } from '@synapsor-runner/protocol';
import { createScopedExploreMcpServer } from './authoring-mcp.js';
import type { ScopedExploreRuntime } from './scoped-explore.js';

const names=['app.describe_actions','app.describe_data','app.explore_data','app.request_change'];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(){
  const observed:unknown[]=[];
  const resource={id:'synthetic.rows',label:'Synthetic Rows',description:'Test-only reviewed metadata'};
  const runtime={boundary:{pack:{name:'reviewed',resources:[resource]},activation:{digest:'sha256:'+ 'a'.repeat(64)}},
    session_fingerprint:'sha256:'+ 'b'.repeat(64),
    describe:async()=>({ok:true,resources:[{...resource,fields:[],relationships:[]}]}),
    validate:async()=>({}),
    explore:async(plan:unknown)=>{observed.push(plan);throw Error('SYNTHETIC_SOURCE_UNAVAILABLE')},
    close:async()=>{}} as unknown as ScopedExploreRuntime;
  return {runtime,observed};
}

describe('outgoing four-tool contract conformance',()=>{
  it('checks the actual tools/list declaration against representative canonical operations and retained host restrictions',async()=>{
    const f=fixture(),server=createScopedExploreMcpServer(f.runtime,{semanticActions:createInactiveSemanticActionRuntime()});
    const client=new Client({name:'outbound-contract-test',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();
    try{
      await server.connect(b);await client.connect(a);
      const listed=(await client.listTools()).tools;
      expect(listed.map(x=>x.name).sort()).toEqual(names); // New or dropped operation needs an explicit case.
      const ajv=new (Ajv as unknown as {new(options:unknown):any})({strict:false,validateFormats:false});
      const validation=Object.fromEntries(listed.map(tool=>[tool.name,ajv.compile(tool.inputSchema)])) as Record<string,(args:unknown)=>boolean>;
      const cases=[
        {tool:'app.describe_data',stage:'listing',args:{query:'Synthetic',limit:1},host:'success'},
        {tool:'app.describe_data',stage:'detail',args:{resource:'synthetic.rows',query:null,limit:0,cursor:0},host:'success'},
        {tool:'app.describe_actions',stage:'listing',args:{query:'synthetic',limit:1},host:'canonical'},
        {tool:'app.describe_actions',stage:'detail',args:{outcome:'synthetic.action',query:null,limit:null,cursor:null},host:'canonical'},
        {tool:'app.explore_data',stage:'rows',args:{plan:{kind:'rows',resource:'synthetic.rows',select:['id']}},host:'parser_reaches_runtime'},
        {tool:'app.explore_data',stage:'aggregate',args:{plan:{kind:'aggregate',resource:'synthetic.rows',measures:[{function:'count'}],top_n:5}},host:'parser_reaches_runtime'},
        {tool:'app.request_change',stage:'request',args:{outcome:'synthetic.action',subject_refs:{subject:'obj_'+ 'a'.repeat(32)}},host:'canonical'},
      ] as const;
      expect([...new Set(cases.map(c=>c.tool))].sort()).toEqual(names);
      for(const entry of cases){
        expect(validation[entry.tool]!(entry.args),`${entry.tool} ${entry.stage} wire grammar`).toBe(true);
        if(entry.tool==='app.describe_actions')expect(semanticActionCatalogSchema.safeParse(entry.args).success).toBe(true);
        if(entry.tool==='app.request_change')expect(semanticActionInputSchema(entry.tool).safeParse(entry.args).success).toBe(true);
        const result=await client.callTool({name:entry.tool,arguments:entry.args});
        const output=listed.find(tool=>tool.name===entry.tool)?.outputSchema;
        if(result.isError!==true&&output)expect(ajv.compile(output)(result.structuredContent),`${entry.tool} result contract`).toBe(true);
        if(entry.host==='success'){
          expect(result.isError).not.toBe(true);
        }
        if(entry.host==='parser_reaches_runtime')expect(f.observed).toHaveLength(entry.stage==='rows'?1:2);
      }
      const mixedData={resource:'synthetic.rows',query:'Synthetic'};
      expect(validation['app.describe_data']!(mixedData)).toBe(true); // Deliberate flat wire superset.
      const mixedResult=await client.callTool({name:'app.describe_data',arguments:mixedData});
      expect(mixedResult.isError).toBe(true);
      expect(JSON.stringify(mixedResult)).toContain('ARGUMENT_INVALID');
      const forgedCursor={cursor:'cur_'+ 'a'.repeat(43)};
      expect(validation['app.describe_data']!(forgedCursor)).toBe(true);
      const forgedResult=await client.callTool({name:'app.describe_data',arguments:forgedCursor});
      expect(forgedResult.isError).toBe(true);
      expect(JSON.stringify(forgedResult)).toContain('CATALOG_CURSOR_INVALID');
      const mixedAction={outcome:'synthetic.action',query:'mix'};
      expect(validation['app.describe_actions']!(mixedAction)).toBe(true);
      expect(semanticActionCatalogSchema.safeParse(mixedAction).success).toBe(false);
      for(const entry of [{tool:'app.describe_data',args:{unknown:true}},{tool:'app.explore_data',args:{plan:{kind:'rows',resource:'synthetic.rows'}}},
        {tool:'app.request_change',args:{outcome:'synthetic.action',subject_refs:{}}}]){
        if(entry.tool!=='app.request_change')expect(validation[entry.tool]!(entry.args)).toBe(false);
        else expect(semanticActionInputSchema(entry.tool).safeParse(entry.args).success).toBe(false);
      }
      const report={profile:'mcp_portable',adapter:'actual in-memory MCP tools/list',
        operations:listed.map(tool=>({name:tool.name,schema_sha256:digest(tool.inputSchema),output_schema_sha256:tool.outputSchema?digest(tool.outputSchema):null,
          issue:outgoingToolSchemaIssue(tool.inputSchema,'mcp_portable',131072)??null,
          tested_variants:cases.filter(entry=>entry.tool===tool.name).map(entry=>entry.stage)})),
        host_only:['describe_data detail/listing exclusion','describe_data issued cursor authenticity','describe_actions detail/listing exclusion',
          'request_change current authority and valid opaque subject','Explore reviewed resource and source execution'],
        unchecked:['native client retention on this fixture','real provider schema admission','real source execution'],
      };
      expect(report.operations.every(operation=>operation.issue===null)).toBe(true);
      if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR){mkdirSync(process.env.SYNAPSOR_TEST_EVIDENCE_DIR,{recursive:true});
        writeFileSync(join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR,'outgoing-mcp-contract-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})}
    }finally{await client.close();await server.close()}
  });
});
