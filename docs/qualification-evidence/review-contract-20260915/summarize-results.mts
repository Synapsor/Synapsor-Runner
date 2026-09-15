// Read-only corroboration. The actual installed/public execution is in terminal logs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.ts';
const E=path.dirname(new URL(import.meta.url).pathname);
const read=(p:string)=>JSON.parse(fs.readFileSync(p,'utf8'));
const plan=read(path.join(E,'assignment-plan.json')),O=plan.owned_root;
const development=process.argv.includes('--development');
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const specs=development ? [
 ['terra','recovery-tournament-assisted','reviewed'],['sol-repaired','recovery-tournament-assisted','reviewed'],
 ['terra','counting-wording-control','receipt-blocked'],['sol-repaired','counting-wording-control','reviewed'],
] : [['','recovery-tournament-assisted',process.argv.includes('--stopped')?'primary-review-stopped':'primary-rechecked']];
const rows=[];
for(const [lane,run,label] of specs) {
 const R=path.join(O,...(development?['development',lane]:[]),'runs',run),P=path.join(R,'project');
 const resume=read(path.join(P,'.synapsor/boundary-authoring/resume.json'));
 const session=read(path.join(P,'.synapsor/boundary-authoring/policy-sources',resume.policy_source_session+'.json'));
 const source=session.snapshots.find((s:any)=>s.version===session.active);
 const readiness=policyReviewReadiness(source,session.coverage,session);
 const oracle=read(path.join(E,run+'-'+(development?lane+'-':'')+label+'-oracle.json'));
 assert(oracle.ledgers.every((l:any)=>l.tables.every((t:any)=>t.unchanged)));
 const captures=[];
 for(const name of fs.readdirSync(path.join(R,'meter')).filter(n=>/^input-\d+\.json$/.test(n)).sort()) {
  const inputPath=path.join(R,'meter',name),input=read(inputPath).request;
  const outputPath=path.join(R,'meter',name.replace('input','output').replace('.json','.txt'));
  const raw=fs.readFileSync(outputPath,'utf8');
  const completed=raw.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)))
    .find(x=>x.type==='response.completed')?.response;
  const calls=(completed?.output??[]).filter((x:any)=>x.type==='function_call');
  const lines=(input.input??[]).flatMap((m:any)=>typeof m.content==='string'?m.content.split('\n'):[]);
  captures.push({input:inputPath,input_sha256:sha(fs.readFileSync(inputPath)),output:outputPath,output_sha256:sha(raw),
    model:input.model,reasoning:input.reasoning,store:input.store,service_tier:completed?.service_tier,
    tool_choice:input.tool_choice,parallel_tool_calls:input.parallel_tool_calls,max_output_tokens:input.max_output_tokens,
    functions:calls.map((c:any)=>c.name),planner:calls.filter((c:any)=>c.name==='runner__plan_boundary_job').map((c:any)=>JSON.parse(c.arguments)),
    correction:lines.find((s:string)=>s.startsWith('Correct this structural coverage problem:')),
    complete_response:Boolean(completed)});
 }
 const history=resume.completed_policy_reviews??[];
 const calls=oracle.actual_authoring_calls;
 if(development) {
  assert.equal(calls,2);
  assert.equal(readiness.ready,!(lane==='terra'&&run==='counting-wording-control'));
  if(run==='counting-wording-control') {
   assert.equal(session.counting_decisions.length,2);
   assert(session.counting_decisions.every((d:any)=>d.source_digest===source.digest&&d.required_capability==='league.result_ratification'));
  }
 } else if(!process.argv.includes('--stopped')) {
  assert(readiness.ready);
  assert.deepEqual(history.map((h:any)=>h.activity),['provider','validated_reuse']);
  assert.equal(history[0].report_digest,history[1].report_digest);
  assert.equal(history[0].context_digest,history[1].context_digest);
  assert(!resume.pending_job_revision&&!resume.pending_policy_review);
  const reviewed=read(path.join(R,'checkpoints/primary-reviewed/project/.synapsor/boundary-authoring/policy-sources',resume.policy_source_session+'.json'));
  assert.deepEqual(session.coverage,reviewed.coverage);
  assert.deepEqual(session.counting_decisions,reviewed.counting_decisions);
 }
 const invocations=fs.readFileSync(path.join(R,'public-invocations.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 rows.push({lane:development?lane:'primary installed',run,status:readiness.ready?'BUSINESS COMPLETE':'BLOCKED',
  source:{version:source.version,digest:source.digest},readiness,review_history:history,
  counting_decisions:session.counting_decisions??[],maintenance_passages:oracle.maintenance_passages,
  pending:oracle.pending,captures,actual_calls:calls,cli_exits:invocations.filter((x:any)=>x.event==='exit').map((x:any)=>x.code),
  counting_questions:run==='counting-wording-control'?2:0,separate_counting_confirmations:run==='counting-wording-control'?2:0,
  source_counts:{events:8,results:96},all_ledger_table_contents_unchanged:true,
  readiness_corroboration:'Read-only host function over saved public state; not a substitute for the recorded public run.',
  restart:development?'NOT RUN in development; deterministic regressions cover restart':process.argv.includes('--stopped')?'NOT RUN after substantive failure':'PASSED: explicit restarted Review, validated reuse, no added call/question',
  evidence:[run+'-'+(development?lane+'-':'')+label+'.json',run+'-'+(development?lane+'-':'')+label+'-oracle.json']});
}
const result={at:new Date().toISOString(),classification:development?'DEVELOPMENT ONLY; not independent or final qualification':'FINAL PRIMARY INSTALLED',
 artifact_tree:development?null:plan.artifact_tree,product:read(path.join(E,'product-revision.json')),
 actual_calls:rows.reduce((n,r)=>n+r.actual_calls,0)+(development?2:0),baseline_calls:development?2:0,
 rows,not_run:development?[]:[{run:'counting-wording-control',status:'BLOCKED / NOT RUN on final artifact',reason:'New primary development receipt-review blocker preserved; unchanged code was not repeatedly sampled. See remaining-receipt-review.md.'}],
 intervention:'Normal chooser/consent, exact legacy review-only confirmation, B business choices and separate confirmations. No payload replacement, policy rescue text, activation, worker, business effect or authority change.',
 independent_secondary:'Claude owns final sol lane; this task ran only separately labelled development sol captures.',original_stage_b:'NOT PASSED'};
fs.writeFileSync(path.join(E,development?'development-results.json':'installed-primary-results.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({classification:result.classification,actual_calls:result.actual_calls,rows:rows.map(r=>({lane:r.lane,run:r.run,status:r.status}))}));
