// Derived exact A variant: same claims/source, use the existing compiled effect
// evidence root instead of its draft AST root. Never a provider response.
import fs from 'node:fs/promises';
import {collectCoverageFeedback} from '../../../apps/runner/src/authoring-policy-coverage.ts';
const f=JSON.parse(await fs.readFile(new URL('../../../apps/runner/src/test-fixtures/receipt-review-association.json',import.meta.url),'utf8')).A;
f.arguments.passages[14].draft_paths[0]='/runner_evidence/actions/release.clear_assessment/effect';
const result=collectCoverageFeedback(f.arguments,f.source,f.draft,f.sources.operator_messages);
console.log(JSON.stringify({classification:'derived same-capability-root variation',expected:'typed structural receipt correction with unchanged invalid review',actual:result.findings.map(f=>({code:f.code,component:f.component,structural:f.structural}))},null,2));
