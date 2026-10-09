import { RECEIPT_COMPONENT_IDS, type PolicyPassage, type PolicyTextSnapshot, type PolicySourceSession } from './authoring-policy-source.js';
import { currentSourceTransactionReview } from './authoring-source-transaction-review.js';
import { isDeferredSourceReadback, isDeferredPolicyDeployment } from './authoring-policy-source.js';
import { assessReceiptCouplingCapability, assessReviewObligation, receiptSelectionComponent, receiptCouplingInterpretation } from './authoring-obligation-review.js';
import type { CoverageRepairCategory, CoverageRepairScope } from './authoring-scoped-correction.js';
import { CoverageScopedCorrectionError } from './authoring-scoped-correction.js';

const ROOT='/runner_evidence/runtime_contract';
/** Narrow host display only. These sentences never classify provider prose.
 * Raw proposals remain in the episode; every component needs current proof. */
export function receiptComponentMeanings(draft: any): Partial<Record<CoverageRepairCategory,string[]>> {
  return {
    compiled_effect: ['The compiled effects describe prepared business mutations only. This component establishes no receipt coupling, provisioning, execution authorization, performed receipt or independent readback.'],
    receipt_configuration: ['The exact current reviewed receipt selection matches the source-required mode. This establishes configuration only, not provisioning, execution permission, a performed receipt or independent readback.'],
    receipt_read_exclusion: ['The exact configured receipt destinations are excluded from this complete selected Read graph. This establishes no broader privacy, provisioning, execution, receipt observation or independent readback.'],
    source_transaction_coupling: (draft?.actions??[]).map((a:any)=>receiptCouplingInterpretation(a.outcome)),
  };
}
export function constrainReceiptComponentSchema(schema:any,draft:unknown):void {
  for(const target of schema.properties.groups.items.oneOf) for(const edit of target.properties.passage_replacements.items?.oneOf??[])
    for(const alternative of edit.properties.fragments.items.oneOf) {
    const category=alternative.properties.category.const as CoverageRepairCategory;
    if((RECEIPT_COMPONENT_IDS as readonly string[]).includes(category)) {
      alternative.properties.passage.properties.receipt_component={type:'string',const:category};
      alternative.properties.passage.required=[...new Set([...(alternative.properties.passage.required??[]),'receipt_component'])];
      alternative.properties.passage.properties.interpretation={type:'string',maxLength:800};
      delete alternative.properties.passage.properties.next_step;
      delete alternative.properties.passage.properties.topic;
    }
  }
}
/** Typed identity/isolated shape, followed by the existing current host proofs.
 * A marker cannot establish a receipt, scope, execution or observation. */
export function validateReceiptComponentIdentity(p: PolicyPassage,source:PolicyTextSnapshot,draft:unknown,
  session?:PolicySourceSession):void {
  const category=p.receipt_component;
  const fail=()=>{throw new CoverageScopedCorrectionError('A receipt component has no exact applicable category proof or adds claims outside its narrow meaning.');};
  if(category===undefined)return;
  if(category==='source_transaction_coupling') {
    assessReceiptCouplingCapability(p,source,draft); // preserve existing exact refusal family/guards
    return;
  }
  if(!(RECEIPT_COMPONENT_IDS as readonly string[]).includes(category)
    ||p.next_step!==undefined||p.topic!==undefined||p.disposition!=='implemented'
    ||p.responsibility!=='runner'||p.issue_kind!=='coverage_link'
    ||p.counter_requirements!==undefined||p.field_checks!==undefined||p.evidence_checks!==undefined
    ||p.application_obligations!==undefined||p.deployment_prerequisite!==undefined
    ||p.source_counter_obligation!==undefined||p.operator_override!==undefined||p.operator_clarification!==undefined
    ||Object.hasOwn(p,'operator_message_id'))fail();
  if(category==='receipt_configuration'&&!receiptSelectionComponent(p,source,draft))fail();
  if(category==='receipt_read_exclusion') {
    if(p.draft_paths.length!==1||p.draft_paths[0]!==ROOT+'/receipt_read_exclusion')fail();
    assessReviewObligation(p,source,draft,session); // exact current excluded=true proof, no observation
  }
  if(category==='compiled_effect'&&(!p.draft_paths.length||p.draft_paths.some(path=>!/^\/runner_evidence\/actions\/[^/]+\/(effect|execution)$/u.test(path))))fail();
}

/** Output formatting after independent validation, never a prose recognizer. */
export function receiptComponentDisplay(p:PolicyPassage,draft:any):string|undefined {
  if(p.receipt_component===undefined)return undefined;
  if(p.receipt_component==='source_transaction_coupling') {
    const actions=(draft?.actions??[]).filter((action:any)=>typeof action.outcome==='string'
      &&p.draft_paths.includes(`/runner_evidence/actions/${action.outcome.replace(/~/gu,'~0').replace(/\//gu,'~1')}/effect`));
    if(actions.length!==1)throw new CoverageScopedCorrectionError('The component display has no exact outcome.');
    return receiptCouplingInterpretation(actions[0].outcome);
  }
  return receiptComponentMeanings(draft)[p.receipt_component]?.[0];
}

export function validateScopedReceiptComponents(assembled:{passages:any[]},categories:Array<{index:number;category:CoverageRepairCategory;target_id:string}>,
  scope:CoverageRepairScope,source:PolicyTextSnapshot,draft:unknown,session?:PolicySourceSession):void {
  const fail=()=>{throw new CoverageScopedCorrectionError('A receipt component has no exact applicable category proof or adds claims outside its narrow meaning.');};
  for(const {index,category,target_id} of categories){
    const p=assembled.passages[index] as PolicyPassage;
    if(category==='ordinary'){if(p.receipt_component!==undefined)fail();continue;}
    const target=scope.targets.find(target=>target.target_id===target_id);
    if(!target)fail();
    if((RECEIPT_COMPONENT_IDS as readonly string[]).includes(category)) {
      if(p.receipt_component!==category||!target!.receipt_region
        ||!target!.source_ranges.some(range=>range.start===p.start&&range.end===p.end)
        ||p.draft_paths.some(path=>!target!.allowed_references[category].includes(path)))fail();
      if(category==='source_transaction_coupling') {
        const requirement=currentSourceTransactionReview(source,draft,session),proof=assessReceiptCouplingCapability(p,source,draft);
        if(!requirement||requirement.start!==p.start||requirement.end!==p.end
          ||!proof?.outcome||proof.outcome!==requirement.action.outcome)fail();
      }
      validateReceiptComponentIdentity(p,source,draft,session);
    } else if(p.receipt_component!==undefined)fail();
    if(category==='setup'){
      const assessment=assessReviewObligation(p,source,draft);
      if(!assessment&&!isDeferredPolicyDeployment(p)||p.disposition!=='needs_decision'||p.responsibility!=='deployment'||p.issue_kind!=='missing_configuration')fail();
    }
    if(category==='receipt_observation')fail();
    if(category==='independent_readback'&&!isDeferredSourceReadback(p))fail();
    // The ordinary parser verifies exact roots/current evidence again and derives
    // host display. Raw generated narration remains untouched in episode history.
  }
}
