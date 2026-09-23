import { describe, expect, it } from 'vitest';
import { outgoingToolSchemaIssue } from './outgoing-tool-contract.js';

const closed = (property: unknown = {type:'string'}) => ({
  type:'object', additionalProperties:false, properties:{value:property}, required:['value'],
});

describe('final outbound tool schema profile', () => {
  it('accepts a bounded closed function and preserves optional versus nullable fields', () => {
    const schema={...closed(),properties:{required:{type:'string'},optional:{type:['string','null']}},required:['required']};
    expect(outgoingToolSchemaIssue(schema,'openai_non_strict_function',4096)).toBeUndefined();
    expect(schema.required).toEqual(['required']);
  });
  it('separates the portable MCP and nonstrict function profiles', () => {
    const schema=closed({anyOf:[{type:'string'},{type:'null'}]});
    expect(outgoingToolSchemaIssue(schema,'mcp_portable',4096)).toBeUndefined();
    expect(outgoingToolSchemaIssue(schema,'openai_non_strict_function',4096)).toEqual({
      code:'unsupported_keyword',path:'/properties/*/anyOf',
    });
  });
  it('refuses root composition added after publication while retaining nested MCP alternatives', () => {
    const injected={...closed(),anyOf:[closed({type:'string'}),closed({type:'integer'})]};
    expect(outgoingToolSchemaIssue(injected,'mcp_portable',4096)).toEqual({
      code:'root_composition_not_portable',path:'/',
    });
    expect(outgoingToolSchemaIssue({...closed(),$ref:'#/$defs/alternative',$defs:{alternative:closed()}},'mcp_portable',4096)?.code).toBe('root_composition_not_portable');
    expect(outgoingToolSchemaIssue(closed({anyOf:[{type:'string'},{type:'integer'}]}),'mcp_portable',4096)).toBeUndefined();
  });
  it('resolves bounded local references and refuses remote or recursive references', () => {
    const local={...closed({$ref:'#/$defs/text'}),$defs:{text:{type:'string'}}};
    expect(outgoingToolSchemaIssue(local,'mcp_portable',4096)).toBeUndefined();
    expect(outgoingToolSchemaIssue(closed({$ref:'https://example.invalid/schema'}),'mcp_portable',4096)?.code).toBe('unsupported_reference');
    expect(outgoingToolSchemaIssue({...closed({$ref:'#/$defs/again'}),$defs:{again:{$ref:'#/$defs/again'}}},'mcp_portable',4096)?.code).toBe('unsupported_reference');
  });
  it('rejects unsupported keys, missing required properties, open roots and size overflow', () => {
    expect(outgoingToolSchemaIssue(closed({type:'string',oneOf:[{type:'string'}]}),'openai_non_strict_function',4096)?.code).toBe('unsupported_keyword');
    expect(outgoingToolSchemaIssue({...closed(),required:['missing']},'mcp_portable',4096)?.code).toBe('required_property_missing');
    expect(outgoingToolSchemaIssue({...closed(),additionalProperties:true},'mcp_portable',4096)?.code).toBe('root_not_closed_object');
    expect(outgoingToolSchemaIssue(closed(),'mcp_portable',8)?.code).toBe('schema_exceeds_limit');
  });
});
