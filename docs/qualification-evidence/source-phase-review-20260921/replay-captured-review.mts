// Read-only exact parser/feedback replay. No provider, application, or persistence operation.
import fs from 'node:fs/promises';
import { parsePolicyCoverage, collectCoverageFeedback } from '../../../apps/runner/src/authoring-policy-coverage.ts';
import { policyReviewReadiness } from '../../../apps/runner/src/authoring-review-readiness.ts';
const file=process.argv[2]!,output=process.argv[3]!;
const f=JSON.parse(await fs.readFile(file,'utf8'));
const result:any={input:file,kind:'EXACT captured complete response replay',side_effects:false};
try { const report=parsePolicyCoverage(f.arguments,f.source,f.draft,f.operator_messages??f.sources.operator_messages); result.parse='PASS';result.readiness=policyReviewReadiness(f.source,report,f.sources); }
catch(e:any) { result.parse='REFUSED';result.first_error=e.message;result.feedback=collectCoverageFeedback(f.arguments,f.source,f.draft,f.operator_messages??f.sources.operator_messages,e); }
await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
