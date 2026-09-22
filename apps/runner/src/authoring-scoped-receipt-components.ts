import { createHash } from 'node:crypto';
import type { PolicyPassage, PolicyTextSnapshot } from './authoring-policy-source.js';
import { isDeferredSourceReadback, isDeferredPolicyDeployment } from './authoring-policy-source.js';
import { assessReceiptCouplingCapability, assessReviewObligation, receiptSelectionComponent, receiptCouplingInterpretation } from './authoring-obligation-review.js';
import type { CoverageRepairCategory, CoverageRepairScope } from './authoring-scoped-correction.js';
import { CoverageScopedCorrectionError } from './authoring-scoped-correction.js';

const ROOT='/runner_evidence/runtime_contract';
/** Fixed narrow meanings, not an inference from provider prose. Raw proposals
 * remain in the episode. A category still needs its ordinary exact host proof. */
export function receiptComponentMeanings(draft: any): Partial<Record<CoverageRepairCategory,string[]>> {
  return {
    compiled_effect: ['The compiled effects describe prepared business mutations only. This component establishes no receipt coupling, provisioning, execution authorization, performed receipt or independent readback.'],
    receipt_configuration: ['The exact current reviewed receipt selection matches the source-required mode. This establishes configuration only, not provisioning, execution permission, a performed receipt or independent readback.'],
    receipt_read_exclusion: ['The exact configured receipt destinations are excluded from this complete selected Read graph. This establishes no broader privacy, provisioning, execution, receipt observation or independent readback.'],
    source_transaction_coupling: (draft?.actions??[]).map((a:any)=>receiptCouplingInterpretation(a.outcome)),
  };
}
export function constrainReceiptComponentSchema(schema:any,draft:unknown):void {
  const meanings=receiptComponentMeanings(draft);
  for(const target of schema.properties.groups.items.oneOf) for(const alternative of target.properties.replacements.items.oneOf) {
    if(Object.hasOwn(alternative.properties.passage,'const'))continue;
    const category=alternative.properties.category.const as CoverageRepairCategory;
    if(meanings[category]?.length) {
      alternative.properties.passage.properties.interpretation={type:'string',enum:meanings[category]};
      delete alternative.properties.passage.properties.next_step;
      delete alternative.properties.passage.properties.topic;
    }
  }
}
export function validateScopedReceiptComponents(assembled:{passages:any[]},categories:Array<{index:number;category:CoverageRepairCategory;target_id:string}>,
  scope:CoverageRepairScope,source:PolicyTextSnapshot,draft:unknown):void {
  const meanings=receiptComponentMeanings(draft);
  const fail=()=>{throw new CoverageScopedCorrectionError('A receipt component has no exact applicable category proof or adds claims outside its narrow meaning.');};
  for(const {index,category,target_id} of categories){
    if(category==='ordinary')continue;
    const p=assembled.passages[index] as PolicyPassage;
    // A read-only overlap dependency is repeated byte-for-byte from this exact
    // parent. New canonical generation wording cannot rewrite it. Its ordinary
    // parser/proof checks still run in the complete assembled report below.
    const digest=`sha256:${createHash('sha256').update(JSON.stringify(p)).digest('hex')}`;
    if(scope.targets.find(t=>t.target_id===target_id)?.required_retained.some(r=>r.raw_digest===digest))continue;
    if(meanings[category]) {
      if(!meanings[category]!.includes(p.interpretation)||p.next_step!==undefined||p.topic!==undefined
        ||p.disposition!=='implemented'||p.responsibility!=='runner'||p.issue_kind!=='coverage_link'
        ||p.counter_requirements!==undefined||p.field_checks!==undefined||p.evidence_checks!==undefined
        ||p.application_obligations!==undefined||p.deployment_prerequisite!==undefined
        ||p.source_counter_obligation!==undefined||p.operator_override!==undefined||p.operator_clarification!==undefined
        ||Object.hasOwn(p,'operator_message_id'))fail();
    }
    if(category==='source_transaction_coupling') {if(!assessReceiptCouplingCapability(p,source,draft))fail();}
    else if(p.receipt_component!==undefined)fail();
    if(category==='receipt_configuration'&&!receiptSelectionComponent(p,source,draft))fail();
    if(category==='receipt_read_exclusion'&&(p.draft_paths.length!==1||p.draft_paths[0]!==ROOT+'/receipt_read_exclusion'))fail();
    if(category==='setup'){
      const assessment=assessReviewObligation(p,source,draft);
      if(!assessment&&!isDeferredPolicyDeployment(p)||p.disposition!=='needs_decision'||p.responsibility!=='deployment'||p.issue_kind!=='missing_configuration')fail();
    }
    if(category==='receipt_observation')fail(); // this review context supplies no operation-bound receipt observation
    if(category==='independent_readback'&&!isDeferredSourceReadback(p))fail();
    if(category==='compiled_effect'&&(!p.draft_paths.length||p.draft_paths.some(path=>!/^\/runner_evidence\/actions\/[^/]+\/(effect|execution)$/u.test(path))))fail();
    // The ordinary parser subsequently verifies exact roots, role and current evidence.
  }
}
