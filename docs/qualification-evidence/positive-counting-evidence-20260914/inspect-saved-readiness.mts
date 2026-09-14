// Read-only host evaluation of state saved by the installed public runs.
// This does not execute a public recheck or grant an application attestation.
import fs from 'node:fs';
import path from 'node:path';
import { policyReviewReadiness, policyReadinessItems } from '../../../apps/runner/src/authoring-review-readiness.ts';
const E = path.dirname(new URL(import.meta.url).pathname);
const plan = JSON.parse(fs.readFileSync(path.join(E, 'assignment-plan.json'), 'utf8'));
const rows = [
  ['recovery-tournament-assisted', 'review-completed'],
  ['recovery-tournament-assisted', 'recheck-requested'],
  ['counting-wording-control', 'wording-stopped'],
].map(([run, checkpoint]) => {
  const P = path.join(plan.owned_root, 'runs', run!, 'checkpoints', checkpoint!, 'project');
  const resume = JSON.parse(fs.readFileSync(path.join(P, '.synapsor/boundary-authoring/resume.json'), 'utf8'));
  const session = JSON.parse(fs.readFileSync(path.join(P, '.synapsor/boundary-authoring/policy-sources', resume.policy_source_session + '.json'), 'utf8'));
  const source = session.snapshots.find((s: any) => s.version === session.active);
  const currentSource = session.coverage?.source_digest === source.digest;
  return { run, checkpoint, current_source_matches_report: currentSource,
    report_readiness: currentSource ? policyReviewReadiness(source, session.coverage, session) : null,
    residuals: currentSource ? policyReadinessItems(session.coverage, session) : null,
    pending: Object.keys(resume).filter(k => k.startsWith('pending_') && resume[k] != null),
    limitation: 'Stored-report host evaluation only. Full current authority/domain/context revalidation belongs to the real public path; this does not substitute for the stopped explicit recheck.' };
});
const result = { at: new Date().toISOString(), evidence: 'read-only host oracle over installed checkpoints', rows };
fs.writeFileSync(path.join(E, 'saved-readiness-oracle.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(rows.map(r => ({run:r.run, checkpoint:r.checkpoint, same_source:r.current_source_matches_report, ready:r.report_readiness?.ready, privacy:r.report_readiness?.privacy, pending:r.pending}))));
