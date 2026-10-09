import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { assessReceiptCouplingCapability, assessReviewObligation, assertRequiredReceiptCoupling,
  receiptCouplingInterpretation, receiptCouplingPaths } from './authoring-obligation-review.js';
import type { PolicyPassage } from './authoring-policy-source.js';
import {policyTextSnapshot} from './authoring-policy-source.js';
import { makeSourceTransactionReview,sourceTransactionMappings,sourceTransactionPreparedContext } from './authoring-source-transaction-review.js';

// DERIVED components over retained authentic prepared evidence. These are not
// paid replies, performed receipts, or a replacement for the new 31-passage
// full-report lineage tests owned by the scoped producer.
const captured = JSON.parse(await fs.readFile(new URL('./test-fixtures/receipt-correction-chain.json', import.meta.url), 'utf8'));
function fixture() {
  const f = structuredClone(captured), outcome = f.draft.actions[0].outcome;
  const store=canonicalJsonDigest('DERIVED test project binding');
  const mapping=sourceTransactionMappings(f.draft)[0]!;
  const record=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:18,end:18,
    mapping,actor:'derived-test-operator',decision:'confirmed'});
  f.sources.source_transaction_reviews=[record];
  f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,store,f.source.digest);
  const p: PolicyPassage = { start: 18, end: 18, disposition: 'implemented', responsibility: 'runner',
    issue_kind: 'coverage_link', receipt_component: 'source_transaction_coupling',
    interpretation: receiptCouplingInterpretation(outcome), draft_paths: receiptCouplingPaths(outcome) };
  return { ...f, p, outcome, host: f.draft.runner_evidence.actions[outcome], contract: f.draft.runner_evidence.runtime_contract };
}
const assess = (f: ReturnType<typeof fixture>) => assessReceiptCouplingCapability(f.p, f.source, f.draft);
const required=(f:ReturnType<typeof fixture>,passages:PolicyPassage[],spans:Pick<PolicyPassage,'start'|'end'>[]=[])=>
  assertRequiredReceiptCoupling(passages,f.source,f.draft,spans,f.sources);

describe('typed source transaction coupling capability', () => {
  it('binds both existing business effects and source receipt without inventing observations or altering context', () => {
    const f = fixture(), before = canonicalJsonDigest(f.draft), proof = assess(f);
    expect(proof).toMatchObject({ origin: 'HOST-RESOLVED', category: 'source_transaction_coupling',
      source_digest: f.source.digest, source_range: { start: 18, end: 18 }, source: f.draft.read.source,
      outcome: f.outcome, effect_count: 2, configuration_digest: f.contract.receipt_configuration.digest,
      phase: 'compiled_capability', observed: false });
    expect(proof!.dependencies_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(assessReviewObligation(f.p, f.source, f.draft)).toBeUndefined();
    expect(canonicalJsonDigest(f.draft)).toBe(before);
    expect(() => required(f,[f.p], [{ start: 18, end: 18 }])).not.toThrow();
  });

  it.each(['prose_receipt', 'prose_readback', 'prose_provisioning', 'next_step', 'topic', 'wrong_responsibility', 'omitted_responsibility',
    'wrong_disposition', 'wrong_issue', 'field', 'counter', 'evidence', 'duty', 'setup', 'override', 'clarification', 'citation',
    'child_reference', 'broad_reference', 'missing_root', 'duplicate_root', 'foreign_root', 'configuration_companion',
    'missing_guarantee', 'contradictory_guarantee', 'missing_transaction', 'wrong_transaction', 'missing_host_companion',
    'missing_raw_companion', 'both_companions_removed', 'duplicate_companion', 'companion_target', 'companion_binding', 'companion_set', 'companion_field',
    'primary_field', 'primary_operation', 'primary_target', 'version', 'nullable_version', 'binding_resource', 'binding_source', 'foreign_source',
    'mode', 'selection_missing', 'selection_stale', 'destination', 'read', 'reader_source', 'reader_engine', 'candidate',
    'action_mode', 'setup_outcome', 'setup_missing', 'setup_duplicate', 'setup_mode', 'setup_unsupported', 'source_snapshot'] as const)(
    'refuses %s instead of inferring a source-atomic conclusion', kind => {
      const f = fixture(), p = f.p as any, c = f.contract, raw = f.draft.actions[0].effect, effect = f.host.effect;
      switch (kind) {
        case 'prose_receipt': p.interpretation += ' A historical receipt was observed.'; c.receipt_configuration.modes[0].authority='runner_ledger'; break;
        case 'prose_readback': p.interpretation = 'Independent source readback verified both changes.'; f.source.digest=canonicalJsonDigest('changed current Source'); break;
        case 'prose_provisioning': p.interpretation += ' Receipt objects and writer grants are provisioned.'; c.deployment_prerequisites.runner_execution_setup.supported=false; break;
        case 'next_step': p.next_step = 'An actual receipt was observed.'; break;
        case 'topic': p.topic = 'An actual receipt was observed'; break;
        case 'wrong_responsibility': p.responsibility = 'deployment'; break;
        case 'omitted_responsibility': delete p.responsibility; break;
        case 'wrong_disposition': p.disposition = 'needs_decision'; break;
        case 'wrong_issue': p.issue_kind = 'missing_configuration'; break;
        case 'field': p.field_checks = [{ resource: 'private', field: 'secret', expectation: 'private' }]; break;
        case 'counter': p.counter_requirements = [{ path: '/unknown', current_capability: null, required_capability: null }]; break;
        case 'evidence': p.evidence_checks = [{ path: '/read/source', equals: f.draft.read.source }]; break;
        case 'duty': p.application_obligations = ['independent_source_readback']; break;
        case 'setup': p.deployment_prerequisite = 'runner_execution_setup'; break;
        case 'override': p.operator_override = 'Approved'; break;
        case 'clarification': p.operator_clarification = 'Approved'; break;
        case 'citation': p.operator_message_id = 1; break;
        case 'child_reference': p.draft_paths[0] += '/transaction'; break;
        case 'broad_reference': p.draft_paths[0] = '/runner_evidence/actions'; break;
        case 'missing_root': p.draft_paths.pop(); break;
        case 'duplicate_root': p.draft_paths.push(p.draft_paths[0]); break;
        case 'foreign_root': p.draft_paths[0] = '/runner_evidence/actions/foreign/effect'; break;
        case 'configuration_companion': p.draft_paths.push('/runner_evidence/runtime_contract/receipt_configuration'); break;
        case 'missing_guarantee': delete c.receipts; break;
        case 'contradictory_guarantee': c.receipts += ' Effects and receipts commit separately.'; break;
        case 'missing_transaction': delete effect.transaction; break;
        case 'wrong_transaction': effect.transaction = 'Business effects only share a transaction.'; break;
        case 'missing_host_companion': delete effect.atomic_updates; break;
        case 'missing_raw_companion': delete raw.atomic_updates; break;
        case 'both_companions_removed': delete raw.atomic_updates; delete effect.atomic_updates; break;
        case 'duplicate_companion': raw.atomic_updates.push(structuredClone(raw.atomic_updates[0])); effect.atomic_updates.push(structuredClone(effect.atomic_updates[0])); break;
        case 'companion_target': effect.atomic_updates[0].target_resource = 'foreign'; break;
        case 'companion_binding': effect.atomic_updates[0].target_binding = 'foreign'; break;
        case 'companion_set': effect.atomic_updates[0].set = { credited_total: { kind: 'literal', value: 999 } }; break;
        case 'companion_field': effect.atomic_updates[0].fields = ['other']; break;
        case 'primary_field': effect.fields = ['other']; break;
        case 'primary_operation': raw.operation = 'insert'; break;
        case 'primary_target': effect.target_resource = 'foreign'; break;
        case 'version': effect.atomic_updates[0].version_advance.column = 'other'; break;
        case 'nullable_version': f.host.scoped_bindings.register.fields.version.nullable = true; break;
        case 'binding_resource': f.host.scoped_bindings.register.resource = 'foreign'; break;
        case 'binding_source': f.host.scoped_bindings.register.source.from_binding = 'foreign'; break;
        case 'foreign_source': f.host.scoped_bindings.register.database_scope_proof.source = 'foreign'; break;
        case 'mode': c.receipt_configuration.modes[0].authority = 'runner_ledger'; break;
        case 'selection_missing': delete c.receipt_configuration; break;
        case 'selection_stale': c.receipt_configuration.status = 'unavailable'; break;
        case 'destination': c.receipt_configuration.source_receipt_destinations[0].relation_digest = canonicalJsonDigest('foreign'); break;
        case 'read': f.draft.read.name = 'foreign'; break;
        case 'reader_source': c.onboarding_reader.source = 'foreign'; break;
        case 'reader_engine': c.onboarding_reader.engine = 'unsupported'; break;
        case 'candidate': c.review_evidence_phases.candidate_action_digest = null; break;
        case 'action_mode': f.host.execution.configured_mode = 'proposal_only'; break;
        case 'setup_outcome': c.deployment_prerequisites.runner_execution_setup.outcomes[0].outcome = 'foreign'; break;
        case 'setup_missing': c.deployment_prerequisites.runner_execution_setup.outcomes = []; break;
        case 'setup_duplicate': c.deployment_prerequisites.runner_execution_setup.outcomes.push(structuredClone(c.deployment_prerequisites.runner_execution_setup.outcomes[0])); break;
        case 'setup_mode': c.deployment_prerequisites.runner_execution_setup.outcomes[0].configured_mode = 'proposal_only'; break;
        case 'setup_unsupported': c.deployment_prerequisites.runner_execution_setup.supported = false; break;
        case 'source_snapshot': delete c.authoring_lifecycle.current_policy_snapshot; break;
      }
      expect(() => assess(f)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
    });

  it('does not let a changed source borrow the old operator requirement even when compiled capability remains',()=>{
    const f=fixture();
    const changed=policyTextSnapshot(Buffer.from(f.source.text.replace('source_db receipt','different receipt'),'utf8'),f.source.name,f.source.version);
    f.source=changed;
    f.contract.authoring_lifecycle.current_policy_snapshot.digest=changed.digest;
    expect(assess(f)).toMatchObject({origin:'HOST-RESOLVED',phase:'compiled_capability'});
    expect(()=>required(f,[f.p])).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });

  it('recomputes its binding instead of trusting a prior positive digest', () => {
    const f = fixture(), first = assess(f)!;
    f.draft.actions[0].effect.set.posted_credits = { kind: 'literal', value: 15, value_type: { kind: 'integer' } };
    expect(assess(f)!.dependencies_digest).not.toBe(first.dependencies_digest);
  });
  it('rejects a well-formed phase digest that disagrees with the applicable execution review', () => {
    const f = fixture();
    f.contract.review_evidence_phases.candidate_action_digest = `sha256:${'f'.repeat(64)}`;
    expect(() => assess(f)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });
  it('requires the complete candidate binding when no execution review exists', () => {
    const f = fixture();
    f.contract.review_evidence_phases.candidate_action_binding_digest = canonicalJsonDigest({
      candidate_action_digest: f.contract.review_evidence_phases.candidate_action_digest,
      actions: f.draft.actions,
    });
    f.contract.saved_execution_review = null;
    f.draft.runner_evidence.action_revision = {
      action_boundary_digest: f.contract.review_evidence_phases.candidate_action_digest,
      review_record_digest: `sha256:${'a'.repeat(64)}`,
    };
    expect(assess(f)).toMatchObject({ origin: 'HOST-RESOLVED' });
    f.contract.review_evidence_phases.candidate_action_digest = `sha256:${'f'.repeat(64)}`;
    expect(() => assess(f)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
    f.contract.review_evidence_phases.candidate_action_digest = captured.draft.runner_evidence.runtime_contract.review_evidence_phases.candidate_action_digest;
    f.contract.review_evidence_phases.candidate_action_binding_digest = null;
    expect(() => assess(f)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });
  it('retains the proof under renamed outcome/resources and reference ordering', () => {
    const f = JSON.parse(JSON.stringify(fixture()).replaceAll('energy_ops.finalize_settlement_cycle', 'tenant.close_cycle'));
    f.p.draft_paths.reverse();
    expect(assess(f)).toMatchObject({ outcome: 'tenant.close_cycle', effect_count: 2, observed: false });
  });
  it('never upgrades an untyped historical receipt claim', () => {
    const f = fixture(); delete f.p.receipt_component;
    expect(assess(f)).toBeUndefined();
    expect(() => assessReviewObligation(f.p, f.source, f.draft)).toThrow('OBLIGATION_OBSERVATION_UNESTABLISHED');
  });
  it('rejects separate effects and configuration as the nominated conjunction', () => {
    const f = fixture(), effect: PolicyPassage = { ...f.p, draft_paths: [f.p.draft_paths[0]!], interpretation: 'The compiled effects are supported.' };
    delete effect.receipt_component;
    const selection = { ...effect, draft_paths: ['/runner_evidence/runtime_contract/receipt_configuration'], interpretation: 'The selected mode is source_db.' };
    expect(() => required(f,[effect, selection])).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
    expect(() => required(f,[selection], [{ start: 18, end: 18 }])).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
    expect(() => required(f,[effect, selection, f.p])).not.toThrow();
  });
  it('does not invent transaction meaning from a mode-only configuration comparison', () => {
    const f = fixture(), selection: PolicyPassage = { ...f.p, draft_paths: ['/runner_evidence/runtime_contract/receipt_configuration'], interpretation: 'The selected mode is source_db.' };
    delete selection.receipt_component;
    expect(() => required(f,[selection])).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });
  it('rejects duplicate coupling proof even when topics or reference ordering differ', () => {
    const f = fixture(), duplicate = { ...f.p, topic: 'Another capability heading', draft_paths: [...f.p.draft_paths].reverse() };
    expect(() => required(f,[f.p, structuredClone(f.p)])).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
    expect(() => required(f,[f.p, duplicate])).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });
  it('requires the exact nominated source range rather than a broader overlapping proof', () => {
    const f = fixture(); f.p.start = 17;
    expect(assess(f)).toBeDefined();
    expect(() => required(f,[f.p], [{ start: 18, end: 18 }])).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });
  it('leaves the existing runner_ledger comparison and setup duty on their ordinary path', () => {
    const f = fixture();
    f.source.text = f.source.text.replace('source_db receipt', 'runner_ledger receipt');
    f.contract.receipt_configuration.modes[0].authority = 'runner_ledger';
    delete f.contract.receipt_read_exclusion;
    f.contract.authoring_lifecycle.current_policy_snapshot.digest = f.source.digest;
    const selection: PolicyPassage = { ...f.p, draft_paths: ['/runner_evidence/runtime_contract/receipt_configuration'], interpretation: 'The selected mode matches the source-required runner_ledger mode.' };
    delete selection.receipt_component;
    expect(() => assessReviewObligation(selection, f.source, f.draft)).not.toThrow();
    expect(() => required(f,[selection])).not.toThrow(); // A Runner-ledger selection is not a source_db coupling claim.
    expect(() => assess(f)).toThrow('OBLIGATION_SOURCE_TRANSACTION_COUPLING_UNESTABLISHED');
  });
});
