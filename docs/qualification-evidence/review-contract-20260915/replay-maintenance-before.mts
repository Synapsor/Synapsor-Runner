import fs from 'node:fs';
import { parsePolicyCoverage } from '../../../apps/runner/src/authoring-policy-coverage.ts';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.ts';
import { bindPolicyCoverage } from '../../../apps/runner/src/authoring-policy-source.ts';
const E=new URL('.',import.meta.url),plan=JSON.parse(fs.readFileSync(new URL('assignment-plan.json',E),'utf8'));
const captured=JSON.parse(fs.readFileSync(plan.owned_root+'/private/primary-maintenance-capture.json','utf8'));
const before=JSON.stringify(captured);
const report=parsePolicyCoverage(captured.arguments,captured.source,captured.draft,captured.operator_messages);
const session=structuredClone(captured.session);
bindPolicyCoverage(session,report,captured.session.coverage_authority_digest);
const readiness=policyReviewReadiness(captured.source,session.coverage,session);
const result={classification:'Exact captured response through parser, coverage binding and readiness; read-only saved inputs, no provider call or store open',
  ready:readiness.ready,blocking:readiness.items?.filter(x=>x.blocksReview),input_unchanged:before===JSON.stringify(captured),
  completion_permitted:readiness.ready,actual_provider_calls:0};
fs.writeFileSync(new URL('maintenance-before-result.json',E),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result));
if(readiness.ready)process.exitCode=1;
