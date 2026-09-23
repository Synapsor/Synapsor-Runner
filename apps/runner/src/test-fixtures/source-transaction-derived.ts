import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { receiptCouplingInterpretation, receiptCouplingPaths } from '../authoring-obligation-review.js';
import { makeSourceTransactionReview, sourceTransactionMappings, sourceTransactionPreparedContext } from '../authoring-source-transaction-review.js';

/** Explicitly DERIVED operator interpretation for captured source-policy tests.
 * The saved historical captures are never rewritten or called an owner answer. */
export function withDerivedSourceTransactionReview<T extends {source:any;draft:any;sources:any;arguments:any}>(capture:T,
  options:{couplingPassage?:boolean}={}):T {
  const f=structuredClone(capture),store=canonicalJsonDigest('DERIVED test project binding');
  const mapping=sourceTransactionMappings(f.draft)[0];
  if (!mapping) throw new Error('DERIVED_SOURCE_TRANSACTION_MAPPING_UNAVAILABLE');
  const line=f.source.text.split(/\r\n|\r|\n/u).findIndex((text:string)=>text.includes('same PostgreSQL source transaction'))+1;
  if (line<1) throw new Error('DERIVED_SOURCE_TRANSACTION_LINE_UNAVAILABLE');
  const record=makeSourceTransactionReview({source:f.source,session:f.sources.id,store,start:line,end:line,
    mapping,actor:'derived-test-operator',decision:'confirmed'});
  f.sources.source_transaction_reviews=[record];
  f.draft.runner_evidence.source_transaction_requirement=sourceTransactionPreparedContext(f.sources,store,f.source.digest);
  if (options.couplingPassage) f.arguments.passages.push({start:line,end:line,disposition:'implemented',
    responsibility:'runner',issue_kind:'coverage_link',receipt_component:'source_transaction_coupling',
    interpretation:receiptCouplingInterpretation(mapping.action.outcome),draft_paths:receiptCouplingPaths(mapping.action.outcome)});
  return f;
}
