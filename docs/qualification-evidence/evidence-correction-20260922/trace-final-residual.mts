// Read-only diagnostic on exact captured final context. No store/provider open.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {assessReviewObligation} from '../../../apps/runner/src/authoring-obligation-review.ts';
import {coverageFinding} from '../../../apps/runner/src/authoring-coverage-feedback.ts';
const root='/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/evidence-correction-f0a6fd1-20260922';
const f=JSON.parse(fs.readFileSync(root+'/private/live-validation-input.json','utf8'));
const matches=f.arguments.passages.map((p:any,index:number)=>({p,index})).filter(({p}:any)=>p.draft_paths.includes('/runner_evidence/runtime_contract/receipt_configuration')&&p.draft_paths.includes('/runner_evidence/runtime_contract/receipts'));
assert.equal(matches.length,1);const {p,index}=matches[0];let cause='';let finding:any;
try{assessReviewObligation(p,f.source,f.draft);}catch(e){cause=(e as Error).message;finding=coverageFinding(e,`/passages/${index}`,p);}
assert(cause.startsWith('OBLIGATION_CONFIGURATION_COMPONENT_MIXED:'));assert.equal(finding.code,'COVERAGE_VALIDATION_INCOMPLETE');assert.equal(finding.structural,false);
const result={classification:'read-only trace; not a new product change, review or eligibility decision',external_provider_calls:0,actual_response_component:`/passages/${index}`,strict_cause:cause,safe_finding:finding,ordering:'receiptSelectionComponent rejects the mixed configuration claim before the later typed receipt-observation correction branch; this is not receipt Read-exclusion',not_established:'No new owner-policy ambiguity, missing infrastructure, absent historical receipt or source safety defect follows from this generic feedback classification.'};
fs.writeFileSync(root+'/FINAL-RESIDUAL-TRACE-001.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({strict_cause:cause,safe_code:finding.code,structural:finding.structural}));
