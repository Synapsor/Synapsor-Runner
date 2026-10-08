import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, caseIds, expectedDeclarations, proposedState, referenceSchedule, referenceCommittedState, compareCompleteSnapshot, applyExactEffects, assess, integer } from './reference-state.mjs';
for (const id of caseIds) test(`${id}: exact declared individual/whole effects and every predeclared order`, () => {
  const c = fixture(id); const expected = expectedDeclarations(id);
  const original = structuredClone(c.initial);
  for (const [name, valid] of Object.entries(expected.individual)) assert.equal(proposedState(id, [name]).assessment.valid, valid, `${id}/${name}`);
  const combined = proposedState(id, Object.keys(c.operations));
  assert.equal(combined.assessment.valid, expected.all_effects_valid);
  if (expected.all_effects_total_cents) assert.equal(combined.assessment.measures.total_cents, expected.all_effects_total_cents);
  for (const order of c.orders) {
    const run = referenceSchedule(id, order);
    const committed = run.decisions.filter(d => d.admissible).map(d => d.operation);
    assert.deepEqual(referenceCommittedState(id, committed), run.committed_state);
    assert.equal(compareCompleteSnapshot(id, committed, run.committed_state).equal, true);
    if (Object.values(expected.individual).some(Boolean)) assert.ok(committed.length >= 1, 'Reference schedule has useful progress');
  }
  assert.deepEqual(c.initial, original, 'Reference calculation never mutates fixture baseline');
});
test('sequential cases are independent fresh states; actual totals 55/50/40/45/55', () => {
  assert.deepEqual(['S01','S02','S03','S04','S05'].map(id => proposedState(id, ['A']).assessment.measures.total_cents), ['5500','5000','4000','4500','5500']);
  assert.deepEqual(referenceCommittedState('S01', []), fixture('S01').initial);
  assert.throws(() => referenceCommittedState('S01', ['A']), /violates/);
});
test('precondition open→closed stays eligible despite false post-state open predicate', () => {
  const c = fixture('PRE01'); const next = proposedState('PRE01', ['A']);
  assert.equal(next.state.requests[0].status, 'closed'); assert.equal(next.assessment.valid, true);
  assert.equal(assess(next.state, c.rule).valid, false, 'A second close fails ordinary precondition');
});
test('T01 column relation and T10 rational indirect impact have exact private measures', () => {
  assert.equal(proposedState('T01', ['A','B']).assessment.measures.products[0].net_cents, '4000');
  const all = proposedState('T10', ['A','B']).assessment.measures.accounts[0];
  assert.equal(BigInt(all.amount_numerator_cents) / BigInt(all.denominator), 10800n);
  assert.equal(proposedState('T10', ['B']).assessment.measures.accounts[0].amount_numerator_cents, '960000');
});
test('T03 equal-valued rows count separately and cross-table rows are not join-multiplied', () => {
  const c = fixture('T03'); c.initial.credits = [{id:'x',team:'T',period:'P',amount_cents:'15000'},{id:'y',team:'T',period:'P',amount_cents:'15000'}];
  assert.equal(assess(c.initial, c.rule).measures.budgets[0].total_cents, '30000');
  c.initial.invoices[0].waiver_cents = '25000';
  assert.deepEqual(assess(c.initial, c.rule), { valid:false, measures:{budgets:[{team:'T',period:'P',total_cents:'55000',limit_cents:'50000'}]} });
});
test('T04 reduction below usage refuses fresh; main simultaneous state450/400', () => {
  assert.equal(proposedState('T04-below-usage', ['B']).assessment.valid, false);
  assert.deepEqual(proposedState('T04', ['A','B']).assessment.measures, {total_cents:'45000',effective_limit_cents:'40000'});
});
test('T06 counts customers rather than rows or pending requests', () => {
  assert.equal(proposedState('T06-same-customer', ['A','B']).assessment.measures.distinct_completed_customers, '10');
  assert.equal(assess(fixture('T06-complete').initial, fixture('T06-complete').rule).measures.distinct_completed_customers, '9');
});
test('T07 move affects both groups and leaves ordinary row fields untouched', () => {
  const next = proposedState('T07', ['A','B']);
  assert.deepEqual(next.assessment.measures.groups, [{group:'Q',total_cents:'12000'}]);
  assert.equal(next.state.entries.find(r=>r.id==='p').amount_cents, '4000');
});
test('T08 whole atomic transfer succeeds in both statement orders; intermediate overage is not final verdict', () => {
  const c = fixture('T08-transfer-reversed');
  assert.equal(assess(applyExactEffects(c.initial, [c.operations.A[0]]), c.rule).valid, false);
  assert.equal(proposedState(c.id, ['A']).assessment.valid, true);
  assert.deepEqual(proposedState(c.id, ['A']).state, proposedState('T08-transfer', ['A']).state);
});
test('T09 six orders and all three pair combinations are represented', () => {
  const c = fixture('T09'); assert.equal(c.orders.length, 6); assert.equal(new Set(c.orders.map(x=>x.join(','))).size, 6);
  for (const pair of [['A','B'],['A','C'],['B','C']]) assert.equal(proposedState(c.id, pair).assessment.valid, true);
  for (const order of c.orders) assert.deepEqual(referenceSchedule(c.id, order).decisions.map(d=>d.admissible), [true,true,false]);
});
test('comparison verifies complete unaffected tables/fields and rejects duplicated effects', () => {
  const exact = referenceCommittedState('T03', ['A']);
  assert.equal(compareCompleteSnapshot('T03', ['A'], exact).equal, true);
  const changed = structuredClone(exact); changed.invoices[0].customer = 'X';
  assert.equal(compareCompleteSnapshot('T03', ['A'], changed).equal, false);
  const missing = structuredClone(exact); delete missing.invoices;
  assert.equal(compareCompleteSnapshot('T03', ['A'], missing).equal, false);
  assert.throws(() => proposedState('S02', ['A','A']), /Replay/);
  assert.throws(() => applyExactEffects(exact, fixture('T03').operations.A), /Duplicate/);
});
test('exact arithmetic has no floating point, NULL-to-zero or machine integer overflow', () => {
  assert.equal(integer('900719925474099300'), 900719925474099300n);
  for (const bad of [null, undefined, 100, '1.00', '1e2', '', ' 100', 'NaN']) assert.throws(() => integer(bad), /exact/);
  const c = fixture('S02'); c.initial.entries[0].amount_cents = null;
  assert.throws(() => assess(c.initial, c.rule), /non-null/);
  const r = fixture('T10'); r.initial.rates[0].numerator = '1'; r.initial.rates[0].denominator = '3';
  const result = assess(r.initial, r.rule);
  assert.equal(result.valid, true); assert.equal(result.measures.accounts[0].amount_numerator_cents, '8000');
  r.initial.rates[0].denominator = '0'; assert.throws(() => assess(r.initial, r.rule), /Invalid declared rate/);
});
test('incomplete populations or unknown shapes never silently become zero/valid', () => {
  const c = fixture('T03'); delete c.initial.invoices; assert.throws(() => assess(c.initial, c.rule), /Complete/);
  const r = fixture('T10'); r.initial.charges.push({id:'foreign',account:'UNKNOWN',amount_cents:'100'}); assert.throws(() => assess(r.initial, r.rule), /Incomplete/);
  assert.throws(() => assess({}, {kind:'unknown'}), /Undeclared/);
});
test('oracle is separate from product/evaluator and provider-facing fixture material', () => {
  const src = readFileSync(new URL('./reference-state.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m=>m[1]);
  assert.deepEqual(imports, ['node:fs','node:util']);
  const facts = JSON.parse(readFileSync(new URL('../fixtures/OPERATOR-FACTS.json', import.meta.url),'utf8'));
  for (const f of facts) { assert.equal(Object.hasOwn(f,'initial'),false); assert.equal(Object.hasOwn(f,'expected'),false); assert.equal(Object.hasOwn(f,'expected_reference'),false); }
});
