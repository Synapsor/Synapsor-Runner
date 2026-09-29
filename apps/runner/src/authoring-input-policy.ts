import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleBooleanExpressionV1, ActionRuleInputSpecV1 } from '@synapsor/spec';
import type { PolicySourceSession, PolicyTextSnapshot } from './authoring-policy-source.js';

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
    if(r?.origin!=='OPERATOR-SOURCE-INPUT-REVIEW'||!sha(r.source_digest)||!sha(r.store_digest)
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
export function makeSourceInputReview(input:{source:PolicyTextSnapshot;session:PolicySourceSession;store:string;outcomes:string[];requirements:SourceInputRequirement[];actor:string;decision?:'confirmed'|'deferred'}):SourceInputPolicyReview {
  const body={origin:'OPERATOR-SOURCE-INPUT-REVIEW' as const,source_session:input.session.id,source_digest:input.source.digest,
    store_digest:input.store,outcomes:[...input.outcomes],agenda_digest:canonicalJsonDigest({source_session:input.session.id,source_digest:input.source.digest,store_digest:input.store,outcomes:input.outcomes}),requirements:structuredClone(input.requirements),decision:input.decision??'confirmed',
    actor:input.actor,reviewed_at:new Date().toISOString(),verified:false as const,previous:input.session.input_policy_reviews?.at(-1)?.digest??null};
  if(body.requirements.some(q=>q.end>input.source.lines))throw new Error('SOURCE_INPUT_REVIEW_INVALID: The source range is not current.');
  const result={...body,digest:canonicalJsonDigest(body)};assertSourceInputReviews([...(input.session.input_policy_reviews??[]),result]);return result;
}
export type InputFidelityFinding={code:'SOURCE_INPUT_REQUIREMENT_PENDING'|'SOURCE_INPUT_CONSTRAINT_WEAKER';path:string;outcome:string;input:string;
  required?:{min_length:number;max_length:number};established?:{min_length:number;max_length:number;enforcement:string};requirement_digest?:string;source_digest:string;repair:string};
export class SourceInputFidelityError extends Error {
  readonly code='SOURCE_INPUT_CONSTRAINT_WEAKER';readonly path='draft.inputs';
  constructor(readonly findings:InputFidelityFinding[]){super(`${findings[0]?.code??'SOURCE_INPUT_REQUIREMENT_PENDING'}: ${JSON.stringify(findings)}`);}
}
/** Deliberately finite implication: conjunctive != empty and exact nonempty
 * equality/in-list. An OR only proves what every branch proves. No arbitrary
 * predicate solver, field-name inference or policy-text parsing. */
function excludesEmpty(e:ActionRuleBooleanExpressionV1,input:string):boolean {
  if(e.kind==='all')return e.expressions.some(x=>excludesEmpty(x,input));
  if(e.kind==='any')return e.expressions.length>0&&e.expressions.every(x=>excludesEmpty(x,input));
  if(e.kind==='compare'){
    const pair=e.left.kind==='input'&&e.left.name===input?[e.left,e.right]:e.right.kind==='input'&&e.right.name===input?[e.right,e.left]:undefined;
    return !!pair&&pair[1]!.kind==='literal'&&typeof pair[1]!.value==='string'
      &&(e.operator==='neq'&&pair[1]!.value===''||e.operator==='eq'&&pair[1]!.value!=='');
  }
  return false;
}
export function establishedInputInterval(def:ActionRuleInputSpecV1,require:ActionRuleBooleanExpressionV1){
  if(def.type.kind!=='string')return undefined;
  let min=def.type.min_length??0,max=def.type.max_length,enforcement='typed_bounds';
  if(def.type.enum?.length){min=Math.max(min,Math.min(...def.type.enum.map(s=>s.length)));max=Math.min(max,Math.max(...def.type.enum.map(s=>s.length)));enforcement='typed_bounds_and_enum';}
  if(min<1&&excludesEmpty(require,def.name)){min=1;enforcement+=' and conjunctive_nonempty_predicate';}
  return {min_length:min,max_length:max,enforcement};
}
export function sourceInputFidelity(source:PolicyTextSnapshot,session:Pick<PolicySourceSession,'id'|'input_policy_reviews'>,store:string,
  actions:Array<{outcome:string;inputs?:ActionRuleInputSpecV1[];require:ActionRuleBooleanExpressionV1}>):{findings:InputFidelityFinding[];digest:string;review_digests:string[]} {
  const records=session.input_policy_reviews??[];assertSourceInputReviews(records);const findings:InputFidelityFinding[]=[];
  const relevant=records.filter(r=>r.outcomes.some(o=>actions.some(a=>a.outcome===o)));
  for(const action of actions){
    const old=relevant.filter(r=>r.outcomes.includes(action.outcome));if(!old.length)continue;
    const record=old.at(-1)!;
    if(record.source_session!==session.id||record.source_digest!==source.digest||record.store_digest!==store||record.decision!=='confirmed'||record.requirements.some(q=>q.end>source.lines)){
      findings.push({code:'SOURCE_INPUT_REQUIREMENT_PENDING',path:'draft.inputs',outcome:action.outcome,input:'',source_digest:source.digest,repair:'Review the exact current source/input interpretation locally; prior meaning is history, not a model-correctable fact.'});continue;
    }
    for(const q of record.requirements.filter(q=>q.outcomes.includes(action.outcome))){
      const def=action.inputs?.find(i=>i.name===q.input),actual=def&&establishedInputInterval(def,action.require);
      if(!actual||actual.min_length<q.min_length||actual.max_length>q.max_length)findings.push({code:'SOURCE_INPUT_CONSTRAINT_WEAKER',path:`draft.inputs.${q.input}`,outcome:action.outcome,input:q.input,source_digest:source.digest,requirement_digest:record.digest,
        required:{min_length:q.min_length,max_length:q.max_length},...(actual?{established:actual}:{}),repair:'Replace only the nominated input constraint/necessary predicate in this draft under existing component correction; preserve other policy/effects. Required presence is separate. Use exact min_length/max_length in UTF-16 units or a provable equivalent; no trim, inferred defaults or policy weakening.'});
    }
  }
  return {findings,review_digests:relevant.map(r=>r.digest),digest:canonicalJsonDigest({source:source.digest,session:session.id,store,actions,reviews:relevant.map(r=>r.digest),findings})};
}

/** Host-retained component parent: only nominated input bounds and an additive
 * conjunction may change. Source meaning never authorizes replacing other rules. */
export function assertInputFidelityRepair(parent:any,next:any,findings:InputFidelityFinding[]):void {
 const names=new Set(findings.map(f=>f.input));
 const strip=(draft:any)=>{const d=structuredClone(draft);
   d.inputs=(d.inputs??[]).filter((i:any)=>!names.has(i.name));delete d.require;return d;};
 if(canonicalJsonDigest(strip(parent))!==canonicalJsonDigest(strip(next)))throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Preserve the nominated component parent and every unrelated field.');
 const terms=(e:ActionRuleBooleanExpressionV1):ActionRuleBooleanExpressionV1[]=>e.kind==='all'?e.expressions.flatMap(terms):[e];
 const old=terms(parent.require), remaining=[...terms(next.require)];
 for(const term of old){const i=remaining.findIndex(t=>canonicalJsonDigest(t)===canonicalJsonDigest(term));if(i<0)throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Preserve every existing predicate.');remaining.splice(i,1);}
 if(remaining.some(e=>e.kind!=='compare'||![...names].some(name=>excludesEmpty(e,name))))throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Only the nominated additive input predicate may change.');
}
