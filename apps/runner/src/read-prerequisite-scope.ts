import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ACTION_RULE_CATALOG_VERSION, actionRuleRelationshipPairs, type ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { actionRuleRelationshipsForTable, actionRuleTypeForColumn } from "./action-rule-schema-metadata.js";

/** Local host evidence only. Never append this object to Read authority or model metadata. */
export type ReadPrerequisiteScopeEvidence = { retained_action_catalogs: readonly ActionRuleCatalogV1[] };

export type ReadPrerequisiteScopeBoundaryContext = {
  source?: string;
  generation_lock_fingerprint?: `sha256:${string}`;
  scopeEvidence?: ReadPrerequisiteScopeEvidence;
  pack: { resources: Array<{
    id?: string;
    schema?: string;
    table?: string;
    tenant_key?: string;
    principal_key?: string;
    tenant_scope?: unknown;
    principal_scope?: unknown;
    field_types?: Record<string, string>;
    rls_session?: { tenant_setting?: string; principal_setting?: string };
  }> };
};

type Source = { schema: string; table: string };
type Roles = { tenant_column?: string; principal_column?: string };
type CompleteRoles = Required<Roles>;
type Claim = Roles & { evidence: unknown };
export type ReadPrerequisiteScopeResolution =
  | { state: "proven"; subject: CompleteRoles; proof_digest: `sha256:${string}`; details: string[] }
  | { state: "missing"; reason: string };

function refuse(code: "STALE" | "CONFLICT" | "AMBIGUOUS", reason: string): never {
  throw new Error(`READ_PREREQUISITE_SCOPE_${code}: ${reason} Reopen exact scope review; no private condition or authority changed.`);
}

function tableId(table: Pick<TableInfo, "schema" | "name">): string { return `${table.schema}.${table.name}`; }

function requiredColumn(table: TableInfo, name: string) {
  const columns = table.columns.filter(column => column.name === name);
  if (columns.length !== 1 || columns[0]!.nullable || !actionRuleTypeForColumn(columns[0]!)) {
    refuse("STALE", `${tableId(table)}.${name} requires its exact inspected non-null portable identity field.`);
  }
  return columns[0]!;
}

function columnProof(table: TableInfo, name: string) {
  const column = requiredColumn(table, name);
  return { name, data_type: column.data_type, nullable: column.nullable, enum_values: column.enum_values ?? [] };
}

function mergeClaims(table: TableInfo, claims: Claim[]): Roles {
  const roles: Roles = {};
  for (const claim of claims) {
    for (const role of ["tenant_column", "principal_column"] as const) {
      const value = claim[role];
      if (value === undefined) continue;
      if (roles[role] !== undefined && roles[role] !== value) {
        refuse("CONFLICT", `${tableId(table)} has incompatible reviewed ${role} bindings ${roles[role]} and ${value}.`);
      }
      roles[role] = value;
    }
  }
  if (roles.tenant_column !== undefined && roles.tenant_column === roles.principal_column) {
    refuse("CONFLICT", `${tableId(table)} cannot use the same field for organization and person.`);
  }
  return roles;
}

function directClaims(table: TableInfo, inspection: SchemaInspection, boundary: ReadPrerequisiteScopeBoundaryContext): Claim[] {
  const claims: Claim[] = [];
  for (const resource of boundary.pack.resources.filter(resource => resource.schema === table.schema && resource.table === table.name)) {
    const roles: Roles = {};
    for (const [role, field, derived] of [
      ["tenant_column", resource.tenant_key, resource.tenant_scope],
      ["principal_column", resource.principal_key, resource.principal_scope],
    ] as const) {
      if (field === undefined) continue;
      if (derived) refuse("CONFLICT", `${tableId(table)} has both direct and derived reviewed ${role}.`);
      const current = requiredColumn(table, field);
      if (resource.field_types && resource.field_types[field]?.trim().toLowerCase() !== current.data_type.trim().toLowerCase()) {
        refuse("STALE", `${tableId(table)}.${field} no longer matches its reviewed Read type.`);
      }
      roles[role] = field;
    }
    if (roles.tenant_column || roles.principal_column) claims.push({ ...roles, evidence: { kind: "read", source: tableId(table),
      roles, fields: Object.values(roles).map(field => columnProof(table, field)) } });
  }
  for (const catalog of boundary.scopeEvidence?.retained_action_catalogs ?? []) {
    if (!boundary.source || !boundary.generation_lock_fingerprint || catalog.schema_version !== ACTION_RULE_CATALOG_VERSION
      || catalog.generation_lock_fingerprint !== boundary.generation_lock_fingerprint) {
      refuse("STALE", "Retained Action scope evidence must match the current source and generation lock.");
    }
    const resources = catalog.resources.filter(resource => resource.schema === table.schema && resource.table === table.name);
    if (resources.length > 1) refuse("AMBIGUOUS", `${tableId(table)} has duplicate physical resources in a retained Action catalog.`);
    for (const resource of resources) {
      if (resource.source !== boundary.source || resource.engine !== inspection.engine) {
        refuse("STALE", `${tableId(table)} retained Action scope belongs to a different source or engine.`);
      }
      const roles: Roles = {};
      for (const [role, field] of [["tenant_column", resource.tenant_key], ["principal_column", resource.principal_scope_key]] as const) {
        if (field === undefined) continue;
        const column = requiredColumn(table, field);
        const expected = { name: field, nullable: column.nullable, type: actionRuleTypeForColumn(column) };
        const saved = resource.fields.filter(candidate => candidate.name === field);
        if (saved.length !== 1 || canonicalJsonDigest(expected) !== canonicalJsonDigest(saved[0]!)) {
          refuse("STALE", `${tableId(table)}.${field} no longer matches its retained Action guard metadata.`);
        }
        roles[role] = field;
      }
      if (roles.tenant_column || roles.principal_column) claims.push({ ...roles, evidence: { kind: "retained_action", source: tableId(table),
        generation_lock_fingerprint: catalog.generation_lock_fingerprint, resource: resource.name,
        roles, fields: Object.values(roles).map(field => columnProof(table, field)) } });
    }
  }
  return claims;
}

/** Proves identity roles, not business eligibility. No source rows, RLS changes or metadata egress. */
export function resolveReadPrerequisiteScope(
  inspection: SchemaInspection,
  boundary: ReadPrerequisiteScopeBoundaryContext,
  source: Source,
): ReadPrerequisiteScopeResolution {
  if ((boundary.scopeEvidence?.retained_action_catalogs.length ?? 0) > 16) {
    refuse("AMBIGUOUS", "Scope review is bounded to 16 exact retained Action catalogs.");
  }
  const matches = inspection.tables.filter(table => table.schema === source.schema && table.name === source.table);
  if (matches.length !== 1 || matches[0]!.type !== "table") refuse("STALE", `${source.schema}.${source.table} must be one inspected base table.`);
  const table = matches[0]!;
  const claims = directClaims(table, inspection, boundary), known = mergeClaims(table, claims);
  const proven = (roles: CompleteRoles, evidence: unknown, details: string[]): ReadPrerequisiteScopeResolution => ({
    state: "proven", subject: roles, proof_digest: canonicalJsonDigest({ source, roles, evidence }), details,
  });
  if (known.tenant_column && known.principal_column) {
    return proven(known as CompleteRoles, claims.map(claim => claim.evidence), [
      `${tableId(table)}: exact reviewed organization=${known.tenant_column}; person=${known.principal_column}.`,
    ]);
  }
  if (new Set(table.foreign_keys.map(key => key.name)).size !== table.foreign_keys.length) {
    refuse("AMBIGUOUS", `${tableId(table)} has duplicate foreign-key identifiers.`);
  }
  const paths: Array<{ roles: CompleteRoles; evidence: unknown; details: string[] }> = [];
  const diagnostics: string[] = [];
  for (const foreignKey of table.foreign_keys) {
    const targets = inspection.tables.filter(target => target.schema === foreignKey.referenced_schema && target.name === foreignKey.referenced_table);
    if (targets.length !== 1 || targets[0]!.type !== "table") continue;
    const parent = targets[0]!;
    if (parent === table) continue;
    const parentClaims = directClaims(parent, inspection, boundary), parentRoles = mergeClaims(parent, parentClaims);
    if (!parentRoles.tenant_column || !parentRoles.principal_column) continue;
    if (foreignKey.deferrable) { diagnostics.push(`${foreignKey.name} is deferred, not immediate`); continue; }
    const issues: Parameters<typeof actionRuleRelationshipsForTable>[3] = [];
    const relationships = actionRuleRelationshipsForTable({ ...table, foreign_keys: [foreignKey] },
      new Map([[tableId(table), table], [tableId(parent), parent]]), new Set([tableId(table), tableId(parent)]), issues);
    diagnostics.push(...issues.map(issue => issue.message));
    const relationship = relationships[0];
    if (!relationship || relationship.nullable || !relationship.target_unique) continue;
    const pairs = actionRuleRelationshipPairs(relationship);
    if (pairs.some(pair => parent.columns.find(column => column.name === pair.target_field)?.nullable !== false)) continue;
    const tenant = pairs.find(pair => pair.target_field === parentRoles.tenant_column)?.local_field;
    const principal = pairs.find(pair => pair.target_field === parentRoles.principal_column)?.local_field;
    if (!tenant || !principal) continue;
    const roles = { tenant_column: tenant, principal_column: principal };
    mergeClaims(table, [...claims, { ...roles, evidence: foreignKey.name }]);
    paths.push({ roles, evidence: { parent: tableId(parent), parent_claims: parentClaims.map(claim => claim.evidence),
      foreign_key: { name: foreignKey.name, columns: foreignKey.columns, referenced_schema: foreignKey.referenced_schema,
        referenced_table: foreignKey.referenced_table, referenced_columns: foreignKey.referenced_columns,
        delete_rule: foreignKey.delete_rule, deferrable: foreignKey.deferrable ?? false, action_rule_issue: foreignKey.action_rule_issue ?? null },
      relationship, fields: pairs.map(pair => ({ local: columnProof(table, pair.local_field), target: columnProof(parent, pair.target_field) })) },
    details: [`${tableId(table)} via exact immediate FK ${foreignKey.name} to ${tableId(parent)}.`,
      ...pairs.map(pair => `${tableId(table)}.${pair.local_field} -> ${tableId(parent)}.${pair.target_field}`),
      `Reviewed organization=${tenant}; person=${principal}. The complete parent tuple is unique and all pairs non-null.`] });
  }
  if (paths.length > 1) refuse("AMBIGUOUS", `${tableId(table)} has more than one complete FK to a directly reviewed organization/person scope.`);
  if (paths.length === 1) return proven(paths[0]!.roles, paths[0]!.evidence, paths[0]!.details);
  return { state: "missing", reason: `${tableId(table)} needs exact reviewed organization/person columns or one complete, immediate, non-null FK to a directly reviewed unique parent. Review the source scope and resume; column names, runtime identities and business-status guesses are not proof.${diagnostics.length ? ` ${diagnostics.join(" ").slice(0, 2000)}` : ""}` };
}
