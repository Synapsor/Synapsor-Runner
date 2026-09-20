/** Diagnostic captured-state projection, NOT a current reference/access replay.
 * The Vite hook exposes the unchanged internal result builder only in this test.
 * All record reads use a read-only whole-project copy. No source or worker runs.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { ProposalStore } from '../../../packages/proposal-store/src/index.js';
import { parseActionRuleAuthority, resolveActivatedActionRule } from '../../../packages/action-rules/src/index.js';
// @ts-expect-error test-only in-memory export; never added to the product surface
import { capturedProposalResult } from '../../../packages/mcp-server/src/semantic-actions.js';
import { toolCallResult } from '../../../packages/mcp-server/src/tool-catalog.js';
const root = process.env.SYNAPSOR_READ_REPRO_ROOT!;
it('projects the exact independent T1 failed/closed record through actual MCP serialization', async () => {
  const paths = JSON.parse(readFileSync(resolve(root, 'captured-paths.json'), 'utf8'));
  const capture = JSON.parse(readFileSync(paths.capture, 'utf8'));
  const db = new DatabaseSync(paths.db, { readOnly: true });
  const store = Object.assign(Object.create(ProposalStore.prototype), { db, path: paths.db }) as ProposalStore;
  try {
    const reference = store.getObservedSubjectReference(Object.values(capture.request_arguments.subject_refs)[0] as string)!;
    const proposal = store.getProposal(`wrp_rule_${reference.claim_id!.slice("request_".length, "request_".length + 32)}`)!;
    const content = db.prepare("SELECT r.content_json FROM control_policy_revisions r JOIN control_policy_active a USING(deployment_id,scope_key,kind,name,revision_id) WHERE r.kind = 'action'").get()!;
    const loaded = parseActionRuleAuthority(JSON.parse(content.content_json as string).authority.authority);
    const activated = resolveActivatedActionRule(loaded.registry, capture.request_arguments.outcome);
    const before = db.prepare('SELECT * FROM worker_queue ORDER BY proposal_id').all();
    const response = await toolCallResult({ config: {mode:'local',capabilities:[]}, callTool: async () =>
      capturedProposalResult(store, proposal, activated, 'existing', {execution:'human_review',source_database_changed:false}) } as never,
      'app.request_change', capture.request_arguments);
    const data = response.structuredContent as any;
    expect(JSON.parse(response.content[0]!.text)).toEqual(data);
    expect(db.prepare('SELECT * FROM worker_queue ORDER BY proposal_id').all()).toEqual(before);
    const approvals = store.approvals(proposal.proposal_id);
    expect(approvals.some(a => a.status==='approved' && a.approver.startsWith('policy:'))).toBe(true);
    expect(store.getWorkerQueueItem(proposal.proposal_id)?.status).toBe('discarded');
    const label = process.env.SYNAPSOR_REPLAY_PHASE ?? 'before';
    writeFileSync(resolve(root,`captured-${label}.json`),JSON.stringify({
      kind:'captured-state diagnostic; access/TTL not exercised', capture_sha256:createHash('sha256').update(readFileSync(paths.capture)).digest('hex'),
      request:capture.request_arguments, response, original: capture.response,
      logical_oracle:{proposal_state:proposal.state,approvals,queue:store.getWorkerQueueItem(proposal.proposal_id),receipts:store.receipts(proposal.proposal_id),events:store.events(proposal.proposal_id)},
    },null,2));
    expect(data).toMatchObject({ status: 'closed', request_disposition: 'already_recorded',
      authorization: { approval: 'automatic', eligibility_basis: 'original_request', execution: 'held' },
      lifecycle: { execution: 'failed', disposition: 'closed', automatic_retry_scheduled: false, next_retry_at: null },
      execution_receipt: { status: 'failed', source_database_changed: false },
      invocation: { operation: 'returned_existing_request', source_database_changed: false } });
    expect(data.result_summary.next).toContain('This work is closed');
    expect(data.authorization.approval).toBe('automatic');
    expect(data.execution).not.toBe('human_review');
    expect(data.proposal.approval).not.toMatch(/pending|limit did not pass/);
  } finally { db.close(); }
});
