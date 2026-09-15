import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
const E=path.dirname(new URL(import.meta.url).pathname);export const plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json')));
export async function budget(runId,select){
 assert(plan.case_sources[runId]);const R=path.join(plan.owned_root,'runs',runId),file=path.join(R,'run-state.json'),state=JSON.parse(await fs.readFile(file));
 if(select){assert(['review','recheck'].includes(select));assert(!(await fs.stat(path.join(plan.owned_root,'one-public-run.lock')).catch(()=>null)));state.phase=select;}
 const phase=state.phase==='setup'?'review':state.phase;assert(['review','recheck'].includes(phase));state.phase=phase;
 let total=0,review=0;
 for(const id of Object.keys(plan.case_sources)){
  const root=path.join(plan.owned_root,'runs',id),events=(await fs.readFile(path.join(root,'meter/events.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse),inv=(await fs.readFile(path.join(root,'public-invocations.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
  for(const attempt of events.filter(e=>e.type==='transport_attempt'&&e.pathname!=='/v1/models')){total++;if(inv.filter(e=>e.event==='start'&&e.authoring&&e.at<=attempt.at).at(-1)?.phase!=='recheck')review++;}
 }
 assert(total<=25&&review<=19,'Declared authoring ceiling exhausted');
 const budgetFile=path.join(plan.owned_root,'final-budget.json');let shared=JSON.parse(await fs.readFile(budgetFile,'utf8').catch(()=>'null'));
 if(!shared){shared={started_at:new Date().toISOString(),deadline:new Date(Date.now()+plan.budgets.final_confirmation_minutes*60000).toISOString(),maximum_calls:25,reserved_recheck_calls:6};await fs.writeFile(budgetFile,JSON.stringify(shared,null,2)+'\n',{flag:'wx'});}
 assert(Date.now()<Date.parse(shared.deadline),'Final public confirmation deadline exhausted; no reset');
 const own=(await fs.readFile(path.join(R,'meter/events.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.type==='transport_attempt'&&e.pathname!=='/v1/models').length;
 const remaining=phase==='review'?Math.min(25-total,19-review):25-total;
 state.first_public_start??=new Date().toISOString();state.status='RUNNING';state.final_deadline=shared.deadline;await fs.writeFile(file,JSON.stringify(state,null,2)+'\n');
 const b={started_at:shared.started_at,maximum_attempts:own+remaining,maximum_case_attempts:25,deadline:shared.deadline,hosts:['api.openai.com'],capture_sanitized_inputs:true,private_values_file:path.join(R,'private/forbidden-provider-values.json')};
 await fs.writeFile(path.join(R,'meter/plan.json'),JSON.stringify(b,null,2)+'\n');await fs.appendFile(path.join(R,'phase-budget-events.jsonl'),JSON.stringify({at:new Date().toISOString(),phase,total_calls:total,review_calls:review,remaining,deadline:shared.deadline})+'\n');return{state,deadline:shared.deadline,phase,meterPlan:b};
}
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(JSON.stringify(await budget(process.argv[2],process.argv[3])));
