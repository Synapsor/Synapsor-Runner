import assert from 'node:assert/strict';
import test from 'node:test';
import { scanSource, evaluate } from './scan.mjs';
const file = 'apps/runner/src/control.ts';
const scan = code => scanSource(file,code);
const allow = cs => ({version:1,entries:cs.map(c=>({fingerprint:c.fingerprint,file,annotation_id:'INDEPENDENT-FIXTURE',category:'exact_identifier_or_code',reason:'Fixture only exact pending protocol.',review:{reviewer:'independent-fixture',evidence:'controlled-before-source',verdict:'accepted'}}))});
const empty = {version:1,entries:[]};
test('plain identifier-key English dictionary requires review',()=>{
 const code='const answers = { yes: true, no: false }; export const consent = answer => answers[answer];';
 assert.ok(evaluate(scan(code),empty).errors.some(e=>e.kind==='unreviewed_candidate'),'plain yes/no decision escaped detector');
});
test('changed caller authority invalidates reviewed predicate usage',()=>{
 const before='export function isPending(v) { return v === "pending"; } export function present(v) { display(isPending(v)); }';
 const after=before.replace('display(isPending(v))','grant(isPending(v))');
 assert.ok(evaluate(scan(after),allow(scan(before))).errors.some(e=>e.kind==='unreviewed_candidate'),'authority caller changed without new review');
});
test('unresolved English keywords require review; exact grammar remains reviewable',()=>{
 const legacy='const unresolvedPattern=/(?:__REVIEW_[A-Z0-9_]+__|\\bTODO\\b|\\bTBD\\b|REVIEW_REQUIRED)/i; export function containsUnresolved(x) { return unresolvedPattern.test(x); }';
 assert.ok(evaluate(scan(legacy),empty).errors.length);
 const exact='const unresolvedPattern=/^__REVIEW_[A-Z0-9_]+__$/; export function containsUnresolved(x) { return unresolvedPattern.test(x); }';
 const grants=allow(scan(exact)); for(const e of grants.entries)e.category='formal_grammar';
 assert.equal(evaluate(scan(exact),grants).errors.length,0);
 assert.ok(evaluate(scan(legacy),grants).errors.length);
});
test('duplicate identical expression within one declaration requires new review',()=>{
 const before='export function show(v) { return v === "pending"; }';
 const after='export function show(v) { return (v === "pending") || (v === "pending"); }';
 assert.ok(evaluate(scan(after),allow(scan(before))).errors.length);
});
