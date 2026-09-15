import fs from 'node:fs';
import { planModelBoundaryJob } from '../../../apps/runner/src/boundary-job-model.ts';
import { createModelAuthoringConversation } from '../../../apps/runner/src/model-authoring-conversation.ts';
const plan=JSON.parse(fs.readFileSync(new URL('./assignment-plan.json',import.meta.url),'utf8'));
const rows=JSON.parse(fs.readFileSync(plan.owned_root+'/private/exact-routing-captures.json','utf8'));
for(const row of rows){let calls=0;const conversation=createModelAuthoringConversation();conversation.policySources=row.source_session;
 const result=await planModelBoundaryJob({jobIntent:row.operator_job,currentState:row.current_state,availableResourceIds:row.current_state.read.resource_ids,egressAcknowledged:true,env:{OPENAI_API_KEY:'captured-only'},session:{provider:'openai',model:'gpt-5.6-terra',conversation,dependencies:{requestJson:async()=>{calls++;return {status:200,body:row.response};}}}});
 console.log(JSON.stringify({case:row.case,result,calls,original_saved_stage:row.stage,original_pending:row.saved_pending_job_revision,coverage_operation_executed:false}));
}
