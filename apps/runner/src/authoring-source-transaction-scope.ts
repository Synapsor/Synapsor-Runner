import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import { currentSourceTransactionReview, type SourceTransactionReview } from './authoring-source-transaction-review.js';

type Source = { digest: string; text: string; lines: number };
type Episode = { submissions?: Array<{ tentative?: { raw_response?: unknown } }> };
type Session = { id: string; source_transaction_reviews?: SourceTransactionReview[];
  source_transaction_scope_reviews?: SourceTransactionScopeReview[]; coverage_episodes?: Episode[] };
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const sha=(value:unknown):value is string=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/u.test(value);

/** An operator's answer about the applicability of an already registered source
 * requirement to one current outcome. It neither changes that requirement nor
 * establishes implementation, setup, execution or observation. */
export type SourceTransactionScopeReview = {
  origin:'OPERATOR-SOURCE-TRANSACTION-SCOPE-REVIEW'; id:string;
  source_session:string; source_digest:string; store_digest:string;
  requirement_digest:string; start:number; end:number; source_excerpt:string;
  action:{name:string;outcome:string;source:string}; action_binding_digest:string;
  decision:'applies'|'does_not_apply'|'deferred'; actor:string;
  actor_source:'local_interactive_operator'; reviewed_at:string; verified:false;
  previous:string|null; digest:string;
};
export type SourceTransactionScopeQuestion = {
  requirement:SourceTransactionReview;
  action:SourceTransactionScopeReview['action'];
  action_binding_digest:string; store_digest:string;
  current?:SourceTransactionScopeReview;
};
export class SourceTransactionScopeError extends Error {
  constructor(readonly reason:'unknown'|'excluded'|'capability') {
    super(reason==='unknown'
      ? 'SOURCE_TRANSACTION_SCOPE_UNESTABLISHED: The current source interpretation does not decide whether this requirement applies to the referenced outcome.'
      : reason==='excluded'
        ? 'SOURCE_TRANSACTION_ASSOCIATION_INVALID: The current attributed scope decision excludes this source requirement for the referenced outcome.'
        : 'SOURCE_TRANSACTION_SCOPE_CAPABILITY_MISMATCH: The current outcome does not implement the complete source requirement and receipt group.');
  }
}

function actionBinding(draft:unknown,action:SourceTransactionScopeReview['action']):string|undefined {
  const value=object(draft), read=object(value.read), evidence=object(value.runner_evidence),
    runtime=object(evidence.runtime_contract);
  const matches=Array.isArray(value.actions)?value.actions.filter((entry:any)=>entry?.name===action.name&&entry?.outcome===action.outcome):[];
  if(matches.length!==1||read.source!==action.source||!object(evidence.actions)[action.outcome])return undefined;
  const raw=matches[0],compiled=object(evidence.actions)[action.outcome],configuration=object(runtime.receipt_configuration);
  // Publication timestamps, draft-review labels and receipt-intent renewal do
  // not change the owner's answer about this exact effect/receipt shape.
  return canonicalJsonDigest({read,action:{name:raw.name,outcome:raw.outcome,effect:raw.effect,verification:raw.verification},
    compiled:{effect:compiled.effect,scoped_bindings:compiled.scoped_bindings,
      execution:{configured_mode:compiled.execution?.configured_mode,
        supported_automatic_completion:compiled.execution?.supported_automatic_completion}},
    receipt_configuration:{modes:configuration.modes,source_receipt_destinations:configuration.source_receipt_destinations},
    receipt_contract:runtime.receipts});
}
export function sourceTransactionScopeIdentity(value:Pick<SourceTransactionScopeReview,
  'source_session'|'source_digest'|'store_digest'|'requirement_digest'|'start'|'end'|'action'|'action_binding_digest'>):string {
  return canonicalJsonDigest({source_session:value.source_session,source_digest:value.source_digest,
    store_digest:value.store_digest,requirement_digest:value.requirement_digest,
    start:value.start,end:value.end,action:value.action,action_binding_digest:value.action_binding_digest});
}
export function validSourceTransactionScopeReview(value:SourceTransactionScopeReview):boolean {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const {digest,...body}=value;
  return value.origin==='OPERATOR-SOURCE-TRANSACTION-SCOPE-REVIEW'&&sha(value.id)
    && /^[a-f0-9-]{36}$/u.test(value.source_session)&&sha(value.source_digest)&&sha(value.store_digest)
    && sha(value.requirement_digest)&&sha(value.action_binding_digest)
    && Number.isSafeInteger(value.start)&&value.start>=1&&Number.isSafeInteger(value.end)&&value.end>=value.start
    && typeof value.source_excerpt==='string'&&value.source_excerpt.length>0&&value.source_excerpt.length<=16_000
    && typeof value.action?.name==='string'&&value.action.name.length>0&&value.action.name.length<=256
    && typeof value.action?.outcome==='string'&&value.action.outcome.length>0&&value.action.outcome.length<=256
    && typeof value.action?.source==='string'&&value.action.source.length>0&&value.action.source.length<=256
    && ['applies','does_not_apply','deferred'].includes(value.decision)
    && typeof value.actor==='string'&&value.actor.length>0&&value.actor.length<=128
    && value.actor_source==='local_interactive_operator'&&Number.isFinite(Date.parse(value.reviewed_at))
    && value.verified===false&&(value.previous===null||sha(value.previous))
    && value.id===sourceTransactionScopeIdentity(value)&&digest===canonicalJsonDigest(body);
}
export function assertSourceTransactionScopeReviews(value:unknown):asserts value is SourceTransactionScopeReview[] {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>64)throw new Error('SOURCE_TRANSACTION_SCOPE_REVIEW_INVALID: Scope decisions remain pending.');
  const latest=new Map<string,string>();
  for(const record of value){
    if(!validSourceTransactionScopeReview(record)||record.previous!==(latest.get(record.id)??null))
      throw new Error('SOURCE_TRANSACTION_SCOPE_REVIEW_INVALID: Saved scope-decision history is invalid.');
    latest.set(record.id,record.digest);
  }
}
export function makeSourceTransactionScopeReview(input:{source:Source;session:string;store:string;
  requirement:SourceTransactionReview;action:SourceTransactionScopeReview['action'];action_binding_digest:string;
  decision:SourceTransactionScopeReview['decision'];actor:string;previous?:SourceTransactionScopeReview}):SourceTransactionScopeReview {
  const {requirement}=input;
  const base={origin:'OPERATOR-SOURCE-TRANSACTION-SCOPE-REVIEW' as const,source_session:input.session,
    source_digest:input.source.digest,store_digest:input.store,requirement_digest:requirement.digest,
    start:requirement.start,end:requirement.end,source_excerpt:requirement.source_excerpt,
    action:input.action,action_binding_digest:input.action_binding_digest,decision:input.decision,
    actor:input.actor,actor_source:'local_interactive_operator' as const,reviewed_at:new Date().toISOString(),verified:false as const};
  const id=sourceTransactionScopeIdentity(base),body={...base,id,previous:input.previous?.digest??null};
  const record={...body,digest:canonicalJsonDigest(body)};
  if(!validSourceTransactionScopeReview(record))throw new Error('SOURCE_TRANSACTION_SCOPE_REVIEW_INVALID: No scope decision was saved.');
  return record;
}
export function currentSourceTransactionScopeReview(source:Source,draft:unknown,session:Session,
  requirement:SourceTransactionReview,action:SourceTransactionScopeReview['action']):SourceTransactionScopeReview|undefined {
  assertSourceTransactionScopeReviews(session.source_transaction_scope_reviews);
  const context=object(object(draft).runner_evidence).source_transaction_requirement;
  const store=object(context).store_digest,binding=actionBinding(draft,action);
  if(!sha(store)||!binding||requirement.source_digest!==source.digest||requirement.source_session!==session.id)return undefined;
  const id=sourceTransactionScopeIdentity({source_session:session.id,source_digest:source.digest,store_digest:store,
    requirement_digest:requirement.digest,start:requirement.start,end:requirement.end,action,action_binding_digest:binding});
  const latest=(session.source_transaction_scope_reviews??[]).filter(record=>record.id===id).at(-1);
  if(!latest||latest.source_excerpt!==source.text.split(/\r\n|\r|\n/u).slice(latest.start-1,latest.end).join('\n'))return undefined;
  return latest;
}
/** A prior invalid generation is only a *question hint*. The host validates its
 * range and complete current outcome references; it never accepts it as meaning.
 * Retaining the question through episode history prevents omission on a later
 * attempt from silently making the saved job ready. */
export function sourceTransactionScopeQuestions(source:Source,draft:unknown,session:Session):SourceTransactionScopeQuestion[] {
  const requirement=currentSourceTransactionReview(source,draft,session);
  if(!requirement)return [];
  const value=object(draft),read=object(value.read),actions=Array.isArray(value.actions)?value.actions:[],
    store=object(object(value.runner_evidence).source_transaction_requirement).store_digest;
  // The canonical structured authoring boundary permits at most 12 Actions.
  // Never truncate registered questions: an omitted tail could otherwise turn
  // an unanswered source meaning into apparent complete coverage.
  if(actions.length>12)throw new Error('SOURCE_TRANSACTION_SCOPE_INVENTORY_LIMIT: Review the supported Action inventory before accepting coverage.');
  if(!sha(store))return [];
  const candidates=new Map<string,SourceTransactionScopeQuestion>();
  const add=(outcome:string)=>{
    const matches=actions.filter((entry:any)=>entry?.outcome===outcome&&typeof entry?.name==='string');
    if(matches.length!==1||outcome===requirement.action.outcome)return;
    const action={name:matches[0].name as string,outcome,source:read.source as string};
    const binding=actionBinding(draft,action);
    if(!binding)return;
    const current=currentSourceTransactionScopeReview(source,draft,session,requirement,action);
    candidates.set(outcome,{requirement,action,action_binding_digest:binding,store_digest:store,current});
  };
  // Existing decisions remain discoverable after an invalid provider component
  // is omitted. Changed action bindings produce a new unresolved question.
  for(const record of session.source_transaction_scope_reviews??[])
    if(record.requirement_digest===requirement.digest&&record.source_digest===source.digest)add(record.action.outcome);
  for(const episode of (session.coverage_episodes??[]).slice(-120))for(const submission of (episode.submissions??[]).slice(0,3)){
    const raw=object(submission.tentative?.raw_response),passages=raw.passages;
    if(!Array.isArray(passages)||passages.length>120)continue;
    for(const passage of passages){
      if(passage?.receipt_component!=='source_transaction_coupling'
        ||passage.start!==requirement.start||passage.end!==requirement.end||!Array.isArray(passage.draft_paths))continue;
      for(const action of actions){
        if(typeof action?.outcome!=='string'||action.outcome===requirement.action.outcome)continue;
        const expected=[`/runner_evidence/actions/${action.outcome}/effect`,
          `/runner_evidence/actions/${action.outcome}/execution`, '/runner_evidence/runtime_contract/receipts'];
        if(passage.draft_paths.length===expected.length&&expected.every(path=>passage.draft_paths.includes(path)))add(action.outcome);
      }
    }
  }
  return [...candidates.values()];
}
