import type { ActionRuleCatalogResourceV1, CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import type { RuntimeSourceConfig } from "@synapsor-runner/mcp-server";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { isCompleteCollectionScopeExpression, postgresActionRuleVerificationScope } from "@synapsor-runner/postgres";

export type WriterRowScope = Array<{ field: string; setting: string }>;

function inspectedPrincipal(resource: ActionRuleCatalogResourceV1, tenant: string, tenantSetting: string,
  principalSetting: string, inspection?: SchemaInspection): string | undefined {
  const role = inspection?.role_posture;
  const table = inspection?.tables.find(table => table.schema === resource.schema && table.name === resource.table);
  const posture = table?.role_posture;
  if (inspection?.engine !== "postgres" || !role?.verified || role.superuser !== false || role.bypass_rls !== false
    || table?.type !== "table" || !table.row_level_security || !posture?.row_security_forced
    || !posture.row_security_effective_for_current_role || posture.current_role_is_owner !== false
    || posture.current_role_can_assume_owner !== false || tenantSetting === principalSetting) return undefined;
  const policies = table.row_level_security_policies?.filter(policy => policy.command === "SELECT") ?? [];
  if (!policies.some(policy => posture.row_security_applicable_policies?.includes(policy.name))) return undefined;
  const uuidColumns = new Set(table.columns.filter(column => column.data_type === "uuid").map(column => column.name));
  // An RLS-scoped Action need not repeat a private principal column. Recover
  // only one exact two-identity equality from inspected policy, never a name.
  const candidates = resource.fields.filter(field => field.name !== tenant && table.columns.some(column => column.name === field.name))
    .filter(field => policies.every(policy => policy.permissive && policy.using_expression
      && isCompleteCollectionScopeExpression(policy.using_expression,
        new Map([[tenant, tenantSetting], [field.name, principalSetting]]), uuidColumns)));
  return candidates.length === 1 ? candidates[0]!.name : undefined;
}

/** Metadata for an administrator's policy repair, not a new runtime permission. */
export function collectWriterRowScopes(compiled: CompiledActionRuleV1, source: RuntimeSourceConfig,
  result: Map<string, WriterRowScope | null>, inspection?: SchemaInspection): void {
  const database = source.database_scope;
  if (database?.mode !== "postgres_rls") return;
  const add = (resource: ActionRuleCatalogResourceV1, tenant: string | undefined, principal: string | undefined, principalSetting?: string) => {
    const relation = `${resource.schema}.${resource.table}`;
    const prior = result.get(relation);
    if (prior === null) return;
    if (tenant && principalSetting && !principal) principal = inspectedPrincipal(resource, tenant, database.tenant_setting, principalSetting, inspection);
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
    add(binding.resource, scope.tenant_field, scope.principal_field, expected.principalSetting);
  }
  for (const target of [compiled.target_resource, ...(compiled.atomic_updates?.map(effect => effect.target_resource) ?? [])]) {
    add(target, target.tenant_key, target.principal_scope_key, database.principal_setting);
  }
}
