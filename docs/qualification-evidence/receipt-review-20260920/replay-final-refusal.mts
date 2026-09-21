// Read-only parser replay of a captured final submission; no provider/store operation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parsePolicyCoverage, collectCoverageFeedback } from '../../../apps/runner/src/authoring-policy-coverage.ts';
const meter=process.argv[2]!; const id=process.argv[3]!;
const read=async(n:string)=>JSON.parse(await fs.readFile(path.join(meter,n),'utf8'));
const sources=await read('source-state-after-refusal.json');
const source=sources.snapshots.find((s:any)=>s.version===sources.active);
const draft=await read(`${id}-prepared-draft.json`), response=await read(`${id}-assembled.json`);
const report:any={classification:'read-only exact captured parser replay; no live request, no persistence',submission:id};
try { report.result=parsePolicyCoverage(response,source,draft,sources.operator_messages??[]); }
catch(e:any) { report.error={name:e.name,code:e.code,message:e.message,component:e.component,cause:e.cause?.message};
 report.feedback=collectCoverageFeedback(response,source,draft,sources.operator_messages??[],e);
}
await fs.writeFile(path.join(meter,`${id}-parser-replay.json`),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.error??{passed:true}));
