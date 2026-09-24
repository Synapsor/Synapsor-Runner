import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { CoverageCounterSupportError, CoverageCurrentDescriptionError, coverageFinding,
  type CoverageFeedback, type CoverageFinding } from './authoring-coverage-feedback.js';
import { SourceTransactionScopeError } from './authoring-source-transaction-scope.js';
import { assertRegisteredReviewFinding, modelReviewResolution, operatorReviewResolution,
  planCoverageResolution, planReviewPrerequisite, REVIEW_RESOLUTION_HANDLERS, ReviewResolutionError,
  runtimeReviewResolution, unknownReviewResolution } from './authoring-review-resolution.js';
import { localSourceTransactionReview, localSourceTransactionScopeReview } from './authoring-source-transaction-operation.js';
import { localScopedDisclosureReview } from './authoring-scoped-disclosure-operation.js';
import { reviewUnestablishedCounting } from './authoring-counting-decision-review.js';
import { createCoverageRepairScope } from './authoring-scoped-correction.js';
import { inspectPolicyReviewSource } from './authoring-policy-evidence.js';

const finding=(error:unknown,component='/passages/0')=>coverageFinding(error,component,{start:1,end:1});
const feedback=(findings:CoverageFinding[],limited=false):CoverageFeedback=>({
  context:canonicalJsonDigest('derived current review'),findings,limited,
  unevaluated:['complete review and persistence'],complete_validation:false});

describe('shared saved-review refusal resolution',()=>{
  it('routes the same coupling family by typed current cause rather than its broad policy label',()=>{
    const excluded=planCoverageResolution(feedback([finding(new SourceTransactionScopeError('excluded'))]));
    const unknown=planCoverageResolution(feedback([finding(new SourceTransactionScopeError('unknown'))]));
    const capability=planCoverageResolution(feedback([finding(new SourceTransactionScopeError('capability'))]));
    expect(excluded.recommended).toBe('scoped_correction');
    expect(unknown.recommended).toBe('source_transaction_scope_review');
    expect(unknown.options.find(x=>x.operation==='source_transaction_scope_review'))
      .toMatchObject({actor:'operator',handler:'source_transaction_scope_review',cost:'local'});
    expect(capability.recommended).toBeNull();
    expect(capability.options.some(x=>x.operation==='scoped_correction'&&x.availability==='available')).toBe(false);
  });

  it('preserves a local owner prerequisite alongside a separately correctable model component',()=>{
    const structural=finding(new CoverageCurrentDescriptionError({path:'/counter',actual:null,submitted:'other'}),
      '/passages/0/counter_requirements/0');
    const owner=finding(new SourceTransactionScopeError('unknown'),'/passages/1');
    const plan=planCoverageResolution(feedback([structural,owner]));
    expect(plan.findings).toHaveLength(2);
    expect(plan.recommended).toBe('source_transaction_scope_review');
    expect(plan.options.find(x=>x.operation==='scoped_correction')?.availability).toBe('waiting_for_prerequisite');
    expect(modelReviewResolution(plan)).toMatchObject({correction_available:false,findings:[]});
    expect(plan.complete_validation).toBe(false);
  });

  it('keeps pending/cancel available beside a terminal unsupported finding',()=>{
    const plan=planCoverageResolution(feedback([finding(new SourceTransactionScopeError('unknown')),
      finding(new SourceTransactionScopeError('capability'),'/passages/1')]));
    expect(plan.recommended).toBe('source_transaction_scope_review');
    expect(plan.options).toEqual(expect.arrayContaining([
      expect.objectContaining({operation:'diagnostic_stop',availability:'terminal',handler:null}),
      expect.objectContaining({operation:'leave_pending',actor:'operator',availability:'available',handler:null}),
    ]));
    expect(plan.options.some(o=>o.operation==='scoped_correction'&&o.availability==='available')).toBe(false);
  });

  it('keeps counter support and current description as separate typed sibling reasons',()=>{
    const support=finding(new CoverageCounterSupportError('quote_disagrees','Counter quote disagrees.'),
      '/passages/0/counter_requirements/0');
    const current=finding(new CoverageCurrentDescriptionError({path:'/counter',actual:'x',submitted:'y'}),
      '/passages/0/counter_requirements/1');
    expect([support.typed_reason,current.typed_reason]).toEqual([
      'counter_support.quote_disagrees','counter.current_description']);
    expect(planCoverageResolution(feedback([support,current])).recommended).toBe('scoped_correction');
    expect(planCoverageResolution(feedback([support,current],true)).recommended).toBeNull();
  });

  it('offers a real local prerequisite with a structured headless pending result',()=>{
    const plan=planReviewPrerequisite('source_transaction_scope','public outcome',canonicalJsonDigest('current'));
    const error=new ReviewResolutionError('SOURCE_TRANSACTION_SCOPE_REVIEW_PENDING',plan,
      'Review the exact current source requirement locally.');
    expect(error.toJSON()).toMatchObject({error_code:'SOURCE_TRANSACTION_SCOPE_REVIEW_PENDING',
      resolution:{status:'pending',subject:'public outcome',recommended:'source_transaction_scope_review',
        complete_validation:false,retained_work:'saved_pending'}});
    expect(operatorReviewResolution(plan).options).toEqual(expect.arrayContaining([
      expect.objectContaining({operation:'source_transaction_scope_review',availability:'available'})]));
    expect(runtimeReviewResolution(plan)).toEqual({status:'pending',complete_validation:false,review_pending:true});
    expect(JSON.stringify(runtimeReviewResolution(plan))).not.toContain('source_transaction_scope_review');
  });

  it('keeps currentness reinspection distinct from exhausted or declined episodes',()=>{
    const changed=planReviewPrerequisite('currentness',null,canonicalJsonDigest('old context'));
    expect(changed.recommended).toBe('reinspection');
    expect(changed.options).toEqual(expect.arrayContaining([
      expect.objectContaining({operation:'reinspection',availability:'available',cost:'local'})]));
    for(const reason of ['episode_declined','episode_exhausted','history_full'] as const){
      const stopped=planReviewPrerequisite(reason,null,null);
      expect(stopped.recommended).toBeNull();
      expect(stopped.options.some(option=>option.operation==='scoped_correction')).toBe(false);
      expect(stopped.options).toEqual(expect.arrayContaining([
        expect.objectContaining({operation:'leave_pending',availability:'available'})]));
    }
  });

  it('fails an unregistered first-party reason closed and sanitizes an unknown exception',()=>{
    const injected={...finding(new SourceTransactionScopeError('unknown')),
      typed_reason:'scope.future_unregistered'} as unknown as CoverageFinding;
    expect(()=>assertRegisteredReviewFinding(injected)).toThrow('REVIEW_RESOLUTION_UNREGISTERED');
    expect(()=>planCoverageResolution(feedback([injected]))).toThrow('REVIEW_RESOLUTION_UNREGISTERED');
    const untyped={...finding(new Error('future diagnostic')),code:'COVERAGE_FUTURE_UNREGISTERED',
      structural:true,typed_reason:undefined};
    expect(()=>assertRegisteredReviewFinding(untyped)).toThrow('REVIEW_RESOLUTION_UNREGISTERED');
    expect(()=>planCoverageResolution(feedback([untyped]))).toThrow('REVIEW_RESOLUTION_UNREGISTERED');
    const safe=unknownReviewResolution();
    expect(safe.message).toContain('REVIEW_DIAGNOSTIC_ONLY');
    expect(JSON.stringify(safe.toJSON())).not.toContain('private');
    expect(safe.plan.options.some(x=>x.operation==='scoped_correction')).toBe(false);
  });

  it('keeps adopted first-party constructors and available handlers in the ordinary release gate',async()=>{
    const source=await fs.readFile(new URL('./authoring-coverage-feedback.ts',import.meta.url),'utf8');
    const constructors=[...source.matchAll(/export class (Coverage\w+Error) extends Error/gu)].map(match=>match[1]).sort();
    expect(constructors).toEqual([
      'CoverageComponentError','CoverageComponentsError','CoverageCounterSupportError',
      'CoverageCurrentDescriptionError','CoverageReceiptConfigurationError','CoverageReceiptDutyError',
      'CoverageReceiptObservationError','CoverageReceiptReadContextError','CoverageReceiptReadExclusionError',
    ].sort());
    const actual={source_transaction_review:localSourceTransactionReview,
      source_transaction_scope_review:localSourceTransactionScopeReview,
      scoped_disclosure_review:localScopedDisclosureReview,counting_review:reviewUnestablishedCounting,
      scoped_correction:createCoverageRepairScope,reinspection:inspectPolicyReviewSource};
    expect(Object.keys(REVIEW_RESOLUTION_HANDLERS).sort()).toEqual(Object.keys(actual).sort());
    expect(Object.values(actual).every(handler=>typeof handler==='function')).toBe(true);
  });
});
