import { canonicalJsonDigest } from '@synapsor-runner/protocol';

/** Attributed source meaning in the existing source-session history, not a
 * compiler verdict, grant, or assertion that arbitrary English was proved. */
export type SourceInputRequirement = {outcomes:string[];input:string;start?:number;end?:number;min_length:number;max_length:number};
export type SourceInputPolicyReview = {
  origin:'OPERATOR-SOURCE-INPUT-REVIEW';source_session:string;source_digest:string;store_digest:string;
  outcomes:string[];agenda_digest:string;requirements:SourceInputRequirement[];decision:'confirmed'|'deferred';
  actor:string;reviewed_at:string;verified:false;previous:string|null;digest:string;
  /** Actual assisted adoption, not model confidence or fabricated testimony.
   * The current consumer cross-checks these immutable references on reuse. */
  question_reference?: {id:string;revision:number;digest:string;proposal_digest:string;
    root_id:string;root_digest:string;basis:'policy_source'|'operator_answer';answer_id?:string};
};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/u.test(v);
const outcome=(v:unknown):v is string=>typeof v==='string'&&v.length<=256&&/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(v);
/** Pure shape/domain validation, never an adoption or fabricated review. Only
 * the owning consumer can establish the actual current answer provenance. */
export function assertSourceInputRequirements(value:unknown,outcomes:string[],basis:'policy_source'|'operator_answer',lines?:number):asserts value is SourceInputRequirement[] {
  if(!Array.isArray(value)||value.length>256)throw new Error('SOURCE_INPUT_REVIEW_INVALID: Preserve the input requirement scope.');
  const keys=new Set<string>();
  for(const q of value){
    const spanRequired=basis==='policy_source'||q?.start!==undefined||q?.end!==undefined;
    if(!q||Object.keys(q).some(k=>!['outcomes','input','start','end','min_length','max_length'].includes(k))
      ||!Array.isArray(q.outcomes)||!q.outcomes.length||new Set(q.outcomes).size!==q.outcomes.length||q.outcomes.some((o:unknown)=>!outcomes.includes(o as string))
      ||typeof q.input!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(q.input)||['__proto__','constructor','prototype'].includes(q.input)
      ||spanRequired&&(!Number.isSafeInteger(q.start)||q.start<1||!Number.isSafeInteger(q.end)||q.end<q.start||lines!==undefined&&q.end>lines)
      ||!Number.isSafeInteger(q.min_length)||q.min_length<0||!Number.isSafeInteger(q.max_length)||q.max_length<1||q.max_length>4096||q.min_length>q.max_length)
      throw new Error('SOURCE_INPUT_REVIEW_INVALID: Use exact current input, source range and UTF-16 bounds.');
    for(const o of q.outcomes){const k=`${o}\0${q.input}`;if(keys.has(k))throw new Error('SOURCE_INPUT_REVIEW_INVALID: Conflicting or duplicate input requirement.');keys.add(k);}
  }
}
export function assertSourceInputReviews(value:unknown):asserts value is SourceInputPolicyReview[] {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>128)throw new Error('SOURCE_INPUT_REVIEW_INVALID: Preserve the source requirement history.');
  let previous:string|null=null;
  const questionIds=new Set<string>();
  for(const r of value){
    const {digest,...body}=r??{};
    if(Object.keys(r??{}).some(k=>!['origin','source_session','source_digest','store_digest','outcomes','agenda_digest','requirements','decision','actor','reviewed_at','verified','previous','digest','question_reference'].includes(k))||r?.origin!=='OPERATOR-SOURCE-INPUT-REVIEW'||!sha(r.source_digest)||!sha(r.store_digest)
      ||typeof r.source_session!=='string'||!/^[-a-f0-9]{36}$/u.test(r.source_session)
      ||!Array.isArray(r.outcomes)||!r.outcomes.length||r.outcomes.length>128||!r.outcomes.every(outcome)||new Set(r.outcomes).size!==r.outcomes.length
      ||r.agenda_digest!==canonicalJsonDigest({source_session:r.source_session,source_digest:r.source_digest,store_digest:r.store_digest,outcomes:r.outcomes})
      ||!Array.isArray(r.requirements)||r.requirements.length>256||!['confirmed','deferred'].includes(r.decision)
      ||typeof r.actor!=='string'||!r.actor.trim()||r.actor.length>128||!Number.isFinite(Date.parse(r.reviewed_at))||r.verified!==false
      ||r.previous!==previous||digest!==canonicalJsonDigest(body))throw new Error('SOURCE_INPUT_REVIEW_INVALID: Current attributed source interpretation is unavailable.');
    if(r.question_reference!==undefined){
      const q=r.question_reference,uuid=(v:unknown)=>typeof v==='string'&&/^[-a-f0-9]{36}$/u.test(v);
      if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['id','revision','digest','proposal_digest','root_id','root_digest','basis','answer_id'].includes(k))
        ||!uuid(q.id)||!uuid(q.root_id)||!Number.isSafeInteger(q.revision)||q.revision<1
        ||!sha(q.digest)||!sha(q.proposal_digest)||!sha(q.root_digest)||r.decision!=='confirmed'||questionIds.has(q.id)
        ||q.basis==='policy_source'&&(q.answer_id!==undefined||q.id!==q.root_id)
        ||q.basis==='operator_answer'&&(!uuid(q.answer_id)||q.id===q.root_id)
        ||!['policy_source','operator_answer'].includes(q.basis))
        throw new Error('SOURCE_INPUT_REVIEW_INVALID: The assisted interpretation has no unique attributable adoption.');
      questionIds.add(q.id);
    }
    assertSourceInputRequirements(r.requirements,r.outcomes,r.question_reference?.basis==='operator_answer'?'operator_answer':'policy_source');
    previous=digest;
  }
}

export type InputFidelityFinding={code:'SOURCE_INPUT_REQUIREMENT_PENDING'|'SOURCE_INPUT_CONSTRAINT_WEAKER';path:string;outcome:string;input:string;
  required?:{min_length:number;max_length:number};established?:{min_length:number;max_length:number;enforcement:string};requirement_digest?:string;source_digest:string;repair:string};
