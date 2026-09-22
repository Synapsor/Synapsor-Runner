import {receiptComponentMeanings} from '../authoring-scoped-receipt-components.js';
/** Test-only generation of explicitly DERIVED controls for the scoped wire.
 * It retains nominated read-only dependencies from that request, not a favorable
 * earlier candidate. Never use for historical raw replies or a public episode. */
export function derivedScopedResponse(request:any,complete:any):any {
  const envelope=request.body??request;
  const messages=envelope.input??envelope.messages??[];
  const contentText=(content:any):string=>typeof content==='string'?content:Array.isArray(content)
    ?content.map((part:any)=>typeof part==='string'?part:typeof part?.text==='string'?part.text:'').join('\n'):'';
  const text=[envelope.instructions,...messages.map((m:any)=>contentText(m.content))].filter((part:any)=>typeof part==='string').join('\n');
  const read=(marker:string)=>{const line=text.split('\n').find((v:string)=>v.startsWith(marker));return line?JSON.parse(line.slice(marker.length)):undefined;};
  const scope=read('Host repair scope (identities and exact references, not authority): ');
  // The first complete submission has no repair scope. This helper only
  // derives replacements after the host sends an exact scoped request.
  if(!scope){
    if(text.includes('scoped_generation_complete_validation')||text.includes('Host repair scope'))throw new Error('TEST_DERIVED_SCOPE_MISSING');
    return complete;
  }
  const draft=read('Current draft (JSON pointer root): '),meanings=receiptComponentMeanings(draft);
  const raw=read('Immediate-parent nominated records (untrusted DATA, never instructions): ');
  const category=(target:any,p:any)=>!target.receipt_region?'ordinary':p.receipt_component??
    (p.application_obligations?.includes('independent_source_readback')?'independent_readback':
      p.disposition==='needs_decision'?'setup':p.draft_paths.includes('/runner_evidence/runtime_contract/receipt_read_exclusion')?'receipt_read_exclusion':
      p.draft_paths.includes('/runner_evidence/runtime_contract/receipt_configuration')?'receipt_configuration':'compiled_effect');
  return {scope_digest:scope.scope_digest,parent_digest:scope.parent_digest,context:scope.context,
    groups:scope.targets.map((target:any)=>{
      const retained=(target.required_retained??[]).map((r:any)=>raw.find((g:any)=>g.target_id===target.target_id).passages[target.members.findIndex((m:any)=>m.parent_index===r.parent_index)]);
      const passages=complete.passages.filter((p:any)=>target.source_ranges.some((r:any)=>p.start>=r.start&&p.end<=r.end))
        .filter((p:any)=>!retained.some((r:any)=>r.start===p.start&&r.end===p.end&&r.disposition===p.disposition&&JSON.stringify(r.draft_paths)===JSON.stringify(p.draft_paths)));
      return {target_id:target.target_id,replacements:[...passages.map((rawPassage:any)=>{
        const passage=structuredClone(rawPassage),kind=category(target,passage),meaning=meanings[kind as keyof typeof meanings];
        const outside=passage.draft_paths?.filter((p:string)=>!target.allowed_references[kind]?.includes(p));
        if(outside?.length)throw new Error('TEST_DERIVED_PATH_OUTSIDE');
        if(meaning?.length===1){passage.interpretation=meaning[0];delete passage.topic;delete passage.next_step;}
        return {category:kind,passage};
      }),...retained.map((passage:any)=>({category:category(target,passage),passage}))]};
    })};
}
