import type { CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import type { RuntimeSourceConfig } from "@synapsor-runner/mcp-server";
import { postgresActionRuleVerificationScope, postgresRlsPrerequisiteErrors,
  type PostgresRlsOperation, type PostgresRlsPolicyInspection } from "@synapsor-runner/postgres";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";

/** No customer values or source-row reads: use inspected policy applicability for this connection. */
export function actionRuleRlsReadiness(input: {
  compiled: CompiledActionRuleV1; inspection: SchemaInspection; source: Pick<RuntimeSourceConfig, "engine" | "database_scope">;
  connection: "reader" | "writer";
}): Array<{ relation: string; reason: string }> {
  const scope = input.source.database_scope;
  if (input.inspection.engine !== "postgres") return [];
  const lockingPrerequisites: Array<{ relation: string; reason: string }> = [];
  const singletonLocks = new Set<string>();
  for (const binding of input.compiled.bindings) if (binding.verification.evidence_mode === "required_scoped_singleton") {
    singletonLocks.add(binding.binding);
    if (binding.verification.source.kind === "relationship") singletonLocks.add(binding.verification.source.from_binding);
  }
  if (input.connection === "writer") for (const binding of input.compiled.bindings) if (singletonLocks.has(binding.binding)) {
    const table = input.inspection.tables.find(table => table.schema === binding.resource.schema && table.name === binding.resource.table);
    const posture = table?.role_posture;
    const role = input.inspection.role_posture;
    const selected = new Set(posture?.column_privileges?.select ?? []);
    const allSelected = posture?.privileges?.select === true || binding.verification.fields.every(field => selected.has(field.name));
    const lockPrivilege = posture?.privileges?.update === true
      || (posture?.column_privileges?.update ?? []).some(name => table?.columns.some(column => column.name === name));
    if (!table || table.type !== "table" || role?.verified !== true || role.superuser !== false || role.bypass_rls !== false
      || posture?.current_role_is_owner !== false || posture.current_role_can_assume_owner !== false || !allSelected || !lockPrivilege) {
      lockingPrerequisites.push({ relation: `${binding.resource.schema}.${binding.resource.table}`,
        reason: "Required singleton revalidation needs a separately reviewed non-owner writer with SELECT on the exact verification fields and UPDATE on at least one explicitly reviewed column for row locking. No grant was changed; broad table UPDATE is not required." });
    }
  }
  if (scope?.mode !== "postgres_rls") return lockingPrerequisites;
  const targets = new Map<string, Set<PostgresRlsOperation>>();
  const principalRequired = new Set<string>();
  const mutationRelations = new Set<string>();
  const add = (schema: string, table: string, operations: PostgresRlsOperation[], principal = scope.principal_setting !== undefined) => {
    const relation = `${schema}.${table}`;
    const existing = targets.get(relation) ?? new Set<PostgresRlsOperation>();
    for (const operation of operations) existing.add(operation);
    targets.set(relation, existing);
    if (principal) principalRequired.add(relation);
  };
  for (const binding of input.compiled.bindings) {
    const verificationScope = postgresActionRuleVerificationScope(binding, { tenantSetting: scope.tenant_setting,
      ...(scope.principal_setting ? { principalSetting: scope.principal_setting } : {}) });
    add(binding.resource.schema, binding.resource.table,
      input.connection === "writer" && (binding.verification.collection_consistency === "complete_locked" || singletonLocks.has(binding.binding)) ? ["SELECT", "UPDATE"] : ["SELECT"],
      verificationScope.principalSetting !== undefined);
  }
  if (input.connection === "writer") {
    mutationRelations.add(`${input.compiled.target_resource.schema}.${input.compiled.target_resource.table}`);
    add(input.compiled.target_resource.schema, input.compiled.target_resource.table,
      input.compiled.effect_envelope.operation === "insert" ? ["SELECT", "INSERT", "UPDATE"] : ["SELECT", "UPDATE"]);
    for (const effect of input.compiled.atomic_updates ?? []) {
      mutationRelations.add(`${effect.target_resource.schema}.${effect.target_resource.table}`);
      add(effect.target_resource.schema, effect.target_resource.table, ["SELECT", "UPDATE"]);
    }
  }
  return [...lockingPrerequisites, ...[...targets].flatMap(([relation, operations]) => {
    const table = input.inspection.tables.find(table => `${table.schema}.${table.name}` === relation);
    const posture = table?.role_posture;
    if (!table || table.type !== "table" || !posture || !posture.row_security_applicable_policies
      || !input.inspection.role_posture?.verified) {
      return [{ relation, reason: "Database row-filtering prerequisites have not been verified for this connection. Refresh the saved database review; do not bypass filtering." }];
    }
    const policies = (table.row_level_security_policies ?? [])
      .filter(policy => posture.row_security_applicable_policies!.includes(policy.name))
      .map(policy => ({ name: policy.name, command: policy.command as PostgresRlsPolicyInspection["command"],
        permissive: policy.permissive, using_expression: policy.using_expression, with_check_expression: policy.check_expression }));
    const errors = postgresRlsPrerequisiteErrors({ row_security_enabled: table.row_level_security === true,
      force_row_security: posture.row_security_forced === true,
      role_is_superuser: input.inspection.role_posture.superuser !== false,
      role_has_bypassrls: input.inspection.role_posture.bypass_rls !== false,
      role_is_table_owner: posture.current_role_is_owner !== false,
      role_can_assume_table_owner: posture.current_role_can_assume_owner !== false,
      policies, required_operations: [...operations], tenant_setting: scope.tenant_setting,
      ...(input.connection === "writer" && (input.compiled.effect_envelope.operation === "insert"
        && relation === `${input.compiled.target_resource.schema}.${input.compiled.target_resource.table}`
        || !mutationRelations.has(relation) && input.compiled.bindings.some(binding => singletonLocks.has(binding.binding)
          && `${binding.resource.schema}.${binding.resource.table}` === relation)) ? { update_purpose: "row_lock" as const } : {}),
      ...(principalRequired.has(relation) ? { principal_setting: scope.principal_setting } : {}) });
    return errors.map(code => ({ relation, reason: code === "POSTGRES_RLS_FORCE_DISABLED"
      ? "FORCE ROW LEVEL SECURITY is required but not enabled. An administrator must review this table's filtering, enable FORCE only after review, then rescan and revalidate the saved job. Additional writer grants alone do not fix this."
      : `${code}. An administrator must review this connection's row-filtering policies, then rescan and revalidate the saved job; no policy was changed.` }));
  })];
}
