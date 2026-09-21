// Exact unchanged captured full submissions, read-only current-source diagnostic.
// The normal tests separately exercise wire transports and persistence.
import fs from 'node:fs/promises';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { parsePolicyCoverage, collectCoverageFeedback } from '../../../apps/runner/src/authoring-policy-coverage.ts';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.ts';
const captures = JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/test-fixtures/receipt-review-association.json', import.meta.url), 'utf8'));
const output:any = { classification:'Exact unchanged full captured submissions on final source; zero provider/store operations; not installed public completion', at:new Date().toISOString() };
for (const c of ['A','B']) {
 const f = captures[c];
 const record:any = { arguments_digest:canonicalJsonDigest(f.arguments), source_digest:canonicalJsonDigest(f.source), draft_digest:canonicalJsonDigest(f.draft) };
 try {
  const report = parsePolicyCoverage(f.arguments,f.source,f.draft,f.sources.operator_messages);
  record.result='accepted';
  record.receipt_components=report.passages.filter(p=>p.obligation_assessment?.family==='receipt_setup');
  record.readiness=policyReviewReadiness(f.source,report,f.sources);
 } catch (e:any) {
  record.result='refused';record.error={name:e.name,code:e.code,component:e.component,message:e.message};
  record.feedback=collectCoverageFeedback(f.arguments,f.source,f.draft,f.sources.operator_messages,e);
 }
 output[c]=record;
}
const destination='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-review-5d92ca5-20260920/exact-after-replay.json';
await fs.writeFile(destination,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({destination,A:output.A.result,A_findings:output.A.feedback?.findings.map((x:any)=>({code:x.code,structural:x.structural})),B:output.B.result,B_ready:output.B.readiness?.ready}));
