import { canonicalJsonDigest } from '@synapsor-runner/protocol';

/** Attributed source meaning in the existing source-session history, not a
 * compiler verdict, grant, or assertion that arbitrary English was proved. */
export type SourceInputRequirement = {outcomes:string[];input:string;start:number;end:number;min_length:number;max_length:number};
export type SourceInputPolicyReview = {
  origin:'OPERATOR-SOURCE-INPUT-REVIEW';source_session:string;source_digest:string;store_digest:string;
  outcomes:string[];agenda_digest:string;requirements:SourceInputRequirement[];decision:'confirmed'|'deferred';
  actor:string;reviewed_at:string;verified:false;previous:string|null;digest:string;
};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^sha256:[a-f0-9]{64}$/u.test(v);
const outcome=(v:unknown):v is string=>typeof v==='string'&&v.length<=256&&/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(v);
export function assertSourceInputReviews(value:unknown):asserts value is SourceInputPolicyReview[] {
  if(value===undefined)return;
  if(!Array.isArray(value)||value.length>128)throw new Error('SOURCE_INPUT_REVIEW_INVALID: Preserve the source requirement history.');
  let previous:string|null=null;
  for(const r of value){
    const {digest,...body}=r??{};
    if(Object.keys(r??{}).some(k=>!['origin','source_session','source_digest','store_digest','outcomes','agenda_digest','requirements','decision','actor','reviewed_at','verified','previous','digest'].includes(k))||r?.origin!=='OPERATOR-SOURCE-INPUT-REVIEW'||!sha(r.source_digest)||!sha(r.store_digest)
      ||typeof r.source_session!=='string'||!/^[-a-f0-9]{36}$/u.test(r.source_session)
      ||!Array.isArray(r.outcomes)||!r.outcomes.length||r.outcomes.length>128||!r.outcomes.every(outcome)||new Set(r.outcomes).size!==r.outcomes.length
      ||r.agenda_digest!==canonicalJsonDigest({source_session:r.source_session,source_digest:r.source_digest,store_digest:r.store_digest,outcomes:r.outcomes})
      ||!Array.isArray(r.requirements)||r.requirements.length>256||!['confirmed','deferred'].includes(r.decision)
      ||typeof r.actor!=='string'||!r.actor.trim()||r.actor.length>128||!Number.isFinite(Date.parse(r.reviewed_at))||r.verified!==false
      ||r.previous!==previous||digest!==canonicalJsonDigest(body))throw new Error('SOURCE_INPUT_REVIEW_INVALID: Current attributed source interpretation is unavailable.');
    const keys=new Set<string>();
    for(const q of r.requirements){
      if(!q||Object.keys(q).some(k=>!['outcomes','input','start','end','min_length','max_length'].includes(k))
        ||!Array.isArray(q.outcomes)||!q.outcomes.length||new Set(q.outcomes).size!==q.outcomes.length||q.outcomes.some((o:unknown)=>!r.outcomes.includes(o))
        ||typeof q.input!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(q.input)||['__proto__','constructor','prototype'].includes(q.input)
        ||!Number.isSafeInteger(q.start)||q.start<1||!Number.isSafeInteger(q.end)||q.end<q.start
        ||!Number.isSafeInteger(q.min_length)||q.min_length<0||!Number.isSafeInteger(q.max_length)||q.max_length<1||q.max_length>4096||q.min_length>q.max_length)
        throw new Error('SOURCE_INPUT_REVIEW_INVALID: Use exact current input, source range and UTF-16 bounds.');
      for(const o of q.outcomes){const k=`${o}\0${q.input}`;if(keys.has(k))throw new Error('SOURCE_INPUT_REVIEW_INVALID: Conflicting or duplicate input requirement.');keys.add(k);}
    }
    previous=digest;
  }
}

export type InputFidelityFinding={code:'SOURCE_INPUT_REQUIREMENT_PENDING'|'SOURCE_INPUT_CONSTRAINT_WEAKER';path:string;outcome:string;input:string;
  required?:{min_length:number;max_length:number};established?:{min_length:number;max_length:number;enforcement:string};requirement_digest?:string;source_digest:string;repair:string};
