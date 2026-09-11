import type { CompiledActionRuleV1 } from "@synapsor-runner/action-rules";
import type { RuntimeSourceConfig } from "@synapsor-runner/mcp-server";
import { isCompleteCollectionScopeExpression } from "@synapsor-runner/postgres";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";

/** Metadata-only deployment evidence. Runtime rechecks the same proofs with
 * actual scoped facts and locks; a draft never needs concrete customer values. */
export function actionRuleCollectionReadiness(input: {
  compiled: CompiledActionRuleV1;
  inspection: SchemaInspection;
  source: RuntimeSourceConfig;
  connection: "reader" | "writer";
}): Array<{ relation: string; reason: string }> {
  const issues: Array<{ relation: string; reason: string }> = [];
  for (const binding of input.compiled.bindings) {
    if (binding.verification.collection_consistency !== "complete_locked") continue;
    const relation = `${binding.resource.schema}.${binding.resource.table}`;
    const table = input.inspection.tables.find(table => `${table.schema}.${table.name}` === relation);
    if (!table || table.type !== "table") {
      issues.push({ relation, reason: "The complete set of related records must be an inspected database table. Refresh the saved database review." });
      continue;
    }
    const foreignKey = table.foreign_keys.find(key => key.name === binding.relationship?.name);
    if (!foreignKey || foreignKey.deferrable || foreignKey.action_rule_issue) {
      issues.push({ relation, reason: "Checking all related records needs a validated, immediate foreign key. Review this database constraint; additional writer grants cannot repair it." });
    }
    if (input.inspection.engine !== "postgres" || table.row_level_security === false) continue;
    const scope = binding.verification.scope;
    const database = input.source.database_scope;
    if (table.row_level_security !== true || scope.mode !== "columns" || database?.mode !== "postgres_rls"
      || (scope.principal_field && !database.principal_setting)) {
      issues.push({ relation, reason: "Runner cannot yet prove that customer filtering includes every related record. Review the database's customer-scope settings before using absence or totals." });
      continue;
    }
    const settings = new Map([[scope.tenant_field, database.tenant_setting]]);
    if (scope.principal_field) settings.set(scope.principal_field, database.principal_setting!);
    const applicable = table.role_posture?.row_security_applicable_policies;
    if (!applicable) {
      issues.push({ relation, reason: "Applicable customer-filter policies have not been checked for this connection. Refresh the database review." });
      continue;
    }
    const operations = input.connection === "writer" ? ["SELECT", "UPDATE"] : ["SELECT"];
    const uuidColumns = new Set(table.columns.filter(column => column.data_type === "uuid").map(column => column.name));
    for (const operation of operations) {
      const policies = (table.row_level_security_policies ?? []).filter(policy => applicable.includes(policy.name)
        && (policy.command === "ALL" || policy.command === operation));
      if (!policies.some(policy => policy.permissive)
        || policies.some(policy => !policy.using_expression || !isCompleteCollectionScopeExpression(policy.using_expression, settings, uuidColumns))) {
        issues.push({ relation, reason: `The ${operation === "UPDATE" ? "write/locking" : "read"} connection cannot prove it sees every related record for this customer. A missing policy or an extra row filter makes absence and totals unsafe. Review the exact database policies, then recheck; do not remove the business condition.` });
      }
    }
  }
  return issues;
}
