import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { collectCoverageFeedback } from './authoring-policy-coverage.js';
import { createCoverageRepairScope, type CoverageRepairCategory } from './authoring-scoped-correction.js';
import { constrainReceiptComponentSchema, receiptComponentMeanings, validateScopedReceiptComponents } from './authoring-scoped-receipt-components.js';
import { assessReceiptCouplingCapability, receiptCouplingInterpretation, receiptCouplingPaths, repairableReceiptCouplingRepresentation } from './authoring-obligation-review.js';
import { makeSourceTransactionReview, sourceTransactionMappings, sourceTransactionPreparedContext } from './authoring-source-transaction-review.js';

// DERIVED, offline current evidence/control data over the retained capture.
// No performed receipt, native execution or paid response is manufactured.
const capture = JSON.parse(await fs.readFile(new URL('./test-fixtures/receipt-correction-chain.json', import.meta.url), 'utf8'));
const ids = ['compiled_effect', 'receipt_configuration', 'receipt_read_exclusion', 'source_transaction_coupling'] as const;
function fixture() {
  const f = structuredClone(capture), store = canonicalJsonDigest('DERIVED test project binding');
  const mapping = sourceTransactionMappings(f.draft)[0]!;
  const review = makeSourceTransactionReview({ source:f.source, session:f.sources.id, store, start:18, end:18,
    mapping, actor:'derived-test-operator', decision:'confirmed' });
  f.sources.source_transaction_reviews = [review];
  f.draft.runner_evidence.source_transaction_requirement = sourceTransactionPreparedContext(f.sources, store, f.source.digest);
  const feedback = collectCoverageFeedback(f.arguments, f.source, f.draft, f.operator_messages, undefined, f.sources);
  const scope = createCoverageRepairScope(f.arguments, feedback, {source:f.source,draft:f.draft,messages:f.operator_messages});
  const target = scope.targets.find(t => t.receipt_region)!;
  const outcome = f.draft.actions[0].outcome;
  const paths = {
    compiled_effect: [receiptCouplingPaths(outcome)[0]!],
    receipt_configuration: ['/runner_evidence/runtime_contract/receipt_configuration'],
    receipt_read_exclusion: ['/runner_evidence/runtime_contract/receipt_read_exclusion'],
    source_transaction_coupling: receiptCouplingPaths(outcome),
  };
  const passage = (id: typeof ids[number], interpretation = 'Current bounded component presentation.') => ({start:18,end:18,
    disposition:'implemented' as const,responsibility:'runner' as const,issue_kind:'coverage_link' as const,
    receipt_component:id,interpretation,draft_paths:paths[id]});
  const validate = (id: typeof ids[number], p:unknown, target_id = target.target_id) => validateScopedReceiptComponents(
    {passages:[p]},[{index:0,category:id,target_id}],scope,f.source,f.draft,f.sources);
  return {...f,scope,target,outcome,paths,passage,validate};
}

describe('B64 I01968–71 closed receipt component identity preseal', () => {
  it.each(ids)('declares %s by closed ID rather than a host sentence enum', id => {
    const schema:any={properties:{groups:{items:{oneOf:[{properties:{passage_replacements:{items:{oneOf:[{properties:{fragments:{items:{oneOf:[{
      properties:{category:{const:id},passage:{properties:{interpretation:{type:'string',maxLength:800},receipt_component:{type:'string'},topic:{type:'string'},next_step:{type:'string'}}}}
    }]}}}}]}}}}]}}}};
    constrainReceiptComponentSchema(schema,capture.draft);
    const p=schema.properties.groups.items.oneOf[0].properties.passage_replacements.items.oneOf[0].properties.fragments.items.oneOf[0].properties.passage.properties;
    expect(p.receipt_component).toMatchObject({const:id});
    expect(p.interpretation.enum).toBeUndefined();
    expect(p.interpretation.maxLength).toBe(800);
  });
  it.each(ids)('accepts translated presentation for %s only with current exact component proof', id => {
    const f=fixture(),p=f.passage(id,'Aktueller begrenzter Prüfbestandteil.');
    const before=structuredClone({source:f.source,draft:f.draft,sources:f.sources});
    expect(()=>f.validate(id,p)).not.toThrow();
    expect({source:f.source,draft:f.draft,sources:f.sources}).toEqual(before);
  });
  it.each(ids)('refuses canonical English with no typed %s identity', id => {
    const f=fixture(),p:any=f.passage(id,receiptComponentMeanings(f.draft)[id]![0]);delete p.receipt_component;
    expect(()=>f.validate(id,p)).toThrow();
  });
  it.each(ids)('refuses %s mismatched ID/category or nonexistent target', id => {
    const f=fixture(),p=f.passage(id),other=ids.find(candidate=>candidate!==id)!;
    expect(()=>f.validate(id,{...p,receipt_component:other})).toThrow();
    expect(()=>f.validate(id,{...p,receipt_component:'receipt_observed'})).toThrow();
    expect(()=>f.validate(id,p,'not-a-current-target')).toThrow();
  });
  it('keeps a valid coupling proof independent from presentation and unobserved', () => {
    const f=fixture(),p=f.passage('source_transaction_coupling','Aktuelle atomare Kopplung.');
    expect(assessReceiptCouplingCapability(p as any,f.source,f.draft)).toMatchObject({origin:'HOST-RESOLVED',observed:false,outcome:f.outcome,effect_count:2});
    expect(repairableReceiptCouplingRepresentation(p as any,f.source,f.draft,f.sources)).toBe(false);
  });
  it.each(['mode','execution','effect','source','extra_claim'] as const)('does not turn the typed marker into %s proof', fault => {
    const f=fixture(),p:any=f.passage('source_transaction_coupling',receiptCouplingInterpretation(f.outcome));
    if(fault==='mode')f.draft.runner_evidence.runtime_contract.receipt_configuration.modes[0].authority='runner_ledger';
    if(fault==='execution')f.draft.runner_evidence.actions[f.outcome].execution.configured_mode='app_handler';
    if(fault==='effect')f.draft.runner_evidence.actions[f.outcome].effect.atomic_updates=[];
    if(fault==='source')f.source.digest=canonicalJsonDigest('changed source');
    if(fault==='extra_claim')p.application_obligations=['independent_source_readback'];
    expect(()=>f.validate('source_transaction_coupling',p)).toThrow();
  });
});
