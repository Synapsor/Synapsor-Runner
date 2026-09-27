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
import type { ScopedExploreBoundarySetRuntime } from './scoped-explore-boundary-set.js';

const names=['app.describe_actions','app.describe_data','app.explore_data','app.request_change'];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Derive required navigation families from the actual published declarations,
// rather than maintaining another schema registry. Adding these arguments must
// not leave the release coverage report with only the former list/detail cases.
function declaredStages(tool: { name: string; inputSchema: { properties?: Record<string, unknown> } }): string[] {
  const fields=tool.inputSchema.properties??{};
  const base=tool.name==='app.explore_data'?['rows','aggregate']:tool.name==='app.request_change'?['request']:['listing','detail'];
  return [...base,...('section' in fields?['section_index','section_index_continue','section_page','section_item','section_continue']:[]),
    ...('page_rows' in fields?['rows_page_start','rows_page_continue']:[])];
}
function fixture(){
  const observed:unknown[]=[];
  const resource={id:'synthetic.rows',label:'Synthetic Rows',description:'Test-only reviewed metadata'};
  const boundary={pack:{name:'reviewed',resources:[resource]},activation:{digest:'sha256:'+ 'a'.repeat(64)},budgets:{max_rows:3,max_response_bytes:32768}};
  // Synthetic authorized descriptor/executor seams; the real SDK declaration,
  // canonical dispatch, section publisher and continuation run unchanged.
  // Real SQL/authority accounting is covered by scoped-explore.test.ts.
  const runtime={boundaries:[boundary],active_boundary_set_digest:'sha256:'+ 'c'.repeat(64),
    session_fingerprint:'sha256:'+ 'b'.repeat(64),
    describe:async()=>({ok:true,resources:[{...resource,fields:[{id:'id',type:'text'},{id:'label',type:'text'}],relationships:[]}]}),
    validate:async(plan:unknown)=>({normalized_plan:plan,boundary_name:'reviewed',boundary_digest:boundary.activation.digest,
      generation_lock_fingerprint:'lock',database_engine:'postgres',trusted_scope:{tenant:'owned',principal:'owned'}}),
    explore:async(plan:unknown)=>{observed.push(plan);
      if((plan as {limit?:number}).limit===3)return {ok:true,kind:'rows',source_database_changed:false,
        outcome:{type:'success',status:'ok',result:{}},data:[{id:'one'},{id:'two'},{id:'three'}]};
      throw Error('SYNTHETIC_SOURCE_UNAVAILABLE')},
    projectResultForModel:({result}:{result:Record<string,unknown>})=>({value:result,withheld:false}),
    close:async()=>{}} as unknown as ScopedExploreBoundarySetRuntime;
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
        {tool:'app.describe_data',stage:'section_index',args:{resource:'synthetic.rows',section:'@sections',limit:1},host:'success'},
        {tool:'app.describe_data',stage:'section_index_continue',args:{resource:'synthetic.rows',section:'@sections',limit:1},host:'success'},
        {tool:'app.describe_data',stage:'section_page',args:{resource:'synthetic.rows',section:'fields',limit:1},host:'success'},
        {tool:'app.describe_data',stage:'section_item',args:{resource:'synthetic.rows',section:'fields',item:'id'},host:'success'},
        {tool:'app.describe_data',stage:'section_continue',args:{resource:'synthetic.rows',section:'fields',limit:1},host:'success'},
        {tool:'app.describe_actions',stage:'section_index',args:{outcome:'synthetic.action',section:'@sections',limit:1},host:'canonical'},
        {tool:'app.describe_actions',stage:'section_index_continue',args:{outcome:'synthetic.action',section:'@sections',limit:1,cursor:'cur_'+ 'a'.repeat(43)},host:'canonical'},
        {tool:'app.describe_actions',stage:'section_page',args:{outcome:'synthetic.action',section:'inputs',limit:1},host:'canonical'},
        {tool:'app.describe_actions',stage:'section_item',args:{outcome:'synthetic.action',section:'inputs',item:'units'},host:'canonical'},
        {tool:'app.describe_actions',stage:'section_continue',args:{outcome:'synthetic.action',section:'inputs',limit:1,cursor:'cur_'+ 'a'.repeat(43)},host:'canonical'},
        {tool:'app.explore_data',stage:'rows',args:{plan:{kind:'rows',resource:'synthetic.rows',select:['id']}},host:'parser_reaches_runtime'},
        {tool:'app.explore_data',stage:'aggregate',args:{plan:{kind:'aggregate',resource:'synthetic.rows',measures:[{function:'count'}],top_n:5}},host:'parser_reaches_runtime'},
        {tool:'app.explore_data',stage:'rows_page_start',args:{plan:{kind:'rows',resource:'synthetic.rows',select:['id'],limit:3},page_rows:1},host:'success'},
        {tool:'app.explore_data',stage:'rows_page_continue',args:{plan:{kind:'rows',resource:'synthetic.rows',select:['id'],limit:3},page_rows:1},host:'success'},
        {tool:'app.request_change',stage:'request',args:{outcome:'synthetic.action',subject_refs:{subject:'obj_'+ 'a'.repeat(32)}},host:'canonical'},
      ] as const;
      expect([...new Set(cases.map(c=>c.tool))].sort()).toEqual(names);
      for(const tool of listed)expect(cases.filter(entry=>entry.tool===tool.name).map(entry=>entry.stage).sort(),
        `${tool.name} declared stage coverage`).toEqual(declaredStages(tool).sort());
      let sectionCursor:unknown,sectionRevision:unknown,indexCursor:unknown,indexRevision:unknown,rowCursor:unknown;
      for(const entry of cases){
        const args={...entry.args,...(entry.tool==='app.describe_data'&&entry.stage==='section_continue'?{cursor:sectionCursor,contract_revision:sectionRevision}:{}),
          ...(entry.tool==='app.describe_data'&&entry.stage==='section_index_continue'?{cursor:indexCursor,contract_revision:indexRevision}:{}),
          ...(entry.stage==='rows_page_continue'?{cursor:rowCursor}:{})};
        expect(validation[entry.tool]!(args),`${entry.tool} ${entry.stage} wire grammar`).toBe(true);
        if(entry.tool==='app.describe_actions')expect(semanticActionCatalogSchema.safeParse(args).success).toBe(true);
        if(entry.tool==='app.request_change')expect(semanticActionInputSchema(entry.tool).safeParse(args).success).toBe(true);
        const result=await client.callTool({name:entry.tool,arguments:args});
        const output=listed.find(tool=>tool.name===entry.tool)?.outputSchema;
        if(result.isError!==true&&output)expect(ajv.compile(output)(result.structuredContent),`${entry.tool} result contract`).toBe(true);
        if(entry.host==='success'){
          expect(result.isError,JSON.stringify(result)).not.toBe(true);
        }
        if(entry.host==='parser_reaches_runtime')expect(f.observed).toHaveLength(entry.stage==='rows'?1:2);
        const value=result.structuredContent as Record<string,unknown>|undefined;
        if(entry.tool==='app.describe_data'&&entry.stage==='section_index'){
          indexCursor=value?.next_cursor;indexRevision=(value?.contract_navigation as Record<string,unknown>)?.revision;
          expect(indexCursor).toMatch(/^cur_/);
        }
        if(entry.tool==='app.describe_data'&&entry.stage==='section_page'){
          sectionCursor=value?.next_cursor;sectionRevision=(value?.contract_section as Record<string,unknown>)?.revision;
          expect(sectionCursor).toMatch(/^cur_/);
        }
        if(entry.stage==='rows_page_start'){rowCursor=value?.next_cursor;expect(rowCursor).toMatch(/^cur_/)}
        if(entry.stage==='rows_page_continue'){
          expect(value?.data).toEqual([{id:'two'}]);expect(f.observed).toHaveLength(3); // No second query.
        }
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
      for(const args of [{resource:'synthetic.rows',section:'fields',query:'mixed'},
        {resource:'synthetic.rows',section:'fields',limit:2,cursor:sectionCursor,contract_revision:sectionRevision}]){
        expect(validation['app.describe_data']!(args)).toBe(true);
        expect((await client.callTool({name:'app.describe_data',arguments:args})).isError).toBe(true);
      }
      for(const args of [{plan:{kind:'rows',resource:'synthetic.rows',select:['id'],limit:3},page_rows:1,cursor:'cur_'+ 'a'.repeat(43)},
        {plan:{kind:'aggregate',resource:'synthetic.rows',measures:[{function:'count'}]},page_rows:1}]){
        expect(validation['app.explore_data']!(args)).toBe(true);
        expect((await client.callTool({name:'app.explore_data',arguments:args})).isError).toBe(true);
      }
      expect(f.observed).toHaveLength(3); // Refusals and continuation never query again.
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
          declared_variants:declaredStages(tool),tested_variants:cases.filter(entry=>entry.tool===tool.name).map(entry=>entry.stage)})),
        host_only:['describe_data detail/listing exclusion','describe_data issued cursor authenticity','describe_actions detail/listing exclusion',
          'request_change current authority and valid opaque subject','Explore reviewed resource and source execution'],
        unchecked:['native client retention on this fixture','real provider schema admission','real source execution',
          'active Action section dispatch (canonical parser here; semantic-actions discovery companions exercise authorized registry)'],
      };
      expect(report.operations.every(operation=>operation.issue===null)).toBe(true);
      if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR){mkdirSync(process.env.SYNAPSOR_TEST_EVIDENCE_DIR,{recursive:true});
        writeFileSync(join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR,'outgoing-mcp-contract-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})}
    }finally{await client.close();await server.close()}
  });
});
