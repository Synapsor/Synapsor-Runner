import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { prepareRetainedDutyReview, assembleRetainedDutyReview, RetainedDutyApplicabilityError } from './authoring-retained-duties.js';
import { parsePolicyCoverage, reviewPolicyCoverage } from './authoring-policy-coverage.js';
import { policyTextSnapshot, newPolicySourceSession, authoringDestination, savePolicySources, loadPolicySources, type PolicyPassage } from './authoring-policy-source.js';
import { createModelAuthoringConversation } from './model-authoring-conversation.js';
import { planCoverageResolution } from './authoring-review-resolution.js';
import type { ActionRuleCoverageLineage } from './action-rule-authority.js';

// Component controls: current source-counter records are recomputed by the real
// canonical parser. Repository/installed provenance is covered separately.
const hash = (c: string) => `sha256:${c.repeat(64)}`;
const source = policyTextSnapshot(Buffer.from('Maintain each version counter on every write, including outside Runner.'), 'counter-rules.txt');
function fixture(names = ['work.finish', 'work.flag']) {
  const [currentName, removedName] = names as [string, string];
  const pointer = (name: string) => `/runner_evidence/actions/${name}/effect/source_counter_maintenance`;
  const evidence = { status: 'owner_confirmed_operating_prerequisite', resource: 'work.records', field: 'version',
    maintenance: 'all_writers_increment', proof_digest: hash('c'), read_boundary_digest: hash('d'),
    generation_lock_fingerprint: hash('e'), role_posture_fingerprint: hash('f'), external_writers_verified: false, production_integration_verified: false };
  const effect = { target_resource: 'work.records', conflict_key: 'version', operation: 'update',
    version_advance: { strategy: 'integer_increment', column: 'version' } };
  const action = { effect: { ...effect, source_counter_maintenance: evidence } };
  const current = { read: {role_posture_fingerprint:hash('f')}, runner_evidence: { actions: { [currentName]: structuredClone(action) } } };
  const old = { read: {role_posture_fingerprint:hash('f')}, runner_evidence: { actions: { [currentName]: structuredClone(action), [removedName]: structuredClone(action) } } };
  const passage = (name: string): PolicyPassage => ({ start: 1, end: 1, disposition: 'needs_decision',
    responsibility: 'deployment', issue_kind: 'missing_configuration', interpretation: 'The all-writers operating requirement remains unverified externally.',
    next_step: 'Maintain the counter for every writer; external assurance stays unverified.', draft_paths: [pointer(name)],
    source_counter_obligation: { path: pointer(name), requirement: 'owner_maintenance' } });
  const previous = parsePolicyCoverage({ passages: [passage(currentName), passage(removedName)] }, source, old, []);
  const submitted = { passages: [passage(currentName)] };
  const parsed = () => parsePolicyCoverage(submitted, source, current, []);
  const rules = (outcomes: string[]) => outcomes.map(outcome => ({ rule: { outcome }, effect_envelope: structuredClone(effect),
    verification_boundary: { resources: [],generation_lock_fingerprint:hash('e') }, read_boundary_name: 'work_read', read_boundary_digest: hash('d') }));
  const origin = { coverage_authority_digest: hash('a'), record: 'old-active', authority: {
    digest: hash('b'), authority: { rules: rules(names) } }, transitions: [{ event: 'reviewed-publication',
      before: 'old-active', after: 'current-active', before_digest: hash('b'), after_digest: hash('9'),
      removed_outcomes: [removedName], introduced_outcomes: [] }] };
  const currentOrigin = { coverage_authority_digest: hash('8'), record: 'current-active', authority: {
    digest: hash('9'), authority: { rules: rules([currentName]) } }, transitions: [] };
  const lineage = { store: hash('7'), selected_digest: hash('9'), active_digest: hash('9'),
    origins: [currentOrigin, origin] } as unknown as ActionRuleCoverageLineage;
  const validate = (passages: PolicyPassage[]) => parsePolicyCoverage({ passages }, source, current, []);
  const plan = () => prepareRetainedDutyReview(previous, source, current, lineage, hash('a'));
  return { currentName, removedName, pointer, current, old, passage, previous, submitted, parsed, lineage, validate, plan };
}

describe('retained-duty applicability at real canonical assembly', () => {
  it.each([['work.finish', 'work.flag'], ['library.checkout', 'library.note']])('retires only the proven removed association (%s/%s), preserving original source-wide duty', (one, two) => {
    const f = fixture([one, two]), before = structuredClone(f.previous);
    const result = assembleRetainedDutyReview(f.parsed(), f.plan(), source, f.current, f.validate);
    expect(result.passages).toHaveLength(1);
    expect(result.retained_duty_history).toMatchObject([{ origin: 'HOST-RETAINED-DUTY', source_digest: source.digest,
      original_passage: before.passages[1], disposition: 'outside_current_action_scope', continuing_paths: [f.pointer(one)], verified: false }]);
    expect(result.retained_duty_history![0]!.original_report).toEqual(before);
    expect(result.retained_duty_history![0]!.original_report_digest).toBe(canonicalJsonDigest(before));
    expect(f.previous).toEqual(before);
    const again = prepareRetainedDutyReview(result, source, f.current, f.lineage, hash('8'));
    expect(assembleRetainedDutyReview(f.parsed(), again, source, f.current, f.validate)).toEqual(result);
  });
  it('persists the complete original report and refuses history loss, tampering and competing saves', async () => {
    const f = fixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsor-retained-history-'));
    try {
      const session = newPolicySourceSession(); session.snapshots = [source]; session.active = source.version;
      session.coverage = f.previous; session.coverage_authority_digest = hash('a');
      await savePolicySources(root, session);
      const result = assembleRetainedDutyReview(f.parsed(), f.plan(), source, f.current, f.validate);
      session.coverage = result; session.coverage_authority_digest = hash('8');
      await savePolicySources(root, session);
      const saved = await loadPolicySources(root, session.id), original = structuredClone(saved);
      expect(saved.coverage).toEqual(result);
      expect(saved.coverage!.retained_duty_history![0]!.original_report).toEqual(f.previous);
      const plan = prepareRetainedDutyReview(saved.coverage, source, f.current, f.lineage, hash('8'));
      expect(assembleRetainedDutyReview(f.parsed(), plan, source, f.current, f.validate)).toEqual(result);
      const missing = structuredClone(saved); delete missing.coverage!.retained_duty_history;
      await expect(savePolicySources(root, missing)).rejects.toThrow('POLICY_RETAINED_DUTY_HISTORY_CHANGED');
      const changed = structuredClone(saved); changed.coverage!.retained_duty_history![0]!.original_report.passages[0]!.interpretation = 'Changed historical interpretation.';
      expect(() => prepareRetainedDutyReview(changed.coverage, source, f.current, f.lineage, hash('8'))).toThrow('POLICY_RETAINED_DUTY_PENDING');
      await expect(savePolicySources(root, changed)).rejects.toThrow('POLICY_RETAINED_DUTY_HISTORY_CHANGED');
      expect(await loadPolicySources(root, session.id)).toEqual(original);
      const next = structuredClone(saved); next.operator_messages = ['A later operator statement, still pending.'];
      await savePolicySources(root, next, { expectedDigest: canonicalJsonDigest(saved) });
      await expect(savePolicySources(root, saved, { expectedDigest: canonicalJsonDigest(saved) })).rejects.toThrow('POLICY_SOURCE_CHANGED');
      expect(await loadPolicySources(root, session.id)).toEqual(next);
      // DERIVED corrupted disk evidence: loading cannot silently discard the
      // audit and turn missing historical provenance into a new paid review.
      const file = path.join(root, '.synapsor/boundary-authoring/policy-sources', `${session.id}.json`);
      await fs.writeFile(file, JSON.stringify(changed));
      await expect(loadPolicySources(root, session.id)).rejects.toThrow('POLICY_RETAINED_DUTY_PENDING');
    } finally { await fs.rm(root, {recursive:true,force:true}); }
  });
  it('retains a still-active duty omitted by a replacement', () => {
    const f = fixture();
    const report = parsePolicyCoverage({ passages: [{ start: 1, end: 1, disposition: 'background', interpretation: 'Version operating context.', draft_paths: [] }] }, source, f.current, []);
    const result = assembleRetainedDutyReview(report, f.plan(), source, f.current, f.validate);
    expect(result.passages.some(p => p.source_counter_obligation?.path === f.pointer(f.currentName))).toBe(true);
  });
  it.each(['absent', 'ambiguous', 'broken-chain', 'unpublished', 'no-removal', 'reintroduced'])("does not infer removal from %s evidence", mode => {
    const f = fixture();
    if (mode === 'ambiguous') f.lineage.origins.push(structuredClone(f.lineage.origins[1]!));
    if (mode === 'broken-chain') f.lineage.origins[1]!.transitions[0]!.before = 'unrelated';
    if (mode === 'unpublished') f.lineage.selected_digest = hash('0');
    if (mode === 'no-removal') f.lineage.origins[1]!.transitions[0]!.removed_outcomes = [];
    if (mode === 'reintroduced') f.lineage.origins[1]!.transitions[0]!.introduced_outcomes = [f.removedName];
    expect(() => prepareRetainedDutyReview(f.previous, source, f.current, mode === 'absent' ? undefined : f.lineage, hash('a'))).toThrow(RetainedDutyApplicabilityError);
  });
  it('refuses a changed effect rather than calling it removal', () => {
    const f = fixture();
    f.lineage.origins[0]!.authority.authority.rules[0]!.effect_envelope.target_resource = 'work.other';
    expect(f.plan).toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it('same-name reintroduction cannot inherit a retained duty', () => {
    const f = fixture();
    f.lineage.origins[1]!.transitions[0]!.introduced_outcomes = [f.currentName];
    expect(f.plan).toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it.each(['proof_digest', 'field', 'maintenance', 'read_boundary_digest', 'generation_lock_fingerprint', 'role_posture_fingerprint', 'external_writers_verified'])('preserves unresolved shared duty after changed %s', field => {
    const f = fixture(), plan = f.plan(), parsed = f.parsed();
    const evidence = f.current.runner_evidence.actions[f.currentName]!.effect.source_counter_maintenance;
    (evidence as Record<string, unknown>)[field] = field === 'external_writers_verified' ? true : 'changed';
    expect(() => assembleRetainedDutyReview(parsed, plan, source, f.current, f.validate)).toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it('requires the whole surviving association set, not one same-field record', () => {
    const f = fixture(), plan = f.plan();
    f.current.runner_evidence.actions['work.other'] = structuredClone(f.current.runner_evidence.actions[f.currentName]!);
    expect(() => assembleRetainedDutyReview(f.parsed(), plan, source, f.current, f.validate)).toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it('changed source is pending despite unchanged cited excerpt', () => {
    const f = fixture(), changed = policyTextSnapshot(Buffer.from(source.text + '\nAn exception applies.'), source.name);
    expect(() => prepareRetainedDutyReview(f.previous, changed, f.current, f.lineage, hash('a'))).toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it('host finding cannot become a root model correction', () => {
    const error = new RetainedDutyApplicabilityError('/private/path', 'lineage_unavailable');
    const feedback = error.feedback(hash('a')), resolution = planCoverageResolution(feedback);
    expect(feedback.findings[0]).toMatchObject({ component: '/host/retained_duties', structural: false, typed_reason: 'retained_duty.applicability' });
    expect(resolution.recommended).toBe('reinspection');
    expect(resolution.options.some(o => o.operation === 'scoped_correction')).toBe(false);
    expect(JSON.stringify(feedback)).not.toContain('/private/path');
  });
  it('actual encoded producer assembles proven retirement once, and stops missing-history host failures without a correction', async () => {
    for (const good of [true, false]) {
      const f = fixture(), conversation = createModelAuthoringConversation();
      conversation.policySources = newPolicySourceSession(); conversation.policySources.snapshots = [source]; conversation.policySources.active = 1;
      conversation.policySources.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: 'openai', model: 'fixture' }) }];
      let calls = 0;
      const run = reviewPolicyCoverage({ source, draft: f.current, previousReport: f.previous,
        ...(good ? { retainedDutyPlan: f.plan() } : {}), env: { OPENAI_API_KEY: 'inert-fixture' },
        session: { provider: 'openai', model: 'fixture', conversation, dependencies: { requestJson: async () => {
          calls++; return { status: 200, body: { output: [{ type: 'function_call', call_id: 'local',
            name: 'runner__review_policy_coverage', arguments: JSON.stringify(f.submitted) }] } };
        } } } });
      if (good) expect((await run).retained_duty_history).toHaveLength(1);
      else await expect(run).rejects.toThrow('POLICY_RETAINED_DUTY_PENDING');
      expect(calls).toBe(1);
    }
  });
});
