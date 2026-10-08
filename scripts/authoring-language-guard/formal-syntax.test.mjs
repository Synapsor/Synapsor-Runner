import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, scanSources, evaluate } from './scan.mjs';
const file = 'apps/runner/src/guarded.ts';
const scan = source => scanSource(file, source);
const empty = { version: 1, entries: [] };

test('strict JavaScript typeof tags are formal grammar, without exempting their operands', () => {
  for (const tag of ['undefined', 'object', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function']) {
    assert.equal(scan(`export const check = value => typeof value === "${tag}";`).length, 0, tag);
    assert.equal(scan(`export const check = value => "${tag}" !== typeof value;`).length, 0, tag);
  }
  for (const code of [
    'export const check = value => typeof value === "approved";',
    'export const check = value => value === "string";',
    'export const check = value => typeof value == "string";',
    'export const check = answer => typeof (/permit/.test(answer) ? grant() : refuse()) === "undefined";',
  ]) assert.ok(evaluate(scan(code), empty).errors.length, code);
});

test('erased type declarations do not create runtime language candidates', () => {
  const code = 'export type Words = ["yes", "no"]; export type First = Words["0"]; export interface Display { status: "pending"; }';
  assert.equal(scan(code).length, 0);
  assert.ok(scan(code + '\nexport const decide = answer => answer === "yes";').length);
});

test('imports and type-only references are not standalone consumers; actual value alias effects stay bound', () => {
  const make = effect => new Map([
    [file, 'export function check(value: string) { return value === "pending"; }'],
    ['apps/runner/src/use.ts', `import { check as classify } from "./guarded.js"; type Signature = typeof classify; const alias = classify; export function use(value: string) { ${effect}(alias(value)); }`],
  ]);
  const before = scanSources(make('display'));
  assert.equal(before.filter(c => c.kind === 'predicate_consumer' && /^(?:import|type)\b/.test(c.excerpt)).length, 0);
  const allowances = { version: 1, entries: before.map(c => ({ fingerprint: c.fingerprint, file: c.file,
    annotation_id: 'FORMAL-CONTROL', category: 'exact_identifier_or_code', reason: 'Fixture exact token and display effect only.',
    review: { reviewer: 'test-fixture', evidence: 'fixture-only', verdict: 'accepted' } })) };
  assert.ok(evaluate(scanSources(make('grant')), allowances).errors.some(e => e.kind === 'unreviewed_candidate'));
});

test('class heritage retains runtime decisions even though TypeScript also classifies it as a type node', () => {
  assert.ok(evaluate(scan('export class Example extends (/permit/.test(answer) ? Approved : Refused) {}'), empty)
    .errors.some(error => error.kind === 'unreviewed_candidate'));
});
