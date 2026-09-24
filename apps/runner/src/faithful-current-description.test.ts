import {derivedScopedResponse} from "./test-fixtures/coverage-derived.js";
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe,it,expect,vi} from 'vitest';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {createHash} from 'node:crypto';
import {parsePolicyCoverage,collectCoverageFeedback,reviewPolicyCoverage} from './authoring-policy-coverage.js';
import {createModelAuthoringConversation} from './model-authoring-conversation.js';
import {ensurePreparedPolicyCoverage} from './authoring-prepared-policy-review.js';
import {savePolicySources,loadPolicySources} from './authoring-policy-source.js';
import {policyReviewReadiness} from './authoring-review-readiness.js';
import * as receipts from './authoring-receipt-configuration.js';

const capture=JSON.parse(await fs.readFile(new URL('./test-fixtures/faithful-current-description.json',import.meta.url),'utf8'));
function fixture() {
  const {context,response}=structuredClone(capture);
  const sources=context.source_document,source=sources.snapshots.find((s:any)=>s.version===sources.active),draft=context.draft;
  // Explicitly derived test response, never substituted into a provider trial.
  const corrected=structuredClone(response),passage=corrected.passages[9];
  for(const check of passage.counter_requirements) check.current_capability=check.required_capability='release.clear_assessment';
  passage.interpretation='Both limits count automatic release.clear_assessment approvals only, at most 2 per center and 8 overall in the inclusive 86400-second window, retaining approval history across revisions.';
  delete passage.next_step;
  return {sources,source,draft,response,corrected};
}
function establishedSourceControl() {
  const f=fixture();
  // Separately labelled source-wording control, NOT the historical context or
  // a repair/rescue offered to the public journey. Original wording stays failing.
  f.source=structuredClone(f.source);f.source.version+=1;
  f.sources.snapshots.push(f.source);f.sources.active=f.source.version;
  f.source.text=f.source.text.replace('For automatic approvals, allow','For automatic clear assessments, allow');
  f.source.bytes=Buffer.byteLength(f.source.text);f.source.digest=`sha256:${createHash('sha256').update(f.source.text).digest('hex')}`;
  return f;
}
function transport(f:ReturnType<typeof fixture>,replies:any[],provider:'openai'|'openrouter'='openrouter') {
  const model='gpt-5.6-terra',actualModel=provider==='openrouter'?`openai/${model}`:model;
  f.sources.approvals.push({digest:f.source.digest,destination:provider==='openrouter'?`openrouter[${actualModel}] at https://openrouter.ai/api/v1`:`openai[${model}] at https://api.openai.com/v1`});
  const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
  const requests:any[]=[];
  const requestJson=vi.fn(async(r:any)=>{
    requests.push(structuredClone(r.body));const rawReply=replies[requests.length-1];if(rawReply instanceof Error)throw rawReply;const reply=derivedScopedResponse(r.body,rawReply);
    return {status:200,body:provider==='openai'?{output:[{type:'function_call',call_id:'derived',name:'runner__review_policy_coverage',arguments:JSON.stringify(reply)}]}:
      {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'derived',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(reply)}}]}}]}};
  });
  const session={provider,model:actualModel,apiKey:'synthetic-local-transport',conversation,dependencies:{requestJson}};
  return {requests,session,run:()=>reviewPolicyCoverage({source:f.source,draft:f.draft,session})};
}
const feedback=(f:ReturnType<typeof fixture>,reply=f.response)=>collectCoverageFeedback(reply,f.source,f.draft,f.sources.operator_messages);
describe('faithful current counter description, exact NEW-SB-A capture',()=>{
  it('refuses the unchanged response and emits both typed, current-context observations without editing it',()=>{
    const f=fixture(),before=structuredClone(f);
    expect(()=>parsePolicyCoverage(f.response,f.source,f.draft,f.sources.operator_messages)).toThrow('COUNTING_CURRENT_DESCRIPTION_MISMATCH');
    const report=feedback(f);expect(report.findings).toHaveLength(2);
    expect(report.context).toBe(canonicalJsonDigest({source:f.source.digest,draft:f.draft,messages:f.sources.operator_messages}));
    report.findings.forEach((finding,i)=>{
      expect(finding).toMatchObject({code:'COUNTING_CURRENT_DESCRIPTION_MISMATCH',structural:true,component:`/passages/9/counter_requirements/${i}`,
        current_evidence:{path:f.response.passages[9].counter_requirements[i].path,actual:'release.clear_assessment',submitted:null}});
      expect(finding.repair).toContain('Do not infer required_capability');
    });
    expect(report.unevaluated).toContain('/passages/9');expect(f).toEqual(before);
  });
  it('retains located parser findings without inventing an untyped root blocker',()=>{
    const f=fixture();let original:unknown;
    try{parsePolicyCoverage(f.response,f.source,f.draft,f.sources.operator_messages);}catch(error){original=error;}
    expect(original).toBeDefined();
    const report=collectCoverageFeedback(f.response,f.source,f.draft,f.sources.operator_messages,original);
    expect(report.findings.map(finding=>finding.code)).toEqual([
      'COUNTING_CURRENT_DESCRIPTION_MISMATCH','COUNTING_CURRENT_DESCRIPTION_MISMATCH']);
    expect(report.findings.every(finding=>finding.typed_reason==='counter.current_description')).toBe(true);
  });
  it.each(['openai','openrouter'] as const)('%s sends exact-capture feedback, then preserves the separately exposed source-association refusal',async provider=>{
    const f=fixture(),t=transport(f,[f.response,f.corrected],provider);
    await expect(t.run()).rejects.toThrow('COUNTING_REQUIREMENT_AMBIGUOUS');
    expect(t.requests).toHaveLength(2);const sent=JSON.stringify(t.requests[1]);
    expect(sent).toContain('COUNTING_CURRENT_DESCRIPTION_MISMATCH');expect(sent).toContain('current_evidence');
    expect(sent).toContain('/automatic_limits/0/history_selector/capability');expect(sent).toContain('/automatic_limits/1/history_selector/capability');
  });
  it.each(['openai','openrouter'] as const)('%s completes the derived established-source control without changing configuration',async provider=>{
    const f=establishedSourceControl(),t=transport(f,[f.response,f.corrected],provider),digest=canonicalJsonDigest(f.draft);
    const report=await t.run();expect(t.requests).toHaveLength(2);
    const wire=JSON.stringify(t.requests[1]);
    expect(wire).toContain('COUNTING_CURRENT_DESCRIPTION_MISMATCH');expect(wire).toContain('current_evidence');
    expect(wire).toContain('/automatic_limits/0/history_selector/capability');expect(wire).toContain('/automatic_limits/1/history_selector/capability');
    expect(wire).toContain('Do not infer required_capability');expect(report.passages[9]!.counter_requirements?.every(c=>c.current_capability==='release.clear_assessment'&&c.required_capability==='release.clear_assessment')).toBe(true);
    expect(report.passages[1]!.disposition).toBe('conflict');expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false);
    expect(canonicalJsonDigest(f.draft)).toBe(digest);
    if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR)await fs.writeFile(path.join(process.env.SYNAPSOR_TEST_EVIDENCE_DIR,`current-${provider}-wire.json`),JSON.stringify({classification:'local transport / derived corrected response',requests:t.requests,report},null,2));
  });
  it('does not infer required=current, erase a real conflict, or expose an arbitrary submitted selector',()=>{
    const f=fixture();f.response.passages[9].counter_requirements[0].current_capability='private-value-not-in-context';
    const report=feedback(f);expect(JSON.stringify(report)).not.toContain('private-value-not-in-context');
    expect(report.findings[0]!.current_evidence?.submitted).toEqual({withheld:true});
    for(const c of f.response.passages[9].counter_requirements)c.current_capability='release.clear_assessment';
    const actualOnly=feedback(f);expect(actualOnly.findings.some(x=>x.structural===false)).toBe(true);
    expect(()=>parsePolicyCoverage(f.response,f.source,f.draft,f.sources.operator_messages)).toThrow(/COUNTING_/);
  });
  it('binds reordered counters by their exact path, never by position or a preferred identifier',()=>{
    const f=fixture();f.response.passages[9].counter_requirements.reverse();
    expect(feedback(f).findings.map(x=>x.current_evidence?.path)).toEqual(f.response.passages[9].counter_requirements.map((x:any)=>x.path));
    delete f.draft.runner_evidence.actions['release.clear_assessment'].automatic_limits[0].history_selector.capability;
    expect(feedback(f).findings.some(x=>!x.structural)).toBe(true);
  });
  it('stops a repeated false observation without an extra favorable opinion',async()=>{
    const f=fixture(),t=transport(f,[f.response,f.response,f.corrected]);
    await expect(t.run()).rejects.toThrow('COUNTING_CURRENT_DESCRIPTION_MISMATCH');expect(t.requests).toHaveLength(2);
  });
  it('a correct first response uses one call and keeps unrelated deployment and privacy review pending',async()=>{
    const f=establishedSourceControl(),t=transport(f,[f.corrected]);const report=await t.run();expect(t.requests).toHaveLength(1);
    expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false);
  });
  it('saves the derived checked report and unverified duties, preserving the independent receipt blocker on restart',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'faithful-observation-')),f=establishedSourceControl();
    // Separate derived positive control: permitted scoped listings return the
    // public label. This does not add a filter grant or change the original.
    f.corrected.passages[1].disposition='implemented';
    f.corrected.passages[1].interpretation='Scoped public listings return public_label so the user can find the assessment by that label; this does not assert a server-side filter grant.';
    delete f.corrected.passages[1].next_step;
    const t=transport(f,[f.response,f.corrected]);
    vi.spyOn(receipts,'authoringReceiptConfiguration').mockResolvedValue(f.draft.runner_evidence.runtime_contract.receipt_configuration);
    try {
      await savePolicySources(root,f.sources);
      const input={projectRoot:root,sources:f.sources,modelSession:t.session,currentDraft:()=>f.draft,authorityDigest:canonicalJsonDigest(f.draft.actions),
        operatorSession:{chooseOption:async()=> 'assign',confirm:async()=>true} as any,clarifications:[],assertCurrent:async()=>{},state:{}};
      await ensurePreparedPolicyCoverage(input);
      const saved=await loadPolicySources(root,f.sources.id);
      expect(saved.coverage_episodes?.at(-1)?.submissions).toHaveLength(2);
      expect(saved.application_assignments?.every(a=>a.owner==='client_application'&&a.verified===false)).toBe(true);
      const readiness=policyReviewReadiness(f.source,saved.coverage,saved);
      expect(readiness.ready).toBe(false);
      expect(readiness.items?.filter(i=>i.blocksReview).map(i=>i.title)).toEqual(['Find assessment by public label','Runner-ledger receipt selection']);
      t.session.conversation.policySources=saved;
      const again=await ensurePreparedPolicyCoverage({...input,sources:saved,state:{}});
      expect(again.activity).toBe('validated_reuse');expect(t.requests).toHaveLength(2);
      expect(saved.coverage?.passages[9]!.counter_requirements).toEqual(f.corrected.passages[9].counter_requirements);
    }finally{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});}
  });
});
