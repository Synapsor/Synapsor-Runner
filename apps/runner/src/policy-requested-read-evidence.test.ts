import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from './auto-boundary.js';
import { policyCoverageDraft } from './authoring-policy-evidence.js';
import { READ_WORKLOAD_ANALYSIS_VERSION, type ReadWorkloadAnalysis } from './read-workload-assist.js';
import { storeReadWorkloadAnalysis, readReadWorkloadAnalysis, recordReadWorkloadReview } from './read-workloads.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
function boundary():ExplorationBoundaryDraft {
  return {schema_version:'synapsor.exploration-boundary.v1',activation:'disabled_unreviewed',deployment_profile:'development',
    source:'lab',compiler_version:'1.8.0',spec_version:'1.11.0',reporting_timezone:'UTC',
    trusted_context:{provider:'environment',tenant_env:'SYNAPSOR_TENANT_ID',principal_env:'SYNAPSOR_PRINCIPAL'},
    generation_lock_fingerprint:canonicalJsonDigest('declared current generation'),role_posture_fingerprint:canonicalJsonDigest('declared reader'),
    pack:{name:'service_read',resources:[]},budgets:{} as never,unresolved_decisions:[]};
}
function analysis(read:ExplorationBoundaryDraft):ReadWorkloadAnalysis {
  return {schema_version:READ_WORKLOAD_ANALYSIS_VERSION,workload_name:'Declared service reads',workload_digest:canonicalJsonDigest('declared requests'),
    status:'ready',allowed:[{id:'current_case',description:'Read the current case',status:'supported',
      normalized_plan_digest:canonicalJsonDigest('declared normalized case plan'),plan_shape:{kind:'rows',resource:'service.cases'},
      authority_atoms:[{id:'case-resource',root_resource:'service.cases',resource:'service.cases',operation:'resource'}]}],
    forbidden:[],authority_atoms:[],candidate:read,candidate_digest:explorationBoundaryCandidateDigest(read),
    coverage:{allowed_supported:1,allowed_total:1,forbidden_denied:0,forbidden_total:0},
    exposure:{generated_resources:1,candidate_resources:1,generated_fields:1,candidate_return_fields:1,candidate_operation_fields:0,candidate_relationships:0},
    blockers:[],authority_granted:false,source_query_executed:false,explore_budget_consumed:false,source_database_changed:false};
}
it('binds the full original request separately from a short routing summary and a pending business change',()=>{
  const read=boundary(),jobIntent=`${'Help signed-in customers. '.repeat(24)}Read active cases and offered changes; archived cases stay excluded.`;
  const requestedRead={jobIntent,readIntent:'Help customers with their account',pendingJobRevision:'Require two reviewers instead of one; keep everything else.'};
  const draft=policyCoverageDraft({read,decisions:[],actions:[],...{requestedRead}});
  const evidence=(draft.runner_evidence as any).requested_read_scope;
  expect(evidence).toMatchObject({original_job:jobIntent,routing_read_summary:requestedRead.readIntent,pending_change:requestedRead.pendingJobRevision,
    selected_read_digest:explorationBoundaryCandidateDigest(read),workload:null});
  const changed=policyCoverageDraft({read,decisions:[],actions:[],...{requestedRead:{...requestedRead,jobIntent:jobIntent.replace('offered changes','billing preferences')}}});
  expect(canonicalJsonDigest(changed)).not.toBe(canonicalJsonDigest(draft));
});
it('uses an exact saved workload after restart and distinguishes its historical plan from the current Read revision',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'requested-read-evidence-'));roots.push(root);
  const read=boundary(),stored=await storeReadWorkloadAnalysis({projectRoot:root,generatedBoundary:read,source:{kind:'operator_exact_plan'},analysis:analysis(read)});
  await recordReadWorkloadReview({projectRoot:root,workload:stored,candidateDigest:explorationBoundaryCandidateDigest(read),reviewRevision:1});
  const workload=await readReadWorkloadAnalysis({projectRoot:root,analysisId:stored.analysis_id,generatedBoundary:read});
  const requestedRead={jobIntent:'Read current cases and offered changes',readIntent:'Read customer information',workload};
  const input={read,decisions:[],actions:[],...{requestedRead}},before=structuredClone(input);
  const original=policyCoverageDraft(input),evidence=(original.runner_evidence as any).requested_read_scope;
  expect(evidence.workload).toMatchObject({analysis_id:stored.analysis_id,analysis_digest:stored.analysis_digest,
    reviewed_candidate_matches_selected:true,allowed:[{id:'current_case',plan_shape:{resource:'service.cases'},status:'supported'}],authority_granted:false});
  const replacement={...read,pack:{...read.pack,name:'changed_read'}};
  const changed=policyCoverageDraft({...input,read:replacement});
  expect((changed.runner_evidence as any).requested_read_scope.workload.reviewed_candidate_matches_selected).toBe(false);
  expect(canonicalJsonDigest(changed)).not.toBe(canonicalJsonDigest(original));expect(input).toEqual(before);
});
