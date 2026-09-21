// Exact captured current context. Derived pointer-only control is not a submitted reply.
import fs from 'node:fs/promises';
import path from 'node:path';
import {receiptRequirement,assessReviewObligation,RECEIPT_PATH} from '../../../apps/runner/src/authoring-obligation-review.ts';
const root=process.argv[2]!;
const read=async(n:string)=>JSON.parse(await fs.readFile(path.join(root,n),'utf8'));
const draft=await read('receipt-pending-prepared-draft.json'),state=await read('source-state-after-receipt-review.json');
const source=state.snapshots.find((s:any)=>s.version===state.active);
const p=state.coverage.passages.find((p:any)=>p.topic==='Source-database receipt');
const result={classification:'read-only exact saved receipt obligation plus labelled derived pointer control; zero provider/store operations',source_requirement:source.text.split('\n').slice(p.start-1,p.end).join('\n'),
 passage:p,configuration:draft.runner_evidence.runtime_contract.receipt_configuration,
 detected_requirement:receiptRequirement(source,p)??null,
 actual_obligation:assessReviewObligation(p,source,draft)??null,
 derived_receipts_only_pointer_obligation:assessReviewObligation({...p,draft_paths:[RECEIPT_PATH]},source,draft)??null,
 observations:['Exact policy range positively resolves source_db; the rejected Runner-ledger-only phrase is not a second matched receipt requirement. No source ambiguity was demonstrated.',
 'Actual pending passage links receipt_configuration only; receipt_setup phase association also requires the narrow receipts path.',
 'Current reviewed disabled intent is present in the real provider request; no actual runtime configuration or observed receipt is claimed.']};
await fs.writeFile(path.join(root,'receipt-pending-trace.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({detected_requirement:result.detected_requirement,actual_obligation:result.actual_obligation,derived_pointer_only:result.derived_receipts_only_pointer_obligation,intent:result.configuration.reviewed_intent?.status}));
