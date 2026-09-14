import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
import {parsePolicyCoverage} from '../../../apps/runner/src/authoring-policy-coverage.js';
const E=path.dirname(fileURLToPath(import.meta.url)),fixture=JSON.parse(await fs.readFile(path.join(E,'../../../apps/runner/src/fixtures/mixed-counting-review.json'),'utf8'));
const checks={
 missing:(d:any,p:any)=>{d.runner_evidence.counting_interpretations=[];},
 ambiguous:(d:any,p:any)=>{d.runner_evidence.counting_interpretations.push(structuredClone(d.runner_evidence.counting_interpretations[0]));},
 explicit_wrong_support:(d:any,p:any)=>{p.counter_requirements[0].operator_message_id=p.operator_message_id;},
 broad_only:(d:any,p:any)=>{p.draft_paths=['/actions/0/approval','/runner_evidence'];},
 invalid_typed_pointer:(d:any,p:any)=>{p.counter_requirements[0].path='/actions/0/approval';},
 incomplete_domain:(d:any,p:any)=>{d.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain.complete=false;},
 different_history:(d:any,p:any)=>{d.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain.retained_automatic_outcomes=['another.outcome'];},
};
const results=[];for(const [name,change]of Object.entries(checks)){const draft=structuredClone(fixture.drafts[0]),reply=structuredClone(fixture.replies[0]),p=reply.passages.find((p:any)=>p.counter_requirements?.length);change(draft,p);let error;try{parsePolicyCoverage(reply,fixture.source,draft,fixture.operator_messages);}catch(e){error=String(e);}assert(error);results.push({name,classification:'DERIVED negative control, not a provider reply',error});}
await fs.writeFile(path.join(E,'diagnostic-controls.json'),JSON.stringify({at:new Date().toISOString(),provider_calls:0,results},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({refused_controls:results.length}));
