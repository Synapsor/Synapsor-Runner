// Read-only corroboration of the installed CLI results. No provider or store open.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.ts';

const E=path.dirname(new URL(import.meta.url).pathname);
const plan=JSON.parse(fs.readFileSync(path.join(E,'assignment-plan.json'),'utf8'));
const O=plan.owned_root;
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const rows:any[]=[];
for(const [run,label] of [['recovery-tournament-assisted','primary-review-stopped'],['counting-wording-control','primary-rechecked']]){
  const R=path.join(O,'runs',run),P=path.join(R,'project');
  const resume=read(path.join(P,'.synapsor/boundary-authoring/resume.json'));
  const sourceSession=read(path.join(P,'.synapsor/boundary-authoring/policy-sources',resume.policy_source_session+'.json'));
  const source=sourceSession.snapshots.find((x:any)=>x.version===sourceSession.active);
  const readiness=policyReviewReadiness(source,sourceSession.coverage,sourceSession);
  const oracle=read(path.join(E,run+'-'+label+'-oracle.json'));
  assert(oracle.ledgers.every((l:any)=>l.tables.every((t:any)=>t.unchanged)));
  const invocations=fs.readFileSync(path.join(R,'public-invocations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const captures:any[]=[];
  for(const name of fs.readdirSync(path.join(R,'meter')).filter(n=>/^input-\d+\.json$/.test(n)).sort()){
    const inputPath=path.join(R,'meter',name),input=read(inputPath),outputPath=path.join(R,'meter',name.replace('input','output').replace('.json','.txt'));
    const output=fs.readFileSync(outputPath,'utf8');
    const complete=output.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==='response.completed').response;
    const calls=complete.output.filter((x:any)=>x.type==='function_call').map((x:any)=>({name:x.name,arguments:JSON.parse(x.arguments)}));
    const content=input.request.input.flatMap((m:any)=>typeof m.content==='string'?m.content.split('\n'):[]);
    const draftLine=content.find((s:string)=>s.startsWith('Current draft (JSON pointer root): '));
    const draft=draftLine?JSON.parse(draftLine.slice('Current draft (JSON pointer root): '.length)):null;
    captures.push({input:inputPath,input_sha256:sha(fs.readFileSync(inputPath)),output:outputPath,output_sha256:sha(output),
      model:input.request.model,reasoning:input.request.reasoning,store:input.request.store,service_tier:complete.service_tier,
      functions:calls.map((x:any)=>x.name),planner:calls.find((x:any)=>x.name==='runner__plan_boundary_job')?.arguments,
      correction:content.find((s:string)=>s.startsWith('Correct this structural coverage problem:')),
      exact_owner_counter_evidence:draft?.runner_evidence?.actions?.['league.result_ratification']?.effect?.source_counter_maintenance});
  }
  const history=resume.completed_policy_reviews??[];
  if(run==='counting-wording-control'){
    assert(readiness.ready);assert.equal(history.length,2);
    assert.deepEqual(history.map((x:any)=>x.activity),['provider','validated_reuse']);
    assert.equal(history[0].report_digest,history[1].report_digest);assert.equal(history[0].context_digest,history[1].context_digest);
    assert(!resume.pending_policy_review&&!resume.pending_job_revision);
    assert.equal(sourceSession.counting_decisions.length,2);
    assert(sourceSession.counting_decisions.every((d:any)=>d.source_digest===source.digest&&d.required_capability==='league.result_ratification'));
    assert.equal(captures.length,2);
    const reviewed=read(path.join(R,'checkpoints/primary-reviewed/project/.synapsor/boundary-authoring/policy-sources',resume.policy_source_session+'.json'));
    assert.deepEqual(sourceSession.coverage,reviewed.coverage);assert.deepEqual(sourceSession.counting_decisions,reviewed.counting_decisions);
  }else{
    assert(!readiness.ready);assert.equal(readiness.items?.filter(x=>x.blocksReview).length,1);
    assert.equal(readiness.items?.find(x=>x.blocksReview)?.title,'Conflict-counter maintenance');
    assert(resume.pending_policy_review&&resume.pending_job_revision);assert.equal(history.length,0);
    assert.equal(captures[0].planner.operation,'review_rules');assert.equal(captures.length,2);
  }
  rows.push({run,status:readiness.ready?'PASSED':'BLOCKED',actual_cli_exits:invocations.filter(x=>x.event==='exit').map(x=>x.code),
    source:{version:source.version,digest:source.digest},readiness,readiness_corroboration:'Read-only current-source function over saved installed state; terminal transcript is the installed execution evidence.',
    exact_counting_decisions:sourceSession.counting_decisions??[],review_history:history,pending_review:resume.pending_policy_review??null,
    captures,actual_calls:oracle.actual_authoring_calls,all_ledger_table_contents_unchanged:true,
    source_counts:{events:8,results:96},counting_questions:run==='counting-wording-control'?2:0,
    separate_counting_confirmations:run==='counting-wording-control'?2:0,
    restart:run==='counting-wording-control'?{status:'PASSED',activity:'validated_reuse',additional_calls:0,repeated_counting_questions:0,coverage_and_decisions_unchanged:true}:{status:'NOT RUN',reason:'Initial substantive BUSINESS blocker preserved; no repeated model attempt for agreement.'},
    evidence:[run+'-'+label+'.json',run+'-'+label+'-oracle.json',run+'-'+label+'-project-difference.json']});
}
const result={at:new Date().toISOString(),artifact_tree:plan.artifact_tree,product:plan.product_commit,
  status:'PARTIAL: B passed, A remains blocked',primary:{adapter:'openai',model:'gpt-5.6-terra',reasoning:'low',store:false,observed_service_tier:'default'},
  total_final_calls:rows.reduce((n,r)=>n+r.actual_calls,0),failed_transports:0,structural_correction_calls:1,
  final_budget:read(path.join(O,'final-budget.json')),rows,development_calls_separate:2,
  interventions:'Operator navigation, exact legacy review-only confirmation, two B business selections and their explicit confirmations. No new policy prose, re-upload, source/business edits or provider payload replacement. Existing host correction counted.',
  elapsed_measurement:'See exact start/exit and transport timestamps in public-invocations.jsonl and meter/events.jsonl; human navigation time included. No fresh-onboarding or general usability timing measured.',
  independent_secondary:'NOT RUN HERE; Claude owns predeclared openai/gpt-5.6-sol lane',original_stage_b:'NOT PASSED'};
assert.equal(result.total_final_calls,4);
fs.writeFileSync(path.join(E,'installed-primary-results.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.status,actual_calls:result.total_final_calls,rows:rows.map(r=>({run:r.run,status:r.status,cli_exits:r.actual_cli_exits}))}));
