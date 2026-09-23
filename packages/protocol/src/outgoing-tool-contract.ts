/** Bounded structural checks on the final tool declaration sent to a consumer.
 * This checks a declared local profile, not every rule enforced by that
 * consumer and never the canonical operation's business authorization. */
export type OutgoingToolProfile = 'mcp_portable' | 'openai_non_strict_function';
export type OutgoingToolIssue = {code:string;path:string};

const baseKeywords=new Set(['type','additionalProperties','required','properties','items','minItems','maxItems',
  'minLength','maxLength','minimum','maximum','exclusiveMinimum','exclusiveMaximum','description','enum',
  'uniqueItems','pattern','format','propertyNames','minProperties','maxProperties']);
const mcpKeywords=new Set([...baseKeywords,'$schema','$defs','definitions','$ref','anyOf','oneOf','allOf','not','const']);
const functionKeywords=new Set([...baseKeywords].filter(key=>!['propertyNames'].includes(key)));
const types=new Set(['object','array','string','integer','number','boolean','null']);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const structural=(path:string,segment:string)=>`${path==='/'?'':path}/${segment}`;

export function outgoingToolSchemaIssue(schema:unknown,profile:OutgoingToolProfile,maxBytes:number):OutgoingToolIssue|undefined {
  if (!object(schema)) return {code:'root_not_object',path:'/'};
  let bytes:number;
  try{bytes=Buffer.byteLength(JSON.stringify(schema))}catch{return {code:'schema_not_json',path:'/'}}
  if(bytes>maxBytes)return {code:'schema_exceeds_limit',path:'/'};
  const allowed=profile==='mcp_portable'?mcpKeywords:functionKeywords;
  let nodes=0;
  const definitions=(schema as Record<string,unknown>);
  const resolve=(reference:string):unknown=>{
    if(!reference.startsWith('#/'))return undefined;
    let value:unknown=definitions;
    for(const encoded of reference.slice(2).split('/')){
      if(!object(value))return undefined;
      const key=encoded.replace(/~1/gu,'/').replace(/~0/gu,'~');
      if(!Object.hasOwn(value,key))return undefined;
      value=value[key];
    }
    return value;
  };
  const visit=(node:unknown,path:string,depth:number,stack:Set<string>):OutgoingToolIssue|undefined=>{
    if(!object(node)||depth>32||++nodes>5000)return {code:'schema_work_bound',path};
    for(const key of Object.keys(node))if(!allowed.has(key))return {code:'unsupported_keyword',path:structural(path,key)};
    const rawTypes=node.type===undefined?[]:Array.isArray(node.type)?node.type:[node.type];
    if(rawTypes.some(value=>typeof value!=='string'||!types.has(value))||new Set(rawTypes).size!==rawTypes.length)
      return {code:'unsupported_type',path:structural(path,'type')};
    if(!rawTypes.length&&!('$ref'in node)&&!('anyOf'in node)&&!('oneOf'in node)&&!('allOf'in node)
      &&!('not'in node)&&!('const'in node)&&!('enum'in node)
      &&!(profile==='mcp_portable'&&(Object.keys(node).length===0||path.endsWith('/propertyNames'))))return {code:'untyped_schema',path};
    if(node.enum!==undefined&&(!Array.isArray(node.enum)||!node.enum.length))return {code:'invalid_enum',path:structural(path,'enum')};
    if(node.description!==undefined&&typeof node.description!=='string')return {code:'invalid_description',path:structural(path,'description')};
    for(const key of ['minItems','maxItems','minLength','maxLength','minProperties','maxProperties'] as const)
      if(node[key]!==undefined&&(!Number.isSafeInteger(node[key])||(node[key] as number)<0))return {code:'invalid_bound',path:structural(path,key)};
    for(const [low,high] of [['minItems','maxItems'],['minLength','maxLength'],['minProperties','maxProperties']] as const)
      if(typeof node[low]==='number'&&typeof node[high]==='number'&&node[low]>node[high])return {code:'inverted_bound',path};
    for(const key of ['pattern','format'] as const)if(node[key]!==undefined&&typeof node[key]!=='string')
      return {code:'invalid_string_constraint',path:structural(path,key)};
    if(node.$ref!==undefined){
      if(profile!=='mcp_portable'||typeof node.$ref!=='string'||stack.has(node.$ref))return {code:'unsupported_reference',path:structural(path,'$ref')};
      if(!node.$ref.startsWith('#/'))return {code:'unsupported_reference',path:structural(path,'$ref')};
      const target=resolve(node.$ref);
      if(target===undefined)return {code:'unresolved_reference',path:structural(path,'$ref')};
      const next=new Set(stack);next.add(node.$ref);
      const issue=visit(target,structural(path,'$ref'),depth+1,next);if(issue)return issue;
    }
    if(node.properties!==undefined){
      if(!object(node.properties)||node.additionalProperties!==false)return {code:'object_not_closed',path};
      if(!rawTypes.includes('object')&&!('$ref'in node))return {code:'object_without_type',path};
      if(node.required!==undefined&&(!Array.isArray(node.required)||node.required.some(key=>typeof key!=='string'||!Object.hasOwn(node.properties as object,key))
        ||new Set(node.required).size!==node.required.length))return {code:'required_property_missing',path:structural(path,'required')};
      for(const child of Object.values(node.properties)){
        const issue=visit(child,structural(path,'properties/*'),depth+1,stack);if(issue)return issue;
      }
    }else if(node.required!==undefined)return {code:'required_without_properties',path:structural(path,'required')};
    if(rawTypes.includes('object')&&node.properties===undefined){
      if(!object(node.additionalProperties)&&node.additionalProperties!==false)return {code:'unbounded_object',path};
      if(object(node.additionalProperties)){
        const issue=visit(node.additionalProperties,structural(path,'additionalProperties'),depth+1,stack);if(issue)return issue;
      }
    }
    if(node.items!==undefined){
      if(!rawTypes.includes('array'))return {code:'items_without_array',path:structural(path,'items')};
      const issue=visit(node.items,structural(path,'items'),depth+1,stack);if(issue)return issue;
    }
    if(node.propertyNames!==undefined){
      const issue=visit(node.propertyNames,structural(path,'propertyNames'),depth+1,stack);if(issue)return issue;
    }
    for(const keyword of ['anyOf','oneOf','allOf'] as const)if(node[keyword]!==undefined){
      if(!Array.isArray(node[keyword])||!node[keyword].length)return {code:'invalid_combination',path:structural(path,keyword)};
      for(const branch of node[keyword]){
        const issue=visit(branch,structural(path,`${keyword}/*`),depth+1,stack);if(issue)return issue;
      }
    }
    if(node.not!==undefined){const issue=visit(node.not,structural(path,'not'),depth+1,stack);if(issue)return issue}
    for(const keyword of ['$defs','definitions'] as const)if(node[keyword]!==undefined){
      if(!object(node[keyword]))return {code:'invalid_definitions',path:structural(path,keyword)};
      for(const child of Object.values(node[keyword])){
        const issue=visit(child,structural(path,`${keyword}/*`),depth+1,stack);if(issue)return issue;
      }
    }
    return undefined;
  };
  if(schema.type!=='object'||schema.additionalProperties!==false||!object(schema.properties))return {code:'root_not_closed_object',path:'/'};
  if(['anyOf','oneOf','allOf','not','$ref','const','enum'].some(keyword=>Object.hasOwn(schema,keyword)))
    return {code:'root_composition_not_portable',path:'/'};
  return visit(schema,'/',0,new Set());
}
