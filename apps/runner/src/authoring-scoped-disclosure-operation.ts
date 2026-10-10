import {canonicalJsonDigest} from '@synapsor-runner/protocol';
import {activePolicySource,bindPolicyCoverage,loadPolicySources,policySourceSavedDigest,policySourceSavedDigestHeld,savePolicySources,adoptPolicySourceAcknowledgement,PolicySourceChangedError,type PolicySourceSaveAcknowledgement,type PolicySourceSession} from './authoring-policy-source.js';
import {reviewScopedDisclosure,decideScopedDisclosure,scopedDisclosureInventory,type ScopedDisclosureReview} from './authoring-scoped-disclosure.js';
import {parsePolicyCoverage} from './authoring-policy-coverage.js';
import {policyReviewReadiness} from './authoring-review-readiness.js';
import type {BoundaryReviewInteractiveSession} from './boundary-cli-picker.js';
import type {ProjectAuthorityMutationPermit} from './project-authority-mutation.js';

/** Existing review record and coordination; no model, new authority, or partial
 * coverage acceptance. Historical provider prose is never rewritten. */
export async function localScopedDisclosureReview(input:{projectRoot:string;sources:PolicySourceSession;
  session:BoundaryReviewInteractiveSession;actor:string;register:boolean;location:'active'|'draft';
  currentDraft:()=>unknown;authorityDigest:string;clarifications:unknown[];
  assertCurrent:()=>Promise<void>;
  assertCurrentHeld:(permit:ProjectAuthorityMutationPermit)=>Promise<void>;
  onValidated?:(sources:PolicySourceSession,permit:ProjectAuthorityMutationPermit)=>Promise<void>;
  coordinated:(operation:(permit:ProjectAuthorityMutationPermit)=>Promise<void>)=>Promise<void>}) {
  const source=activePolicySource(input.sources)!;
  let expected=await policySourceSavedDigest(input.projectRoot,input.sources.id);
  if(canonicalJsonDigest(await loadPolicySources(input.projectRoot,input.sources.id))!==canonicalJsonDigest(input.sources))
    throw new Error('POLICY_SOURCE_CHANGED: Reopen the current saved source before recording this review.');
  const assertCurrent=async()=>{
    await input.assertCurrent();
    if(await policySourceSavedDigest(input.projectRoot,input.sources.id)!==expected)throw new Error('POLICY_SOURCE_CHANGED: A competing source or decision was saved. No later record was overwritten.');
  };
  const assertCurrentHeld=async(permit:ProjectAuthorityMutationPermit)=>{
    await input.assertCurrentHeld(permit);
    if(await policySourceSavedDigestHeld(input.projectRoot,input.sources.id,permit)!==expected)throw new Error('POLICY_SOURCE_CHANGED: A competing source or decision was saved. No later record was overwritten.');
  };
  let sourceSave: PolicySourceSaveAcknowledgement | undefined;
  const append=async(record:ScopedDisclosureReview)=>{
    const prepared=canonicalJsonDigest(input.currentDraft());
    const staged=structuredClone(input.sources);
    staged.scoped_disclosure_reviews=[...(staged.scoped_disclosure_reviews??[]),record];
    const candidate=structuredClone(input.currentDraft()) as {runner_evidence:{scoped_disclosure:{reviews:ScopedDisclosureReview[]}}};
    candidate.runner_evidence.scoped_disclosure.reviews=staged.scoped_disclosure_reviews;
    if(scopedDisclosureInventory(source,candidate).items.some(f=>f.id===record.id && f.state==='stale'))
      throw new Error('SCOPED_DISCLOSURE_CONTEXT_CHANGED: The selected source/field/reader binding changed before save. No stale decision was saved.');
    let acknowledgement: PolicySourceSaveAcknowledgement | undefined;
    await input.coordinated(async permit=>{
      await assertCurrentHeld(permit);
      if(canonicalJsonDigest(input.currentDraft())!==prepared)throw new Error('SCOPED_DISCLOSURE_CONTEXT_CHANGED: No stale decision was saved.');
      acknowledgement=await savePolicySources(input.projectRoot,staged,{expectedDigest:expected,permit});
      expected=acknowledgement.outcome.reference.revision_digest;
      adoptPolicySourceAcknowledgement(input.sources,acknowledgement);
      sourceSave=acknowledgement;
    });
    if (!acknowledgement) throw new PolicySourceChangedError();
  };
  await assertCurrent();
  if(input.register){
    const mapping=await reviewScopedDisclosure({source,draft:input.currentDraft(),actor:input.actor,session:input.session,assertCurrent});
    if(mapping){if(!input.sources.scoped_disclosure_reviews?.some(r=>r.digest===mapping.digest))await append(mapping);}
    else return {cancelled:true,ready:false,inventory:undefined,summary:['Source requirement registration cancelled. Existing review evidence and authority are unchanged.']};
  }
  const decision=await decideScopedDisclosure({source,draft:input.currentDraft(),actor:input.actor,session:input.session,assertCurrent});
  if(decision)await append(decision);
  const draft=input.currentDraft(), inventory=scopedDisclosureInventory(source,draft), prepared=canonicalJsonDigest(draft);
  let report;
  let validationFailure:string|undefined;
  if(input.sources.coverage?.source_digest===source.digest){
    try {report=parsePolicyCoverage({passages:input.sources.coverage.passages},source,draft,input.sources.operator_messages??[],input.sources);}
    catch {validationFailure='The retained full review requires current validation; a local classification cannot repair or waive another claim.';}
  }
  // Whole strict revalidation is required even for a provider-free old report.
  // This replaces current coverage through its normal save; completed-review
  // history and its exact report digest, original prose and captures remain.
  if(report){
    const staged=structuredClone(input.sources);
    bindPolicyCoverage(staged,report,input.authorityDigest);
    staged.coverage_context_digest=canonicalJsonDigest({source:source.digest,draft,messages:staged.operator_messages??[],
      clarifications:input.clarifications,interpretations:staged.read_interpretations??[]});
    let acknowledgement: PolicySourceSaveAcknowledgement | undefined;
    await input.coordinated(async permit=>{
      await assertCurrentHeld(permit);
      if(canonicalJsonDigest(input.currentDraft())!==prepared)throw new Error('SCOPED_DISCLOSURE_CONTEXT_CHANGED: Current review was not saved.');
      acknowledgement=await savePolicySources(input.projectRoot,staged,{expectedDigest:expected,permit});
      expected=acknowledgement.outcome.reference.revision_digest;
      adoptPolicySourceAcknowledgement(input.sources,acknowledgement);
      sourceSave=acknowledgement;
      if(policyReviewReadiness(source,report,input.sources,input.location).ready)await input.onValidated?.(input.sources,permit);
    });
    if (!acknowledgement) throw new PolicySourceChangedError();
  }
  const readiness=policyReviewReadiness(source,report,input.sources,input.location);
  return {cancelled:false,...readiness,inventory,sourceSave,summary:[...readiness.summary,
    ...(validationFailure?[validationFailure]:[]),
    'Local source requirement/decision review only. Provider calls: 0. Classification is an owner assertion; source contents and client implementation remain unverified.']};
}
