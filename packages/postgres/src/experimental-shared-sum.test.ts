import { describe, expect, it } from 'vitest';
import { experimentalSharedSumFixture } from '../../action-rules/src/testing/experimental-shared-sum-fixture.js';
import { createPostgresActionRuleFactLoader, type PostgresApplyClient } from './index.js';

// Controlled PG catalog responses exercise the real adapter qualification.
// These are not native metadata evidence or execution/approval acceptance.
class ProfileClient implements PostgresApplyClient {
  readonly sql: string[] = [];
  readonly fixture = experimentalSharedSumFixture();
  constructor(readonly opaque: false | true | 'missing' | 'error' = false) {}
  async query(sql: string, values?: unknown[]) {
    this.sql.push(sql);
    const rows = (data: Record<string, unknown>[]) => ({ rows: data, rowCount: data.length });
    if (sql.includes('server_version_num')) return rows([{ version: 170000, isolation: 'read committed', replication_role: 'origin' }]);
    if (sql.includes('pg_catalog.pg_locks') && !sql.includes('pg_catalog.pg_class c')) return rows([{ held: true }]);
    if (sql.includes('quote_ident(n.nspname)')) return rows([{ name: '"shared_fixture"."receipts"' }]);
    if (sql.includes('FROM pg_catalog.pg_class c WHERE c.oid=to_regclass')) {
      const name = String(values?.[0]);
      const i = ['teams', 'credits', 'waivers', 'receipts'].findIndex(t => name.endsWith(`"${t}"`));
      if (i < 0) throw new Error('Unknown fixture relation');
      return rows([{ oid: String(i + 1), relkind: 'r', relam: 2, relispartition: false, inherits: false, protected: true, relrowsecurity: false }]);
    }
    if (sql.includes('FROM pg_catalog.pg_attribute a JOIN')) {
      const i = Number(values?.[0]) - 1;
      if (i < 3) return rows(this.fixture.catalog.resources[i]!.fields.map(f => ({ attname: f.name,
        type: f.type.kind === 'string' ? 1043 : 23, atttypmod: f.type.kind === 'string' ? f.type.max_length + 4 : -1,
        attnotnull: !f.nullable, attgenerated: '', attidentity: '', core: true, typtype: 'b', default_expression: null,
        collisdeterministic: true, collprovider: f.type.kind === 'string' ? 'd' : null })));
      const types: Record<string, [number, boolean]> = { idempotency_key: [25, true], job_id: [25, true], proposal_id: [25, true],
        status: [25, true], result_hash: [25, false], semantic_verification_json: [3802, false], completion_evidence_json: [3802, false],
        created_at: [1184, true], completed_at: [1184, false] };
      return rows(Object.entries(types).map(([attname, [type, attnotnull]]) => ({ attname, type, attnotnull, atttypmod: -1,
        attgenerated: '', attidentity: '', core: true, typtype: 'b', default_expression: attname === 'created_at' ? 'now()' : null,
        collisdeterministic: true, collprovider: null })));
    }
    if (sql.includes('AS triggers')) {
      if (this.opaque === 'error') throw Object.assign(new Error('private metadata error'), { code: '42501' });
      if (this.opaque === 'missing') return rows([]);
      return rows([{ triggers: this.opaque, rules: false, constraints: false, indexes: false }]);
    }
    if (sql.includes('FROM pg_catalog.pg_policy')) return rows([{ polcmd: '*',
      using_expression: "((tenant_id = current_setting('app.tenant', true)) AND (principal_id = current_setting('app.principal', true)))",
      check_expression: "((tenant_id = current_setting('app.tenant', true)) AND (principal_id = current_setting('app.principal', true)))" }]);
    if (sql.includes("c.contype='f'")) return rows([]);
    if (sql.includes('t.tgisinternal')) return rows([]);
    if (/^(PREPARE|DEALLOCATE|LOCK TABLE|SET LOCAL)/u.test(sql)) return rows([]);
    throw new Error(`Unexpected profile query: ${sql}`);
  }
}
const scope = { tenantSetting: 'app.tenant', principalSetting: 'app.principal', tenantId: 't1', principal: 'p1' };
function loader(client: ProfileClient, receipt?: { table: string; provisioning: 'precreated' | 'auto_migrate' }) {
  return createPostgresActionRuleFactLoader(client, scope, receipt ? { receipt } : undefined);
}
const receipt = { table: 'shared_fixture.receipts', provisioning: 'precreated' as const };

describe.each(['experimental', 'reviewed'] as const)('%s shared SUM uses existing PostgreSQL Source protection', profile => {
  const inspect = (l: ReturnType<typeof loader>, c: ProfileClient) => profile === 'experimental'
    ? l.assertExperimentalSharedSumSource!(c.fixture.registry.rules[0]!.compiled)
    : l.assertReviewedSharedSumSource!(c.fixture.registry.rules[0]!.compiled);
  it.each(['absent', 'auto_migrate'] as const)('refuses %s atomic receipt before querying Source', async mode => {
    const c = new ProfileClient(), l = loader(c, mode === 'absent' ? undefined : { ...receipt, provisioning: 'auto_migrate' });
    await expect(inspect(l, c))
      .rejects.toMatchObject({ code: 'ACTION_RULE_SCOPE_UNPROVEN', path: profile === 'experimental' ? 'experimental.shared_sum.source_receipt' : 'source.hard_limit.shared_sum_receipt' });
    expect(c.sql).toEqual([]);
  });
  it('qualifies the existing native profile and protects all three relations before inspection', async () => {
    const c = new ProfileClient(), l = loader(c, receipt), compiled = c.fixture.registry.rules[0]!.compiled;
    await expect(inspect(l, c)).resolves.toBeUndefined();
    const guards = c.sql.filter(s => s.startsWith('PREPARE'));
    expect(guards).toHaveLength(3);
    expect(c.sql.indexOf(guards[2]!)).toBeLessThan(c.sql.findIndex(s => s.includes('AS triggers')));
    expect(c.sql.some(s => /^(INSERT|UPDATE|DELETE|COMMIT)\b/u.test(s))).toBe(false);
    const count = c.sql.length;
    await inspect(l, c);
    expect(c.sql.length - count).toBe(2); // Session/namespace evidence precedes cache reuse.
  });
  it.each([true, 'missing', 'error'] as const)('fails closed for %s opaque metadata with no Source DML', async mode => {
    const c = new ProfileClient(mode), l = loader(c, receipt);
    await expect(inspect(l, c)).rejects.toThrow();
    expect(c.sql.some(s => /^(INSERT|UPDATE|DELETE|COMMIT)\b/u.test(s))).toBe(false);
  });
});
