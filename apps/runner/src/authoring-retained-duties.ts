import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleCoverageLineage, ActionRuleProspectiveWithdrawal, ActionRuleReviewSubject } from './action-rule-authority.js';
import { proveExactActionWithdrawal } from './action-rule-withdrawal-proof.js';
import { actionRuleModelDraftFromAuthority } from './action-rule-draft.js';
import { explorationBoundaryCandidateDigest } from './auto-boundary.js';
import { deferredReviewObligation, receiptConfigurationComponentOnly, isDeferredSourceReadback,
  isDeferredSourceCounterMaintenance, validStoredCoverage, counterSourceReviewContextDigest,
  type CrossSourceCounterReview, type PolicyCoverage, type PolicyPassage, type PolicyTextSnapshot, type RetainedDutyHistory } from './authoring-policy-source.js';
import type { CoverageFeedback } from './authoring-coverage-feedback.js';
import { resolveSourceCounterObligation } from './authoring-counter-maintenance-review.js';
import { assessReviewObligation } from './authoring-obligation-review.js';

/** Audit belongs to the host and original report, never the correction tool.
 * Only the obsolete association is retired. The source-wide duty continues at
 * independently validated current records; external assurance remains false. */
export class RetainedDutyApplicabilityError extends Error {
  readonly code = 'POLICY_RETAINED_DUTY_PENDING';
  constructor(readonly path: string, readonly reason: 'lineage_unavailable' | 'binding_changed' | 'shared_duty_unresolved' | 'retained_validation') {
    super('POLICY_RETAINED_DUTY_PENDING: A host-retained source obligation cannot be reconciled with the exact current authority. Inspect the saved source, current Action review and publication history locally. The obligation and prior attempts remain pending; another model response cannot establish missing history or owner evidence.');
  }
  feedback(context: string): CoverageFeedback {
    return { context, findings: [{ code: this.code, component: '/host/retained_duties',
      identity: canonicalJsonDigest({ context, origin: 'host_retained', path: this.path, reason: this.reason }),
      component_identity: canonicalJsonDigest({ context, origin: 'host_retained', path: this.path }),
      typed_reason: 'retained_duty.applicability', structural: false, reason: this.message,
      repair: 'Use existing saved Review details and policy history to inspect this exact source/Action association. Keep unresolved duties pending; no root model correction, rule edit, execution or historical-work recovery is implied.' }],
      limited: false, unevaluated: ['complete review acceptance and persistence'], complete_validation: false };
  }
}
const valueAt = (draft: unknown, pointer: string): unknown => pointer.slice(1).split('/').reduce<unknown>((value, part) =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[part.replace(/~1/gu, '/').replace(/~0/gu, '~')] : undefined, draft);
export const carriedReviewDuty = (p: PolicyPassage) => Boolean(deferredReviewObligation(p) || receiptConfigurationComponentOnly(p)
  || isDeferredSourceReadback(p) || isDeferredSourceCounterMaintenance(p));
const dutyKey = (p: PolicyPassage) => {
  const family = p.obligation_assessment?.family ?? (receiptConfigurationComponentOnly(p) ? 'receipt_setup'
    : isDeferredSourceReadback(p) ? 'independent_source_readback' : 'source_counter_maintenance');
  const path = p.obligation_assessment?.path ?? (receiptConfigurationComponentOnly(p)
    ? '/runner_evidence/runtime_contract/receipts' : p.source_counter_obligation?.path ?? p.draft_paths[0]);
  return `${family}:${path}`;
};
const counterPath = /^\/runner_evidence\/actions\/([^/]+)\/effect(?:\/atomic_updates\/(\d+))?\/source_counter_maintenance$/u;
function removalBasis(p: PolicyPassage, source: PolicyTextSnapshot, lineage: ActionRuleCoverageLineage | undefined,
  coverageAuthority: string | undefined) {
  const path = p.source_counter_obligation?.path ?? p.draft_paths[0] ?? '/';
  const match = counterPath.exec(path);
  const origins = lineage?.origins.filter(entry => entry.coverage_authority_digest === coverageAuthority) ?? [];
  if (!match || !isDeferredSourceCounterMaintenance(p) || !deferredReviewObligation(p)
    || p.source_counter_resolution?.source_digest !== source.digest || origins.length !== 1)
    throw new RetainedDutyApplicabilityError(path, 'lineage_unavailable');
  const origin = origins[0]!, outcome = match[1]!.replace(/~1/gu, '/').replace(/~0/gu, '~');
  const rules = origin.authority.authority.rules.filter(rule => rule.rule.outcome === outcome);
  if (rules.length !== 1 || !origin.transitions.length || lineage!.selected_digest !== lineage!.active_digest
    || origin.transitions[0]!.before !== origin.record || origin.transitions[0]!.before_digest !== origin.authority.digest
    || origin.transitions.at(-1)!.after_digest !== lineage!.active_digest
    || !origin.transitions.some(t => t.removed_outcomes.includes(outcome))
    || origin.transitions.some(t => t.introduced_outcomes.includes(outcome))
    || origin.transitions.some((t, i) => i > 0 && (origin.transitions[i - 1]!.after !== t.before
      || origin.transitions[i - 1]!.after_digest !== t.before_digest)))
    throw new RetainedDutyApplicabilityError(path, 'lineage_unavailable');
  const effect = match[2] === undefined ? rules[0]!.effect_envelope : rules[0]!.effect_envelope.atomic_updates?.[Number(match[2])];
  if (!effect || effect.operation !== 'update' || effect.version_advance?.strategy !== 'integer_increment' || !effect.conflict_key || effect.conflict_key !== effect.version_advance.column)
    throw new RetainedDutyApplicabilityError(path, 'binding_changed');
  return { origin, outcome, resource: effect.target_resource, field: effect.version_advance.column,
    read_digest: rules[0]!.read_boundary_digest, generation_lock: rules[0]!.verification_boundary.generation_lock_fingerprint,
    removal_basis: {store:lineage!.store,origin_record:origin.record,active_digest:lineage!.active_digest,
      transitions:structuredClone(origin.transitions)},
    lineage_digest: canonicalJsonDigest({ store: lineage!.store, selected: lineage!.selected_digest, origin }) };
}
export type RetainedDutyPlan = { retain: PolicyPassage[]; retire: Array<{ passage: PolicyPassage; basis: ReturnType<typeof removalBasis>;
  original_report_digest: string; original_report: PolicyCoverage; coverage_authority_digest: string;
  expected_continuing_paths?: string[] }>;
  pending?: Array<{ passage: PolicyPassage; basis?: ReturnType<typeof prospectiveBasis> | ReturnType<typeof removalBasis>;
    record: Extract<RetainedDutyHistory, { disposition: 'pending_exact_withdrawal' }> }>;
  counterHistory?: CrossSourceCounterReview[];
  crossSource?: { base: Omit<CrossSourceCounterReview, 'mappings'>; originalDuties: PolicyPassage[]; preparedDigest: string } };

/** Supplied only by host repository inspection. A saved report, field-name
 * match or model response cannot construct this missing origin. */
export type CounterSourceReviewContext = { snapshots: PolicyTextSnapshot[];
  selected?: ActionRuleReviewSubject; readDigest?: string; authorityDigest?: string };

function prepareCounterSourceTransition(previous: PolicyCoverage, source: PolicyTextSnapshot, draft: unknown,
  coverageAuthority: string | undefined, context: CounterSourceReviewContext | undefined): NonNullable<RetainedDutyPlan['crossSource']> {
  const fail = (): never => { throw new RetainedDutyApplicabilityError('/source', 'binding_changed'); };
  const selected = context?.selected;
  if (!context || !selected || !validStoredCoverage(previous, context.snapshots) || previous.retained_duty_history?.length
    || !['active','disabled'].includes(selected.identity.location)
    || selected.identity.location !== (selected.authority.state === 'disabled' ? 'disabled' : 'active')
    || !/^sha256:[a-f0-9]{64}$/u.test(selected.identity.store) || !selected.identity.record || selected.identity.record.length > 128
    || context.authorityDigest !== coverageAuthority
    || coverageAuthority !== canonicalJsonDigest({read:context.readDigest,action:selected.authority.digest})) fail();
  const oldSource = context!.snapshots.find(s => s.digest === previous.source_digest);
  if (!oldSource || source.digest === oldSource.digest) fail();
  try {
    if (explorationBoundaryCandidateDigest(valueAt(draft,'/read') as Parameters<typeof explorationBoundaryCandidateDigest>[0]) !== context!.readDigest) fail();
    const actions = selected!.authority.authority.rules.map(r => actionRuleModelDraftFromAuthority({authority:selected!.authority.authority,
      outcome:r.rule.outcome,review:selected!.authority.reviews.find(v=>v.outcome===r.rule.outcome)!,preserveVerificationFields:true}));
    if (canonicalJsonDigest(valueAt(draft,'/actions')) !== canonicalJsonDigest(actions)) fail();
  } catch { fail(); }
  const originalDuties = previous.passages.filter(carriedReviewDuty);
  if (!originalDuties.length || originalDuties.length > 120 || new Set(originalDuties.map(dutyKey)).size !== originalDuties.length) fail();
  for (const p of originalDuties) {
    const match = counterPath.exec(p.source_counter_obligation?.path ?? '');
    if (!match || !isDeferredSourceCounterMaintenance(p) || !deferredReviewObligation(p)) fail();
    const outcome = match![1]!.replace(/~1/gu,'/').replace(/~0/gu,'~');
    const rules = selected!.authority.authority.rules.filter(r=>r.rule.outcome===outcome);
    if (rules.length !== 1) fail();
    const rule = rules[0]!, effect = match![2] === undefined ? rule.effect_envelope : rule.effect_envelope.atomic_updates?.[Number(match![2])];
    const evidence = valueAt(draft,p.source_counter_obligation!.path) as Record<string,unknown> | undefined;
    if (!effect || effect.operation !== 'update' || effect.version_advance?.strategy !== 'integer_increment'
      || effect.conflict_key !== effect.version_advance.column || evidence?.resource !== effect.target_resource
      || evidence.field !== effect.version_advance.column || evidence.read_boundary_digest !== context!.readDigest
      || rule.read_boundary_digest !== context!.readDigest
      || evidence.generation_lock_fingerprint !== rule.verification_boundary.generation_lock_fingerprint
      || evidence.generation_lock_fingerprint !== valueAt(draft,'/read/generation_lock_fingerprint')
      || evidence.role_posture_fingerprint !== valueAt(draft,'/read/role_posture_fingerprint')) fail();
    try {
      const resolution = resolveSourceCounterObligation(p,oldSource!,draft);
      if (!resolution || canonicalJsonDigest(resolution) !== canonicalJsonDigest(p.source_counter_resolution)
        || canonicalJsonDigest(assessReviewObligation({...p,source_counter_resolution:resolution},oldSource!,draft) ?? null)
          !== canonicalJsonDigest(p.obligation_assessment ?? null)) fail();
    } catch { fail(); }
  }
  const unsigned = { origin:'HOST-COUNTER-SOURCE-REVIEW' as const, verified:false as const,
    original_source_digest:previous.source_digest,current_source_digest:source.digest,
    original_report:structuredClone(previous),original_report_digest:canonicalJsonDigest(previous),
    selected:structuredClone(selected!.identity),selected_body_digest:canonicalJsonDigest(selected!.authority),
    authority_digest:selected!.authority.digest,read_digest:context!.readDigest!,coverage_authority_digest:coverageAuthority! };
  return {base:{...unsigned,context_digest:counterSourceReviewContextDigest(unsigned)},
    originalDuties:structuredClone(originalDuties),preparedDigest:canonicalJsonDigest(draft)};
}

function prospectiveBasis(p: PolicyPassage, source: PolicyTextSnapshot, proof: ActionRuleProspectiveWithdrawal | undefined,
  coverageAuthority: string | undefined) {
  const path = p.source_counter_obligation?.path ?? p.draft_paths[0] ?? '/', match = counterPath.exec(path);
  const {proof_digest: digest, ...unsigned} = proof?.basis ?? {proof_digest: ''};
  if (!proof || !match || !isDeferredSourceCounterMaintenance(p) || !deferredReviewObligation(p)
    || p.source_counter_resolution?.source_digest !== source.digest || digest !== canonicalJsonDigest(unsigned)
    || proof.basis.active_digest !== proof.active.digest
    || coverageAuthority !== canonicalJsonDigest({read: proof.basis.read_digest, action: proof.active.digest}))
    throw new RetainedDutyApplicabilityError(path, 'lineage_unavailable');
  try {
    if (proof.candidate.digest !== proof.basis.candidate_digest || canonicalJsonDigest(proveExactActionWithdrawal(proof.active,proof.candidate))
      !== canonicalJsonDigest(proof.basis.removed_outcomes)) throw new Error();
  } catch { throw new RetainedDutyApplicabilityError(path,'binding_changed'); }
  const outcome = match[1]!.replace(/~1/gu, '/').replace(/~0/gu, '~');
  const rules = proof.active.authority.rules.filter(r => r.rule.outcome === outcome);
  if (!proof.basis.removed_outcomes.includes(outcome) || rules.length !== 1)
    throw new RetainedDutyApplicabilityError(path, 'binding_changed');
  const rule = rules[0]!, effect = match[2] === undefined ? rule.effect_envelope : rule.effect_envelope.atomic_updates?.[Number(match[2])];
  if (!effect || effect.operation !== 'update' || effect.version_advance?.strategy !== 'integer_increment'
    || effect.conflict_key !== effect.version_advance.column || rule.read_boundary_digest !== proof.basis.read_digest)
    throw new RetainedDutyApplicabilityError(path, 'binding_changed');
  return {outcome, resource: effect.target_resource, field: effect.version_advance.column,
    read_digest: rule.read_boundary_digest, generation_lock: rule.verification_boundary.generation_lock_fingerprint};
}

/** Pointer availability only tells us whether to revalidate a current duty.
 * It never proves removal. This read-only assessment runs before episode consent. */
export function prepareRetainedDutyReview(previous: PolicyCoverage | undefined, source: PolicyTextSnapshot, draft: unknown,
  lineage?: ActionRuleCoverageLineage, coverageAuthority?: string, prospective?: ActionRuleProspectiveWithdrawal,
  counterContext?: CounterSourceReviewContext): RetainedDutyPlan {
  const plan: RetainedDutyPlan = { retain: [], retire: [], pending: [] };
  if (prospective) {
    const expected = prospective.candidate.authority.rules.map(r => actionRuleModelDraftFromAuthority({
      authority:prospective.candidate.authority,outcome:r.rule.outcome,
      review:prospective.candidate.reviews.find(v => v.outcome===r.rule.outcome)!,preserveVerificationFields:true}));
    try {
      if (canonicalJsonDigest(valueAt(draft,'/actions')) !== canonicalJsonDigest(expected)
        || explorationBoundaryCandidateDigest(valueAt(draft,'/read') as Parameters<typeof explorationBoundaryCandidateDigest>[0])
          !== prospective.basis.read_digest) throw new Error();
    } catch { throw new RetainedDutyApplicabilityError('/prospective_withdrawal','binding_changed'); }
  }
  if (!previous) return plan;
  if (previous.cross_source_counter_reviews?.length) {
    if (!counterContext || !validStoredCoverage(previous,counterContext.snapshots))
      throw new RetainedDutyApplicabilityError('/history','binding_changed');
    plan.counterHistory = structuredClone(previous.cross_source_counter_reviews);
  }
  const prior = previous.passages.filter(carriedReviewDuty);
  if (previous.source_digest !== source.digest && previous.passages.some(p=>p.source_counter_obligation?.requirement==='independent_assurance'))
    throw new RetainedDutyApplicabilityError('/source','binding_changed');
  if (previous.source_digest !== source.digest && (prior.length || previous.retained_duty_history?.length || plan.counterHistory?.length)) {
    if (prospective || lineage?.origins.some(origin=>origin.transitions.some(t=>t.removed_outcomes.length || t.introduced_outcomes.length)))
      throw new RetainedDutyApplicabilityError('/source','binding_changed');
    plan.crossSource = prepareCounterSourceTransition(previous,source,draft,coverageAuthority,counterContext);
    return plan;
  }
  for (const p of prior) {
    if (p.draft_paths.every(path => valueAt(draft, path) !== undefined)) {
      const outcome = counterPath.exec(p.source_counter_obligation?.path ?? '')?.[1]?.replace(/~1/gu, '/').replace(/~0/gu, '~');
      if (outcome && lineage?.origins.some(origin => origin.coverage_authority_digest === coverageAuthority
        && origin.transitions.some(t => t.removed_outcomes.includes(outcome) || t.introduced_outcomes.includes(outcome))))
        throw new RetainedDutyApplicabilityError(p.draft_paths[0]!, 'binding_changed');
      const origin = lineage?.origins.find(entry => entry.coverage_authority_digest === coverageAuthority);
      const current = lineage?.origins.find(entry => entry.authority.digest === lineage.selected_digest);
      if (outcome && origin && current) {
        const before = origin.authority.authority.rules.find(entry => entry.rule.outcome === outcome);
        const after = current.authority.authority.rules.find(entry => entry.rule.outcome === outcome);
        const binding = (entry: typeof before) => entry && { rule: entry.rule, effect: entry.effect_envelope,
          verification: entry.verification_boundary, read: { name: entry.read_boundary_name, digest: entry.read_boundary_digest } };
        if (!before || !after || canonicalJsonDigest(binding(before)) !== canonicalJsonDigest(binding(after)))
          throw new RetainedDutyApplicabilityError(p.draft_paths[0]!, 'binding_changed');
      }
      plan.retain.push(p); continue;
    }
    if (prospective) {
      // A restored/reselected original duty may appear in the current passage
      // list again. Its immutable pending audit is processed below; copying
      // this newer report would recursively duplicate that audit on every No
      // or reselection cycle. Retain and revalidate the existing origin once.
      if (previous.retained_duty_history?.some(record => record.disposition==='pending_exact_withdrawal'
        && dutyKey(record.original_passage)===dutyKey(p))) continue;
      const basis = prospectiveBasis(p, source, prospective, coverageAuthority);
      plan.pending!.push({passage: p, basis, record: {origin:'HOST-RETAINED-DUTY', source_digest:source.digest,
        original_report:structuredClone(previous), original_report_digest:canonicalJsonDigest(previous),
        coverage_authority_digest:coverageAuthority!, original_passage:structuredClone(p),
        disposition:'pending_exact_withdrawal', prospective_basis:structuredClone(prospective.basis), continuing_paths:[], verified:false}});
      continue;
    }
    const basis = removalBasis(p, source, lineage, coverageAuthority);
    // No Action substitution or same-name resurrection. The exact removed
    // outcome must be absent from the complete current prepared authority.
    if (valueAt(draft, `/runner_evidence/actions/${basis.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}`) !== undefined)
      throw new RetainedDutyApplicabilityError(p.draft_paths[0]!, 'binding_changed');
    plan.retire.push({ passage: p, basis, original_report: structuredClone(previous),
      original_report_digest: canonicalJsonDigest(previous), coverage_authority_digest: coverageAuthority! });
  }
  for (const record of previous.retained_duty_history ?? []) {
    if (record.origin !== 'HOST-RETAINED-DUTY' || record.source_digest !== source.digest || record.verified !== false
      || !record.original_report || record.original_report.source_digest !== source.digest
      || canonicalJsonDigest(record.original_report) !== record.original_report_digest
      || !record.original_report.passages.some(p => canonicalJsonDigest(p) === canonicalJsonDigest(record.original_passage)))
      throw new RetainedDutyApplicabilityError('/history', 'binding_changed');
    if (record.disposition === 'pending_exact_withdrawal') {
      // Restoring the outcome revalidates the original duty normally; the old
      // proposal remains immutable pending history, never publication proof.
      if (record.original_passage.draft_paths.every(path => valueAt(draft, path) !== undefined)) {
        plan.retain.push(record.original_passage);
        plan.pending!.push({passage:record.original_passage,record:structuredClone(record)});
        continue;
      }
      const basis = prospective ? prospectiveBasis(record.original_passage, source, prospective, record.coverage_authority_digest)
        : removalBasis(record.original_passage, source, lineage, record.coverage_authority_digest);
      const next = structuredClone(record);
      if (prospective && canonicalJsonDigest(next.prospective_basis) !== canonicalJsonDigest(prospective.basis)) {
        // Reuse the complete original report, not a recursively nested copy of
        // the newer report that already contains this pending audit.
        next.prospective_basis = structuredClone(prospective.basis);
        plan.pending!.push({passage:record.original_passage,record:structuredClone(record)});
      }
      plan.pending!.push({passage:record.original_passage,basis,record:next});
      continue;
    }
    const basis = removalBasis(record.original_passage, source, lineage, record.coverage_authority_digest);
    if (!record.removal_basis || record.lineage_digest !== basis.lineage_digest
      || canonicalJsonDigest(record.removal_basis) !== canonicalJsonDigest(basis.removal_basis) || valueAt(draft,
      `/runner_evidence/actions/${basis.outcome.replace(/~/gu, '~0').replace(/\//gu, '~1')}`) !== undefined)
      throw new RetainedDutyApplicabilityError(record.original_passage.draft_paths[0]!, 'binding_changed');
    plan.retire.push({ passage: record.original_passage, basis, original_report_digest: record.original_report_digest,
      original_report: structuredClone(record.original_report), coverage_authority_digest: record.coverage_authority_digest,
      expected_continuing_paths: record.continuing_paths });
  }
  return plan;
}

export function assembleRetainedDutyReview(report: PolicyCoverage, plan: RetainedDutyPlan, source: PolicyTextSnapshot, draft: unknown,
  validate: (passages: PolicyPassage[]) => PolicyCoverage): PolicyCoverage {
  const counterHistory = structuredClone(plan.counterHistory ?? []);
  if (plan.crossSource) {
    if (plan.crossSource.preparedDigest !== canonicalJsonDigest(draft) || report.source_digest !== source.digest
      || plan.crossSource.base.current_source_digest !== source.digest)
      throw new RetainedDutyApplicabilityError('/source','binding_changed');
    const mappings = plan.crossSource.originalDuties.map(original => {
      const candidates = report.passages.filter(p=>p.source_counter_obligation?.path===original.source_counter_obligation!.path);
      const current = candidates[0];
      if (candidates.length !== 1 || !isDeferredSourceCounterMaintenance(current!) || !deferredReviewObligation(current!)
        || current!.source_counter_resolution?.source_digest !== source.digest
        || current!.source_counter_resolution?.proof_digest !== original.source_counter_resolution!.proof_digest)
        throw new RetainedDutyApplicabilityError(original.draft_paths[0]!,'retained_validation');
      return {original_passage_digest:canonicalJsonDigest(original),current_passage:structuredClone(current!),
        current_passage_digest:canonicalJsonDigest(current!)};
    });
    counterHistory.push({...structuredClone(plan.crossSource.base),mappings});
    // The prepared commit validates the result again. Accept only the plain
    // canonical review or this exact host-derived assembly; never strip or
    // merge an arbitrary supplied audit to make it pass.
    try {
      const plain = validate(report.passages);
      const expected = {...plain, cross_source_counter_reviews:counterHistory};
      const supplied = canonicalJsonDigest(report);
      if (supplied !== canonicalJsonDigest(plain) && supplied !== canonicalJsonDigest(expected)) throw new Error();
    } catch { throw new RetainedDutyApplicabilityError('/source','retained_validation'); }
  }
  if (counterHistory.length > 120) throw new RetainedDutyApplicabilityError('/history','binding_changed');
  const missing = plan.retain.filter(p => !report.passages.some(current => dutyKey(current) === dutyKey(p)
    && Boolean(deferredReviewObligation(current))));
  let complete: PolicyCoverage;
  try { complete = missing.length ? validate([...report.passages, ...missing]) : report; }
  catch { throw new RetainedDutyApplicabilityError(missing[0]?.draft_paths[0] ?? '/', 'retained_validation'); }
  const continuingPaths = (p: PolicyPassage, basis: ReturnType<typeof prospectiveBasis>) => {
    // Keep every surviving association of this exact all-writers counter. A
    // field-name match is insufficient: the canonical current proof must equal
    // the original host-confirmed source/Read/role/lock/target proof.
    const effects = Object.entries((valueAt(draft, '/runner_evidence/actions') ?? {}) as Record<string, unknown>)
      .flatMap(([name, action]) => {
        const effect = (action as { effect?: Record<string, unknown> }).effect;
        const prefix = `/runner_evidence/actions/${name.replace(/~/gu, '~0').replace(/\//gu, '~1')}/effect`;
        return effect ? [{ path: `${prefix}/source_counter_maintenance`, value: effect },
          ...((effect.atomic_updates ?? []) as Record<string, unknown>[]).map((v, i) => ({ path: `${prefix}/atomic_updates/${i}/source_counter_maintenance`, value: v }))] : [];
      }).filter(({ value }) => value.target_resource === basis.resource
        && (value.version_advance as { column?: string } | undefined)?.column === basis.field);
    if (!effects.length) throw new RetainedDutyApplicabilityError(p.draft_paths[0]!, 'shared_duty_unresolved');
    const continuing_paths = effects.map(({ path }) => {
      const evidence = valueAt(draft, path) as Record<string, unknown> | null | undefined;
      const current = complete.passages.find(item => item.source_counter_obligation?.path === path
        && deferredReviewObligation(item)?.family === 'source_counter_maintenance');
      if (!current || current.source_counter_resolution?.source_digest !== source.digest
        || current.source_counter_resolution.proof_digest !== p.source_counter_resolution!.proof_digest
        || evidence?.proof_digest !== p.source_counter_resolution!.proof_digest
        || evidence.resource !== basis.resource || evidence.field !== basis.field
        || evidence.read_boundary_digest !== basis.read_digest || evidence.generation_lock_fingerprint !== basis.generation_lock
        || evidence.role_posture_fingerprint !== valueAt(draft, '/read/role_posture_fingerprint')
        || evidence.status !== 'owner_confirmed_operating_prerequisite' || evidence.maintenance !== 'all_writers_increment'
        || evidence.external_writers_verified !== false || evidence.production_integration_verified !== false)
        throw new RetainedDutyApplicabilityError(path, 'shared_duty_unresolved');
      return path;
    }).sort();
    return continuing_paths;
  };
  const history = plan.retire.map(({ passage: p, basis, original_report_digest, original_report, coverage_authority_digest, expected_continuing_paths }): RetainedDutyHistory => {
    const continuing_paths = continuingPaths(p, basis);
    if (expected_continuing_paths && canonicalJsonDigest(expected_continuing_paths) !== canonicalJsonDigest(continuing_paths))
      throw new RetainedDutyApplicabilityError(p.draft_paths[0]!, 'binding_changed');
    return { origin: 'HOST-RETAINED-DUTY', source_digest: source.digest, original_report_digest,
      original_report: structuredClone(original_report),
      coverage_authority_digest, original_passage: structuredClone(p), disposition: 'outside_current_action_scope',
      removal_basis: structuredClone(basis.removal_basis),
      lineage_digest: basis.lineage_digest, continuing_paths, verified: false };
  });
  const applicable: string[] = [];
  for (const entry of plan.pending ?? []) {
    const record = structuredClone(entry.record);
    if (entry.basis) {
      const paths = continuingPaths(entry.passage, entry.basis);
      if (record.continuing_paths.length && canonicalJsonDigest(record.continuing_paths) !== canonicalJsonDigest(paths))
        throw new RetainedDutyApplicabilityError(entry.passage.draft_paths[0]!, 'binding_changed');
      record.continuing_paths = paths;
      applicable.push(canonicalJsonDigest(record));
    }
    if (!history.some(item => canonicalJsonDigest(item) === canonicalJsonDigest(record))) history.push(record);
  }
  if (history.length > 120) throw new RetainedDutyApplicabilityError('/history', 'binding_changed');
  return { ...complete, ...(history.length ? { retained_duty_history: history } : {}),
    ...(counterHistory.length ? { cross_source_counter_reviews: counterHistory } : {}),
    ...(history.some(r => r.disposition==='pending_exact_withdrawal')
      ? {current_pending_retained_duties:[...new Set(applicable)]} : {}) };
}

/** Establish known host prerequisites locally, before consent/reservation. This
 * cannot certify a model report; full canonical assembly remains mandatory. */
export function preflightRetainedDutyEvidence(plan: RetainedDutyPlan, source: PolicyTextSnapshot, draft: unknown,
  session?: import('./authoring-policy-source.js').PolicySourceSession): void {
  const checked: PolicyPassage[] = plan.retain.map(p => {
    try {
      const resolution = p.source_counter_obligation ? resolveSourceCounterObligation(p, source, draft) : undefined;
      const current = { ...p, ...(resolution ? { source_counter_resolution: resolution } : {}) };
      const assessment = assessReviewObligation(current, source, draft, session);
      if (!assessment) throw new Error('Current retained obligation evidence unavailable.');
      return { ...current, obligation_assessment: assessment };
    } catch { throw new RetainedDutyApplicabilityError(p.draft_paths[0] ?? '/', 'retained_validation'); }
  });
  // Known surviving old records are not trusted through retention: their exact
  // current host evidence was recomputed above. No new pointer is generated.
  if (plan.retire.length || plan.pending?.some(entry => entry.basis)) assembleRetainedDutyReview({ source_digest: source.digest,
    draft_digest: canonicalJsonDigest(draft), passages: checked }, { ...plan, retain: [] }, source, draft,
    () => { throw new Error('Preflight cannot manufacture model coverage.'); });
}

/** Publication still rechecks the real pointers and pure reduction proof.
 * A persisted proposal audit is never itself fresh permission or an event. */
export function assertPendingWithdrawalDutyProofs(report: PolicyCoverage, proof: ActionRuleProspectiveWithdrawal | undefined): void {
  const pending=report.retained_duty_history?.filter(r=>r.disposition==='pending_exact_withdrawal')??[];
  const current=pending.filter(r=>report.current_pending_retained_duties?.includes(canonicalJsonDigest(r)));
  if(current.some(r=>!proof || canonicalJsonDigest(r.prospective_basis)!==canonicalJsonDigest(proof.basis))
    || pending.some(r=>proof?.basis.removed_outcomes.includes(counterPath.exec(r.original_passage.source_counter_obligation?.path??'')?.[1]?.replace(/~1/gu,'/').replace(/~0/gu,'~')??'')
      && !current.some(c=>c.original_passage.source_counter_obligation?.path===r.original_passage.source_counter_obligation?.path)))
    throw new RetainedDutyApplicabilityError('/prospective_withdrawal','binding_changed');
}
