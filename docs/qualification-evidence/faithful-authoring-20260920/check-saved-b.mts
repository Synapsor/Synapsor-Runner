// Readback/evaluator evidence only, after the public stop. No store writes/provider.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { compileActionRule, evaluateActionRule } from '@synapsor-runner/action-rules';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
const root=process.argv[2];const tables=JSON.parse(fs.readFileSync(path.join(root,'state-readbacks/recheck-control.json'),'utf8'));
const pointer=tables.control_policy_drafts.find((x:any)=>x.kind==='action');assert(pointer);
const row=tables.control_policy_revisions.find((x:any)=>x.revision_id===pointer.revision_id);const saved=JSON.parse(row.content_json).authority;
assert.equal(saved.state,'disabled');assert(!tables.control_policy_active.some((x:any)=>['read','action','execution'].includes(x.kind)));
const authority=saved.authority, item=authority.rules[0];assert.equal(authority.rules.length,1);
const compiled=compileActionRule({...item,catalog:authority.catalog});
assert.equal(compiled.rule_digest,authority.action_boundary.rules[0].action_rule_digest);
const id={tenant_id:'synthetic-tenant',principal_id:'synthetic-person'};
const facts:any={trusted:{tenant:id.tenant_id,principal:id.principal_id,transaction_time:'2026-09-20T00:00:00.000Z'},subject_provenance_digest:canonicalJsonDigest('diagnostic'),bindings:{
  cycle:{rows:[{...id,cycle_id:'c',register_id:'r',state:'draft',restricted:false,follow_up:false,posted_credits:0,version:1}]},
  register:{rows:[{...id,register_id:'r',status:'open',credited_total:11,version:1}]},
  samples:{rows:[{...id,sample_id:'s1',cycle_id:'c',quality:'validated',credits:5,version:1},{...id,sample_id:'s2',cycle_id:'c',quality:'validated',credits:7,version:1},{...id,sample_id:'s3',cycle_id:'c',quality:'ignored',credits:90,version:1}]},
  notes:{rows:[{...id,exception_id:'n1',cycle_id:'c',open:false,severity:'blocking',version:1},{...id,exception_id:'n2',cycle_id:'c',open:true,severity:'advisory',version:1}]}}};

const positive=evaluateActionRule({compiled,facts,proposal_id:'saved-readback-diagnostic',inputs:{credits_to_post:12}});
assert.equal(positive.result,'eligible');
const negativeFacts=structuredClone(facts);negativeFacts.bindings.notes.rows[0].open=true;
assert.notEqual(evaluateActionRule({compiled,facts:negativeFacts,proposal_id:'saved-readback-negative',inputs:{credits_to_post:12}}).result,'eligible');
assert.deepEqual(item.rule.derive.new_credited_total,{inputs:[{binding:'register',field:'credited_total',kind:'field'},{kind:'input',name:'credits_to_post'}],kind:'math',operation:'add'});
const collections=item.verification_boundary.resources.filter((x:any)=>x.cardinality==='many');
assert.equal(collections.length,2);assert(collections.every((x:any)=>x.max_rows===16&&x.collection_consistency==='complete_locked'&&x.fields.every((f:any)=>!f.model_visible)));
const limits=authority.approval_classes[0].shared_limits;
assert.deepEqual(limits.map((x:any)=>[x.scope,x.maximum,x.window_seconds,x.capability??null]),[['tenant',4,86400,null],['boundary',6,86400,null]]);
const visibility=item.verification_boundary.resources.find((x:any)=>x.binding==='cycle').fields.find((x:any)=>x.name==='restricted').model_visible;
assert.equal(visibility,true); // preserved privacy blocker, not silently corrected
console.log(JSON.stringify({classification:'host recompile/evaluator readback of public saved candidate; synthetic facts only; no installed execution',action_revision:pointer.revision_id,authority_digest:authority.digest,rule_digest:compiled.rule_digest,compiled:true,positive,open_blocking_note:'refused',collections:collections.map((x:any)=>({binding:x.binding,max_rows:x.max_rows,consistency:x.collection_consistency,all_fields_private:x.fields.every((f:any)=>!f.model_visible)})),limits,restricted_visible:visibility,authority_state:saved.state,business_ready:false,public_tool_calls:0,source_effects:0},null,2));
