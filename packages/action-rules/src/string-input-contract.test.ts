import {describe,it,expect} from 'vitest';
import {actionRuleStringMatches} from '@synapsor/spec';
import {validateActionRuleInputs} from './inputs.js';
import {compileActionRule} from './compile.js';
import {evaluateActionRule} from './evaluate.js';
import {atomicSource} from './testing/atomic-fixture.js';
import {actionRuleDigest} from './normalize.js';
const text=(min?:number)=>({kind:'string' as const,comparison:'exact' as const,max_length:64,...(min===undefined?{}:{min_length:min})});
const rule=(type:any=text(1))=>({inputs:[{name:'operator_note',description:'Caller note',type}]});
describe('explicit Action text bounds retain UTF-16 and presence semantics',()=>{
 it.each([{}, {operator_note:null}, {operator_note:''},{operator_note:'x'.repeat(65)}])('refuses invalid input %j',value=>expect(()=>validateActionRuleInputs(rule(),value)).toThrow());
 it.each(['x','x'.repeat(64),' ','\t','😀'.repeat(32)])('preserves exact accepted text',value=>expect(validateActionRuleInputs(rule(),{operator_note:value})).toEqual({operator_note:value}));
 it('retains legacy zero minimum and explicit zero; optional/defaults are unsupported',()=>{
  expect(validateActionRuleInputs(rule(text()),{operator_note:''})).toEqual({operator_note:''});
  expect(validateActionRuleInputs(rule(text(0)),{operator_note:''})).toEqual({operator_note:''});
  for(const option of [{required:false},{default:'x'}])expect(()=>validateActionRuleInputs({inputs:[{...rule().inputs[0]!,...option}]},{})).toThrow();
 });
 it.each([-1,1.5,65,Infinity,NaN,null])('refuses malformed minimum %s',min=>expect(()=>validateActionRuleInputs(rule({...text(),min_length:min}),{operator_note:'x'})).toThrow());
 it('uses code units, not bytes/code points/trimmed text',()=>{
  expect(actionRuleStringMatches('😀',{min_length:2,max_length:2})).toBe(true);
  expect(actionRuleStringMatches('😀',{min_length:1,max_length:1})).toBe(false);
  expect(actionRuleStringMatches('é',{min_length:1,max_length:1})).toBe(true);
  expect(actionRuleStringMatches('e\u0301',{min_length:2,max_length:2})).toBe(true);
  expect(actionRuleStringMatches(' ',{min_length:1,max_length:1})).toBe(true);
 });
 it('composes enum and minimum without dropping either',()=>{
  expect(()=>validateActionRuleInputs(rule({...text(1),enum:['','x']}),{operator_note:'x'})).toThrow();
  expect(()=>validateActionRuleInputs(rule({...text(1),enum:['x']}),{operator_note:'y'})).toThrow();
  expect(validateActionRuleInputs(rule({...text(0),enum:['','x']}),{operator_note:''})).toEqual({operator_note:''});
 });
 it('compiles, persists explicit bounds and retains legacy digest without injecting defaults',()=>{
  const f=atomicSource('postgres'); f.rule.inputs=rule(text()).inputs;
  const original=structuredClone(f.rule), old=actionRuleDigest(original);
  const compile=()=>compileActionRule({rule:f.rule,catalog:f.catalog,verification_boundary:f.verification,effect_envelope:f.envelope});
  expect(compile().rule_digest).toBe(old);expect(compile().rule.inputs![0]!.type).not.toHaveProperty('min_length');
  f.rule.inputs=rule().inputs;const compiled=compile();expect(compiled.rule_digest).not.toBe(old);
  expect(compiled.rule.inputs![0]!.type).toEqual(text(1));
  const result=evaluateActionRule({compiled,inputs:{operator_note:''},facts:{bindings:{},trusted:{tenant:'t',principal:'p',transaction_time:'2026-09-29T00:00:00.000Z'},subject_provenance_digest:'sha256:'+ 'a'.repeat(64) as `sha256:${string}`},proposal_id:'never-proposed'});
  expect(result).toMatchObject({result:'unknown',safe_code:'ACTION_RULE_INVALID'});expect(result).not.toHaveProperty('effect');
 });
});
