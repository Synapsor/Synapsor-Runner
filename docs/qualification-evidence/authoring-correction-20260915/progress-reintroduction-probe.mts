// Read-only deterministic progress probe; no provider/store/application mutation.
import fs from 'node:fs';
import { collectCoverageFeedback } from '../../../apps/runner/src/authoring-policy-coverage.js';
import { permitsSecondCoverageCorrection } from '../../../apps/runner/src/authoring-coverage-feedback.js';
const f=JSON.parse(fs.readFileSync('apps/runner/src/test-fixtures/coverage-correction-captures.json','utf8'));
const source=f.sources.snapshots.find((s:any)=>s.version===f.sources.active);
const first=collectCoverageFeedback(f.arguments[0],source,f.draft,f.sources.operator_messages);
const second=structuredClone(f.arguments[1]);
for(const p of second.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
const repeated=structuredClone(f.arguments[1].passages.find((p:any)=>p.counter_requirements));
repeated.start=repeated.end=1;second.passages.push(repeated);
const next=collectCoverageFeedback(second,source,f.draft,f.sources.operator_messages);
const result={classification:'derived reintroduced identical bad counter citation moved to another passage/source range',first:first.findings.map(f=>({code:f.code,component:f.component})),next:next.findings.map(f=>({code:f.code,component:f.component})),second_correction_permitted:permitsSecondCoverageCorrection([first],next)};
fs.writeFileSync(process.env.SYNAPSOR_TEST_EVIDENCE_DIR+'/result.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
if(result.second_correction_permitted)process.exitCode=1;
