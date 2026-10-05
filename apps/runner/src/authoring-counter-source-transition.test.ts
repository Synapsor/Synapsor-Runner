import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { onboard } from './guided-start.js';
import { structuredBoundaryAuthoringCommand } from './boundary-structured-authoring.js';
import { boundaryReviewCommand, loadBoundaryReviewContext } from './boundary-commands.js';
import { explorationBoundaryCandidateDigest } from './auto-boundary.js';
import { readActionRuleAuthorityDraft, readActionRuleReviewSubjects, readActionRuleCoverageLineage,
  readActionRuleProspectiveWithdrawal, writeActionRuleAuthorityDraftIfCurrent, type ActionRuleReviewSubject } from './action-rule-authority.js';
import { activateSemanticActionRuntime } from './semantic-action-deployment.js';
import { prepareSavedActionRuleRemoval } from './action-rule-removal.js';
import { ownedProgramDraft, ownedProgramInspection } from './test-fixtures/owned-authoring-program.js';
import { prepareActionVersionField } from './action-rule-version-review.js';
import { buildActionRuleAuthoringCatalog } from './action-rule-authoring.js';
import { policyCoverageDraft } from './authoring-policy-evidence.js';
import { parsePolicyCoverage } from './authoring-policy-coverage.js';
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, loadPolicySources, type PolicyPassage } from './authoring-policy-source.js';
import { prepareRetainedDutyReview, assembleRetainedDutyReview } from './authoring-retained-duties.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

// DERIVED local control: genuine disabled subject/repository, canonical Read,
// native counter review and complete old/current reports. No publication,
// provider, database or fabricated active-history lineage is connected.
async function fixture(published = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'counter-source-transition-')); roots.push(root);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const inspection = ownedProgramInspection(), inspect = async () => inspection;
  expect(await onboard(['db', '--project-root', root, '--from-env', 'OWNED_STUDIO_READ_URL', '--schema', 'studio', '--json'],
    { interactive: false, schemaInspector: inspect })).toBe(0);
  const command = (args: string[]) => structuredBoundaryAuthoringCommand(['--project-root', root, ...args], inspect);
  expect(await command(['--export-draft', 'input.json', '--json'])).toBe(0);
  const request = JSON.parse(await fs.readFile(path.join(root, 'input.json'), 'utf8'));
  request.read.resources = [{ resource_id: 'studio.parcels', include: true, tenant_key: 'tenant_id', principal_key: 'principal_id',
    row_identity: 'parcel_id', selectable_fields: ['label', 'units', 'available', 'version'], keep_out_fields: ['internal_note'],
    withhold_from_model_fields: ['available', 'version'], private_model_fields: ['available', 'version'] }];
  request.actions = [ownedProgramDraft(1), ownedProgramDraft(2)];
  await fs.writeFile(path.join(root, 'input.json'), JSON.stringify(request));
  expect(await command(['--draft', 'input.json', '--json'])).toBe(0);
  const context = await loadBoundaryReviewContext(root), readDigest = explorationBoundaryCandidateDigest(context.candidate);
  let visits = 0;
  expect(await boundaryReviewCommand(['--project-root', root, '--access'], inspect, {
    chooseResource: async () => visits++ === 0 ? { action: 'confirm' } : undefined,
    editFieldTiers: async () => undefined, promptText: async () => 'DERIVED local operator',
    confirm: async () => true, confirmActivation: async () => true,
  })).toBe(0);
  let authority: ActionRuleReviewSubject['authority'] = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
  if (published) authority = (await activateSemanticActionRuntime({projectRoot:root,draft:authority,
    actor:'DERIVED component operator'})).activation;
  const selected = (await readActionRuleReviewSubjects(root)).find(s => canonicalJsonDigest(s.authority) === canonicalJsonDigest(authority))!;
  expect(selected.identity.location).toBe(published ? 'active' : 'disabled');
  if (!published) expect(await readActionRuleCoverageLineage(root, authority, readDigest)).toBeUndefined();
  const review = prepareActionVersionField({ context: { readBoundary: context.candidate, readBoundaryDigest: readDigest,
    builtCatalog: buildActionRuleAuthoringCatalog({ boundary: context.candidate, inspection }) }, inspection,
    generationLock: context.lock, resource: 'studio.parcels', field: 'version' }).review;
  const old = policyTextSnapshot(Buffer.from('Maintain each version counter on every write, including outside Runner.'), 'old.txt');
  const current = policyTextSnapshot(Buffer.from('Current policy replacement.\n' + old.text), 'current.txt', 2);
  const session = newPolicySourceSession(); session.snapshots = [old, current]; session.active = 2;
  const prepared = policyCoverageDraft({ read: context.candidate, decisions: context.bundle.decisions, actions: [], authority,
    source: { inspection, generationLock: context.lock }, reviewedVersionFields: [review], policySources: session });
  const passage = (outcome: string, line: number): PolicyPassage => ({ start: line, end: line, disposition: 'needs_decision',
    responsibility: 'deployment', issue_kind: 'missing_configuration', interpretation: 'All writers maintain the counter; independent assurance remains unverified.',
    next_step: 'Keep maintaining this counter for every writer.',
    draft_paths: [`/runner_evidence/actions/${outcome}/effect/source_counter_maintenance`],
    source_counter_obligation: { path: `/runner_evidence/actions/${outcome}/effect/source_counter_maintenance`, requirement: 'owner_maintenance' } });
  const previous = parsePolicyCoverage({ passages: authority.authority.rules.map(r => passage(r.rule.outcome, 1)) }, old, prepared, []);
  const validate = (passages: PolicyPassage[]) => parsePolicyCoverage({ passages }, current, prepared, []);
  const report = validate([{ start: 1, end: 1, disposition: 'background', interpretation: 'Current policy heading.', draft_paths: [] },
    ...authority.authority.rules.map(r => passage(r.rule.outcome, 2))]);
  const coverageAuthority = canonicalJsonDigest({ read: readDigest, action: authority.digest });
  session.coverage = previous; session.coverage_authority_digest = coverageAuthority;
  const origin = { snapshots: session.snapshots, selected, readDigest, authorityDigest: coverageAuthority };
  // Seventh argument is the prospectively agreed host context. Before the fix,
  // production ignores it and reproduces POLICY_RETAINED_DUTY_PENDING.
  const plan = () => prepareRetainedDutyReview(previous, current, prepared, undefined, coverageAuthority, undefined, origin);
  const preparedFor = (subject:typeof authority) => policyCoverageDraft({read:context.candidate,
    decisions:context.bundle.decisions,actions:[],authority:subject,source:{inspection,generationLock:context.lock},
    reviewedVersionFields:[review],policySources:session});
  return { root, old, current, session, prepared, previous, report, validate, origin, coverageAuthority, plan, preparedFor, readDigest };
}

describe('unchanged native counter duty across a reviewed Source replacement', () => {
  it('uses a genuine disabled origin and new current passages, preserving the complete old report on save/restart', async () => {
    const f = await fixture(), original = structuredClone(f.previous);
    const result = assembleRetainedDutyReview(f.report, f.plan(), f.current, f.prepared, f.validate) as any;
    expect(result.passages).toEqual(f.report.passages);
    expect(result.cross_source_counter_reviews).toHaveLength(1);
    const audit = result.cross_source_counter_reviews[0];
    expect(audit).toMatchObject({ origin: 'HOST-COUNTER-SOURCE-REVIEW', original_source_digest: f.old.digest,
      current_source_digest: f.current.digest, selected: f.origin.selected.identity, verified: false });
    expect(audit.original_report).toEqual(original);
    expect(audit.original_report_digest).toBe(canonicalJsonDigest(original));
    expect(audit.mappings).toHaveLength(2);
    expect(audit.mappings.every((m: any) => m.current_passage.start === 2 && m.current_passage.end === 2)).toBe(true);
    expect(f.previous).toEqual(original);
    await savePolicySources(f.root, f.session);
    f.session.coverage = result;
    await savePolicySources(f.root, f.session);
    expect((await loadPolicySources(f.root, f.session.id)).coverage).toEqual(result);
    const sameSourcePlan = prepareRetainedDutyReview(result, f.current, f.prepared, undefined, f.coverageAuthority,
      undefined, {snapshots:f.session.snapshots});
    expect(assembleRetainedDutyReview(f.report,sameSourcePlan,f.current,f.prepared,f.validate)).toEqual(result);
    const stale = structuredClone(f.session), next = structuredClone(f.session);
    next.operator_messages = ['A later explicit decision, still attributed and pending.'];
    await savePolicySources(f.root,next,{expectedDigest:canonicalJsonDigest(stale)});
    await expect(savePolicySources(f.root,stale,{expectedDigest:canonicalJsonDigest(stale)})).rejects.toThrow('POLICY_SOURCE_CHANGED');
    expect(await loadPolicySources(f.root,f.session.id)).toEqual(next);
  });
  it.each(['missing-origin','missing-snapshot','wrong-authority','changed-selected','changed-proof','changed-role','changed-lock','changed-read','changed-target'])
    ('keeps %s pending before a model review', async mode => {
      const f = await fixture(), path = f.previous.passages[0]!.source_counter_obligation!.path;
      const evidence = path.slice(1).split('/').reduce<any>((v,k)=>v[k],f.prepared);
      if (mode==='missing-origin') delete (f.origin as any).selected;
      if (mode==='missing-snapshot') f.origin.snapshots=[f.current];
      if (mode==='wrong-authority') f.origin.authorityDigest=canonicalJsonDigest({unrelated:true});
      if (mode==='changed-selected') f.origin.selected.authority.authority.rules[0]!.effect_envelope.target_resource='studio.other';
      if (mode==='changed-proof') evidence.proof_digest='sha256:'+'a'.repeat(64);
      if (mode==='changed-role') evidence.role_posture_fingerprint='sha256:'+'a'.repeat(64);
      if (mode==='changed-lock') evidence.generation_lock_fingerprint='sha256:'+'a'.repeat(64);
      if (mode==='changed-read') evidence.read_boundary_digest='sha256:'+'a'.repeat(64);
      if (mode==='changed-target') evidence.resource='studio.other';
      expect(f.plan).toThrow('POLICY_RETAINED_DUTY_PENDING');
    });
  it.each(['omitted','independent','duplicate','different-path'])('does not fill a %s current duty from an old citation', async mode => {
    const f=await fixture(), plan=f.plan(), report=structuredClone(f.report);
    const p=report.passages[1]!;
    if(mode==='omitted')report.passages.splice(1,1);
    if(mode==='independent'){p.source_counter_obligation!.requirement='independent_assurance';delete p.source_counter_resolution;delete p.obligation_assessment;}
    if(mode==='duplicate')report.passages.push(structuredClone(p));
    if(mode==='different-path')p.source_counter_obligation!.path='/runner_evidence/actions/unrelated/effect/source_counter_maintenance';
    expect(()=>assembleRetainedDutyReview(report,plan,f.current,f.prepared,f.validate)).toThrow('POLICY_RETAINED_DUTY_PENDING');
    expect(f.previous.passages.every(p=>p.start===1&&p.end===1)).toBe(true);
  });
  it('refuses post-preparation native evidence drift and independent-assurance history', async()=>{
    const f=await fixture(), plan=f.plan();
    f.prepared.read.role_posture_fingerprint=canonicalJsonDigest({role:'changed'});
    expect(()=>assembleRetainedDutyReview(f.report,plan,f.current,f.prepared,f.validate)).toThrow('POLICY_RETAINED_DUTY_PENDING');
    f.previous.passages[0]!.source_counter_obligation!.requirement='independent_assurance';
    expect(f.plan).toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it('refuses a current report that drops a still-active cross-Source counter duty', async()=>{
    const f=await fixture();
    const report=assembleRetainedDutyReview(f.report,f.plan(),f.current,f.prepared,f.validate);
    await savePolicySources(f.root,f.session);f.session.coverage=report;await savePolicySources(f.root,f.session);
    const changed=structuredClone(f.session);
    changed.coverage!.passages=changed.coverage!.passages.filter(p=>p.source_counter_obligation?.path!==report.cross_source_counter_reviews![0]!.mappings[0]!.current_passage.source_counter_obligation!.path);
    await expect(savePolicySources(f.root,changed)).rejects.toThrow('POLICY_RETAINED_DUTY_PENDING');
    expect((await loadPolicySources(f.root,f.session.id)).coverage).toEqual(report);
  });
  it('revalidates its exact assembled cross-Source report before the prepared commit', async()=>{
    const f=await fixture(), plan=f.plan();
    const once=assembleRetainedDutyReview(f.report,plan,f.current,f.prepared,f.validate);
    expect(assembleRetainedDutyReview(once,plan,f.current,f.prepared,f.validate)).toEqual(once);
    expect(once.cross_source_counter_reviews).toHaveLength(1);
  });
  it.each(['extra-audit','changed-audit','changed-report'])('rejects a %s during repeated assembly',async mode=>{
    const f=await fixture(),plan=f.plan();
    const changed=structuredClone(assembleRetainedDutyReview(f.report,plan,f.current,f.prepared,f.validate));
    if(mode==='extra-audit')changed.cross_source_counter_reviews!.push(structuredClone(changed.cross_source_counter_reviews![0]!));
    if(mode==='changed-audit')changed.cross_source_counter_reviews![0]!.selected.record='different-record';
    if(mode==='changed-report')(changed as any).execution_permission=true;
    expect(()=>assembleRetainedDutyReview(changed,plan,f.current,f.prepared,f.validate)).toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it.each(['omission','wrong-proof','wrong-family','duplicate'])('rejects %s at current storage membership and fresh load',async mode=>{
    const f=await fixture(),report=assembleRetainedDutyReview(f.report,f.plan(),f.current,f.prepared,f.validate);
    await savePolicySources(f.root,f.session);f.session.coverage=report;await savePolicySources(f.root,f.session);
    const changed=structuredClone(f.session),passage=changed.coverage!.passages[1]!;
    if(mode==='omission')changed.coverage!.passages.splice(1,1);
    if(mode==='wrong-proof')passage.source_counter_resolution!.proof_digest=canonicalJsonDigest({different:'proof'});
    if(mode==='wrong-family')passage.obligation_assessment!.family='independent_source_readback';
    if(mode==='duplicate')changed.coverage!.passages.push(structuredClone(passage));
    await expect(savePolicySources(f.root,changed)).rejects.toThrow('POLICY_RETAINED_DUTY_PENDING');
    expect((await loadPolicySources(f.root,f.session.id)).coverage).toEqual(report);
    // DERIVED corruption control only; no qualification fixture is modified.
    await fs.writeFile(path.join(f.root,'.synapsor/boundary-authoring/policy-sources',f.session.id+'.json'),JSON.stringify(changed));
    await expect(loadPolicySources(f.root,f.session.id)).rejects.toThrow('POLICY_RETAINED_DUTY_PENDING');
  });
  it('accepts a genuine same-Source withdrawal audit while retaining the peer duty and cross-Source history',async()=>{
    const f=await fixture(true),report=assembleRetainedDutyReview(f.report,f.plan(),f.current,f.prepared,f.validate);
    await savePolicySources(f.root,f.session);f.session.coverage=report;await savePolicySources(f.root,f.session);
    const removed=f.origin.selected.authority.authority.rules[1]!.rule.outcome;
    const removal=await prepareSavedActionRuleRemoval(f.root,removed);
    if(removal.mode==='deactivate')throw new Error('Expected retained peer Action');
    await writeActionRuleAuthorityDraftIfCurrent(f.root,removal.draft,removal.baseline);
    const proof=(await readActionRuleProspectiveWithdrawal(f.root,removal.draft,f.readDigest))!;
    const prepared=f.preparedFor(removal.draft);
    const validate=(passages:PolicyPassage[])=>parsePolicyCoverage({passages},f.current,prepared,[]);
    const fresh=validate(report.passages.filter(p=>p.source_counter_obligation?.path!==`/runner_evidence/actions/${removed}/effect/source_counter_maintenance`));
    const plan=prepareRetainedDutyReview(report,f.current,prepared,undefined,f.coverageAuthority,proof,{snapshots:f.session.snapshots});
    const withdrawal=assembleRetainedDutyReview(fresh,plan,f.current,prepared,validate);
    expect(withdrawal.cross_source_counter_reviews).toEqual(report.cross_source_counter_reviews);
    expect(withdrawal.retained_duty_history).toHaveLength(1);
    expect(withdrawal.retained_duty_history![0]).toMatchObject({disposition:'pending_exact_withdrawal',verified:false});
    expect(withdrawal.passages.filter(p=>p.source_counter_obligation)).toHaveLength(1);
    f.session.coverage=withdrawal;await savePolicySources(f.root,f.session);
    expect((await loadPolicySources(f.root,f.session.id)).coverage).toEqual(withdrawal);
    expect(f.previous.passages).toHaveLength(2);
  });
  it.each(['unknown-key','orphan-link','changed-current-digest','missing-old-snapshot','dropped-history'])
    ('does not discard %s on persistence or restart',async mode=>{
      const f=await fixture();
      const result=assembleRetainedDutyReview(f.report,f.plan(),f.current,f.prepared,f.validate);
      await savePolicySources(f.root,f.session);f.session.coverage=result;await savePolicySources(f.root,f.session);
      const original=await loadPolicySources(f.root,f.session.id), changed=structuredClone(original);
      const audit=changed.coverage!.cross_source_counter_reviews![0]!;
      if(mode==='unknown-key')(audit as any).approval='granted';
      if(mode==='orphan-link')audit.mappings[0]!.original_passage_digest='sha256:'+'a'.repeat(64);
      if(mode==='changed-current-digest')audit.current_source_digest=f.old.digest;
      if(mode==='missing-old-snapshot')changed.snapshots=[f.current];
      if(mode==='dropped-history')delete changed.coverage!.cross_source_counter_reviews;
      await expect(savePolicySources(f.root,changed)).rejects.toThrow(/POLICY_RETAINED_DUTY/);
      expect(await loadPolicySources(f.root,f.session.id)).toEqual(original);
      if(mode!=='dropped-history'){
        // DERIVED corruption control only: never mutate a qualification fixture.
        const file=path.join(f.root,'.synapsor/boundary-authoring/policy-sources',f.session.id+'.json');
        await fs.writeFile(file,JSON.stringify(changed));
        await expect(loadPolicySources(f.root,f.session.id)).rejects.toThrow('POLICY_RETAINED_DUTY_PENDING');
      }
    });
});
