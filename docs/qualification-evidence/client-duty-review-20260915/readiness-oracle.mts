// Read-only implementation inspection of a quiescent installed-run snapshot.
// Public CLI completion is recorded separately; this creates no attestation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.js';
import { clientDutyAssigned } from '../../../apps/runner/src/authoring-client-duties.js';
const E=path.dirname(new URL(import.meta.url).pathname);
const plan=JSON.parse(fs.readFileSync(path.join(E,'assignment-plan.json'),'utf8'));
const [run,label]=process.argv.slice(2);assert(plan.case_sources[run]&&/^[a-z0-9-]+$/.test(label));
const P=path.join(plan.owned_root,'runs',run,'checkpoints',label,'project');
const resume=JSON.parse(fs.readFileSync(path.join(P,'.synapsor/boundary-authoring/resume.json'),'utf8'));
const session=JSON.parse(fs.readFileSync(path.join(P,'.synapsor/boundary-authoring/policy-sources',resume.policy_source_session+'.json'),'utf8'));
const source=session.snapshots.find((s:any)=>s.version===session.active);
const readiness=policyReviewReadiness(source,session.coverage,session);
const ownership=(session.coverage?.client_duties?.duties??[]).map((d:any)=>({duty:d,assigned:clientDutyAssigned(session.coverage,d,session)}));
const sha=(f:string)=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const result={at:new Date().toISOString(),run,label,artifact_tree:plan.artifact_tree,
  kind:'Read-only pure implementation oracle over the installed-run snapshot; not a separate public operation',
  modules:['authoring-review-readiness.ts','authoring-client-duties.ts','authoring-policy-source.ts'].map(n=>({name:n,sha256:sha(path.resolve(E,'../../../apps/runner/src',n))})),
  source_digest:source.digest,coverage_draft_digest:session.coverage?.draft_digest,
  client_duties:session.coverage?.client_duties,ownership,readiness};
fs.writeFileSync(path.join(E,`${run}-${label}-readiness.json`),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({run,label,ready:readiness.ready,ownership,items:readiness.items?.map(i=>({title:i.title,blocksReview:i.blocksReview,clientDuty:i.clientDuty}))}));
