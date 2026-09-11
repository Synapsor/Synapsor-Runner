import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { isCompleteCollectionScopeExpression } from "@synapsor-runner/postgres";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";

export type InspectedScopeMapping = {
  tenant: { field: string; setting: string };
  principal: { field: string; setting: string };
  policy_names: string[];
  policy_fingerprint: `sha256:${string}`;
};

/** A closed SELECT row-scope proof, not a permission, business predicate or SQL egress. */
export function inspectedPostgresScopeMapping(input: {
  inspection?: SchemaInspection;
  resource: { schema: string; table: string; fields: readonly string[] };
  tenantField: string;
  tenantSetting: string;
  principalSetting: string;
}): InspectedScopeMapping | undefined {
  const { inspection, resource, tenantField, tenantSetting, principalSetting } = input;
  const role = inspection?.role_posture;
  if (inspection?.engine !== "postgres" || role?.verified !== true
    || role.superuser !== false || role.bypass_rls !== false
    || !tenantField || !tenantSetting || !principalSetting || tenantSetting === principalSetting
    || new Set(resource.fields).size !== resource.fields.length || !resource.fields.includes(tenantField)) return undefined;
  const tables = inspection.tables.filter(table => table.schema === resource.schema && table.name === resource.table);
  if (tables.length !== 1) return undefined;
  const table = tables[0]!, posture = table.role_posture;
  if (table.type !== "table" || table.row_level_security !== true || posture?.row_security_forced !== true
    || posture.row_security_effective_for_current_role !== true || posture.current_role_is_owner !== false
    || posture.current_role_can_assume_owner !== false
    || new Set(table.columns.map(column => column.name)).size !== table.columns.length) return undefined;
  const policies = table.row_level_security_policies ?? [];
  if (new Set(policies.map(policy => policy.name)).size !== policies.length
    || policies.some(policy => !["SELECT", "ALL", "INSERT", "UPDATE", "DELETE"].includes(policy.command))) return undefined;
  // ALL also grants SELECT. Ignore neither a widening ALL policy nor an unknown
  // posture; conservatively require every SELECT-capable policy to have this shape.
  const selectPolicies = policies.filter(policy => policy.command === "SELECT" || policy.command === "ALL");
  if (!selectPolicies.some(policy => posture.row_security_applicable_policies?.includes(policy.name))) return undefined;
  const columns = new Set(table.columns.map(column => column.name));
  if (!columns.has(tenantField)) return undefined;
  const uuidColumns = new Set(table.columns.filter(column => column.data_type === "uuid").map(column => column.name));
  const candidates = resource.fields.filter(field => field !== tenantField && columns.has(field))
    .filter(field => selectPolicies.every(policy => policy.permissive === true && policy.using_expression
      && isCompleteCollectionScopeExpression(policy.using_expression,
        new Map([[tenantField, tenantSetting], [field, principalSetting]]), uuidColumns)));
  if (candidates.length !== 1) return undefined;
  return { tenant: { field: tenantField, setting: tenantSetting },
    principal: { field: candidates[0]!, setting: principalSetting },
    policy_names: selectPolicies.map(policy => policy.name).sort(),
    policy_fingerprint: canonicalJsonDigest([...selectPolicies].sort((a, b) => a.name.localeCompare(b.name))),
  };
}
