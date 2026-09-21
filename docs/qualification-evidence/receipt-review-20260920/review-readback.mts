// Read-only saved-state inspection. Public restart/recheck establishes freshness;
// this separately verifies actual persisted coverage/ownership, not a CLI exit.
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {policyReviewReadiness} from '../../../apps/runner/src/authoring-review-readiness.ts';
import {parsePolicyCoverage} from '../../../apps/runner/src/authoring-policy-coverage.ts';
const root=process.argv[2]!,label=process.argv[3]!,draftFile=process.argv[4];
const dir=path.join(root,'project/.synapsor/boundary-authoring/policy-sources');
const files=(await fs.readdir(dir)).filter(p=>p.endsWith('.json'));if(files.length!==1)throw Error('Ambiguous saved source; select explicitly');
const sources=JSON.parse(await fs.readFile(path.join(dir,files[0]!),'utf8'));
const source=sources.snapshots.find((s:any)=>s.version===sources.active);
const report=sources.coverage;
if(!source||!report)throw Error('Missing actual persisted review');
const readiness=policyReviewReadiness(source,report,sources);
let replay:any;
if(draftFile){const draft=JSON.parse(await fs.readFile(draftFile,'utf8'));const checked=parsePolicyCoverage({passages:report.passages},source,draft,sources.operator_messages??[]);replay={classification:'current captured prepared context, not a new provider or atomic store read',equal:canonicalJsonDigest(checked)===canonicalJsonDigest(report),draft_digest:canonicalJsonDigest(draft)};}
const result={label,source:{name:source.name,version:source.version,digest:source.digest},source_session:sources.id,coverage_digest:canonicalJsonDigest(report),coverage_draft_digest:report.draft_digest,
 ready:readiness.ready,items:readiness.items,summary:readiness.summary,assessments:report.passages.filter((p:any)=>p.obligation_assessment).map((p:any)=>({start:p.start,end:p.end,disposition:p.disposition,draft_paths:p.draft_paths,assessment:p.obligation_assessment})),
 assignments:sources.application_assignments,episodes:sources.coverage_episodes,application_verified:sources.application_assignments?.some((a:any)=>a.verified===true)??false,replay};
await fs.mkdir(path.join(root,'state-readbacks'),{recursive:true});await fs.writeFile(path.join(root,'state-readbacks',label+'-business.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({label,ready:result.ready,blocked:readiness.items?.filter(i=>i.blocksReview).map(i=>i.title),assessment_families:result.assessments.map((p:any)=>p.assessment.family),replay}));
