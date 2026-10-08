// PRIVATE TEST ORACLE. No Runner imports, SQL parsing, database or provider access.
// Only fixture initial state and the exact declared effects produce expected state.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/SCENARIOS.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../CASE-MANIFEST.json', import.meta.url), 'utf8'));
export const caseIds = Object.freeze(fixtures.map(c => c.id));
export function fixture(id) {
  const result = fixtures.find(c => c.id === id);
  if (!result) throw new Error(`Unknown predeclared fixture: ${id}`);
  return structuredClone(result);
}
export function expectedDeclarations(id) {
  const result = manifest.cases.find(c => c.id === id);
  if (!result) throw new Error(`Unknown predeclared case: ${id}`);
  return structuredClone(result.expected_reference);
}
export function integer(value) {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) throw new Error('An exact non-null decimal integer string is required');
  return BigInt(value);
}
function rows(state, table) {
  if (!Object.hasOwn(state, table) || !Array.isArray(state[table])) throw new Error(`Complete declared table missing: ${table}`);
  const ids = new Set();
  for (const row of state[table]) {
    if (typeof row.id !== 'string' || ids.has(row.id)) throw new Error(`Missing/duplicate row identity in ${table}`);
    ids.add(row.id);
  }
  return state[table];
}
function sum(items, field) { return items.reduce((n, r) => n + integer(r[field]), 0n); }
function one(items, description) { if (items.length !== 1) throw new Error(`Expected one ${description}, got ${items.length}`); return items[0]; }
function groupKey(...values) { if (values.some(v => typeof v !== 'string')) throw new Error('Missing exact grouping identity'); return JSON.stringify(values); }
function result(checks, measures) { return { valid: checks.every(Boolean), measures }; }
export function assess(state, rule, before = state) {
  switch (rule.kind) {
    case 'sum': {
      const total = sum(rows(state, rule.table), rule.field); const limit = integer(rule.limit_cents);
      return result([total <= limit], { total_cents: String(total), limit_cents: String(limit) });
    }
    case 'precondition': {
      const row = one(rows(before, rule.table).filter(r => r.id === rule.key), 'precondition target');
      return result([row[rule.field] === rule.value], { phase: 'before_effect', field: rule.field, actual: row[rule.field] });
    }
    case 'net_price': {
      const measurements = rows(state, 'products').map(r => ({ id: r.id, net_cents: String(integer(r.price_cents) - integer(r.discount_cents)), floor_cents: r.floor_cents }));
      return result(measurements.map(r => integer(r.net_cents) >= integer(r.floor_cents)), { products: measurements });
    }
    case 'minimum_available': {
      const rr = rows(state, 'responders');
      if (rr.some(r => !rule.teams.includes(r.team) || typeof r.available !== 'boolean')) throw new Error('Incomplete team membership/availability fixture');
      const populations = rule.teams.map(team => ({ team, available: String(rr.filter(r => r.team === team && r.available).length) }));
      return result(populations.map(r => integer(r.available) >= 1n), { populations });
    }
    case 'cross_budget': {
      const limits = rows(state, 'limits'); const totals = new Map();
      for (const l of limits) { const k = groupKey(l.team, l.period); if (totals.has(k)) throw new Error('Duplicate budget scope'); totals.set(k, 0n); }
      for (const [table, field] of [['credits', 'amount_cents'], ['invoices', 'waiver_cents']]) {
        // Independent row sums: never DISTINCT amount or a fan-out join.
        for (const r of rows(state, table)) { const k = groupKey(r.team, r.period); if (!totals.has(k)) throw new Error('Undeclared budget scope'); totals.set(k, totals.get(k) + integer(r[field])); }
      }
      const budgets = limits.map(l => ({ team: l.team, period: l.period, total_cents: String(totals.get(groupKey(l.team, l.period))), limit_cents: l.limit_cents }));
      return result(budgets.map(b => integer(b.total_cents) <= integer(b.limit_cents)), { budgets });
    }
    case 'adjusted_budget': {
      const base = one(rows(state, 'budget'), 'base budget');
      const total = sum(rows(state, 'credits'), 'amount_cents');
      const limit = integer(base.base_cents) + sum(rows(state, 'adjustments'), 'amount_cents');
      return result([total <= limit], { total_cents: String(total), effective_limit_cents: String(limit) });
    }
    case 'campaign_exclusivity': {
      const populations = new Map();
      for (const table of ['cash_awards', 'product_awards']) for (const r of rows(state, table)) {
        if (typeof r.campaign !== 'string' || typeof r.active !== 'boolean') throw new Error('Incomplete benefit membership');
        if (!populations.has(r.campaign)) populations.set(r.campaign, 0n);
        if (r.active) populations.set(r.campaign, populations.get(r.campaign) + 1n);
      }
      return result([...populations.values()].map(n => n <= 1n), { campaigns: [...populations].map(([campaign, count]) => ({ campaign, active: String(count) })) });
    }
    case 'distinct_completed': {
      const rr = rows(state, 'refunds');
      if (rr.some(r => typeof r.customer !== 'string' || !['completed', 'pending'].includes(r.status))) throw new Error('Incomplete refund membership');
      const count = BigInt(new Set(rr.filter(r => r.status === 'completed').map(r => r.customer)).size);
      return result([count <= integer(rule.limit)], { distinct_completed_customers: String(count) });
    }
    case 'group_budget': {
      const groups = new Map();
      for (const r of rows(state, 'entries')) { const k = groupKey(r.group); groups.set(k, (groups.get(k) ?? 0n) + integer(r.amount_cents)); }
      return result([...groups.values()].map(n => n <= integer(rule.limit_cents)), { groups: [...groups].map(([key, n]) => ({ group: JSON.parse(key)[0], total_cents: String(n) })) });
    }
    case 'rate_budget': {
      const charges = rows(state, 'charges'); const rates = rows(state, 'rates'); const limits = rows(state, 'limits');
      if (new Set(limits.map(l => l.account)).size !== limits.length) throw new Error('Duplicate account limit');
      if (charges.some(c => !limits.some(l => l.account === c.account)) || rates.some(r => !limits.some(l => l.account === r.account))) throw new Error('Incomplete impacted-account population');
      const accounts = limits.map(l => {
        const rate = one(rates.filter(r => r.account === l.account), 'applicable account rate');
        const numerator = integer(rate.numerator); const denominator = integer(rate.denominator);
        if (denominator <= 0n || numerator < 0n) throw new Error('Invalid declared rate');
        const raw = sum(charges.filter(c => c.account === l.account), 'amount_cents');
        return { account: l.account, amount_numerator_cents: String(raw * numerator), denominator: String(denominator), limit_cents: l.limit_cents };
      });
      return result(accounts.map(a => integer(a.amount_numerator_cents) <= integer(a.limit_cents) * integer(a.denominator)), { accounts });
    }
    default: throw new Error(`Undeclared finite oracle rule: ${rule.kind}`);
  }
}
export function applyExactEffects(initial, effects) {
  const next = structuredClone(initial);
  for (const effect of effects) {
    const table = rows(next, effect.table);
    if (effect.kind === 'insert') {
      if (table.some(r => r.id === effect.row.id) || typeof effect.row.id !== 'string') throw new Error('Duplicate/missing inserted row identity');
      table.push(structuredClone(effect.row));
    } else if (effect.kind === 'update') {
      const target = one(table.filter(r => r.id === effect.key), 'UPDATE target');
      if (Object.hasOwn(effect.set, 'id')) throw new Error('Fixture UPDATE cannot silently change row identity');
      for (const [key, value] of Object.entries(effect.set)) {
        if (!Object.hasOwn(target, key)) throw new Error(`Undeclared UPDATE field: ${key}`);
        target[key] = structuredClone(value);
      }
    } else throw new Error(`Unsupported fixture effect: ${effect.kind}`);
  }
  return next;
}
function operation(c, name) { if (!Object.hasOwn(c.operations, name)) throw new Error(`Undeclared operation ${name}`); return c.operations[name]; }
export function proposedState(id, operationIds) {
  const c = fixture(id); let state = c.initial; const seen = new Set();
  for (const name of operationIds) {
    if (seen.has(name)) throw new Error('Replay is not a reference-state operation');
    seen.add(name); state = applyExactEffects(state, operation(c, name));
  }
  return { state, assessment: assess(state, c.rule, c.initial) };
}
// Ideal serial admissibility, not a requirement to optimally accept stale proposals.
// Native observations must separately classify stale/review/currentness refusals.
export function referenceSchedule(id, order) {
  const c = fixture(id); let state = structuredClone(c.initial); const decisions = []; const seen = new Set();
  for (const name of order) {
    if (seen.has(name)) throw new Error('Replay is not permitted'); seen.add(name);
    const proposed = applyExactEffects(state, operation(c, name));
    const assessment = assess(proposed, c.rule, state);
    decisions.push({ operation: name, admissible: assessment.valid, assessment, proposed_state: proposed });
    if (assessment.valid) state = proposed;
  }
  return { case_id: id, order, decisions, committed_state: state };
}
// Tester gives only actually committed operation identities. Expected rows still
// derive entirely from initial data/effects, never by evaluating observed rows.
export function referenceCommittedState(id, committedOperations) {
  const result = referenceSchedule(id, committedOperations);
  if (result.decisions.some(d => !d.admissible)) throw new Error('Committed operation sequence violates the declared invariant');
  return result.committed_state;
}
function canonicalSnapshot(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Complete table snapshot required');
  return Object.fromEntries(Object.keys(state).sort().map(table => [table, rows(state, table).map(r => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))).sort((a, b) => a.id.localeCompare(b.id))]));
}
export function compareCompleteSnapshot(id, committedOperations, observed) {
  const expected = referenceCommittedState(id, committedOperations);
  return { equal: isDeepStrictEqual(canonicalSnapshot(expected), canonicalSnapshot(observed)), expected };
}
