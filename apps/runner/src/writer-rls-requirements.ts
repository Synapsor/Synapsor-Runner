import type { CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import type { RuntimeSourceConfig } from "@synapsor-runner/mcp-server";
import { postgresActionRuleVerificationScope } from "@synapsor-runner/postgres";

export type WriterRowScope = Array<{ field: string; setting: string }>;

/** Metadata for an administrator's policy repair, not a new runtime permission. */
export function collectWriterRowScopes(compiled: CompiledActionRuleV1, source: RuntimeSourceConfig,
  result: Map<string, WriterRowScope | null>): void {
  const database = source.database_scope;
  if (database?.mode !== "postgres_rls") return;
  const add = (relation: string, tenant: string | undefined, principal: string | undefined, principalSetting?: string) => {
    const prior = result.get(relation);
    if (prior === null) return;
    if (!tenant || (principalSetting && !principal)) { result.set(relation, null); return; }
    const next = [{ field: tenant, setting: database.tenant_setting },
      ...(principalSetting ? [{ field: principal!, setting: principalSetting }] : [])];
    const byField = new Map((prior ?? []).map(item => [item.field, item.setting]));
    for (const item of next) {
      if ((byField.has(item.field) && byField.get(item.field) !== item.setting)
        || [...byField].some(([field, setting]) => field !== item.field && setting === item.setting)) {
        result.set(relation, null); return;
      }
      byField.set(item.field, item.setting);
    }
    result.set(relation, [...byField].sort(([a], [b]) => a.localeCompare(b)).map(([field, setting]) => ({ field, setting })));
  };
  for (const binding of compiled.bindings) {
    const relation = `${binding.resource.schema}.${binding.resource.table}`;
    const scope = binding.verification.scope;
    if (scope.mode !== "columns") { result.set(relation, null); continue; }
    const expected = postgresActionRuleVerificationScope(binding, { tenantSetting: database.tenant_setting,
      ...(database.principal_setting ? { principalSetting: database.principal_setting } : {}) });
    add(relation, scope.tenant_field, scope.principal_field, expected.principalSetting);
  }
  for (const target of [compiled.target_resource, ...(compiled.atomic_updates?.map(effect => effect.target_resource) ?? [])]) {
    add(`${target.schema}.${target.table}`, target.tenant_key, target.principal_scope_key, database.principal_setting);
  }
}
