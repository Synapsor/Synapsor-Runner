import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, scanSource, scanSources } from './scan.mjs';
const file = 'apps/runner/src/owner.ts';
const scan = text => scanSource(file, text);
const allow = candidates => ({ version: 1, entries: candidates.map(candidate => ({
  fingerprint: candidate.fingerprint, file, annotation_id: 'INDEPENDENT-FIXTURE',
  category: 'exact_identifier_or_code', reason: 'Fixture exact typed status token.',
  review: { reviewer: 'independent-test-fixture', evidence: 'fixture-only', verdict: 'accepted' },
})) });
const empty = { version: 1, entries: [] };
for (const [name, code] of Object.entries({
  regex: 'export function approve(answer) { return /approve|allow/i.test(answer); }',
  includes: 'export const route = answer => answer.toLowerCase().includes("average");',
  comparison: 'export const route = answer => answer === "count rows";',
  words: 'const words = ["permit", "deny"]; export const route = x => words.some(w => x.includes(w));',
  dynamic: 'const re = new RegExp(pattern); export const route = x => re.test(x);',
  indirect: 'export const route = x => predicate[method](x);',
})) test(`unreviewed ${name} cannot pass`, () => assert.ok(evaluate(scan(code), empty).errors.length));
test('exact reviewed typed code passes; no blanket file exemption', () => {
  const code = 'export function isPending(record) { return record.status === "pending"; }';
  const candidates = scan(code); assert.equal(evaluate(candidates, allow(candidates)).errors.length, 0);
  assert.ok(evaluate(scan(code + '\nexport const route = x => /permit/.test(x);'), allow(candidates)).errors.length);
});
test('changed keyword, receiver, owner or controlling effect invalidates the exact review', () => {
  const old = 'export function show(record) { if (record.status === "pending") display(record); }';
  const grant = allow(scan(old));
  for (const next of [old.replace('pending', 'approved'), old.replace('record.status', 'record.answer'),
    old.replace('show', 'authorize'), old.replace('display(record)', 'grant(record)')])
    assert.ok(evaluate(scan(next), grant).errors.some(error => error.kind === 'unreviewed_candidate'));
});
test('copying an allowed expression adds an unreviewed occurrence', () => {
  const code = 'const one = /secret/.test(value);';
  assert.ok(evaluate(scan(code + code.replace('one', 'two')), allow(scan(code))).errors.length);
});
test('format-only changes preserve review; removal reports stale permission', () => {
  const grant = allow(scan('const one = value === "pending";'));
  assert.equal(evaluate(scan('/* display */ const one=value==="pending";'), grant).errors.length, 0);
  assert.ok(evaluate([], grant).errors.some(error => error.kind === 'stale_allowance'));
});
test('no review, broad category, duplicate entries and malformed source fail closed', () => {
  const candidates = scan('const one = value === "pending";');
  for (const edit of [entry => delete entry.review, entry => entry.category = 'all_english']) {
    const grant = allow(candidates); edit(grant.entries[0]);
    assert.ok(evaluate(candidates, grant).errors.some(error => error.kind === 'invalid_allowance'));
  }
  const grant = allow(candidates); grant.entries.push(grant.entries[0]);
  assert.ok(evaluate(candidates, grant).errors.some(error => error.kind === 'duplicate_allowance'));
  assert.throws(() => scan('export function broken('), /malformed/);
});

test('identifier-key vocabulary lookup requires review', () => {
  const code = 'const answers = { yes: true, no: false }; export const consent = answer => answers[answer];';
  assert.ok(evaluate(scan(code), empty).errors.some(error => error.kind === 'unreviewed_candidate'));
});
test('caller effect change invalidates predicate review, including alias and cross-module consumers', () => {
  const old = 'export function isPending(v) { return v === "pending"; } export function present(v) { display(isPending(v)); }';
  assert.ok(evaluate(scan(old.replace('display(isPending(v))', 'grant(isPending(v))')), allow(scan(old))).errors.length);
  const make = effect => new Map([
    [file, 'export function isPending(v) { return v === "pending"; }'],
    ['apps/runner/src/use.ts', `import {isPending as check} from "./owner.js"; const alias = check; export function use(v) { ${effect}(alias(v)); }`],
  ]);
  const before = scanSources(make('display'));
  const grants = allow(before); grants.entries.forEach((entry, i) => entry.file = before[i].file);
  assert.equal(evaluate(before, grants).errors.length, 0);
  assert.ok(evaluate(scanSources(make('grant')), grants).errors.some(error => error.kind === 'unreviewed_candidate'));
});
test('ordinary numeric branch alone is not a language candidate', () => {
  assert.equal(scan('export function bounded(n:number) { if (n > 10) return 10; return n; }').length, 0);
});

test('plain structured output is not a keyword decision; actual lookup binds key changes', () => {
  assert.equal(scan('export const metadata = { title: "Current status", count: 2, enabled: true };').length, 0);
  const before = 'const answers = { yes: true, no: false }; export const consent = answer => answers[answer];';
  assert.ok(evaluate(scan(before.replace('yes: true', 'permit: true')), allow(scan(before))).errors.length);
});
