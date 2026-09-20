import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {evaluateActionRule} from '@synapsor-runner/action-rules';
import {compileActionRuleModelDraft,actionRuleDraftDiagnostics} from './action-rule-draft.js';
import {generateModelActionRuleDraft,actionRuleModelDraftJsonSchema} from './action-rule-model.js';
import {actionRuleAuthoringCheckpoint,parseActionRuleAuthoringCheckpoint} from './action-rule-authoring-checkpoint.js';
import {buildActionRuleAuthorityDraft,writeActionRuleAuthorityDraft,readActionRuleAuthorityDraft} from './action-rule-authority.js';
const captured=JSON.parse(await fs.readFile(new URL('./test-fixtures/faithful-expression.json',import.meta.url),'utf8'));
function fixture(){return structuredClone(captured);}
function compile(f:any,draft=f.draft){return compileActionRuleModelDraft({...f.options,draft});}
const parts=(d:any)=>{const {schema_version,verification,effect,approval,...rule}=d;return {verification,effect,approval,rule};};
function facts(){const scope={tenant_id:'synthetic-tenant',principal_id:'synthetic-person'};return {
  trusted:{tenant:scope.tenant_id,principal:scope.principal_id,transaction_time:'2026-09-20T00:00:00.000Z'},subject_provenance_digest:canonicalJsonDigest('diagnostic'),bindings:{
    cycle:{rows:[{...scope,cycle_id:'c',register_id:'r',state:'draft',restricted:false,follow_up:false,posted_credits:0,version:1}]},
    register:{rows:[{...scope,register_id:'r',status:'open',credited_total:11,version:1}]},
    samples:{rows:[{...scope,sample_id:'s1',cycle_id:'c',quality:'validated',credits:5,version:1},{...scope,sample_id:'s2',cycle_id:'c',quality:'validated',credits:7,version:1},{...scope,sample_id:'s3',cycle_id:'c',quality:'ignored',credits:90,version:1}]},
    notes:{rows:[{...scope,exception_id:'n1',cycle_id:'c',open:false,severity:'blocking',version:1},{...scope,exception_id:'n2',cycle_id:'c',open:true,severity:'advisory',version:1}]}}};}
describe('canonical arithmetic in the complete captured job (derived local fixtures)',()=>{
  it('retains exact illegal arithmetic refusal and separates syntax from the invented unit mismatch',()=>{
    const f=fixture(),c=f.captured_components,d={schema_version:f.draft.schema_version,...c.rule,verification:c.verification,effect:c.effect,approval:c.approval};
    try{compile(f,d);throw new Error('unexpected acceptance');}catch(e){expect(actionRuleDraftDiagnostics(e)[0]).toMatchObject({code:'ACTION_RULE_EXPRESSION_KIND_INVALID',path:'rule.derive.new_credited_total.kind',repair:'model',category:'draft_structure'});}
    d.derive.new_credited_total=f.draft.derive.new_credited_total;
    expect(()=>compile(f,d)).toThrow(/types or units/);
  });
  it.each(['add','arithmetic','untrusted-secret-kind'])('refuses %s without alias conversion or leaking the submitted discriminant',kind=>{
    const f=fixture();f.draft.derive.new_credited_total={kind,operation:'add',left:{kind:'field',binding:'register',field:'credited_total'},right:{kind:'input',name:'credits_to_post'}};
    try{compile(f);throw new Error('unexpected acceptance');}catch(e){const d=actionRuleDraftDiagnostics(e)[0]!;expect(d.code).toBe('ACTION_RULE_EXPRESSION_KIND_INVALID');expect(d.next_action).toContain('"kind":"math"');expect(d.next_action).toContain('ordered inputs');expect(JSON.stringify(d)).not.toContain('untrusted-secret-kind');}
  });
  it.each(['derive','atomic_set'])('compiles and evaluates complete policy with canonical math in %s',placement=>{
    const f=fixture();if(placement==='atomic_set'){f.draft.effect.atomic_updates[0].set.credited_total=f.draft.derive.new_credited_total;f.draft.derive={};}
    const c=compile(f),result=evaluateActionRule({compiled:c.loaded.registry.rules[0]!.compiled,facts:facts(),inputs:{credits_to_post:12},proposal_id:'test'});
    expect(result.result).toBe('eligible');if(result.result!=='eligible')throw new Error('missing effect');
    expect(result.effect.set).toEqual({posted_credits:12,state:'finalized'});expect(result.effect.atomic_updates?.[0]?.set).toEqual({credited_total:23});
    expect([result.effect,...result.effect.atomic_updates!].map(x=>[x.expected_version,x.version_advance])).toEqual(Array.from({length:2},()=>[{column:'version',value:1},{column:'version',strategy:'integer_increment'}]));
    expect(c.verification_boundary.resources.filter(x=>x.cardinality==='many').map(x=>[x.binding,x.max_rows,x.collection_consistency,x.fields.every(f=>!f.model_visible)])).toEqual([['samples',16,'complete_locked',true],['notes',16,'complete_locked',true]]);
    expect(c.draft.require).toEqual(f.draft.require);expect(c.draft.approval).toEqual(f.draft.approval);
  });
  it.each(['wrong_total','open_block','missing','null','empty','overflow','type','range','arithmetic_overflow'])('retains existing %s refusal/unknown semantics',mode=>{
    const f=fixture(),c=compile(f),v:any=facts();let input:any=12;
    if(mode==='wrong_total')input=13;if(mode==='open_block')v.bindings.notes.rows[0].open=true;
    if(mode==='missing')delete v.bindings.samples.rows[0].credits;if(mode==='null')v.bindings.samples.rows[0].credits=null;
    if(mode==='empty')v.bindings.samples.rows=[];if(mode==='overflow')v.bindings.samples.rows=Array.from({length:17},(_,i)=>({...v.bindings.samples.rows[0],sample_id:`s${i}`}));
    if(mode==='type')input='12';if(mode==='range')input=101;if(mode==='arithmetic_overflow')v.bindings.register.rows[0].credited_total=Number.MAX_SAFE_INTEGER;
    expect(evaluateActionRule({compiled:c.loaded.registry.rules[0]!.compiled,facts:v,inputs:{credits_to_post:input},proposal_id:'test'}).result).not.toBe('eligible');
  });
  it('does not accept wrong operands as the faithful increment merely because syntax compiles',()=>{
    const f=fixture();f.draft.derive.new_credited_total.inputs[0]={kind:'literal',value:0,value_type:{kind:'integer'}};
    const c=compile(f),r=evaluateActionRule({compiled:c.loaded.registry.rules[0]!.compiled,facts:facts(),inputs:{credits_to_post:12},proposal_id:'test'});
    expect(r.result).toBe('eligible');if(r.result==='eligible')expect(r.effect.atomic_updates?.[0]?.set).not.toEqual({credited_total:23});
    // Compilation is not business review; this candidate fails the sealed oracle.
  });
  it('labels invalid-expression status separately from unproven model narration and preserves the pending checkpoint',async()=>{
    const f=fixture(),intent='Resume the disabled metering settlement job.',requests:any[]=[];
    const initial=actionRuleAuthoringCheckpoint({intent_digest:canonicalJsonDigest(intent),context_digest:canonicalJsonDigest({catalog:f.options.builtCatalog.catalog,read:f.options.readBoundaryDigest,baseline:null}),components:f.captured_components});
    const requestJson=vi.fn(async(r:any)=>{requests.push(r.body);return {status:200,body:{output:requests.length===1
      ?[{type:'function_call',call_id:'invalid',name:'runner__validate_action_draft',arguments:'{}'}]
      :[{type:'message',content:[{type:'output_text',text:'The compiler cannot add these values. What should I do?'}]}]}};});
    const askClarification=vi.fn(async()=>undefined),before=structuredClone(initial);
    await expect(generateModelActionRuleDraft({...f.options,intent,checkpoint:initial,egressAcknowledged:true,
      session:{provider:'openai',model:'gpt-5.6-terra',apiKey:'local-transport',dependencies:{requestJson}},askClarification})).rejects.toThrow('CANCELLED');
    expect(requests).toHaveLength(2);expect(askClarification).toHaveBeenCalledWith(expect.stringContaining('Runner validation: an invalid generated expression'));
    expect(askClarification).toHaveBeenCalledWith(expect.stringContaining('Model response (not a compiler finding)'));
    expect(initial).toEqual(before);
  });
  it.each(['openrouter','openai'] as const)('%s delivers canonical repair in the actual next request, saves disabled authority and revalidates after restart',async provider=>{
    const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'faithful-expression-')),requests:any[]=[],intent='Complete the existing disabled metering settlement job.';
    const initial=actionRuleAuthoringCheckpoint({intent_digest:canonicalJsonDigest(intent),context_digest:canonicalJsonDigest({catalog:f.options.builtCatalog.catalog,read:f.options.readBoundaryDigest,baseline:null}),
      components:f.captured_components,reviewed_relationships:f.options.builtCatalog.catalog.relationships.map((r:any)=>r.name)});
    const complete=parts(f.draft);let step=0;
    const operations:any[][]=[ [['runner.validate_action_draft',{}]], [['runner.submit_action_rule_draft',{status:'draft',...complete.rule}],['runner.submit_approval_policy_draft',{status:'draft',...complete.approval}]], [['runner.validate_action_draft',{}]], [] ];
    const requestJson=vi.fn(async(r:any)=>{
      requests.push(structuredClone(r.body));const calls=operations[step++]!;
      const output=calls.map(([name,args],i)=>({type:'function_call',call_id:`call${step}_${i}`,name:name.replaceAll('.','__'),arguments:JSON.stringify(args)}));
      return {status:200,body:provider==='openai'?{output:output.length?output:[{type:'message',content:[{type:'output_text',text:'Disabled draft ready for review.'}]}]}:
        {choices:[{finish_reason:output.length?'tool_calls':'stop',message:{role:'assistant',content:output.length?null:'Disabled draft ready for review.',...(output.length?{tool_calls:output.map(x=>({id:x.call_id,type:'function',function:{name:x.name,arguments:x.arguments}}))}:{})}}]}};
    });
    const input={...f.options,intent,checkpoint:initial,egressAcknowledged:true,session:{provider,model:provider==='openrouter'?'openai/gpt-5.6-terra':'gpt-5.6-terra',apiKey:'synthetic-local-transport',dependencies:{requestJson}},
      onCheckpoint:async(value:any)=>fs.writeFile(path.join(root,'checkpoint.json'),JSON.stringify(value)),askClarification:async(q:string)=>{throw new Error(`Unexpected operator syntax question: ${q}`);}};
    try {
      const result=await generateModelActionRuleDraft(input);expect(result.state).toBe('ready');expect(result.authority_granted).toBe(false);
      const wire=JSON.stringify(requests[1]);expect(wire).toContain('ACTION_RULE_EXPRESSION_KIND_INVALID');expect(wire).toContain('Numeric arithmetic uses');expect(wire).toContain('ordered inputs');expect(wire).toContain('Do not invent units');
      expect(result.compiled.draft).toMatchObject(f.draft);
      const a=result.compiled.loaded.authority;
      const disabled=buildActionRuleAuthorityDraft({name:a.name,action_boundary_name:a.action_boundary.name,catalog:a.catalog,rules:a.rules,approval_classes:a.approval_classes,reviews:[{outcome:result.compiled.rule.outcome,...result.compiled.draft.review}]});
      await writeActionRuleAuthorityDraft(root,disabled);
      expect((await readActionRuleAuthorityDraft(root,a.name))?.state).toBe('disabled');
      const saved=parseActionRuleAuthoringCheckpoint(JSON.parse(await fs.readFile(path.join(root,'checkpoint.json'),'utf8')));
      operations.splice(0,operations.length,[['runner.validate_action_draft',{}]],[]);step=0;
      const restarted=await generateModelActionRuleDraft({...input,checkpoint:saved});expect(restarted.compiled.rule).toEqual(result.compiled.rule);
      if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR)await fs.writeFile(path.join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR,`expression-${provider}-wire.json`),JSON.stringify({classification:'local transport; derived corrected response; owned disabled save',requests},null,2));
    }finally{await fs.rm(root,{recursive:true,force:true});}
  });
});
