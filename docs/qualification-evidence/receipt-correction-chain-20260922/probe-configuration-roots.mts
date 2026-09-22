// Labelled derived pointer diagnostics, no store/provider and no original edits.
import fs from 'node:fs/promises';
import {parsePolicyCoverage,collectCoverageFeedback} from '../../../apps/runner/src/authoring-policy-coverage.ts';
const f=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/test-fixtures/receipt-correction-chain.json',import.meta.url),'utf8'));
const results=[];
for(const pointer of ['/runner_evidence/runtime_contract/receipt_configuration/status','/runner_evidence/runtime_contract']) {
 const args=structuredClone(f.arguments);for(const p of args.passages)for(const c of p.counter_requirements??[])delete c.operator_message_id;
 args.passages[25].draft_paths=[pointer];let accepted=false,cause='';
 try{parsePolicyCoverage(args,f.source,f.draft,f.operator_messages);accepted=true;}catch(e){cause=(e as Error).message;}
 results.push({pointer,accepted,cause,feedback:collectCoverageFeedback(args,f.source,f.draft,f.operator_messages)});
}
const target=process.argv[2];if(!target)throw Error('Exclusive output required');
await fs.writeFile(target,JSON.stringify({classification:'Derived root-routing controls, not historical model replies',results},null,2)+'\n',{flag:'wx'});
console.log(results.map(({pointer,accepted,cause})=>({pointer,accepted,cause})));
