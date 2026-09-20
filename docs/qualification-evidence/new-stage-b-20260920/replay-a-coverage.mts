// Read-only diagnostic replay after the public case stopped. No provider or store opens.
import fs from 'node:fs';
import path from 'node:path';
import { parsePolicyCoverage, collectCoverageFeedback } from '../../../apps/runner/src/authoring-policy-coverage.js';
const root = process.argv[2];
if (!root) throw new Error('Supply the private Case A evidence root.');
const context = JSON.parse(fs.readFileSync(path.join(root, 'captured-parser-context-derived.json'), 'utf8'));
const response = JSON.parse(fs.readFileSync(path.join(root, 'stopped-checkpoint-response15-derived.json'), 'utf8'));
const source = context.source_document.snapshots.find((s: {version:number}) => s.version === context.source_document.active);
try {
  parsePolicyCoverage(response, source, context.draft, context.messages);
  console.log(JSON.stringify({unexpected_acceptance:true})); process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({
    kind:'exact captured response/context; source-module diagnostic, not a new public trial',
    raw_validation_error: error instanceof Error ? error.message : String(error),
    feedback:collectCoverageFeedback(response, source, context.draft, context.messages, error),
    current_selectors:context.draft.runner_evidence.actions['release.clear_assessment'].automatic_limits.map((l: any) => l.history_selector.capability),
    submitted_selectors:response.passages[9].counter_requirements.map((c: any) => c.current_capability),
    provider_calls:0, stores_opened:0, response_modified:false,
  },null,2));
}
