import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { SchemaInspection } from '@synapsor-runner/schema-inspector';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { boundaryCommand } from './guided-start.js';
import { assertStoredExplorationPolicy, reviewExplorationBoundaryCandidate, buildAutoBoundary, emptyReviewOverrides } from './auto-boundary.js';
import { readProjectReadAuthoring } from './control-policy-read-authoring-project.js';
import { applyManagedBoundaryReviewDecision } from './boundary-review-domain.js';
import { buildActionRuleAuthoringCatalog } from './action-rule-authoring.js';
import { prepareReadWorkloadRelationship } from './read-relationship-preparation.js';
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from './boundary-review-mutation.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, {recursive:true,force:true}); });
async function inspection(name: string): Promise<SchemaInspection> {
  return JSON.parse(await fs.readFile(new URL(`./__fixtures__/scoped-read-recovery/${name}.json`, import.meta.url),'utf8'));
}

it.each(['v_scope3_norls','returns_ops','v_rename3a'])('fresh public scoped Read preparation stores canonical policy and preserves the catalog: %s', async schema => {
  const metadata = await inspection(schema);
  const original = structuredClone(metadata);
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'scoped-read-recovery-')); roots.push(root);
  vi.spyOn(process.stdout,'write').mockReturnValue(true);
  expect(await boundaryCommand(['draft','--project-root',root,'--from-env','DATABASE_URL','--schema',schema,'--json'],async()=>structuredClone(metadata))).toBe(0);
  const saved = await readProjectReadAuthoring(root);
  const entry = saved!.selected!;
  expect(entry.progress.candidate.activation).toBe('disabled_unreviewed');
  expect(entry.progress.candidate.pack.resources).toHaveLength(3);
  for (const [b,l] of [[entry.draft,entry.draft_lock],[entry.progress.candidate,entry.candidate_lock]] as const) {
    expect(()=>assertStoredExplorationPolicy(b,l)).not.toThrow();
    const {unresolved_decisions: _a,...before}=b;
    const {unresolved_decisions: _b,...after}=reviewExplorationBoundaryCandidate(b,structuredClone(b)).candidate;
    expect(after).toEqual(before);
    expect(b.budgets.max_analysis_relationship_hops).toBe(2);
  }
  // The generated metadata still offers the existing exact three-hop opt-in;
  // canonical storage must not erase it or raise the pending candidate's budget.
  expect(entry.catalog!.policy_baseline.boundary.pack.resources.flatMap(r=>r.relationships).some(r=>r.path_depth===3)).toBe(true);
  const reloaded=await readProjectReadAuthoring(root);
  expect(reloaded!.selected).toEqual(entry);
  expect(canonicalJsonDigest(metadata)).toBe(canonicalJsonDigest(original));
});

it.each(['refunds','returns_ops'])('retains the private fraud fact and distinguishes its actual catalog dependency: %s', async schema => {
  const metadata=await inspection(schema);
  const overrides=applyManagedBoundaryReviewDecision(emptyReviewOverrides(), {kind:'field_exposure',
    resource_id:`${schema}.customers`,field:'fraud_flag',exposure:'withhold_from_model',
    actor:'synthetic-reviewer',reason:'The required fraud fact is only for host verification.',decided_at:metadata.inspected_at});
  const build=buildAutoBoundary({inspection:metadata,overrides,sourceEnv:'DATABASE_URL',inspectedSchema:schema,
    project:{root:'/synthetic/read-dependency',frameworks:[],schema_inputs:[],database_env_names:['DATABASE_URL']}});
  const full=build.exploration_boundary;
  const customer=full.pack.resources.find(r=>r.id===`${schema}.customers`)!;
  expect(customer.model_withheld_fields).toContain('fraud_flag');
  const catalog=buildActionRuleAuthoringCatalog({boundary:full,inspection:metadata});
  expect(catalog.authoring.resources.find(r=>r.name===customer.id)!.fields.find(f=>f.name==='fraud_flag')!.role).toBe('runner_verification_only');
  expect(catalog.catalog.resources.find(r=>r.name===customer.id)!.fields.some(f=>f.name==='fraud_flag')).toBe(true);
  const source=full.pack.resources.find(r=>r.id===`${schema}.orders`)!;
  if(schema==='returns_ops') {
    const link=source.relationships.find(r=>r.target_resource===customer.id)!;
    expect(link.proof!.links[0]!.source_columns).toEqual(['customer_id','tenant_id','principal_id']);
    expect(link.proof!.links[0]!.target_columns).toEqual(['customer_id','tenant_id','principal_id']);
    expect(link.cardinality).toBe('many_to_one');
    expect(link.unmatched_rows).toBe('exclude');
  } else {
    expect(source.relationships).toEqual([]);
    const before=structuredClone(full);
    await expect(prepareReadWorkloadRelationship({projectRoot:'/synthetic/read-dependency',boundary:full,generatedBoundary:full,
      fromResource:source.id,toResource:customer.id,modelLabel:'unused',assertCurrent:async()=>{},
      session:{chooseResource:async()=>undefined,editFieldTiers:async()=>undefined,
        promptText:async()=>undefined,confirm:async()=>false}})).rejects.toMatchObject({
        code:'READ_RELATIONSHIP_RESTORE_UNAVAILABLE',message:expect.stringContaining('no generated outgoing path')});
    expect(full).toEqual(before);
  }
});

it('allows reviewed exclusion of a genuinely unrelated control without losing the required customer dependency',async()=>{
  const metadata=await inspection('returns_ops');
  const unrelated=structuredClone(metadata.tables.find(t=>t.name==='customers')!);
  unrelated.name='unrelated_control'; unrelated.foreign_keys=[];
  metadata.tables.push(unrelated);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'read-optional-control-'));roots.push(root);
  vi.spyOn(process.stdout,'write').mockReturnValue(true);
  await boundaryCommand(['draft','--project-root',root,'--schema','returns_ops','--from-env','DATABASE_URL','--json'],async()=>metadata);
  for(const id of ['returns_ops.customers','returns_ops.unrelated_control']) {
    const current=await readProjectReadAuthoring(root);
    if(!current!.selected!.progress.candidate.pack.resources.some(r=>r.id===id)) {
      const preview=await prepareBoundaryResourceReviewMutation(root,{resource_id:id,include:true,actor:'synthetic-reviewer',reason:'Explicitly include this control before testing its removal.'},async()=>metadata);
      await commitBoundaryResourceReviewMutation(root,preview);
    }
  }
  const before=(await readProjectReadAuthoring(root))!.selected!.progress.candidate;
  const preview=await prepareBoundaryResourceReviewMutation(root,{resource_id:'returns_ops.unrelated_control',exclude:true,
    actor:'synthetic-reviewer',reason:'This independent control is not a required policy dependency.'},async()=>metadata);
  // Preparation is not consent or persistence.
  expect((await readProjectReadAuthoring(root))!.selected!.progress.candidate).toEqual(before);
  await commitBoundaryResourceReviewMutation(root,preview);
  const after=(await readProjectReadAuthoring(root))!.selected!.progress.candidate;
  expect(after.pack.resources.map(r=>r.id)).not.toContain('returns_ops.unrelated_control');
  expect(after.pack.resources.find(r=>r.id==='returns_ops.customers')).toEqual(before.pack.resources.find(r=>r.id==='returns_ops.customers'));
  expect(after.pack.resources.find(r=>r.id==='returns_ops.orders')!.relationships.some(r=>r.target_resource==='returns_ops.customers')).toBe(true);
  expect(after.budgets).toEqual(before.budgets);
});
