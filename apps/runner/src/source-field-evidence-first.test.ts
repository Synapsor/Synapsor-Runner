import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { policyCoverageDraft } from './authoring-policy-evidence.js';
import { collectCoverageFeedback, parsePolicyCoverage, unresolvedPolicyPassages } from './authoring-policy-coverage.js';
import { bindPolicyCoverage, loadPolicySources, savePolicySources } from './authoring-policy-source.js';
const capture=JSON.parse(await fs.readFile(new URL('./test-fixtures/source-field-evidence-first.json',import.meta.url),'utf8'));
function fixture(){
 const f=structuredClone(capture);
 const sources={schema_version:'synapsor.policy-source-session.v1',id:randomUUID(),active:f.source.version,snapshots:[f.source],approvals:[],operator_messages:f.messages,
  counting_decisions:f.prepared.runner_evidence.counting_decisions??[]};
 const draft=policyCoverageDraft({read:f.prepared.read,decisions:[],actions:[],authority:f.authority,
  source:{inspection:f.inspection,generationLock:f.generationLock},reviewedVersionFields:f.reviewedVersionFields,policySources:sources as any,
  receiptConfiguration:f.prepared.runner_evidence.runtime_contract.receipt_configuration});
 return {...f,sources,draft};
}
describe('first tester B excluded-field evidence through the complete producer and parser',()=>{
 it('preserves the unchanged historical refusal and binds current reinspection to the same exact disabled program',()=>{
  const f=fixture();
  expect(collectCoverageFeedback(f.response,f.source,f.prepared,f.messages).findings[0]?.code).toBe('COVERAGE_FIELD_EVIDENCE_UNAVAILABLE');
  expect(canonicalJsonDigest(f.generationLock)).toBe(f.prepared.read.generation_lock_fingerprint);
  expect(f.draft.read).toEqual(f.prepared.read);expect(f.draft.actions).toEqual(f.prepared.actions);
  expect(f.draft.runner_evidence.source_constraints).toEqual(f.prepared.runner_evidence.source_constraints);
  expect(f.draft.runner_evidence.excluded_field_access?.resources['energy_ops.exception_notes']?.fields.detail)
   .toMatchObject({actual_values_returned:false,model_analysis:[],private_action_verification:false});
  expect(f.draft.runner_evidence.actions['energy_ops.finalize_settlement_cycle']?.scoped_bindings.notes?.fields.detail).toBeUndefined();
  const feedback=collectCoverageFeedback(f.response,f.source,f.draft,f.messages);
  expect(feedback.findings).toEqual([]);
  const report=parsePolicyCoverage(f.response,f.source,f.draft,f.messages);
  expect(report.passages[7]?.disposition).toBe('implemented');
  expect(report.passages.some(p=>p.disposition==='conflict')).toBe(true);
 });
 it('persists the exact validated field proof without erasing other blockers and rechecks it on reload', async()=>{
  const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'field-association-'));
  try {
   const report=parsePolicyCoverage(f.response,f.source,f.draft,f.messages);
   bindPolicyCoverage(f.sources as any,report,canonicalJsonDigest(f.draft.actions));
   await savePolicySources(root,f.sources as any,{expectedDigest:null});
   const saved=await loadPolicySources(root,f.sources.id);
   const again=parsePolicyCoverage({passages:saved.coverage!.passages},f.source,f.draft,saved.operator_messages!);
   expect(again.passages[7]).toEqual(report.passages[7]);
   expect(unresolvedPolicyPassages(again).some(p=>p.disposition==='conflict')).toBe(true);
   expect(saved.application_assignments).toBeUndefined();
   const stale=structuredClone(f.draft);
   stale.runner_evidence.excluded_field_access!.selected_read_digest=canonicalJsonDigest('other Read');
   expect(()=>parsePolicyCoverage(f.response,f.source,stale,f.messages)).toThrow(/Incomplete field privacy evidence: selected Read, Actions or inspected metadata changed/);
   await expect(savePolicySources(root,f.sources as any,{expectedDigest:null})).rejects.toThrow(/CHANGED/);
   expect((await loadPolicySources(root,f.sources.id)).coverage).toEqual(saved.coverage);
  } finally {await fs.rm(root,{recursive:true,force:true});}
 });

});
