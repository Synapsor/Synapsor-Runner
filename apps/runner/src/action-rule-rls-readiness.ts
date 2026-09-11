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
  if (input.inspection.engine !== "postgres" || scope?.mode !== "postgres_rls") return [];
  const targets = new Map<string, Set<PostgresRlsOperation>>();
  const principalRequired = new Set<string>();
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
      input.connection === "writer" && binding.verification.collection_consistency === "complete_locked" ? ["SELECT", "UPDATE"] : ["SELECT"],
      verificationScope.principalSetting !== undefined);
  }
  if (input.connection === "writer") {
    add(input.compiled.target_resource.schema, input.compiled.target_resource.table,
      ["SELECT", input.compiled.effect_envelope.operation === "insert" ? "INSERT" : "UPDATE"]);
    for (const effect of input.compiled.atomic_updates ?? []) add(effect.target_resource.schema, effect.target_resource.table, ["SELECT", "UPDATE"]);
  }
  return [...targets].flatMap(([relation, operations]) => {
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
      ...(principalRequired.has(relation) ? { principal_setting: scope.principal_setting } : {}) });
    return errors.map(code => ({ relation, reason: code === "POSTGRES_RLS_FORCE_DISABLED"
      ? "FORCE ROW LEVEL SECURITY is required but not enabled. An administrator must review this table's filtering, enable FORCE only after review, then rescan and revalidate the saved job. Additional writer grants alone do not fix this."
      : `${code}. An administrator must review this connection's row-filtering policies, then rescan and revalidate the saved job; no policy was changed.` }));
  });
}
