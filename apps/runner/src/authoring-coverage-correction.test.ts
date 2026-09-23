import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {secureAskJsonRequest} from './model-ask.js';
import { describe, it, expect, vi } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { parsePolicyCoverage, reviewPolicyCoverage, collectCoverageFeedback } from './authoring-policy-coverage.js';
import { permitsSecondCoverageCorrection, MAX_COVERAGE_FEEDBACK_BYTES } from './authoring-coverage-feedback.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';
import { ensurePreparedPolicyCoverage } from './authoring-prepared-policy-review.js';
import { savePolicySources, loadPolicySources } from './authoring-policy-source.js';
import { policyReviewReadiness } from './authoring-review-readiness.js';
import * as receiptConfiguration from './authoring-receipt-configuration.js';
import {derivedScopedResponse} from './test-fixtures/coverage-derived.js';
const captured = JSON.parse(await fs.readFile(new URL('./test-fixtures/coverage-correction-captures.json', import.meta.url), 'utf8'));
function fixture() {
  const { sources, draft, arguments: replies } = structuredClone(captured);
  const source = sources.snapshots.find((s:any) => s.version === sources.active);
  // DERIVED structural replacement, never represented as a historical reply.
  const corrected = structuredClone(replies[0]);
  // DERIVED corrections use only the four challenged records; all unchallenged
  // dependencies retain the exact immediate-parent fields and optional absence.
  for(const index of [3,6,8,11])corrected.passages[index]=structuredClone(replies[1].passages[index]);
  for(const p of corrected.passages) for(const c of p.counter_requirements ?? []) delete c.operator_message_id;
  return {sources,draft,replies,source,corrected};
}
function transport(f:ReturnType<typeof fixture>, submissions:any[], provider:'openai'|'openrouter'='openai') {
  if(provider==='openrouter') f.sources.approvals.push({digest:f.source.digest,destination:'openrouter[x-ai/grok-4.6] at https://openrouter.ai/api/v1'}); // local transport fixture consent, not a provider trial
  const conversation=createModelAuthoringConversation(); conversation.policySources=f.sources;
  const requests:any[]=[];
  const requestJson=vi.fn(async(r:any)=>{
    requests.push(structuredClone(r.body));const submitted=submissions[requests.length-1],explicit=typeof submitted==='function';let args=explicit?submitted(r.body):submitted;
    if(args instanceof Error) throw args;
    if(!explicit&&requests.length>1&&!f.replies.some((raw:any)=>canonicalJsonDigest(raw)===canonicalJsonDigest(args)))args=derivedScopedResponse(r.body,args);
    return {status:200,body:provider==='openai'?{output:[{type:'function_call',call_id:'captured',name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}]}:
      {choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'captured',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]}};
  });
  const session={provider,model:provider==='openai'?'gpt-5.6-terra':'x-ai/grok-4.6',apiKey:'test-only',conversation,dependencies:{requestJson}};
  return {session,requests,requestJson,run:()=>reviewPolicyCoverage({source:f.source,draft:f.draft,session})};
}
function correction(body:any) {
  const messages=body.input??body.messages;
  const question=messages.map((m:any)=>m.content).filter((s:any)=>typeof s==='string').join('\n');
  return question.split('\n').find((s:string)=>s.startsWith('Correct this structural coverage problem: '))!;
}
describe('captured coverage correction round trip',()=>{
  it('preserves both exact negative replies and discovers independent findings without accepting coverage',()=>{
    const f=fixture(),before=structuredClone(f);
    expect(()=>parsePolicyCoverage(f.replies[0],f.source,f.draft,f.sources.operator_messages)).toThrow('Draft pointer(s) not present');
    expect(()=>parsePolicyCoverage(f.replies[1],f.source,f.draft,f.sources.operator_messages)).toThrow('COUNTING_SUPPORT_MISMATCH');
    const feedback=collectCoverageFeedback(f.replies[0],f.source,f.draft,f.sources.operator_messages);
    expect(feedback.findings.map(x=>x.code)).toEqual(['COVERAGE_REFERENCE_MISSING','SOURCE_COUNTER_COMPONENT_MIXED','COUNTING_SUPPORT_MISMATCH','COUNTING_SUPPORT_MISMATCH','COVERAGE_DEPLOYMENT_COMPONENT_MIXED']);
    expect(feedback.findings.filter(x=>x.code==='COUNTING_SUPPORT_MISMATCH').every(x=>x.repair.includes('omit operator_message_id/operator_clarification'))).toBe(true);
    expect(feedback.unevaluated).toContain('/passages/3');expect(feedback.complete_validation).toBe(false);
    expect(JSON.stringify(feedback)).not.toContain('referee_private_note');expect(f).toEqual(before);
  });
  it.each(['openai','openrouter'] as const)('%s serializes BOTH families and the operative support repair into the actual next request',async provider=>{
    const f=fixture(),t=transport(f,[f.replies[0],f.corrected],provider);
    const report=await t.run();expect(t.requests).toHaveLength(2);
    const sent=correction(t.requests[1]);expect(sent).toContain('COVERAGE_REFERENCE_MISSING');expect(sent).toContain('COUNTING_SUPPORT_MISMATCH');
    expect(sent).toContain('omit operator_message_id/operator_clarification');expect(sent).not.toContain('referee_private_note');
    expect(sent).toContain('Read exclusion is not evidence');expect(sent).not.toContain('operator_message_id":9');
    expect(report.counting_inventory?.paths).toHaveLength(2);
    expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false); // intrinsic ownership still missing
    if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR) await fs.writeFile(`${process.env.SYNAPSOR_TEST_EVIDENCE_DIR}/${provider}-wire.json`,JSON.stringify({classification:'local adapter transport; derived corrected response',requests:t.requests},null,2));
  });
  it('refuses the unchanged historical full correction envelope with no third opinion',async()=>{
    const f=fixture(),t=transport(f,f.replies);await expect(t.run()).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');expect(t.requests).toHaveLength(2);
  });
  it.each(['openai','openrouter'] as const)('%s streamed local transport delivers feedback and never executes an incomplete call',async provider=>{
    const f=fixture(),t=transport(f,[f.replies[0],f.corrected],provider),wire:any[]=[],events:any[]=[];
    let incomplete=false;
    const server=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req) chunks.push(Buffer.from(chunk));
      wire.push(JSON.parse(Buffer.concat(chunks).toString()));
      const args=wire.length===1?f.replies[0]:derivedScopedResponse(wire.at(-1),f.corrected);
      res.setHeader('content-type','text/event-stream');
      if(provider==='openai') {
        res.write(`data: ${JSON.stringify({type:'response.output_item.added',item:{type:'function_call',name:'runner__review_policy_coverage'}})}\n\n`);
        res.end(`data: ${JSON.stringify({type:incomplete?'response.incomplete':'response.completed',response:{status:incomplete?'incomplete':'completed',output:[{type:'function_call',name:'runner__review_policy_coverage',call_id:'wire',arguments:JSON.stringify(args)}]}})}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({choices:[{delta:{reasoning_details:[{type:'reasoning.encrypted',data:'opaque-private-continuation',index:0}],tool_calls:[{index:0,id:'wire',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(args)}}]}}]})}\n\n`);
        res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:incomplete?'length':'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
      }
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const requestJson=(r:any)=>secureAskJsonRequest({...r,headers:{},endpoint:new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/test`),scope:'custom_loopback'});
      Object.assign(t.session.dependencies,{requestJson,onStream:(e:any)=>events.push(e)});
      await t.run();expect(wire).toHaveLength(2);expect(correction(wire[1])).toContain('COUNTING_SUPPORT_MISMATCH');expect(correction(wire[1])).toContain('COVERAGE_REFERENCE_MISSING');
      expect(JSON.stringify(events)).not.toContain('opaque-private-continuation');
      incomplete=true;const after=vi.fn();
      await expect(reviewPolicyCoverage({source:f.source,draft:f.draft,session:t.session,episode:{beforeSubmission:async()=>{},afterSubmission:after}})).rejects.toMatchObject({code:provider==='openai'?'ASK_PROVIDER_RESPONSE_INVALID':'ASK_PROVIDER_RESPONSE_INCOMPLETE'});
      expect(after).not.toHaveBeenCalled();
      if(process.env.SYNAPSOR_TEST_EVIDENCE_DIR) await fs.writeFile(`${process.env.SYNAPSOR_TEST_EVIDENCE_DIR}/${provider}-actual-http-wire.json`,JSON.stringify(wire,null,2));
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('keeps opaque OpenRouter continuation private and outside structural correction content',async()=>{
    const f=fixture(),t=transport(f,[f.replies[0],f.corrected],'openrouter'),events:any[]=[];
    const original=t.session.dependencies.requestJson;
    t.session.dependencies.requestJson=vi.fn(async(r:any)=>{
      const response:any=await original(r);
      response.body.choices[0].message.reasoning_details=[{type:'reasoning.encrypted',data:'opaque-private-continuation',id:'r1',index:0}];return response;
    });
    Object.assign(t.session.dependencies,{onStream:(event:any)=>events.push(event)});
    await t.run();expect(JSON.stringify(events)).not.toContain('opaque-private-continuation');
    expect(correction(t.requests[1])).not.toContain('opaque-private-continuation');
    expect(JSON.stringify(t.requests[1])).not.toContain('opaque-private-continuation'); // separate bounded submission, no private-text echo
  });
  it('stops on a context change before transmitting a correction',async()=>{
    const f=fixture(),t=transport(f,[f.replies[0],f.corrected]);
    await expect(reviewPolicyCoverage({source:f.source,draft:f.draft,session:t.session,
      episode:{beforeSubmission:async()=>{},afterSubmission:async()=>{f.draft.actions[0].approval.shared_limits[0].maximum=1;}}})).rejects.toThrow('POLICY_COVERAGE_CONTEXT_CHANGED');
    expect(t.requests).toHaveLength(1);
  });
  it('a fully valid first report needs no correction',async()=>{const f=fixture(),t=transport(f,[f.corrected]);await t.run();expect(t.requests).toHaveLength(1);});
  it('returns a genuine policy conflict as unresolved without requesting a favorable opinion',async()=>{
    const f=fixture();f.corrected.passages.push({start:7,end:7,disposition:'conflict',responsibility:'runner',interpretation:'An additional actual policy condition is not implemented.',draft_paths:['/actions/0/approval']});
    const t=transport(f,[f.corrected]);const report=await t.run();expect(t.requests).toHaveLength(1);expect(policyReviewReadiness(f.source,report,f.sources).ready).toBe(false);
  });
  it('never echoes unknown private names, values or arbitrary keys in feedback',()=>{
    const f=fixture();for(const value of ['/credentials/private_row_7_SECRET','/fields/referee_private_note','/\u001b[31mPRIVATE']) {
      const args=structuredClone(f.corrected);args.passages[0].draft_paths=[value];
      const text=JSON.stringify(collectCoverageFeedback(args,f.source,f.draft,f.sources.operator_messages));expect(text).not.toContain(value);expect(text).not.toContain('PRIVATE');
    }
    const report=collectCoverageFeedback({'private_secret_key':true},f.source,f.draft,f.sources.operator_messages);
    expect(JSON.stringify(report)).not.toContain('private_secret_key');expect(report.unevaluated).toEqual(['/passages']);
  });
  it('bounds findings/work and labels dependent or remaining checks unevaluated',()=>{
    const f=fixture();const malformed={start:'bad',draft_paths:['/private_unknown']};
    const r=collectCoverageFeedback({passages:Array(120).fill(malformed)},f.source,f.draft,f.sources.operator_messages);
    expect(r.limited).toBe(true);expect(r.findings.length).toBeLessThanOrEqual(8);expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(MAX_COVERAGE_FEEDBACK_BYTES);
    expect(r.findings.every(x=>x.code==='COVERAGE_STRUCTURE_INVALID')).toBe(true);expect(JSON.stringify(r)).not.toContain('private_unknown');
  });
  it.each(['wrong_support','broad_counter','wrong_value','unavailable_domain','invented_duty','mixed_privacy','wrong_maximum'])('keeps %s strict',mode=>{
    const f=fixture(),p=f.corrected.passages.find((x:any)=>x.counter_requirements);
    if(mode==='wrong_support')p.counter_requirements[0].operator_message_id=9;
    if(mode==='broad_counter')p.counter_requirements[0].path='/actions/0/approval';
    if(mode==='wrong_value')p.counter_requirements[0].required_capability=null;
    if(mode==='unavailable_domain')f.draft.runner_evidence.actions['league.result_ratification'].automatic_limits[0].maximum=999;
    if(mode==='invented_duty')f.corrected.passages[0].application_obligations=['waive_privacy'];
    if(mode==='mixed_privacy')p.field_checks=[{resource:'missing',field:'private_secret',expectation:'private'}];
    if(mode==='wrong_maximum')p.evidence_checks=[{path:'/runner_evidence/actions/league.result_ratification/automatic_limits/0/maximum',equals:999}];
    expect(()=>parsePolicyCoverage(f.corrected,f.source,f.draft,f.sources.operator_messages)).toThrow();
  });
  it('preserves the original full-report progress oracle while refusing a new outside mutation in scoped transport',async()=>{
    const f=fixture(),second=structuredClone(f.corrected);second.passages[0].draft_paths=['/not_present'];
    const first=collectCoverageFeedback(f.replies[0],f.source,f.draft,f.sources.operator_messages);
    const next=collectCoverageFeedback(second,f.source,f.draft,f.sources.operator_messages);
    expect(permitsSecondCoverageCorrection([first],next)).toBe(true); // historical full-report oracle is unchanged
    const t=transport(f,[f.replies[0],(body:any)=>{
      const replacement=derivedScopedResponse(body,f.corrected);
      replacement.groups.find((g:any)=>g.passage_replacements.length).passage_replacements[0].fragments.push({category:'ordinary',passage:second.passages[0]});
      return replacement;
    },f.corrected]);
    await expect(t.run()).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');expect(t.requests).toHaveLength(2);
  });
  it('deleting failed components is not evidence of resolved structural findings',async()=>{
    const f=fixture(),t=transport(f,[f.replies[0],(body:any)=>{
      const replacement=derivedScopedResponse(body,f.corrected);
      const group=replacement.groups.find((g:any)=>g.counter_replacements.length);
      group.counter_replacements.pop();
      return replacement;
    },f.corrected]);
    await expect(t.run()).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');expect(t.requests).toHaveLength(2);
  });
  it.each(['counter','pointer'])('relocating the same invalid %s is not a newly exposed issue',async kind=>{
    const f=fixture(),second=structuredClone(f.corrected);
    const repeated=structuredClone(f.replies[0].passages[kind==='counter'?8:3]);
    repeated.start=repeated.end=1;second.passages.push(repeated);
    const first=collectCoverageFeedback(f.replies[0],f.source,f.draft,f.sources.operator_messages);
    expect(permitsSecondCoverageCorrection([first],collectCoverageFeedback(second,f.source,f.draft,f.sources.operator_messages))).toBe(false);
    const t=transport(f,[f.replies[0],(body:any)=>{
      const replacement=derivedScopedResponse(body,f.corrected);
      replacement.groups.find((g:any)=>g.passage_replacements.length).passage_replacements[0].fragments.push({category:'ordinary',passage:repeated});
      return replacement;
    },f.corrected]);
    await expect(t.run()).rejects.toThrow('COVERAGE_SCOPED_CORRECTION_REFUSED');
    expect(t.requests).toHaveLength(2);
  });
  it('rejects stale context, reintroduced identities and code-only changes as progress',()=>{
    const f=fixture(),first=collectCoverageFeedback(f.replies[0],f.source,f.draft,f.sources.operator_messages);
    expect(permitsSecondCoverageCorrection([first],first)).toBe(false);
    expect(permitsSecondCoverageCorrection([first],{...first,context:canonicalJsonDigest('changed')})).toBe(false);
    const changed=structuredClone(first);changed.findings[0]!.code='COUNTING_COMPARISON_INVALID';
    expect(permitsSecondCoverageCorrection([first],changed)).toBe(false);
  });
});

describe('durable bounded review episodes and actual prepared save',()=>{
  async function prepared(mode:string) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'coverage-episode-'));const f=fixture();
    const t=transport(f,mode==='interrupted'?[new Error('transport stopped')]:[f.replies[0],f.corrected]);
    vi.spyOn(receiptConfiguration,'authoringReceiptConfiguration').mockResolvedValue(f.draft.runner_evidence.runtime_contract.receipt_configuration);
    const chooseOption=vi.fn(async()=> 'assign'),confirm=vi.fn(async()=>false),onValidated=vi.fn();
    await savePolicySources(root,f.sources);
    const input={projectRoot:root,sources:f.sources,modelSession:t.session,operatorSession:{chooseOption,confirm} as any,currentDraft:()=>f.draft,
      authorityDigest:f.sources.coverage_authority_digest,clarifications:[],assertCurrent:async()=>{},state:{},onValidated};
    return {root,f,t,input,chooseOption,confirm,onValidated};
  }
  it('strictly validates, saves coverage plus explicit unverified ownership, restarts and reuses',async()=>{
    const x=await prepared('success');try {
      const result=await ensurePreparedPolicyCoverage(x.input);expect(result.activity).toBe('provider');
      const saved=await loadPolicySources(x.root,x.f.sources.id);expect(saved.coverage_episodes?.[0]?.submissions).toHaveLength(2);
      expect(policyReviewReadiness(x.f.source,saved.coverage,saved).ready).toBe(true);
      expect(saved.application_assignments?.at(-1)).toMatchObject({owner:'client_application',verified:false,origin:'PRODUCT-CLIENT-CONTRACT'});
      x.t.session.conversation.policySources=saved;
      const reused=await ensurePreparedPolicyCoverage({...x.input,sources:saved,state:{}});expect(reused.activity).toBe('validated_reuse');
      expect(x.t.requests).toHaveLength(2);expect(x.chooseOption).toHaveBeenCalledTimes(1);expect(x.confirm).not.toHaveBeenCalled();
    }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
  });
  it('interruption persists the reserved call; restart requires explicit new-episode authorization',async()=>{
    const x=await prepared('interrupted');try{
      const before=structuredClone(x.f.sources);await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow('transport stopped');
      const saved=await loadPolicySources(x.root,x.f.sources.id);expect(saved.coverage_episodes?.[0]?.submissions).toHaveLength(1);
      expect(saved.application_assignments).toEqual(before.application_assignments);expect(saved.coverage).toEqual(before.coverage);
      await expect(ensurePreparedPolicyCoverage({...x.input,sources:saved,state:{}})).rejects.toThrow('POLICY_COVERAGE_EPISODE_PENDING');
      expect(x.t.requests).toHaveLength(1);expect(x.onValidated).not.toHaveBeenCalled();
      expect((await loadPolicySources(x.root,x.f.sources.id)).coverage_episodes).toEqual(saved.coverage_episodes);
    }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
  });
  it.each(['failed_reservation','concurrent_save'])('a %s cannot send an unreserved call or install ownership',async mode=>{
    const x=await prepared('success');try {
      if(mode==='failed_reservation') vi.spyOn(fs,'rename').mockRejectedValue(new Error('owned save failed'));
      else x.input.assertCurrent=async()=>{await savePolicySources(x.root,{...x.f.sources,operator_messages:[...x.f.sources.operator_messages,'Concurrent genuine decision']});};
      await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow(mode==='failed_reservation'?'owned save failed':'POLICY_SOURCE_CHANGED');
      expect(x.t.requests).toHaveLength(0);expect(x.chooseOption).not.toHaveBeenCalled();expect(x.onValidated).not.toHaveBeenCalled();
      expect((await loadPolicySources(x.root,x.f.sources.id)).application_assignments).toEqual(x.f.sources.application_assignments);
    }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
  });
  it('records a separately confirmed new episode without erasing the interrupted one',async()=>{
    const x=await prepared('interrupted');try{
      await expect(ensurePreparedPolicyCoverage(x.input)).rejects.toThrow('transport stopped');
      const saved=await loadPolicySources(x.root,x.f.sources.id),old=structuredClone(saved.coverage_episodes);
      const t=transport({...x.f,sources:saved},[x.f.corrected]);
      const result=await ensurePreparedPolicyCoverage({...x.input,sources:saved,modelSession:t.session,state:{},operatorSession:{...x.input.operatorSession,confirm:async()=>true}});
      expect(result.activity).toBe('provider');const final=await loadPolicySources(x.root,saved.id);
      expect(final.coverage_episodes).toHaveLength(2);expect(final.coverage_episodes?.slice(0,1)).toEqual(old);expect(t.requests).toHaveLength(1);
    }finally{vi.restoreAllMocks();await fs.rm(x.root,{recursive:true,force:true});}
  });

});
