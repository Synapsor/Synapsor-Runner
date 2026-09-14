// Reviewer-requested derived full-reply probes; product source and frozen candidate unchanged.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {reviewPolicyCoverage} from '../../../apps/runner/src/authoring-policy-coverage.js';
import {bindPolicyCoverage,savePolicySources,loadPolicySources,policyTextSnapshot} from '../../../apps/runner/src/authoring-policy-source.js';
import {createModelAuthoringConversation} from '../../../apps/runner/src/model-authoring-conversation.js';
import {countingSourceRequirements} from '../../../apps/runner/src/authoring-counting-requirements.js';
const f=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/fixtures/counting-addition-review.json',import.meta.url),'utf8'));
const prefix=f.source.text.split('\n')[6].split('Qualifying results beyond')[0];
const variants=[
 {name:'auto-approved wording',text:'No more than two ratifications may be auto-approved per league per day, and no more than six overall. '},
 {name:'allowance covers only',text:'The automatic allowance covers ratification only. Six approvals overall and two per league within the inclusive rolling 24-hour window. '},
 {name:'split across lines',text:'Valid qualifying-stage results may be approved automatically, with at most six automatic\nratifications overall and two per league in the inclusive rolling 24-hour window. '},
 {name:'non-stem alias',text:'At most six automatic greenlights overall and two per league in the inclusive rolling 24-hour window. ',alias:'greenlight'}
];const results=[];
for(const variant of variants){const d=structuredClone(f.draft),reply=structuredClone(f.reply),state=structuredClone(f.policy_sources);if(variant.alias)d.actions[0].discovery={title:'Authorize result',aliases:[variant.alias]};
 const source=policyTextSnapshot(Buffer.from(f.source.text.replace(prefix,variant.text)),variant.name+'.txt');
 if(variant.text.includes('\n'))for(const p of reply.passages){if(p.start>7)p.start++;if(p.end>=7)p.end++;}
 // Exact false provider equality/support retained; only declared source wording/alias differs.
 state.snapshots=[source];state.active=1;state.approvals=[{...state.approvals[0],digest:source.digest}];delete state.coverage;delete state.coverage_context_digest;
 const conversation=createModelAuthoringConversation();conversation.policySources=state;let calls=0;const root=await fs.mkdtemp(path.join(os.tmpdir(),'wording-bound-'));
 const bindings=countingSourceRequirements(source,d,state.operator_messages??[]);
 let result:any={name:variant.name,requirement_text:variant.text,alias:variant.alias??null,bindings:bindings.map(b=>({path:b.path,required:b.required_capability,ambiguity:b.ambiguity})),expected_for_outcome_specific_null_claim:'REFUSE or independently validated applicable proof; equality alone must not suffice'};
 try{const report=await reviewPolicyCoverage({source,draft:d,env:{OPENAI_API_KEY:'captured-only'},session:{provider:'openai',model:'gpt-5.6-terra',conversation,dependencies:{requestJson:async()=>{calls++;return{status:200,body:{output:[{type:'function_call',name:'runner__review_policy_coverage',call_id:'derived-wording',arguments:JSON.stringify(reply)}]}}}}}});
 bindPolicyCoverage(state,report,state.coverage_authority_digest);await savePolicySources(root,state,{expectedDigest:null});const saved=await loadPolicySources(root,state.id);const p=saved.coverage!.passages.find(p=>p.counter_requirements?.length);result={...result,accepted:true,persisted:true,disposition:p?.disposition,counter_requirements:p?.counter_requirements,components:p?.counting_components??[],host_bindings:p?.counting_requirement_bindings??[]};
 }catch(error){result={...result,accepted:false,error:String(error)};}finally{await fs.rm(root,{recursive:true,force:true});}
 result.captured_producer_calls=calls;result.actual_provider_calls=0;result.silent_fallthrough=result.accepted===true&&result.disposition==='implemented'&&!result.components.length;results.push(result);
}
console.log(JSON.stringify({classification:'Derived full producer/parser/save/reload controls; same frozen product source; no provider, authority or source writes',results},null,2));

// Assert the requested safety disposition; known misses remain a failing gate, not expected-failure green.
if(results.some(r=>r.silent_fallthrough))throw Error("COUNTING_WORDING_BOUND: outcome-specific requirements persisted as implemented without association/proof");
