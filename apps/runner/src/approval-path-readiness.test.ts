import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionRuleAuthority } from '@synapsor-runner/action-rules';
import type { RuntimeConfig } from '@synapsor-runner/mcp-server';
import { ownerPolicyTestFixture } from '../../../packages/mcp-server/src/owner-policy-test-fixture.js';
import { assessApprovalPath, approvalPathReadinessLines } from './approval-path-readiness.js';
import { operatorPublicKeyFingerprint, resolveOperatorIdentity } from './operator-identity.js';
import { reviewerGrantRemovalImpact, reviewerGrantImpactLines, inspectReviewerGrantRemovalImpact } from './reviewer-grant-impact.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root,{recursive:true,force:true}))); });
async function fixture(quorum=1, conditional=false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'synapsor-approval-readiness-')); roots.push(root);
  const f=ownerPolicyTestFixture(), configPath=path.join(root,'runner.json');
  const base={name:'inventory_actions',action_boundary_name:'inventory_changes',catalog:{schema_version:'synapsor.action-rule-catalog.v1' as const,
    generation_lock_fingerprint:f.compiled.generation_lock_fingerprint,resources:[f.compiled.target_resource],relationships:[]},
    rules:[{read_boundary_name:'inventory_read',read_boundary_digest:`sha256:${'b'.repeat(64)}` as const,rule:f.compiled.rule,
      verification_boundary:f.compiled.verification_boundary,effect_envelope:f.compiled.effect_envelope,activated_at:'2026-09-01T00:00:00.000Z'}]};
  const defaults=createActionRuleAuthority(base);
  const approval=structuredClone(defaults.authority.approval_classes[0]!);
  approval.required_approvals=quorum;
  if(conditional) { approval.mode='policy'; approval.rules[0]!.auto_approve_when=f.compiled.rule.require;
    approval.shared_limits=[{id:'per_action',kind:'count',scope:'capability',maximum:10,window_seconds:3600,capability:f.compiled.outcome},
      {id:'per_identity',kind:'count',scope:'tenant_principal',maximum:10,window_seconds:3600}]; }
  const {registry}=createActionRuleAuthority({...base,approval_classes:[approval]});
  const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
  await fs.writeFile(path.join(root,'reviewer.pub.pem'),key,{mode:0o600});
  const config:RuntimeConfig={version:1,mode:'review',capabilities:[],action_rules:{project_root:root},
    trusted_context:{provider:'environment'}, sources:{local_postgres:{engine:'postgres',read_url_env:'READ_URL',read_only:true}},
    operator_identity:{provider:'signed_key',operators:{reviewer:{public_key_path:'reviewer.pub.pem',public_key_fingerprint:operatorPublicKeyFingerprint(key),
      roles:['action_reviewer'],outcomes:[f.compiled.outcome]}}}};
  const assess=()=>assessApprovalPath({config,configPath,registry,outcome:f.compiled.outcome});
  return {root,config,configPath,registry,outcome:f.compiled.outcome,key,assess};
}
describe('operator-only approval configuration evidence',()=>{
  it.each([false,true])('reports exact current mandatory/conditional coverage without authentication or availability (%s)',async conditional=>{
    const f=await fixture(1,conditional), before=structuredClone(f.config), files=await fs.readdir(f.root);
    const result=await f.assess();
    expect(result).toMatchObject({state:'covered',human_path:conditional?'conditional':'mandatory',required_role:'action_reviewer',required_approvals:1,
      current_request:'not_assessed',authentication:'not_checked',human_availability:'unknown',eligible_subjects:[{subject:'reviewer',public_key:'valid',binding:'pinned'}]});
    expect(await f.assess()).toEqual(result); expect(f.config).toEqual(before); expect(await fs.readdir(f.root)).toEqual(files);
    const lines=approvalPathReadinessLines(result).join('\n'); expect(lines).toContain('possession and future signature not checked'); expect(lines).not.toContain(f.key);
  });
  it('counts subjects rather than roles and honors the existing subject quorum',async()=>{
    const f=await fixture(2), identity=f.config.operator_identity!;
    identity.operators!.reviewer!.roles.push('another_role');
    expect(await f.assess()).toMatchObject({state:'missing',eligible_subjects:[{subject:'reviewer'}]});
    identity.operators!.second=structuredClone(identity.operators!.reviewer!);
    expect(await f.assess()).toMatchObject({state:'covered',eligible_subjects:[{subject:'reviewer'},{subject:'second'}]});
  });
  it.each(['outcome','role','pin','key','removed'] as const)('does not count %s-invalid reviewer configuration',async kind=>{
    const f=await fixture(), op=f.config.operator_identity!.operators!.reviewer!;
    if(kind==='outcome')op.outcomes=['inventory.other']; if(kind==='role')op.roles=['worker_only'];
    if(kind==='pin')op.public_key_fingerprint=`sha256:${'c'.repeat(64)}`;
    if(kind==='key')await fs.writeFile(path.join(f.root,'reviewer.pub.pem'),'DERIVED malformed public key');
    if(kind==='removed')delete f.config.operator_identity!.operators!.reviewer;
    expect((await f.assess()).state).toBe(kind==='removed'?'unknown':'missing');
    expect((await f.assess()).eligible_subjects).toEqual([]);
  });
  it('does not count scoped APPLY as approval and does not turn advisory evidence into permission',async()=>{
    const f=await fixture(); f.config.version=2;
    f.config.operator_identity={provider:'signed_key',roster_version:2,operators:{worker:{public_key_path:'reviewer.pub.pem',authority_kind:'scoped_apply',roles:[],apply_outcomes:[f.outcome]}}};
    expect(await f.assess()).toMatchObject({state:'missing',eligible_subjects:[]});
    await expect(resolveOperatorIdentity({config:f.config.operator_identity,configPath:f.configPath,identity:'worker',action:'approve',requiredRole:'action_reviewer',
      proposal:{action:f.outcome,proposal_id:'DERIVED',proposal_version:1,proposal_hash:'DERIVED'}})).rejects.toMatchObject({code:'OPERATOR_SCOPED_APPLY_NOT_AUTHORIZED'});
  });
  it('keeps unavailable authority, legacy identity and external directories unknown without fetching them',async()=>{
    const f=await fixture();
    expect(await assessApprovalPath({...f,outcome:'inventory.absent'})).toMatchObject({state:'unknown',reason:'APPROVAL_AUTHORITY_UNAVAILABLE'});
    expect(await assessApprovalPath({...f,unavailableOutcomes:[f.outcome]})).toMatchObject({state:'unknown',reason:'APPROVAL_READ_DEPENDENCY_UNAVAILABLE'});
    delete f.config.operator_identity; expect(await f.assess()).toMatchObject({state:'unknown',reason:'DEVELOPMENT_REVIEWER_COVERAGE_UNASSESSED'});
    f.config.operator_identity={provider:'jwt_oidc',algorithms:['RS256'],issuer:'https://invalid.example',audience:'reviewer',jwks_url_env:'NEVER_FETCHED'};
    expect(await f.assess()).toMatchObject({state:'unknown',reason:'EXTERNAL_REVIEWER_COVERAGE_UNASSESSED'});
  });
  it('a later grant change is assessed again rather than cached as approval evidence',async()=>{
    const f=await fixture(); expect((await f.assess()).state).toBe('covered');
    f.config.operator_identity!.operators!.reviewer!.outcomes=['inventory.revoked'];
    expect((await f.assess()).state).toBe('missing');
  });
});
describe('nonmutating reviewer impact on proposed Action removal',()=>{
  it('keeps mixed reviewer scopes, APPLY and history separate from retirement',async()=>{
    const f=await fixture(), identity=f.config.operator_identity!;
    identity.operators!.reviewer!.outcomes=[f.outcome,'inventory.keep'];
    identity.operators!.worker={public_key_path:'reviewer.pub.pem',authority_kind:'scoped_apply',roles:[],apply_outcomes:[f.outcome]};
    const before=structuredClone(identity), impact=reviewerGrantRemovalImpact(identity,[f.outcome,'inventory.keep'],[f.outcome]);
    expect(impact).toEqual({state:'known',grants:[{subject:'reviewer',removed_scopes:[f.outcome],retained_scopes:['inventory.keep']}]});
    expect(identity).toEqual(before); const lines=reviewerGrantImpactLines(impact,f.root).join('\n');
    expect(lines).toContain('policy approver'); expect(lines).toContain('separate'); expect(lines).toContain('historical approvals'); expect(lines).not.toContain(f.key);
  });
  it.each([false,true])('does not silently treat unrestricted legacy roles as an exact scoped reviewer inventory (shared APPLY=%s)', async sharedApply=>{
    const f=await fixture(); delete f.config.operator_identity!.operators!.reviewer!.outcomes;
    if(sharedApply) f.config.operator_identity!.apply_roles=['action_reviewer'];
    expect(await f.assess()).toMatchObject({state:'covered', required_role:'action_reviewer'});
    expect(reviewerGrantRemovalImpact(f.config.operator_identity,[f.outcome],[f.outcome])).toMatchObject({state:'unknown',reason:'UNRESTRICTED_LEGACY_REVIEWER_IMPACT_UNASSESSED'});
  });
  it('an absent/unavailable or mismatched authority never becomes zero impact',async()=>{
    const f=await fixture(); expect(reviewerGrantRemovalImpact(f.config.operator_identity,[f.outcome],['inventory.missing'])).toMatchObject({state:'unknown'});
    const unknown=await inspectReviewerGrantRemovalImpact({projectRoot:f.root,activeDigest:'sha256:absent',removedOutcomes:[f.outcome]});
    expect(unknown).toMatchObject({state:'unknown',reason:'CURRENT_REVIEWER_OR_ACTION_CONFIGURATION_UNAVAILABLE'});
    expect(reviewerGrantImpactLines(unknown,f.root).join('\n')).toContain('not evidence that no reviewers');
  });
});
