import { outgoingToolSchemaIssue } from '@synapsor-runner/protocol';

/** Check the final encoded function parameters, after the selected adapter has
 * transformed canonical authoring tools and before an upstream request. */
export function coverageToolDeclarationIssue(body:Record<string,unknown>,maxSchemaBytes:number,required=false):string|undefined {
  if(!Array.isArray(body.tools))return required?'review_tool_missing@/tools':undefined;
  let matched=0;
  for(const tool of body.tools){
    if(!tool||typeof tool!=='object'||Array.isArray(tool))continue;
    const entry=tool as Record<string,unknown>;
    const definition=entry.function&&typeof entry.function==='object'&&!Array.isArray(entry.function)
      ?entry.function as Record<string,unknown>:entry;
    if(definition.name!=='runner__review_policy_coverage')continue;
    matched++;
    if(definition.strict===true)return 'strict_mode_is_not_the_selected_coverage_tool_contract@/tools/*/strict';
    const issue=outgoingToolSchemaIssue(definition.parameters,'openai_non_strict_function',maxSchemaBytes);
    if(issue)return `${issue.code}@/tools/*/parameters${issue.path}`;
  }
  if(required&&matched!==1)return 'review_tool_missing_or_duplicated@/tools';
  return undefined;
}
