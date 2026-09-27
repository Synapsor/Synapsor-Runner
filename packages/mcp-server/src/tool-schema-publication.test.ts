import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpToolInputJsonSchema, portableDiscoveryInputJsonSchema, publishToolInputContracts } from "./tool-schema-publication.js";
import { semanticActionCatalogSchema, semanticActionCatalogJsonSchema } from "./semantic-action-schema.js";

describe("portable discovery declarations", () => {
  it('refuses a late incompatible tools/list replacement instead of dropping the tool', async()=>{
    const server=new McpServer({name:'publication-conformance',version:'1'},{capabilities:{tools:{}}});
    const canonical=z.object({resource:z.string()}).strict();
    publishToolInputContracts(server,name=>name==='app.describe_data'
      ? {...mcpToolInputJsonSchema(canonical),properties:{resource:{$ref:'https://untrusted.example/schema'}}}
      : undefined);
    server.registerTool('app.describe_data',{description:'Metadata',inputSchema:canonical},async()=>({content:[{type:'text',text:'unused'}]}));
    const client=new Client({name:'publication-check',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    try{await server.connect(b);await client.connect(a);
      await expect(client.listTools()).rejects.toThrow('MCP_TOOL_DECLARATION_INVALID');
    }finally{await client.close();await server.close()}
  });
  it('refuses late root composition even when the root still looks like a closed object', async()=>{
    const server=new McpServer({name:'root-composition-check',version:'1'},{capabilities:{tools:{}}});
    const canonical=z.object({resource:z.string()}).strict();
    publishToolInputContracts(server,name=>name==='app.describe_data'
      ? {...mcpToolInputJsonSchema(canonical),anyOf:[
        {type:'object',additionalProperties:false,properties:{resource:{type:'string'}}},
        {type:'object',additionalProperties:false,properties:{resource:{type:'integer'}}},
      ]} : undefined);
    server.registerTool('app.describe_data',{description:'Metadata',inputSchema:canonical},async()=>({content:[{type:'text',text:'unused'}]}));
    const client=new Client({name:'root-composition-client',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    try{await server.connect(b);await client.connect(a);
      await expect(client.listTools()).rejects.toThrow('root_composition_not_portable');
    }finally{await client.close();await server.close()}
  });
  it("projects canonical fields without changing the canonical operation validator", () => {
    const before = mcpToolInputJsonSchema(semanticActionCatalogSchema);
    const declaration = semanticActionCatalogJsonSchema();
    expect(before.anyOf).toHaveLength(3);
    expect(declaration).toMatchObject({ type: "object", additionalProperties: false });
    expect(declaration).not.toHaveProperty("anyOf");
    expect(declaration).not.toHaveProperty("required");
    expect(Object.keys(declaration.properties!)).toEqual(["outcome", "query", "limit", "cursor", "section", "contract_revision", "item"]);
    for (const args of [{}, { section: null, item: null, contract_revision: null }, { query: "label", limit: 2 }, { outcome: "example.action" },
      { outcome: "example.action", query: null, limit: null, cursor: null, section: null, item: null, contract_revision: null },
      { outcome: "example.action", section: "inputs", item: "quantity", contract_revision: `rev_${"a".repeat(43)}`, limit: 2 }]) {
      expect(semanticActionCatalogSchema.safeParse(args).success).toBe(true);
    }
    for (const args of [{ outcome: "example.action", query: "label" },
      { outcome: "example.action", limit: 2 }, { outcome: "example.action", cursor: `cur_${"a".repeat(43)}` },
      { section: "inputs" }, { outcome: "example.action", item: "quantity" },
      { outcome: "example.action", section: "inputs", query: "label" },
      { cursor: "" }, { limit: 0 }, { extra: null }]) {
      expect(semanticActionCatalogSchema.safeParse(args).success).toBe(false);
    }
    expect(mcpToolInputJsonSchema(semanticActionCatalogSchema)).toEqual(before);
  });

  it("preserves nested grammar and only common required fields across closed branches", () => {
    const plan = z.union([z.object({ kind: z.literal("rows"), select: z.array(z.string()).min(1) }).strict(),
      z.object({ kind: z.literal("count") }).strict()]);
    const source = z.union([z.object({ contract: z.literal("source"), plan }).strict(),
      z.object({ contract: z.literal("settings"), section: z.enum(["summary"]) }).strict()]);
    const declared = portableDiscoveryInputJsonSchema(source);
    expect(declared.required).toEqual(["contract"]);
    expect(declared.properties!.plan).toEqual(mcpToolInputJsonSchema(z.object({ plan }).strict()).properties!.plan);
    expect(declared.properties!.plan).toHaveProperty("anyOf");
    expect(declared.additionalProperties).toBe(false);
    expect(JSON.stringify(declared)).not.toContain('"default"');
  });

  it("fails unsupported roots rather than dropping constraints or allowing unknown keys", () => {
    for (const schema of [z.string(), z.object({ a: z.string() }).passthrough(),
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))]) {
      expect(() => portableDiscoveryInputJsonSchema(schema)).toThrow();
    }
  });
});
