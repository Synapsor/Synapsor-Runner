import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
const E=path.dirname(new URL(import.meta.url).pathname);export const plan=JSON.parse(await fs.readFile(path.join(E,'assignment-plan.json')));
export async function budget(runId,select){
 const R=path.join(plan.owned_root,'runs',runId),file=path.join(R,'run-state.json'),state=JSON.parse(await fs.readFile(file));assert(plan.case_sources[runId]);
 if(select){assert(['setup','add','remove','restart'].includes(select));assert(!(await fs.stat(path.join(plan.owned_root,'one-public-run.lock')).catch(()=>null)));state.phase=select;}
 const phase=state.phase??'setup';assert(['setup','add','remove','restart'].includes(phase));const events=(await fs.readFile(path.join(R,'meter/events.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse),inv=(await fs.readFile(path.join(R,'public-invocations.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
 const attempts=events.filter(e=>e.type==='transport_attempt');let used=0;
 for(const attempt of attempts){const start=inv.filter(e=>e.event==='start'&&e.authoring&&e.at<=attempt.at).at(-1);if(start?.phase===phase)used++;}
 const allocations={setup:12,add:22,remove:12,restart:4};assert(used<=allocations[phase]);assert(attempts.length<=50);
 state.phase_windows??={};const overall=Date.parse(plan.started_at)+plan.budgets.overall_minutes*60000;
 if(!state.phase_windows[phase]){
  if(phase!=='setup')state.evolution_deadline??=new Date(Math.min(overall,Date.now()+65*60000)).toISOString();
  state.phase_windows[phase]={started_at:new Date().toISOString(),deadline:phase==='setup'?new Date(Math.min(overall,Date.now()+(runId==='recovery-software'?30:60)*60000)).toISOString():state.evolution_deadline};
 }
 const deadline=state.phase_windows[phase].deadline;assert(Date.now()<Date.parse(deadline),'Declared phase deadline exhausted; no reset');
 state.setup_deadline=state.phase_windows.setup?.deadline;state.first_public_start??=new Date().toISOString();state.status='RUNNING';
 await fs.writeFile(file,JSON.stringify(state,null,2)+'\n');
 const b={started_at:state.first_public_start,maximum_attempts:Math.min(50,attempts.length+allocations[phase]-used),maximum_case_attempts:50,deadline,hosts:['api.openai.com'],capture_sanitized_inputs:true,private_values_file:path.join(R,'private/forbidden-provider-values.json')};
 await fs.writeFile(path.join(R,'meter/plan.json'),JSON.stringify(b,null,2)+'\n');
 await fs.appendFile(path.join(R,'phase-budget-events.jsonl'),JSON.stringify({at:new Date().toISOString(),phase,select:select??null,actual_calls:attempts.length,phase_calls:used,allocation:allocations[phase],maximum_attempts:b.maximum_attempts,deadline})+'\n');return{state,deadline,phase,meterPlan:b};
}
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(JSON.stringify(await budget(process.argv[2],process.argv[3])));
