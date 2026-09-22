// Read-only exact captured context/response; no original store or provider call.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {parsePolicyCoverage,collectCoverageFeedback,reviewPolicyCoverage} from '../../../apps/runner/src/authoring-policy-coverage.ts';
import {createModelAuthoringConversation} from '../../../apps/runner/src/model-authoring-conversation.ts';
const f=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/test-fixtures/evidence-aware-correction.json',import.meta.url),'utf8'));
let refusal='';try{parsePolicyCoverage(f.arguments,f.source,f.draft,f.operator_messages);}catch(e){refusal=(e as Error).message;}
assert(refusal.startsWith('COUNTING_SUPPORT_MISMATCH:'));
const feedback=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages);
assert.deepEqual(feedback.findings.map(x=>x.code),['COUNTING_SUPPORT_MISMATCH','COUNTING_SUPPORT_MISMATCH','RECEIPT_READ_EXCLUSION_UNESTABLISHED']);
const conversation=createModelAuthoringConversation();conversation.policySources=f.sources;
const wire:any[]=[];
const session={provider:'openrouter' as const,model:'openai/gpt-5.6-terra',apiKey:'local-only',conversation,dependencies:{requestJson:async(r:any)=>{wire.push(r.body);return {status:200,body:{choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'baseline',type:'function',function:{name:'runner__review_policy_coverage',arguments:JSON.stringify(f.arguments)}}]}}]}};}}};
let stopped='';try{await reviewPolicyCoverage({session,source:f.source,draft:f.draft});}catch(e){stopped=(e as Error).message;}
assert.equal(wire.length,process.argv.includes("--after")?2:1);assert(stopped.includes('POLICY_COVERAGE_INVALID'));
console.log(JSON.stringify({refusal,feedback,producer_requests:wire.length,correction_sent:wire.length===2,external_provider_calls:0,original_store_opened:false},null,2));
