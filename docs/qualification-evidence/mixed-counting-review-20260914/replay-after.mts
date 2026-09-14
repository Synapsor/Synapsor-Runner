import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parsePolicyCoverage } from "../../../apps/runner/src/authoring-policy-coverage.js";
import { bindPolicyCoverage } from "../../../apps/runner/src/authoring-policy-source.js";
import { policyReviewReadiness } from "../../../apps/runner/src/authoring-review-readiness.js";
const E=path.dirname(fileURLToPath(import.meta.url)),trace=JSON.parse(await fs.readFile(path.join(E,'../counting-contract-review-20260914/installed-public-trace.json'),'utf8'));
const fixture=JSON.parse(await fs.readFile(path.join(E,'../../../apps/runner/src/fixtures/mixed-counting-review.json'),'utf8'));
for(const entry of trace.raw_files)assert.equal(createHash('sha256').update(await fs.readFile(entry.path)).digest('hex'),entry.sha256);
assert.deepEqual(fixture.requests,trace.requests);assert.deepEqual(fixture.replies,trace.replies);assert.deepEqual(fixture.drafts,trace.drafts);
const results=trace.replies.map((reply:any,index:number)=>{
 const original=JSON.stringify(reply),report=parsePolicyCoverage(reply,trace.source,trace.drafts[index],trace.operator_messages),state=structuredClone(fixture.policy_sources);
 bindPolicyCoverage(state,report,state.coverage_authority_digest);assert(policyReviewReadiness(trace.source,report,state).ready);assert.equal(JSON.stringify(reply),original);
 assert.deepEqual(parsePolicyCoverage({passages:report.passages},trace.source,trace.drafts[index],trace.operator_messages),report);
 return {call:index+1,exact_response_unchanged:true,business_ready:true,components:report.passages.flatMap(p=>p.counting_components??[]),
  residual_pending:report.passages.filter(p=>!['implemented','background','overridden'].includes(p.disposition)),report};
});
await fs.writeFile(path.join(E,'after-replay.json'),JSON.stringify({at:new Date().toISOString(),classification:'Host exact-response replay and persisted-record parser; installed public confirmation remains separate',provider_calls:0,results},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({exact_replies:results.length,business_ready:true,component_support_preserved:true,provider_calls:0}));
