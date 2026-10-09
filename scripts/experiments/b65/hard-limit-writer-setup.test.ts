import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, expect, it, vi } from 'vitest';
import { createActionRuleAuthority, ActionRuleError } from '@synapsor-runner/action-rules';
import type { HardLimitDesignationV1 } from '@synapsor-runner/action-rules';
import type { RuntimeConfig } from '@synapsor-runner/mcp-server';
import { invariantFixture } from './writer-setup-fixture.js';
const native = vi.hoisted(() => ({ maintain: true, global: false, qualifier: vi.fn(), pool: vi.fn(), query: vi.fn(), release: vi.fn(), end: vi.fn(), inspect: vi.fn(), posture: vi.fn(), selection: vi.fn(), identity: { database: "fixture", database_oid: "1234", server_address: "127.0.0.1", server_port: 5432, server_version: 170000, system_identifier: "123456789", postmaster_start_us: "1791500000000000", in_recovery: false }, inspectionIdentity: undefined as Record<string, unknown> | undefined, inspectionQuery: vi.fn(), inspectWithConnection: vi.fn(), firstTransactionOpen: false, schemaFingerprint: "a" }));
vi.mock('@synapsor-runner/postgres', () => ({ createPostgresPool: native.pool, assertPostgresHardLimitSource: native.qualifier }));
vi.mock('@synapsor-runner/schema-inspector', () => ({ inspectDatabase: native.inspect, inspectDatabaseWithConnection: native.inspectWithConnection, rolePostureFingerprint: () => `sha256:${'a'.repeat(64)}`, schemaFingerprintForInspection: () => `sha256:${native.schemaFingerprint.repeat(64)}` }));
vi.mock('../../../apps/runner/src/worker-policy.js', () => ({ assessSemanticSupervisedWriterPosture: native.posture }));
vi.mock('../../../apps/runner/src/semantic-receipt-setup.js', async () => {
  const { withHeldProjectAuthorityAccess } = await import('../../../apps/runner/src/project-authority-mutation.js');
  return { inspectSemanticReceiptSetupHeld: (input: { projectRoot: string }, permit: Parameters<typeof withHeldProjectAuthorityAccess>[1]) =>
    withHeldProjectAuthorityAccess(input.projectRoot, permit, async () => native.selection(input)),
    selectedSemanticReceipts: (setup: any, writer: string) => { if (!setup.selection_current || setup.selection.write_url_env !== writer) throw new Error('stale selection'); return setup.selection.receipts; } };
});
import { projectHardLimitActivationWriterSelections } from '../../../apps/runner/src/hard-limit-writer-selection.js';
import { inspectReviewedHardLimitWriterSetup, assertReviewedHardLimitWriterSetup,
  type HardLimitWriterReviewContext, type HardLimitWriterReviewBinding } from '../../../apps/runner/src/hard-limit-writer-review-binding.js';
import { assertHardLimitWriterSetup, inspectHardLimitWriterSetup, hardLimitWriterSetupLines } from '../../../apps/runner/src/hard-limit-writer-setup.js';
function fixture(hard = true, multiple = false) {
  const f = invariantFixture(25);
  f.effect_envelope.writeback = { mode: 'direct_sql', supervised_worker: 'allowed' };
  if (f.rule.require.kind !== 'compare' || f.rule.require.left.kind !== 'aggregate') throw new Error('fixture');
  const hard_limit: HardLimitDesignationV1 = { kind: 'hard_invariant', scope: { tenant_field: 'tenant_id', principal_field: 'principal_id' }, population: { binding: 'holds', field: 'credits', where: f.rule.require.left.where }, limit: { binding: 'customer', field: 'limit' }, time: 'current_state', external_writers: 'participating_only' };
  const authority = createActionRuleAuthority({ name: 'b65_setup', action_boundary_name: 'b65.setup.actions', catalog: f.catalog,
    rules: Array.from({ length: multiple ? 2 : 1 }, (_, index) => ({ read_boundary_name: 'b65.setup.read', read_boundary_digest: f.catalog.generation_lock_fingerprint, rule: index ? { ...f.rule, name: f.rule.name + '_two', outcome: f.rule.outcome + '_two' } : f.rule, verification_boundary: f.verification_boundary, effect_envelope: f.effect_envelope, ...(hard ? { hard_limit } : {}), activated_at: '2026-10-08T00:00:00.000Z' })) });
  const source = authority.registry.rules[0]!.compiled.source;
  const config: RuntimeConfig = { version: 1, sources: { [source]: { engine: 'postgres', read_url_env: 'READ', write_url_env: 'WRITE', database_scope: { mode: 'postgres_rls', tenant_setting: 'app.tenant', principal_setting: 'app.principal' }, receipts: { authority: 'source_db', provisioning: 'precreated', schema: 'public', table: 'receipts' } } } };
  return { authorityDigest: authority.authority.digest, registry: authority.registry, config, env: { READ: 'postgres://reader', WRITE: 'postgres://writer' }, source };
}
beforeEach(() => {
  vi.clearAllMocks(); native.selection.mockReset().mockResolvedValue(undefined); native.maintain = true; native.global = false; native.schemaFingerprint = "a";
  native.identity = { database: "fixture", database_oid: "1234", server_address: "127.0.0.1", server_port: 5432, server_version: 170000, system_identifier: "123456789", postmaster_start_us: "1791500000000000", in_recovery: false };
  native.inspectionIdentity = undefined; native.firstTransactionOpen = false;
  native.qualifier.mockReset().mockResolvedValue(undefined);
  native.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.startsWith('BEGIN')) native.firstTransactionOpen = true;
    if (sql === 'ROLLBACK') native.firstTransactionOpen = false;
    return { rows: sql.startsWith("SELECT pg_catalog.current_setting('server_version_num')") ? [{ version: 170000 }] : sql.startsWith('SELECT current_user') ? [{ role: 'dedicated_writer', maintain: native.maintain, global_maintain: native.global, catalog_dml: false }] : sql.startsWith('SELECT pg_catalog.current_database()') ? [native.identity] : [], rowCount: 0 }; });
  native.end.mockResolvedValue(undefined); native.release.mockReset();
  native.inspectionQuery.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.startsWith('SELECT pg_catalog.current_database()') ? [native.inspectionIdentity ?? native.identity] : [], rowCount: 0 }));
  let connections = 0;
  native.pool.mockImplementation(() => { connections = 0; return {
    connect: async () => ({ query: connections++ === 0 ? native.query : native.inspectionQuery, release: native.release }), end: native.end }; });
  native.inspect.mockReset().mockResolvedValue({ engine: 'postgres', current_user: 'dedicated_writer', tables: [] });
  native.inspectWithConnection.mockReset().mockImplementation(async (options, borrowed) => {
    await borrowed.connection.query('BEGIN READ ONLY');
    await borrowed.connection.query('SELECT COMPONENT_METADATA');
    const result = await native.inspect(options);
    await borrowed.connection.query('COMMIT');
    return result;
  });
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

// Retain each isolated project's SQLite lock inode with the run artifacts.
// Entry acquisition and explicit live Held validation use the real access API.
async function selectionProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synapsor-b65-writer-selection-'));
  await fs.chmod(root, 0o700);
  return root;
}

function disabledSelection(f: ReturnType<typeof fixture>) {
  const source = f.config.sources![f.source]!;
  source.read_only = true; delete source.write_url_env;
  return { phase: 'disabled_authoring', selection_current: true, action_digest: f.authorityDigest,
    outcome: f.registry.rules[0]!.compiled.outcome, source_name: f.source, source: structuredClone(source),
    selection: { write_url_env: 'CHOSEN_WRITE', receipts: { authority: 'source_db', provisioning: 'precreated', schema: 'public', table: 'receipts' } } };
}
it('projects the exact saved disabled writer selection into the separate Action candidate without execution authority', async () => {
  const projectRoot = await selectionProject();
  const f = fixture(), before = JSON.stringify(f.config); const setup = disabledSelection(f); const readOnly = JSON.stringify(f.config);
  native.selection.mockResolvedValue(setup);
  const projected = await projectHardLimitActivationWriterSelections({ ...f, projectRoot });
  expect(projected.sources![f.source]).toMatchObject({ read_only: false, write_url_env: 'CHOSEN_WRITE', read_url_env: 'READ', receipts: setup.selection.receipts });
  expect(projected.supervised_worker).toBeUndefined(); expect(JSON.stringify(f.config)).toBe(readOnly);
  expect(native.selection).toHaveBeenCalledWith(expect.objectContaining({ disabled: true, configPath: path.join(projectRoot, 'synapsor.runner.json'), outcome: setup.outcome }));
  expect(before).not.toBe(readOnly);
});
it.each(['stale', 'wrong_action', 'wrong_source', 'wrong_outcome', 'source_drift', 'missing'])('cannot stage %s disabled setup as a writer', async mode => {
  const projectRoot = await selectionProject();
  const f = fixture(), setup = disabledSelection(f);
  if (mode === 'stale') setup.selection_current = false;
  if (mode === 'wrong_action') setup.action_digest = 'sha256:' + 'b'.repeat(64);
  if (mode === 'wrong_source') setup.source_name = 'other';
  if (mode === 'wrong_outcome') setup.outcome = 'other';
  if (mode === 'source_drift') setup.source.read_url_env = 'OTHER_READ';
  native.selection.mockResolvedValue(mode === 'missing' ? undefined : setup);
  const projected = await projectHardLimitActivationWriterSelections({ ...f, projectRoot });
  expect(projected.sources![f.source]!.write_url_env).toBeUndefined();
});
it('keeps the current genuine writer rather than silently replacing it with a disabled setup', async () => {
  const projectRoot = await selectionProject();
  const f = fixture(); const result = await projectHardLimitActivationWriterSelections({ ...f, projectRoot });
  expect(result).toEqual(f.config); expect(native.selection).not.toHaveBeenCalled();
});
it('reinspects the disabled setup rather than allowing human-wait drift to reuse selection', async () => {
  const projectRoot = await selectionProject();
  const f = fixture(), setup = disabledSelection(f); native.selection.mockResolvedValue(setup);
  expect((await projectHardLimitActivationWriterSelections({ ...f, projectRoot })).sources![f.source]!.write_url_env).toBe('CHOSEN_WRITE');
  setup.selection_current = false;
  expect((await projectHardLimitActivationWriterSelections({ ...f, projectRoot })).sources![f.source]!.write_url_env).toBeUndefined();
  expect(native.selection).toHaveBeenCalledTimes(2);
});

it('does not borrow one outcome selection for an unselected sibling on the same Source', async () => {
  const projectRoot = await selectionProject();
  const f = fixture(true, true), setup = disabledSelection(f);
  native.selection.mockImplementation(async input => input.outcome === setup.outcome ? setup : undefined);
  expect((await projectHardLimitActivationWriterSelections({ ...f, projectRoot })).sources![f.source]!.write_url_env).toBeUndefined();
});
it('refuses conflicting selected writer references on the same unselected Source', async () => {
  const projectRoot = await selectionProject();
  const f = fixture(true, true), setup = disabledSelection(f);
  native.selection.mockImplementation(async input => ({ ...setup, outcome: input.outcome, selection: { ...setup.selection, write_url_env: input.outcome === setup.outcome ? 'ONE_WRITE' : 'OTHER_WRITE' } }));
  await expect(projectHardLimitActivationWriterSelections({ ...f, projectRoot })).rejects.toMatchObject({ code: 'SEMANTIC_ACTION_HARD_LIMIT_WRITER_REQUIRED', readback: { checks: [expect.objectContaining({ reason_code: 'writer_selection_ambiguous' })] } });
});

// Mocked producer regressions only; actual public DP09 remains independent.
function reviewFixture(hard = true) {
  const f = fixture(hard);
  const reviewContext: HardLimitWriterReviewContext = { projectRoot: '/fixture/project',
    sourceConfigPath: '/fixture/project/synapsor.runner.json', outputConfigPath: '/fixture/project/synapsor.actions.runner.json',
    sourceConfigText: JSON.stringify(f.config), draft: { digest: f.authorityDigest },
    executionReview: { digest: f.authorityDigest, epoch: 4 },
    nativePolicy: { project_id: 'fixture-project', deployment_id: 'fixture-deployment', epoch: 4 } };
  return { ...f, reviewContext };
}
it('issues an opaque review identity only after successful native inspection and rollback', async () => {
  const f = reviewFixture(), shown = await inspectReviewedHardLimitWriterSetup(f);
  expect(shown.status).toBe('ready'); expect(shown.writerReviewBinding).toBeDefined();
  expect(JSON.stringify(shown.writerReviewBinding)).toBe('{}');
  expect(JSON.stringify(shown)).not.toContain(f.env.WRITE);
  await expect(assertReviewedHardLimitWriterSetup(f, shown.writerReviewBinding!)).resolves.toBeUndefined();
  expect(native.pool).toHaveBeenCalledTimes(2);
});
it.each(['writer', 'credential', 'receipt', 'native_epoch', 'authority'])('refuses %s drift after the shown writer assessment before opening a new writer', async change => {
  const f = reviewFixture(), shown = await inspectReviewedHardLimitWriterSetup(f);
  const opens = native.pool.mock.calls.length;
  if (change === 'writer') f.config.sources![f.source]!.write_url_env = 'OTHER_WRITE';
  if (change === 'credential') f.env.WRITE = 'postgres://different-fixture-writer';
  if (change === 'receipt') f.config.sources![f.source]!.receipts = { authority: 'runner_ledger' };
  if (change === 'native_epoch') f.reviewContext.nativePolicy!.epoch++;
  if (change === 'authority') f.reviewContext.draft.digest = `sha256:${'b'.repeat(64)}`;
  await expect(assertReviewedHardLimitWriterSetup(f, shown.writerReviewBinding!)).rejects.toMatchObject({ code: 'SEMANTIC_ACTION_WRITER_REVIEW_CHANGED' });
  expect(native.pool).toHaveBeenCalledTimes(opens);
});
it.each(['database', 'schema'])('refuses native %s identity drift despite unchanged selection and ready privilege', async change => {
  const f = reviewFixture(), shown = await inspectReviewedHardLimitWriterSetup(f);
  if (change === 'database') native.identity.database_oid = '5678';
  else native.schemaFingerprint = 'b';
  await expect(assertReviewedHardLimitWriterSetup(f, shown.writerReviewBinding!)).rejects.toMatchObject({ code: 'SEMANTIC_ACTION_WRITER_REVIEW_CHANGED' });
  expect(native.pool).toHaveBeenCalledTimes(2);
});
it('a review identity does not bypass current native privilege refusal', async () => {
  const f = reviewFixture(), shown = await inspectReviewedHardLimitWriterSetup(f);
  native.maintain = false;
  await expect(assertReviewedHardLimitWriterSetup(f, shown.writerReviewBinding!)).rejects.toMatchObject({ code: 'SEMANTIC_ACTION_HARD_LIMIT_WRITER_REQUIRED' });
});
it('does not issue review identity if native rollback becomes unproven', async () => {
  const f = reviewFixture(), query = native.query.getMockImplementation()!;
  native.query.mockImplementation(async (sql: string) => { if (sql === 'ROLLBACK') throw new Error('lost'); return query(sql); });
  const shown = await inspectReviewedHardLimitWriterSetup(f);
  expect(shown.status).toBe('refused'); expect(shown.writerReviewBinding).toBeUndefined();
});
it('rejects a caller-created empty token before a writer connection', async () => {
  await expect(assertReviewedHardLimitWriterSetup(reviewFixture(), {} as HardLimitWriterReviewBinding)).rejects.toMatchObject({ code: 'SEMANTIC_ACTION_WRITER_REVIEW_CHANGED' });
  expect(native.pool).not.toHaveBeenCalled();
});
it('ordinary unmarked authority has no binding or native inspection', async () => {
  const shown = await inspectReviewedHardLimitWriterSetup(reviewFixture(false));
  expect(shown.status).toBe('not_required'); expect(shown.writerReviewBinding).toBeUndefined();
  expect(native.pool).not.toHaveBeenCalled();
});

// Controlled production-setup connection binding only. Real compiler authority,
// simulated driver/catalog responses; no native qualification or public proof.
it.each(['database', 'endpoint', 'postmaster'])('source binding refuses same-role metadata from another %s', async changed => {
  native.inspectionIdentity = { ...native.identity,
    ...(changed === 'database' ? { database: 'other', database_oid: '7777' } : changed === 'endpoint' ? { server_address: '127.0.0.2' } : { system_identifier: '987654321' }) };
  const observe = vi.fn();
  const result = await inspectHardLimitWriterSetup({ ...fixture(), observeNativeAssessment: observe });
  expect(result.status).toBe('refused');
  expect(native.posture).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
  expect(native.query).toHaveBeenCalledWith('ROLLBACK');
  if (changed === 'postmaster') {
    // A physical clone retains the system identifier but has another postmaster.
    native.inspectionIdentity = { ...native.identity, postmaster_start_us: '1791500000000001' };
    expect((await inspectHardLimitWriterSetup({ ...fixture(), observeNativeAssessment: observe })).status).toBe('refused');
    expect(native.posture).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
  }
});
it('source binding refuses an unobserved native postmaster identity', async () => {
  native.inspectionIdentity = { ...native.identity, system_identifier: undefined };
  const result = await inspectHardLimitWriterSetup(fixture());
  expect(result.status).toBe('refused'); expect(native.posture).not.toHaveBeenCalled();
});
it('source binding accepts the actual matching metadata transaction without releasing qualification locks', async () => {
  Object.assign(native.identity, { server_address: null, server_port: null });
  native.inspectionQuery.mockImplementation(async (sql: string) => {
    if (sql === 'COMMIT') expect(native.firstTransactionOpen).toBe(true);
    return { rows: sql.startsWith('SELECT pg_catalog.current_database()') ? [native.identity] : [], rowCount: 0 };
  });
  const observe = vi.fn();
  expect((await inspectHardLimitWriterSetup({ ...fixture(), observeNativeAssessment: observe })).status).toBe('ready');
  expect(native.inspectionQuery.mock.calls.map(call => call[0])).toEqual([
    'BEGIN READ ONLY', expect.stringContaining('SELECT pg_catalog.current_database()'), 'SELECT COMPONENT_METADATA', 'COMMIT']);
  expect(native.query.mock.calls.some(call => call[0] === 'COMMIT')).toBe(false);
  expect(native.firstTransactionOpen).toBe(false); expect(observe).toHaveBeenCalledOnce();
});
it('source binding refuses cached metadata without a native inspection transaction', async () => {
  native.inspectWithConnection.mockImplementation(async options => native.inspect(options));
  expect((await inspectHardLimitWriterSetup(fixture())).status).toBe('refused');
  expect(native.posture).not.toHaveBeenCalled();
});
it('source binding refuses a failed native identity query without observing ready', async () => {
  native.inspectionQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT pg_catalog.current_database()')) throw new Error('private metadata connection failure');
    return { rows: [], rowCount: 0 };
  });
  const observe = vi.fn(); const result = await inspectHardLimitWriterSetup({ ...fixture(), observeNativeAssessment: observe });
  expect(result.status).toBe('refused'); expect(observe).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain('private');
});
it('source binding refuses missing first native identity even without a review observer', async () => {
  native.query.mockImplementation(async (sql: string) => ({ rows:
    sql.startsWith("SELECT pg_catalog.current_setting('server_version_num')") ? [{ version: 170000 }]
      : sql.startsWith('SELECT current_user') ? [{ role: 'dedicated_writer', maintain: true, global_maintain: false, catalog_dml: false }] : [], rowCount: 0 }));
  expect((await inspectHardLimitWriterSetup(fixture())).status).toBe('refused');
  expect(native.inspect).not.toHaveBeenCalled();
});
