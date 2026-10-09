import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { CoverageCounterSupportError, CoverageCurrentDescriptionError, coverageFinding,
  type CoverageFeedback, type CoverageFinding } from './authoring-coverage-feedback.js';
import { SourceTransactionScopeError } from './authoring-source-transaction-scope.js';
import { assertRegisteredReviewFinding, modelReviewResolution, operatorReviewResolution,
  planCoverageResolution, planReviewPrerequisite, REVIEW_RESOLUTION_HANDLERS, ReviewResolutionError,
  runtimeReviewResolution, unknownReviewResolution, AUTHORING_REFUSAL_INVENTORY,
  isRegisteredAuthoringRefusalCode, planAuthoringRefusal } from './authoring-review-resolution.js';
import { localSourceTransactionReview, localSourceTransactionScopeReview } from './authoring-source-transaction-operation.js';
import { localScopedDisclosureReview } from './authoring-scoped-disclosure-operation.js';
import { reviewUnestablishedCounting } from './authoring-counting-decision-review.js';
import { createCoverageRepairScope } from './authoring-scoped-correction.js';
import { inspectPolicyReviewSource } from './authoring-policy-evidence.js';
import { SourceInputFidelityError } from './authoring-input-policy.js';
import { createBusinessStatementHost } from './authoring-business-statement-host.js';

const finding=(error:unknown,component='/passages/0')=>coverageFinding(error,component,{start:1,end:1});
const feedback=(findings:CoverageFinding[],limited=false):CoverageFeedback=>({
  context:canonicalJsonDigest('derived current review'),findings,limited,
  unevaluated:['complete review and persistence'],complete_validation:false});
// Inventory diagnostic literals, not similarly named TypeScript declarations.
// Both an exact code value and a message/template prefix remain discoverable.
const durableProducerCodes=(source:string)=>[...source.matchAll(/["'`]\b((?:READ_WORKLOAD_ASSISTANCE_CHECKPOINT_|READ_RELATIONSHIP_|ACTION_SOURCE_REPAIR_|ACTION_WORK_UNIT_|STRUCTURED_DRAFT_BUNDLE_|STRUCTURED_DRAFT_SUCCESSOR_)[A-Z_]+)(?=[:"'`])/gu)]
  .map(match=>match[1]!);

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
      'CoverageValidationError',
    ].sort());
    const actual={source_transaction_review:localSourceTransactionReview,
      source_transaction_scope_review:localSourceTransactionScopeReview,
      scoped_disclosure_review:localScopedDisclosureReview,counting_review:reviewUnestablishedCounting,
      receipt_requirement_review:createBusinessStatementHost,
      scoped_correction:createCoverageRepairScope,reinspection:inspectPolicyReviewSource};
    expect(Object.keys(REVIEW_RESOLUTION_HANDLERS).sort()).toEqual(Object.keys(actual).sort());
    expect(Object.values(actual).every(handler=>typeof handler==='function')).toBe(true);
  });
});

describe('finite durable authoring refusal inventory',()=>{
  it.each(Object.keys(AUTHORING_REFUSAL_INVENTORY))('declares only pending or stopped safe options for %s',code=>{
    expect(isRegisteredAuthoringRefusalCode(code)).toBe(true);
    const result=planAuthoringRefusal(code,{subject:'owned disabled draft',context:canonicalJsonDigest('owned context'),retainedWork:'saved_pending'});
    expect(result).toBeDefined();
    if(!result)throw new Error('Expected registered refusal');
    expect(result.code).toBe(code);
    expect(result.plan).toMatchObject({subject:'owned disabled draft',context:canonicalJsonDigest('owned context'),
      findings:[{code,component:'/'}],complete_validation:false,retained_work:'saved_pending'});
    expect(result.next_action.trim().length).toBeGreaterThan(20);
    expect(result.next_action.length).toBeLessThan(1000);
    expect(result.plan.options.every(option=>['leave_pending','diagnostic_stop'].includes(option.operation)
      &&option.handler===null&&option.actor!=='authoring_model'&&option.cost!=='provider_episode'&&option.consent==='none')).toBe(true);
    expect(result.plan.options).toContainEqual(expect.objectContaining({operation:'leave_pending',availability:'available'}));
    expect(result.plan.recommended).toBe(result.plan.result==='pending'?'leave_pending':null);
    expect(modelReviewResolution(result.plan)).toEqual({status:result.plan.result,complete_validation:false,findings:[],correction_available:false});
    const operator=operatorReviewResolution(result.plan),runtime=runtimeReviewResolution(result.plan);
    expect(operator.options.every(option=>['leave_pending','diagnostic_stop'].includes(option.operation))).toBe(true);
    expect(JSON.stringify(operator)).not.toContain('handler');
    expect(JSON.stringify(operator)).not.toContain('next_action');
    expect(runtime).toEqual({status:result.plan.result,complete_validation:false,review_pending:true});
    expect(JSON.stringify(runtime)).not.toContain('leave_pending');
  });

  it('does not invent acknowledged persistence or a current subject/context',()=>{
    expect(planAuthoringRefusal('BOUNDARY_AUTHORING_RESUME_NOT_SAVED')?.plan).toMatchObject({
      subject:null,context:null,retained_work:'not_established',result:'stopped',recommended:null});
  });

  it('keeps resumable exact waits distinct from declined or exhausted assistance',()=>{
    for(const code of ['READ_WORKLOAD_AUTHORING_PAUSED','READ_RELATIONSHIP_REVIEW_PENDING','AUTHORING_OWNER_QUESTION_PENDING']){
      expect(planAuthoringRefusal(code)?.plan).toMatchObject({result:'pending',recommended:'leave_pending'});
    }
    for(const code of ['READ_WORKLOAD_CLARIFICATION_DECLINED','READ_WORKLOAD_ASSISTANCE_REQUEST_REPEATED','READ_WORKLOAD_MECHANICAL_QUESTION_REPEATED','ACTION_SOURCE_REPAIR_EXHAUSTED']){
      expect(planAuthoringRefusal(code)?.plan).toMatchObject({result:'stopped',recommended:null});
    }
    expect(planAuthoringRefusal('READ_WORKLOAD_CLARIFICATION_DECLINED')?.next_action).toContain('a decline is not an unanswered question');
    expect(planAuthoringRefusal('ACTION_SOURCE_REPAIR_EXHAUSTED')?.next_action).toContain('does not renew');
  });

  it('does not treat a rescan or model switch as retargeting a drifted producer checkpoint',()=>{
    const result=planAuthoringRefusal('READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE');
    expect(result?.plan).toMatchObject({result:'stopped',recommended:null});
    expect(result?.next_action).toContain('does not retarget');
    expect(result?.plan.options.some(option=>option.operation==='reinspection')).toBe(false);
    expect(planReviewPrerequisite('currentness',null,null).recommended).toBe('reinspection');
  });

  it('describes a stale Action question without promising that reopening refreshes it',()=>{
    const result=planAuthoringRefusal('ACTION_AUTHORING_QUESTION_STALE');
    expect(result?.plan).toMatchObject({result:'stopped',recommended:null});
    expect(result?.plan.options.every(option=>option.handler===null)).toBe(true);
    expect(result?.next_action).toContain('Reopening preserves this checkpoint; it does not approve changed applicability');
    expect(result?.next_action).toContain('untouched program with no prepared or saved Action');
    expect(result?.next_action).toContain('Draft a change');
    expect(result?.next_action).toContain('fresh exact agenda for review');
    expect(result?.next_action).toContain('Prepared or partially saved work requires applicable revision review');
  });

  it('keeps ambiguous persistence and successor confirmation descriptive and non-authorizing',()=>{
    expect(planAuthoringRefusal('READ_RELATIONSHIP_SAVE_UNCONFIRMED')?.next_action).toContain('An ambiguous save remains unknown');
    const confirmation=planAuthoringRefusal('STRUCTURED_DRAFT_SUCCESSOR_CONFIRMATION_REQUIRED');
    expect(confirmation?.next_action).toContain('--dry-run');expect(confirmation?.next_action).toContain('requires explicit --yes');
    expect(confirmation?.next_action).toContain('not provider consent or activation');
    expect(confirmation?.plan.options).toContainEqual(expect.objectContaining({operation:'diagnostic_stop',availability:'waiting_for_prerequisite',handler:null}));
  });

  it('provides fenced unknown transport only read-only inspection/export guidance, including missing past consent',()=>{
    for(const code of ['ASK_GENERATION_OUTCOME_UNKNOWN','ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION','ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE']){
      const result=planAuthoringRefusal(code);
      expect(result?.plan).toMatchObject({result:'stopped',recommended:null});
      expect(result?.next_action).toContain('without replay');expect(result?.next_action).toContain('offline inspection');
      expect(result?.next_action).toContain('establishes no viable Resume or recovery permission');
      expect(result?.next_action).toContain('do not import old replies');
    }
  });

  it.each([undefined,null,{},'toString','__proto__','READ_WORKLOAD_ASSISTANCE_CHECKPOINT_FUTURE',
    'ACTION_RULE_EXPRESSION_KIND_INVALID','ACTION_RULE_DRAFT_INVALID','ACTION_RULE_EFFECT_TARGET_UNAVAILABLE',
    'ACTION_RULE_FUTURE_COMPILE_ERROR','SOURCE_INPUT_REQUIREMENT_PENDING','SOURCE_INPUT_CONSTRAINT_WEAKER',
    'READ_WORKLOAD_VALUE_REQUEST_REFUSED','READ_WORKLOAD_CLARIFICATION_REFUSED'])
    ('adopts no unknown value or ordinary grammar/Source-root code %j',code=>{
      expect(isRegisteredAuthoringRefusalCode(code)).toBe(false);expect(planAuthoringRefusal(code)).toBeUndefined();
    });

  it('preserves unregistered root Source refusal even when its broad error code looks like weaker input',()=>{
    const source=new SourceInputFidelityError([{code:'SOURCE_INPUT_REQUIREMENT_PENDING',path:'draft.inputs',outcome:'owned.action',input:'',
      source_digest:canonicalJsonDigest('owned Source'),repair:'Review the exact current Source root; no finite input correction is established.'}]);
    expect(source.code).toBe('SOURCE_INPUT_CONSTRAINT_WEAKER');
    expect(source.message).toMatch(/^SOURCE_INPUT_REQUIREMENT_PENDING:/u);
    expect(planAuthoringRefusal(source.code)).toBeUndefined();
    const root={...finding(source),structural:true,typed_reason:undefined};
    expect(()=>planCoverageResolution(feedback([root]))).toThrow('REVIEW_RESOLUTION_UNREGISTERED');
    const stopped=unknownReviewResolution();
    expect(stopped.plan).toMatchObject({result:'stopped',recommended:null});
    expect(modelReviewResolution(stopped.plan).correction_available).toBe(false);
  });

  it('retains positive correction for existing registered structural grammar',()=>{
    const structural=finding(new CoverageCurrentDescriptionError({path:'/counter',actual:null,submitted:'other'}));
    expect(planCoverageResolution(feedback([structural])).recommended).toBe('scoped_correction');
    expect(modelReviewResolution(planCoverageResolution(feedback([structural]))).correction_available).toBe(true);
    expect(isRegisteredAuthoringRefusalCode('ACTION_RULE_DRAFT_INVALID')).toBe(false);
  });

  it('requires every scoped first-party durable producer code to be explicitly inventoried',async()=>{
    const files=['read-workload-assistance-checkpoint.ts','read-workload-model.ts','action-rule-model.ts',
      'action-authoring-work-unit-contract.ts','boundary-draft-bundle.ts','boundary-draft-successor.ts','boundary-structured-authoring.ts'];
    const sources=await Promise.all(files.map(file=>fs.readFile(new URL(file,import.meta.url),'utf8')));
    const codes=[...new Set(sources.flatMap(durableProducerCodes))].sort();
    expect(codes.length).toBeGreaterThan(20);
    expect(codes.filter(code=>!isRegisteredAuthoringRefusalCode(code))).toEqual([]);
    expect(Object.keys(REVIEW_RESOLUTION_HANDLERS).sort()).toEqual(['source_transaction_review','source_transaction_scope_review',
      'scoped_disclosure_review','counting_review','receipt_requirement_review','scoped_correction','reinspection'].sort());
  });

  it('excludes a loader-field declaration without hiding an uninventoried diagnostic',()=>{
    const source='export const ACTION_WORK_UNIT_BINDING_LOADER_FIELDS = ["source"]; '
      + 'const code = "ACTION_WORK_UNIT_SOURCE_CONTEXT_CHANGED"; '
      + 'throw new Error(`ACTION_WORK_UNIT_NEW_REFUSAL: keep work pending`);';
    expect(durableProducerCodes(source)).toEqual(['ACTION_WORK_UNIT_SOURCE_CONTEXT_CHANGED','ACTION_WORK_UNIT_NEW_REFUSAL']);
    expect(durableProducerCodes(source).filter(code=>!isRegisteredAuthoringRefusalCode(code)))
      .toEqual(['ACTION_WORK_UNIT_NEW_REFUSAL']);
  });
});
