import { beforeEach, expect, it, vi } from 'vitest';
import { createActionRuleAuthority, ActionRuleError } from '@synapsor-runner/action-rules';
import type { HardLimitDesignationV1 } from '@synapsor-runner/action-rules';
import type { RuntimeConfig } from '@synapsor-runner/mcp-server';
import { invariantFixture } from './invariant-fixture.js';
const native = vi.hoisted(() => ({ maintain: true, global: false, qualifier: vi.fn(), pool: vi.fn(), query: vi.fn(), release: vi.fn(), end: vi.fn(), inspect: vi.fn(), posture: vi.fn() }));
vi.mock('@synapsor-runner/postgres', () => ({ createPostgresPool: native.pool, assertPostgresHardLimitSource: native.qualifier }));
vi.mock('@synapsor-runner/schema-inspector', () => ({ inspectDatabase: native.inspect, rolePostureFingerprint: () => `sha256:${'a'.repeat(64)}` }));
vi.mock('../../../apps/runner/src/worker-policy.js', () => ({ assessSemanticSupervisedWriterPosture: native.posture }));
import { assertHardLimitWriterSetup, inspectHardLimitWriterSetup, hardLimitWriterSetupLines } from '../../../apps/runner/src/hard-limit-writer-setup.js';
function fixture(hard = true) {
  const f = invariantFixture(25);
  f.effect_envelope.writeback = { mode: 'direct_sql', supervised_worker: 'allowed' };
  if (f.rule.require.kind !== 'compare' || f.rule.require.left.kind !== 'aggregate') throw new Error('fixture');
  const hard_limit: HardLimitDesignationV1 = { kind: 'hard_invariant', scope: { tenant_field: 'tenant_id', principal_field: 'principal_id' }, population: { binding: 'holds', field: 'credits', where: f.rule.require.left.where }, limit: { binding: 'customer', field: 'limit' }, time: 'current_state', external_writers: 'participating_only' };
  const authority = createActionRuleAuthority({ name: 'b65_setup', action_boundary_name: 'b65.setup.actions', catalog: f.catalog,
    rules: [{ read_boundary_name: 'b65.setup.read', read_boundary_digest: f.catalog.generation_lock_fingerprint, rule: f.rule, verification_boundary: f.verification_boundary, effect_envelope: f.effect_envelope, ...(hard ? { hard_limit } : {}), activated_at: '2026-10-08T00:00:00.000Z' }] });
  const source = authority.registry.rules[0]!.compiled.source;
  const config: RuntimeConfig = { version: 1, sources: { [source]: { engine: 'postgres', read_url_env: 'READ', write_url_env: 'WRITE', database_scope: { mode: 'postgres_rls', tenant_setting: 'app.tenant', principal_setting: 'app.principal' }, receipts: { authority: 'source_db', provisioning: 'precreated', schema: 'public', table: 'receipts' } } } };
  return { registry: authority.registry, config, env: { READ: 'postgres://reader', WRITE: 'postgres://writer' }, source };
}
beforeEach(() => {
  vi.clearAllMocks(); native.maintain = true; native.global = false;
  native.qualifier.mockReset().mockResolvedValue(undefined);
  native.query.mockReset().mockImplementation(async (sql: string) => ({ rows: sql.startsWith("SELECT pg_catalog.current_setting('server_version_num')") ? [{ version: 170000 }] : sql.startsWith('SELECT current_user') ? [{ role: 'dedicated_writer', maintain: native.maintain, global_maintain: native.global, catalog_dml: false }] : [], rowCount: 0 }));
  native.end.mockResolvedValue(undefined); native.release.mockReset();
  native.pool.mockReturnValue({ connect: async () => ({ query: native.query, release: native.release }), end: native.end });
  native.inspect.mockResolvedValue({ engine: 'postgres', current_user: 'dedicated_writer', tables: [] });
  native.posture.mockReturnValue({ ok: true, reasons: [] });
});
it('unmarked and legacy registries require no Source connection', async () => {
  expect((await inspectHardLimitWriterSetup(fixture(false))).status).toBe('not_required');
  expect(native.pool).not.toHaveBeenCalled(); expect(native.inspect).not.toHaveBeenCalled();
});
it('missing writer refuses with exact namespace requirement and never inspects reader', async () => {
  const f = fixture(); delete f.config.sources![f.source]!.write_url_env;
  const result = await inspectHardLimitWriterSetup(f);
  expect(result.status).toBe('refused'); expect(result.checks[0]?.reason_code).toBe('writer_not_selected');
  expect(hardLimitWriterSetupLines(result).join(' ')).toContain('GRANT MAINTAIN ON TABLE pg_catalog.pg_namespace');
  expect(native.pool).not.toHaveBeenCalled(); expect(native.inspect).not.toHaveBeenCalled();
});
it('identical reader and writer connection refuses without a native probe', async () => {
  const f = fixture(); f.env.WRITE = f.env.READ;
  expect((await inspectHardLimitWriterSetup(f)).checks[0]?.reason_code).toBe('writer_is_reader'); expect(native.pool).not.toHaveBeenCalled();
});
it('missing MAINTAIN refuses before qualification and closes its rollback transaction', async () => {
  native.maintain = false;
  await expect(assertHardLimitWriterSetup(fixture())).rejects.toMatchObject({ code: 'SEMANTIC_ACTION_HARD_LIMIT_WRITER_REQUIRED', readback: { checks: [expect.objectContaining({ native_path: 'source.hard_limit.namespace_acl', status: 'refused' })] } });
  expect(native.qualifier).not.toHaveBeenCalled(); expect(native.query).toHaveBeenCalledWith('ROLLBACK'); expect(native.release).toHaveBeenCalledWith(true); expect(native.end).toHaveBeenCalled();
});
it('requires fresh inspection after readback: revocation cannot reuse ready', async () => {
  const f = fixture(); expect((await inspectHardLimitWriterSetup(f)).status).toBe('ready');
  native.maintain = false;
  await expect(assertHardLimitWriterSetup(f)).rejects.toMatchObject({ code: 'SEMANTIC_ACTION_HARD_LIMIT_WRITER_REQUIRED' });
  expect(native.pool).toHaveBeenCalledTimes(2);
});
it('hidden or uninspectable effects preserve native refusal stage and roll back', async () => {
  native.qualifier.mockRejectedValue(new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN', 'hidden effects', 'source.hard_limit.opaque_effects'));
  const result = await inspectHardLimitWriterSetup(fixture());
  expect(result.checks[0]).toMatchObject({ status: 'refused', reason_code: 'native_source_uninspectable', native_path: 'source.hard_limit.opaque_effects' });
  expect(native.inspect).not.toHaveBeenCalled(); expect(native.query).toHaveBeenCalledWith('ROLLBACK');
});
it('native inspection receives static reviewed settings without invented identities and does no business DML', async () => {
  const f = fixture(); const result = await inspectHardLimitWriterSetup(f);
  expect(result.status).toBe('ready'); expect(result.checks[0]?.writer_role).toBe('dedicated_writer');
  expect(native.qualifier.mock.calls[0]?.[2]).toEqual({ tenantSetting: 'app.tenant', principalSetting: 'app.principal' });
  expect(native.qualifier.mock.calls[0]?.[3]).toEqual({ table: '"public"."receipts"', provisioning: 'precreated' });
  expect(native.inspect).toHaveBeenCalledWith(expect.objectContaining({ databaseUrlEnv: 'WRITE' }));
  expect(native.query.mock.calls.map(call => call[0]).filter(sql => /^(INSERT|UPDATE|DELETE|COMMIT)/u.test(sql))).toEqual([]);
});
it('rejects broader global maintain rather than prescribing it as least privilege', async () => {
  native.global = true;
  expect((await inspectHardLimitWriterSetup(fixture())).checks[0]?.reason_code).toBe('namespace_maintain_overbroad'); expect(native.qualifier).not.toHaveBeenCalled();
});
it('unsupported MySQL capability fails before opening a connection', async () => {
  const f = fixture(); f.config.sources![f.source]!.engine = 'mysql';
  expect((await inspectHardLimitWriterSetup(f)).checks[0]?.reason_code).toBe('hard_limit_engine_unsupported'); expect(native.pool).not.toHaveBeenCalled();
});
it('ordinary business posture remains a required check', async () => {
  native.posture.mockReturnValue({ ok: false, reasons: ['writer_privilege_missing'] });
  expect((await inspectHardLimitWriterSetup(fixture())).checks[0]?.reason_code).toBe('writer_posture_unproven');
});
it('an outcome writer reference cannot borrow a mismatched Source alias', async () => {
  const f = fixture(); f.config.supervised_worker = { enabled: false, capabilities: [], outcomes: [{ outcome: f.registry.rules[0]!.compiled.outcome, write_url_env: 'OTHER' } as never] };
  f.config.sources!.alias = { ...f.config.sources![f.source]!, write_url_env: 'OTHER', database_scope: { mode: 'application' } };
  expect((await inspectHardLimitWriterSetup(f)).checks[0]?.reason_code).toBe('writer_not_selected'); expect(native.pool).not.toHaveBeenCalled();
});
it('failure to prove rollback refuses a previously qualified writer', async () => {
  native.query.mockImplementation(async (sql: string) => { if (sql === 'ROLLBACK') throw new Error('lost'); return { rows: sql.startsWith("SELECT pg_catalog.current_setting('server_version_num')") ? [{ version: 170000 }] : [{ role: 'dedicated_writer', maintain: true, global_maintain: false, catalog_dml: false }], rowCount: 1 }; });
  expect((await inspectHardLimitWriterSetup(fixture())).checks[0]).toMatchObject({ status: 'refused', reason_code: 'setup_rollback_unproven' });
});

it('renders inspected role with SQL identifier quoting and unsupported MySQL without a PG grant', async () => {
  const f = fixture(); const ready = await inspectHardLimitWriterSetup(f);
  ready.checks[0]!.writer_role = 'writer"quote';
  expect(hardLimitWriterSetupLines(ready).join(' ')).toContain('TO "writer""quote";');
  f.config.sources![f.source]!.engine = 'mysql';
  const unsupported = await inspectHardLimitWriterSetup(f);
  expect(unsupported.requirements).toEqual([]);
  expect(hardLimitWriterSetupLines(unsupported).join(' ')).not.toContain('GRANT MAINTAIN');
});
