import { canonicalJsonDigest } from '@synapsor-runner/protocol';
import type { ActionRuleBooleanExpressionV1, ActionRuleInputSpecV1 } from '@synapsor/spec';
import type { PolicySourceSession, PolicyTextSnapshot } from './authoring-policy-source.js';

import { assertSourceInputReviews, type SourceInputRequirement, type SourceInputPolicyReview, type InputFidelityFinding } from './authoring-input-policy-records.js';
export { assertSourceInputReviews, type SourceInputRequirement, type SourceInputPolicyReview, type InputFidelityFinding } from './authoring-input-policy-records.js';

export function makeSourceInputReview(input:{source:PolicyTextSnapshot;session:PolicySourceSession;store:string;outcomes:string[];requirements:SourceInputRequirement[];actor:string;decision?:'confirmed'|'deferred'}):SourceInputPolicyReview {
  const body={origin:'OPERATOR-SOURCE-INPUT-REVIEW' as const,source_session:input.session.id,source_digest:input.source.digest,
    store_digest:input.store,outcomes:[...input.outcomes],agenda_digest:canonicalJsonDigest({source_session:input.session.id,source_digest:input.source.digest,store_digest:input.store,outcomes:input.outcomes}),requirements:structuredClone(input.requirements),decision:input.decision??'confirmed',
    actor:input.actor,reviewed_at:new Date().toISOString(),verified:false as const,previous:input.session.input_policy_reviews?.at(-1)?.digest??null};
  if(body.requirements.some(q=>q.end>input.source.lines))throw new Error('SOURCE_INPUT_REVIEW_INVALID: The source range is not current.');
  const result={...body,digest:canonicalJsonDigest(body)};assertSourceInputReviews([...(input.session.input_policy_reviews??[]),result]);return result;
}
export class SourceInputFidelityError extends Error {
  readonly code='SOURCE_INPUT_CONSTRAINT_WEAKER';readonly path='draft.inputs';
  constructor(readonly findings:InputFidelityFinding[]){super(`${findings[0]?.code??'SOURCE_INPUT_REQUIREMENT_PENDING'}: ${JSON.stringify(findings)}`);}
}
/** Finite length implication only, applied after real compilation. Unknown
 * expressions supply no evidence; this is not arbitrary predicate equivalence. */
function predicateInterval(e:ActionRuleBooleanExpressionV1,input:string):{min:number;max:number;proved:boolean} {
 const unknown={min:0,max:Infinity,proved:false};
 if(e.kind==='all'||e.kind==='any'){
  if(!e.expressions.length)return unknown;
  const p=e.expressions.map(x=>predicateInterval(x,input));
  return e.kind==='all'?{min:Math.max(...p.map(x=>x.min)),max:Math.min(...p.map(x=>x.max)),proved:p.some(x=>x.proved)}
    :{min:Math.min(...p.map(x=>x.min)),max:Math.max(...p.map(x=>x.max)),proved:p.every(x=>x.proved)};
 }
 if(e.kind==='compare'){
  const literal=e.left.kind==='input'&&e.left.name===input?e.right:e.right.kind==='input'&&e.right.name===input?e.left:undefined;
  if(literal?.kind==='literal'&&typeof literal.value==='string'){
   if(e.operator==='eq')return {min:literal.value.length,max:literal.value.length,proved:true};
   if(e.operator==='neq'&&literal.value==='')return {min:1,max:Infinity,proved:true};
  }
 }
 if(e.kind==='not'&&e.expression.kind==='compare'&&e.expression.operator==='eq')return predicateInterval({...e.expression,operator:'neq'},input);
 if(e.kind==='in'&&e.value.kind==='input'&&e.value.name===input&&e.values.length&&e.values.every(v=>v.kind==='literal'&&typeof v.value==='string')){
  const lengths=e.values.map(v=>(v as {value:string}).value.length);return {min:Math.min(...lengths),max:Math.max(...lengths),proved:true};
 }
 return unknown;
}
function excludesEmpty(e:ActionRuleBooleanExpressionV1,input:string):boolean {
 if(e.kind!=='compare'||e.operator!=='neq')return false;
 const literal=e.left.kind==='input'&&e.left.name===input?e.right:e.right.kind==='input'&&e.right.name===input?e.left:undefined;
 return literal?.kind==='literal'&&literal.value==='';
}
export function establishedInputInterval(def:ActionRuleInputSpecV1,require:ActionRuleBooleanExpressionV1){
 if(def.type.kind!=='string')return undefined;
 let min=def.type.min_length??0,max=def.type.max_length,enforcement='typed_bounds';
 if(def.type.enum?.length){min=Math.max(min,Math.min(...def.type.enum.map(s=>s.length)));max=Math.min(max,Math.max(...def.type.enum.map(s=>s.length)));enforcement='typed_bounds_and_enum';}
 const predicate=predicateInterval(require,def.name);
 if(predicate.proved){min=Math.max(min,predicate.min);max=Math.min(max,predicate.max);enforcement+=' and finite_input_predicate';}
 return {min_length:min,max_length:max,enforcement};
}
export function sourceInputFidelity(source:PolicyTextSnapshot,session:Pick<PolicySourceSession,'id'|'input_policy_reviews'>,store:string,
  actions:Array<{outcome:string;inputs?:ActionRuleInputSpecV1[];require:ActionRuleBooleanExpressionV1}>):{findings:InputFidelityFinding[];digest:string;review_digests:string[]} {
  const records=session.input_policy_reviews??[];assertSourceInputReviews(records);const findings:InputFidelityFinding[]=[];
  const relevant=records.filter(r=>r.outcomes.some(o=>actions.some(a=>a.outcome===o)));
  const assessed=new Set<string>();
  for(const action of actions){
    const old=relevant.filter(r=>r.outcomes.includes(action.outcome));
    if(!old.length){
      if(records.length)findings.push({code:'SOURCE_INPUT_REQUIREMENT_PENDING',path:'draft.inputs',outcome:action.outcome,input:'',source_digest:source.digest,repair:'Review the exact current Action input requirements locally; another Action’s interpretation cannot establish this scope.'});
      continue;
    }
    const record=old.at(-1)!;assessed.add(record.digest);
    if(record.source_session!==session.id||record.source_digest!==source.digest||record.store_digest!==store||record.decision!=='confirmed'||record.requirements.some(q=>q.end>source.lines)){
      findings.push({code:'SOURCE_INPUT_REQUIREMENT_PENDING',path:'draft.inputs',outcome:action.outcome,input:'',source_digest:source.digest,repair:'Review the exact current source/input interpretation locally; prior meaning is history, not a model-correctable fact.'});continue;
    }
    for(const q of record.requirements.filter(q=>q.outcomes.includes(action.outcome))){
      const def=action.inputs?.find(i=>i.name===q.input),actual=def&&establishedInputInterval(def,action.require);
      if(!actual||actual.min_length>actual.max_length||actual.min_length<q.min_length||actual.max_length>q.max_length)findings.push({code:'SOURCE_INPUT_CONSTRAINT_WEAKER',path:`draft.inputs.${q.input}`,outcome:action.outcome,input:q.input,source_digest:source.digest,requirement_digest:record.digest,
        required:{min_length:q.min_length,max_length:q.max_length},...(actual?{established:actual}:{}),repair:'Replace only the nominated input constraint/necessary predicate in this draft under existing component correction; preserve other policy/effects. Required presence is separate. Use exact min_length/max_length in UTF-16 units or a provable equivalent; no trim, inferred defaults or policy weakening.'});
    }
  }
  return {findings,review_digests:[...assessed],digest:canonicalJsonDigest({source:source.digest,session:session.id,store,actions,reviews:relevant.map(r=>r.digest),findings})};
}

/** Host-retained component parent: only nominated input bounds and an additive
 * conjunction may change. Source meaning never authorizes replacing other rules. */
export function assertInputFidelityRepair(parent:any,next:any,findings:InputFidelityFinding[]):void {
 const names=new Set(findings.map(f=>f.input));
 for(const name of names){
  const before=parent.inputs?.find((i:any)=>i.name===name),after=next.inputs?.find((i:any)=>i.name===name);
  if(!before||!after)continue; // A missing definition still must pass compilation and the exact requirement assessor.
  const surrounding=(definition:any)=>{const d=structuredClone(definition);delete d.type;delete d.minimum;delete d.maximum;return d;};
  if(canonicalJsonDigest(surrounding(before))!==canonicalJsonDigest(surrounding(after)))throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Preserve the input identity and description.');
  if(before.type.kind==='string'){
   const withoutBounds=(type:any)=>{const t=structuredClone(type);delete t.min_length;delete t.max_length;return t;};
   if(canonicalJsonDigest(withoutBounds(before.type))!==canonicalJsonDigest(withoutBounds(after.type)))throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Correct length bounds without inventing an enum or changing comparison semantics.');
  }
 }
 const strip=(draft:any)=>{const d=structuredClone(draft);
   d.inputs=(d.inputs??[]).filter((i:any)=>!names.has(i.name));delete d.require;return d;};
 if(canonicalJsonDigest(strip(parent))!==canonicalJsonDigest(strip(next)))throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Preserve the nominated component parent and every unrelated field.');
 const terms=(e:ActionRuleBooleanExpressionV1):ActionRuleBooleanExpressionV1[]=>e.kind==='all'?e.expressions.flatMap(terms):[e];
 const old=terms(parent.require), remaining=[...terms(next.require)];
 for(const term of old){const i=remaining.findIndex(t=>canonicalJsonDigest(t)===canonicalJsonDigest(term));if(i<0)throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Preserve every existing predicate.');remaining.splice(i,1);}
 if(remaining.some(e=>e.kind!=='compare'||![...names].some(name=>excludesEmpty(e,name))))throw new Error('SOURCE_INPUT_CORRECTION_OUTSIDE_SCOPE: Only the nominated additive input predicate may change.');
}
