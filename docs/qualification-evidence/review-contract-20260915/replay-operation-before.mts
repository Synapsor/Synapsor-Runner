import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { planModelBoundaryJob } from '../../../apps/runner/src/boundary-job-model.ts';
const E=new URL('.',import.meta.url);
const captured=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/fixtures/review-operation-sol-capture.json',E),'utf8'));
let calls=0,diagnostic;
await assert.rejects(planModelBoundaryJob({session:{provider:'openai',model:'gpt-test',apiKey:'test-only',dependencies:{requestJson:async()=>{
 calls++;return{status:200,body:captured.response};}}},jobIntent:captured.jobIntent,currentState:captured.currentState,
 availableResourceIds:captured.availableResourceIds,egressAcknowledged:true,onDiagnostic:value=>{diagnostic=value;}}),/Review-only routing cannot contain a business edit/u);
assert.equal(calls,2);
await fs.writeFile(new URL('operation-before-result.json',E),JSON.stringify({classification:'Deterministic real adapter/parser replay of the exact newly captured first response. The same first response is replayed for the bounded correction; it is NOT a captured second response.',actual_provider_calls:0,mock_transport_calls:calls,diagnostic},null,2)+'\n',{flag:'wx'});
console.log('Exact new sol first response refused through actual adapter/parser; repeated-response bounded correction also refused.');
