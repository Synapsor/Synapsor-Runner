// Diagnostic only. Never writes authority or supplies a public authoring start.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { compileActionRuleModelDraft, actionRuleDraftDiagnostics, ACTION_RULE_MODEL_DRAFT_VERSION } from '../../../apps/runner/src/action-rule-draft.js';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { evaluateActionRule } from '@synapsor-runner/action-rules';
const root=process.argv[2];
const read=(n:string)=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8'));
const authoring=read('B-authoring-catalog.json'), boundary=read('B-read-context.json').boundary, components=read('B-captured-components.json');
// Lossless compiler-field projection of the captured structural catalog. This
// does not establish runtime visibility or a reviewed source connection.
const catalog={schema_version:'synapsor.action-rule-catalog.v1',generation_lock_fingerprint:authoring.generation_lock_fingerprint,
  resources:authoring.resources.map((r:any)=>({name:r.name,source:authoring.source,engine:authoring.engine,schema:r.name.split('.')[0],table:r.name.split('.')[1],
    primary_key:r.primary_key,tenant_key:r.tenant_key,principal_scope_key:r.principal_key,version_field:r.selected_version_field,
    fields:r.fields.map(({name,type,nullable}:any)=>({name,type,nullable}))})),relationships:authoring.relationships};
const draft={schema_version:ACTION_RULE_MODEL_DRAFT_VERSION,...components.rule,verification:components.verification,effect:components.effect,approval:components.approval};
const options={builtCatalog:{authoring,catalog},readBoundary:boundary,readBoundaryDigest:canonicalJsonDigest(boundary)};
const results:any[]=[];
function attempt(label:string,d:any,opts:any=options){try{const compiled=compileActionRuleModelDraft({...opts,draft:d});results.push({label,result:'compiled'});return compiled;}catch(e){results.push({label,result:'refused',diagnostics:actionRuleDraftDiagnostics(e)});return undefined;}}
assert.equal(attempt('unchanged illegal arithmetic capture',draft),undefined);
const math={kind:'math',operation:'add',inputs:[{kind:'field',binding:'register',field:'credited_total'},{kind:'input',name:'credits_to_post'}]};
const canonical=structuredClone(draft);canonical.derive.new_credited_total=math;
attempt('canonical syntax only; captured invented unit retained',canonical);
// The original OWNER-FACTS explicitly says dimensionless points. This is a
// separately authored diagnostic, not an automatic correction of a model reply.
delete canonical.inputs[0].type.unit;
const derived=attempt('canonical derive; original dimensionless owner contract',canonical);
assert(derived,'Canonical derived representation must compile before B product work');
const direct=structuredClone(canonical);direct.derive={};direct.effect.atomic_updates[0].set.credited_total=math;
const directResult=attempt('canonical direct atomic set; same operands and type',direct);
// Complete intended policy diagnostic: explicitly scoped history and private
// collection visibility. No saved historical Read permission is rewritten.
const faithful=structuredClone(canonical), privateOptions=structuredClone(options);
for(const l of faithful.approval.shared_limits)l.capability=faithful.outcome;
for(const r of privateOptions.builtCatalog.authoring.resources)if(['energy_ops.meter_samples','energy_ops.exception_notes'].includes(r.name)){
  for(const f of r.fields)if(f.role!=='guard')f.role='runner_only';
}
const full=attempt('handwritten full-policy diagnostic, never public authority',faithful,privateOptions);assert(full);
const compiled=full.loaded.registry.rules[0]!.compiled;
const id={tenant_id:'synthetic-tenant',principal_id:'synthetic-person'};
const facts:any={trusted:{tenant:id.tenant_id,principal:id.principal_id,transaction_time:'2026-09-20T00:00:00.000Z'},subject_provenance_digest:canonicalJsonDigest('diagnostic'),bindings:{
  cycle:{rows:[{...id,cycle_id:'c',register_id:'r',state:'draft',restricted:false,follow_up:false,posted_credits:0,version:1}]},
  register:{rows:[{...id,register_id:'r',status:'open',credited_total:11,version:1}]},
  samples:{rows:[{...id,sample_id:'s1',cycle_id:'c',quality:'validated',credits:5,version:1},{...id,sample_id:'s2',cycle_id:'c',quality:'validated',credits:7,version:1},{...id,sample_id:'s3',cycle_id:'c',quality:'ignored',credits:90,version:1}]},
  notes:{rows:[{...id,exception_id:'n1',cycle_id:'c',open:false,severity:'blocking',version:1},{...id,exception_id:'n2',cycle_id:'c',open:true,severity:'advisory',version:1}]}}};
const evaluate=(f:any=facts,input:any=12)=>evaluateActionRule({compiled,facts:f,proposal_id:'diagnostic',inputs:{credits_to_post:input}});
const positive=evaluate();assert.equal(positive.result,'eligible');
const negatives:any[]=[];
for(const mode of ['wrong_total','open_block','missing_credit','empty_sum','collection_overflow','wrong_input_type','zero']){
 const f=structuredClone(facts);let input:any=12;
 if(mode==='wrong_total')input=13;
 if(mode==='open_block')f.bindings.notes.rows[0].open=true;
 if(mode==='missing_credit')delete f.bindings.samples.rows[0].credits;
 if(mode==='empty_sum')f.bindings.samples.rows=[];
 if(mode==='collection_overflow')f.bindings.samples.rows=Array.from({length:17},(_,i)=>({...facts.bindings.samples.rows[0],sample_id:`s${i}`}));
 if(mode==='wrong_input_type')input='12';if(mode==='zero')input=0;
 try{const x=evaluate(f,input);assert.notEqual(x.result,'eligible');negatives.push({mode,result:x.result});}catch(e){if((e as any).code==='ERR_ASSERTION')throw e;negatives.push({mode,result:'refused',code:(e as any).code});}
}
assert.deepEqual(full.verification_boundary.resources.filter(r=>r.cardinality==='many').map(r=>[r.binding,r.max_rows,r.collection_consistency]),[['samples',16,'complete_locked'],['notes',16,'complete_locked']]);
assert(full.verification_boundary.resources.filter(r=>r.cardinality==='many').every(r=>r.fields.every(f=>!f.model_visible)));
fs.writeFileSync(path.join(root,'B-capability-derived-candidate.json'),JSON.stringify({classification:'handwritten diagnostic only; never install or give to provider',draft:faithful,options:privateOptions,positive},null,2));
console.log(JSON.stringify({classification:'no-provider parser/compiler/evaluator diagnostic, no source execution',results,direct_set_supported:!!directResult,derived_supported:!!derived,positive,negatives,
  receipt_requirement:'source_db/precreated remains required by original policy; this compiler/evaluator diagnostic does not select, provision or verify receipts',
  historical_read_private_grants:'broad stopped metadata draft remains unchanged; the diagnostic narrows only its private in-memory authoring roles to model the sealed policy',provider_calls:0,authority_saved:false},null,2));
