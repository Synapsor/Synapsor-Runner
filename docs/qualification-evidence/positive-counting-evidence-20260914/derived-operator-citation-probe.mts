import fs from 'node:fs';
import {parsePolicyCoverage} from '../../../apps/runner/src/authoring-policy-coverage.js';
import {policyTextSnapshot} from '../../../apps/runner/src/authoring-policy-source.js';
import {reviewUnestablishedCounting} from '../../../apps/runner/src/authoring-counting-decision-review.js';
const f=JSON.parse(fs.readFileSync(new URL('../../../apps/runner/src/fixtures/mixed-counting-review.json',import.meta.url),'utf8'));
const d=f.drafts[0],source=policyTextSnapshot(Buffer.from('No more than two ratifications may be auto-approved per league per day and six overall.'),'probe.txt');
d.runner_evidence.counting_interpretations=[];const outcome=d.actions[0].outcome;
for(const l of d.actions[0].approval.shared_limits)l.capability=outcome;
for(const l of d.runner_evidence.actions[outcome].automatic_limits){l.capability=outcome;l.history_selector.capability=outcome;}
const messages=['An unrelated display explanation.'];
d.runner_evidence.counting_decisions=await reviewUnestablishedCounting({source,draft:d,messages,assertCurrent:async()=>{},session:{chooseOption:async()=> 'outcome-0',confirm:async()=>true}});
const p=f.replies[0].passages.find((p:any)=>p.counter_requirements);p.start=p.end=1;p.disposition='implemented';delete p.operator_message_id;
for(const c of p.counter_requirements){c.current_capability=c.required_capability=outcome;c.operator_message_id=1;}
let result;try{const report=parsePolicyCoverage({passages:[p]},source,d,messages);result={accepted:true,disposition:report.passages[0]!.disposition};}catch(e){result={accepted:false,error:String(e)};}
console.log(JSON.stringify({classification:'Derived zero-provider explicit-review provenance probe; separate from captured replies',expected:'refuse explicitly unrelated counter citation, while retaining the authentic operator decision',...result},null,2));
