import process from 'node:process';
import type { PoolClient } from 'pg';
import { ActionRuleError, type RuntimeActionRuleRegistryV1 } from '@synapsor-runner/action-rules';
import { resolveSemanticSupervisedWriterSource, type RuntimeConfig, type RuntimeSupervisedWorkerOutcomePolicy } from '@synapsor-runner/mcp-server';
import { assertPostgresHardLimitSource, createPostgresPool } from '@synapsor-runner/postgres';
import { inspectDatabase, rolePostureFingerprint } from '@synapsor-runner/schema-inspector';
import { assessSemanticSupervisedWriterPosture } from './worker-policy.js';

export type HardLimitWriterSetupInput = {
  registry: RuntimeActionRuleRegistryV1;
  config: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  outcome?: string;
};
export type HardLimitWriterSetupReadback = {
  status: 'not_required' | 'ready' | 'refused';
  requirements: Array<{ source: string; outcomes: string[]; engine: 'postgres'; namespace_relation: 'pg_catalog.pg_namespace'; privilege: 'MAINTAIN'; additional_powers: string[] }>;
  checks: Array<{ source: string; outcome: string; writer_env?: string; writer_role?: string; status: 'ready' | 'refused'; reason_code?: string; native_path?: string }>;
};
export class HardLimitWriterSetupError extends Error {
  readonly code = 'SEMANTIC_ACTION_HARD_LIMIT_WRITER_REQUIRED';
  constructor(readonly readback: HardLimitWriterSetupReadback) {
    super(`SEMANTIC_ACTION_HARD_LIMIT_WRITER_REQUIRED: ${hardLimitWriterSetupLines(readback).join(' ')}`);
    this.name = 'HardLimitWriterSetupError';
  }
}
export function hardLimitWriterSetupLines(readback: HardLimitWriterSetupReadback): string[] {
  if (readback.status === 'not_required') return [];
  const supported = readback.checks.filter(check => check.reason_code !== 'hard_limit_engine_unsupported');
  const grants = [...new Set(supported.map(check => `Current profile requires (administrator review, no grant executed) for ${check.source}/${check.outcome}: GRANT MAINTAIN ON TABLE pg_catalog.pg_namespace TO ${check.writer_role ? quote(check.writer_role) : '"<selected dedicated writer, not yet inspected>"'}; (no grant option).`))];
  return [
    ...(supported.length ? ['Hard-limit setup requires PostgreSQL 17 and an inspected dedicated writer before Action activation.', ...grants,
      'The Source guard takes a SHARE lock on the entire pg_catalog.pg_namespace catalog table.',
      'MAINTAIN also permits maintenance and all table lock modes on this catalog relation, subject to PostgreSQL restrictions; it grants no catalog row mutation.'] : []),
    ...(readback.checks.some(check => ['writer_not_selected', 'writer_connection_missing'].includes(check.reason_code ?? '')) ? ['Before activation, review the existing disabled setup: synapsor-runner writeback setup --disabled --project-root . --outcome <outcome> --receipt-mode <mode> --write-url-env <NAME>. Save its exact reviewed selection, provision the dedicated writer, then recheck. This selects setup only; execution needs separate consent.'] : []),
    ...readback.checks.map(check => check.reason_code === 'hard_limit_engine_unsupported'
      ? `${check.source}/${check.outcome}: hard-limit Source verification is unsupported for this engine. No namespace grant applies or enables this capability.`
      : `${check.outcome}: ${check.writer_env ?? 'writer not selected'}${check.writer_role ? ` (role ${check.writer_role})` : ''}: ${check.status}${check.reason_code ? ` (${check.reason_code})` : ''}${check.native_path ? ` [${check.native_path}]` : ''}.`),
  ];
}

/** Fresh bounded native inspection, never a cached execution permit. No business
 * rows, human identity, effect execution, or credential URLs enter the readback. */
export async function inspectHardLimitWriterSetup(input: HardLimitWriterSetupInput): Promise<HardLimitWriterSetupReadback> {
  const rules = input.registry.rules.filter(({ compiled }) => compiled.hard_limit && (!input.outcome || compiled.outcome === input.outcome));
  const readback: HardLimitWriterSetupReadback = { status: rules.length ? 'ready' : 'not_required', requirements: [], checks: [] };
  const env = input.env ?? process.env;
  for (const { compiled } of rules) {
    const configuredEngine = input.config.sources?.[compiled.source]?.engine;
    let requirement = readback.requirements.find(item => item.source === compiled.source);
    if (!requirement && configuredEngine !== 'mysql') {
      requirement = { source: compiled.source, outcomes: [], engine: 'postgres', namespace_relation: 'pg_catalog.pg_namespace', privilege: 'MAINTAIN', additional_powers: ['VACUUM', 'ANALYZE', 'CLUSTER', 'REINDEX', 'REFRESH MATERIALIZED VIEW', 'all table lock modes (subject to native object restrictions)'] };
      readback.requirements.push(requirement);
    }
    requirement?.outcomes.push(compiled.outcome);
    const check: HardLimitWriterSetupReadback['checks'][number] = { source: compiled.source, outcome: compiled.outcome, status: 'refused' };
    readback.checks.push(check);
    const refuse = (reason: string) => { check.reason_code = reason; readback.status = 'refused'; };
    if (configuredEngine === 'mysql') { refuse('hard_limit_engine_unsupported'); continue; }
    const existing = input.config.supervised_worker?.outcomes?.filter(policy => policy.outcome === compiled.outcome) ?? [];
    if (existing.length > 1) { refuse('writer_selection_ambiguous'); continue; }
    const source = existing[0] ? resolveSemanticSupervisedWriterSource(input.config, compiled.source, existing[0]) : input.config.sources?.[compiled.source];
    if (!source || source.read_only === true || !source.write_url_env) { refuse('writer_not_selected'); continue; }
    check.writer_env = source.write_url_env;
    if (source.engine !== 'postgres') { refuse('hard_limit_engine_unsupported'); continue; }
    const url = env[source.write_url_env]?.trim();
    if (!url) { refuse('writer_connection_missing'); continue; }
    if (source.write_url_env === source.read_url_env || url === env[source.read_url_env]?.trim()) { refuse('writer_is_reader'); continue; }
    if (source.database_scope?.mode !== 'postgres_rls' || !source.database_scope.principal_setting || source.receipts?.provisioning === 'auto_migrate') { refuse('hard_limit_source_profile_unsupported'); continue; }
    let pool: ReturnType<typeof createPostgresPool> | undefined;
    let client: PoolClient | undefined;
    let began = false;
    try {
      pool = createPostgresPool(url, { max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, idleTimeoutMillis: 5_000 });
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED'); began = true;
      await client.query("SET LOCAL statement_timeout = '5s'");
      const engine = await client.query("SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4 AS version");
      if (Number(engine.rows[0]?.version) < 170000 || Number(engine.rows[0]?.version) >= 180000 || !Number.isInteger(Number(engine.rows[0]?.version))) { refuse('hard_limit_engine_profile_unsupported'); continue; }
      const role = await client.query("SELECT current_user AS role,pg_catalog.has_table_privilege(current_user,'pg_catalog.pg_namespace','MAINTAIN') AS maintain,pg_catalog.pg_has_role(current_user,'pg_maintain','USAGE') AS global_maintain,pg_catalog.has_table_privilege(current_user,'pg_catalog.pg_namespace','UPDATE,DELETE,TRUNCATE') AS catalog_dml");
      if (typeof role.rows[0]?.role === 'string') check.writer_role = role.rows[0].role;
      if (role.rows.length !== 1 || role.rows[0]?.maintain !== true) { refuse('namespace_maintain_missing'); check.native_path = 'source.hard_limit.namespace_acl'; }
      else if (role.rows[0]?.global_maintain !== false || role.rows[0]?.catalog_dml !== false) refuse('namespace_maintain_overbroad');
      else {
        const receipt = source.receipts?.authority === 'source_db' ? { table: `${quote(source.receipts.schema ?? 'public')}.${quote(source.receipts.table ?? 'synapsor_writeback_receipts')}`, provisioning: 'precreated' as const } : undefined;
        await assertPostgresHardLimitSource(client, compiled, { tenantSetting: source.database_scope.tenant_setting, principalSetting: source.database_scope.principal_setting }, receipt);
        // Existing metadata posture checks supply the ordinary business/receipt
        // privilege and RLS envelope. The connection is the selected writer.
        const inspection = await inspectDatabase({ engine: 'postgres', databaseUrlEnv: source.write_url_env, statementTimeoutMs: 5_000, env });
        if (inspection.current_user !== check.writer_role) { refuse('writer_role_changed'); continue; }
        const policies: RuntimeSupervisedWorkerOutcomePolicy[] = input.registry.rules.filter(entry => {
          const policy = input.config.supervised_worker?.outcomes?.find(p => p.outcome === entry.compiled.outcome);
          const selected = policy ? resolveSemanticSupervisedWriterSource(input.config, entry.compiled.source, policy) : input.config.sources?.[entry.compiled.source];
          return selected?.write_url_env === source.write_url_env && entry.compiled.effect_envelope.writeback.mode === 'direct_sql' && entry.compiled.effect_envelope.writeback.supervised_worker === 'allowed';
        }).map(entry => ({ outcome: entry.compiled.outcome, action_boundary_digest: entry.action_boundary_digest, mode: 'supervised_worker', concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5, proposal_ttl_seconds: 86400, rate_limit: { executions: 60, window_seconds: 60 }, write_url_env: source.write_url_env!, require_least_privilege_writer: true, writer_posture_fingerprint: rolePostureFingerprint(inspection) }));
        const policy = policies.find(item => item.outcome === compiled.outcome);
        if (!policy) refuse('hard_limit_execution_profile_unsupported');
        else {
          const candidate = { ...input.config, supervised_worker: { enabled: false, profile: 'development' as const, capabilities: [], outcomes: policies } };
          const assessment = assessSemanticSupervisedWriterPosture(candidate, policy, input.registry, inspection);
          if (!assessment.ok) refuse('writer_posture_unproven');
          else check.status = 'ready';
        }
      }
    } catch (error) {
      refuse('native_source_uninspectable');
      if (error instanceof ActionRuleError && typeof error.path === 'string' && /^source\.(hard_limit|receipt_read)\.[a-z_]+$/u.test(error.path)) check.native_path = error.path;
    } finally {
      if (client) {
        if (began) { try { await client.query('ROLLBACK'); } catch { check.status = 'refused'; refuse('setup_rollback_unproven'); } }
        client.release(true);
      }
      try { await pool?.end(); } catch { check.status = 'refused'; refuse('setup_connection_close_unproven'); }
    }
  }
  return readback;
}
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
/** Reopen every writer and repeat inspection at each publication. */
export async function assertHardLimitWriterSetup(input: HardLimitWriterSetupInput): Promise<void> {
  const readback = await inspectHardLimitWriterSetup(input);
  if (readback.status === 'refused') throw new HardLimitWriterSetupError(readback);
}
