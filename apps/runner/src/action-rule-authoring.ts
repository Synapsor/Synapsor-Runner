import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  ACTION_RULE_CATALOG_VERSION,
  type ActionRuleCatalogFieldV1,
  type ActionRuleCatalogRelationshipV1,
  type ActionRuleCatalogResourceV1,
  type ActionRuleCatalogV1,
} from "@synapsor-runner/action-rules";
import type { ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import type {
  SchemaInspection,
  TableInfo,
} from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import { actionRuleRelationshipsForTable, actionRuleTypeForColumn, type ActionRuleSchemaDiagnostic } from "./action-rule-schema-metadata.js";
import { actionRuleSourceConstraints, type ActionRuleSourceConstraints } from "./action-rule-source-evidence.js";
export { actionRuleRelationshipsForTable, actionRuleTypeForColumn, uniqueKey } from "./action-rule-schema-metadata.js";

export const ACTION_RULE_AUTHORING_CATALOG_VERSION =
  "synapsor.action-rule-authoring-catalog.v1" as const;

export type ActionRuleAuthoringFieldV1 = {
  name: string;
  label?: string;
  description?: string;
  type: ActionRuleScalarTypeSpecV1;
  nullable: boolean;
  role: "model_visible" | "runner_verification_only" | "guard";
  /** Structurally eligible effect field, NOT a grant on the selected connection. */
  writable: boolean;
  enum_source?: "schema";
};

export type ActionRuleAuthoringResourceV1 = {
  name: string;
  label?: string;
  description?: string;
  primary_key: string;
  tenant_scope: "direct" | "single_organization" | "unsupported_derived";
  tenant_key?: string;
  principal_scope: "direct" | "postgres_rls" | "none" | "unsupported_derived";
  principal_key?: string;
  principal_rls_setting?: string;
  version_candidates: string[];
  selected_version_field?: string;
  /** Structurally suitable fields; their conflict-counter meaning needs review. */
  version_field_options?: string[];
  verification_only?: true;
  operations: {
    update: boolean;
    insert: boolean;
  };
  fields: ActionRuleAuthoringFieldV1[];
  /** Metadata for authoring only; not new Read, verification or write authority. */
  source_constraints?: ActionRuleSourceConstraints;
};

export type ActionRuleAuthoringCatalogV1 = {
  schema_version: typeof ACTION_RULE_AUTHORING_CATALOG_VERSION;
  source: string;
  engine: "postgres" | "mysql";
  read_boundary_name: string;
  generation_lock_fingerprint: `sha256:${string}`;
  resources: ActionRuleAuthoringResourceV1[];
  relationships: ActionRuleCatalogRelationshipV1[];
  supported_language: {
    comparisons: readonly ["eq", "neq", "lt", "lte", "gt", "gte"];
    predicates: readonly ["all", "any", "not", "null_check", "in", "exists"];
    aggregates: readonly ["count", "sum", "min", "max"];
    arithmetic: readonly ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"];
    effects: readonly ["single_row_update", "single_row_insert"];
    atomic_updates?: { maximum_records: 4; same_source: true; versioned_updates_only: true; all_or_nothing: true };
    complete_collections?: { strategy: "complete_locked"; shape: "inverse_foreign_key_from_one_scoped_parent"; visibility_and_phantoms_reverified: true };
  };
  diagnostics: ActionRuleSchemaDiagnostic[];
  digest: `sha256:${string}`;
};

export type BuiltActionRuleAuthoringCatalogV1 = {
  catalog: ActionRuleCatalogV1;
  authoring: ActionRuleAuthoringCatalogV1;
};

/**
 * Converts reviewed Boundary and live schema metadata into the closed catalog
 * accepted by the Action Rule compiler. It reads no rows and never guesses a
 * currency, an unbounded text type, a relationship, or a scope path.
 */
export function buildActionRuleAuthoringCatalog(input: {
  boundary: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
  retainedCatalog?: ActionRuleCatalogV1;
}): BuiltActionRuleAuthoringCatalogV1 {
  if (input.inspection.engine !== "postgres" && input.inspection.engine !== "mysql") {
    throw new Error("ACTION_RULE_ENGINE_UNSUPPORTED: Action Rules require PostgreSQL or MySQL.");
  }
  if (input.retainedCatalog
    && input.retainedCatalog.generation_lock_fingerprint !== input.boundary.generation_lock_fingerprint) {
    throw new Error(
      "ACTION_RULE_REVISION_STALE: the saved Action authority was built from a different inspected schema revision.",
    );
  }
  const tables = new Map(input.inspection.tables.map((table) => [resourceId(table), table]));
  const reviewed = new Map(input.boundary.pack.resources.map((resource) => [resource.id, resource]));
  const retained = new Map((input.retainedCatalog?.resources ?? []).map((resource) => [resource.name, resource]));
  const diagnostics: ActionRuleAuthoringCatalogV1["diagnostics"] = [];
  const resources: ActionRuleCatalogResourceV1[] = [];
  const authoringResources: ActionRuleAuthoringResourceV1[] = [];

  const resourceIds = [...new Set([
    ...reviewed.keys(),
    ...retained.keys(),
  ])].sort();
  for (const resourceName of resourceIds) {
    const resource = reviewed.get(resourceName);
    const retainedResource = retained.get(resourceName);
    const verificationOnly = retainedResource?.verification_only === true;
    const table = tables.get(resourceName);
    if (!table || table.type !== "table") {
      diagnostics.push({
        code: "ACTION_RULE_LOCKABLE_TABLE_REQUIRED",
        resource: resourceName,
        message: "Runner-only verification and derived effects require an inspected base table.",
      });
      continue;
    }
    if (retainedResource
      && (retainedResource.source !== input.boundary.source
        || retainedResource.engine !== input.inspection.engine
        || retainedResource.schema !== table.schema
        || retainedResource.table !== table.name)) {
      throw new Error(
        `ACTION_RULE_REVISION_STALE: saved structural authority for ${resourceName} no longer matches the inspected source.`,
      );
    }
    const primaryKey = resource?.primary_key ?? retainedResource?.primary_key;
    if (!primaryKey) {
      diagnostics.push({
        code: "ACTION_RULE_PRIMARY_KEY_UNSUPPORTED",
        resource: resourceName,
        message: "The reviewed row identity is absent or has no portable Action Rule type.",
      });
      continue;
    }
    const tenantKey = resource?.tenant_key ?? retainedResource?.tenant_key;
    const principalKey = resource?.principal_key ?? retainedResource?.principal_scope_key;
    const supportedFields = table.columns.flatMap((column) => {
      const type = actionRuleTypeForColumn(column);
      if (!type) {
        diagnostics.push({
          code: "ACTION_RULE_FIELD_TYPE_UNSUPPORTED",
          resource: resourceName,
          field: column.name,
          message: `Database type ${column.data_type} has no portable bounded Action Rule scalar mapping.`,
        });
        return [];
      }
      return [{ name: column.name, type, nullable: column.nullable } satisfies ActionRuleCatalogFieldV1];
    });
    const supportedNames = new Set(supportedFields.map((field) => field.name));
    if (!supportedNames.has(primaryKey)) {
      diagnostics.push({
        code: "ACTION_RULE_PRIMARY_KEY_UNSUPPORTED",
        resource: resourceName,
        field: primaryKey,
        message: "The reviewed row identity is absent or has no portable Action Rule type.",
      });
      continue;
    }
    const versionCandidates = table.suggestions.conflict_columns
      .filter((name) => supportedNames.has(name))
      .sort();
    const versionFieldOptions = table.columns.filter(column => !column.nullable && !column.generated && !column.identity
      && !column.suggestions.immutable && actionRuleTypeForColumn(column)?.kind === "integer"
      && ![...table.primary_key, primaryKey, tenantKey, principalKey].includes(column.name)).map(column => column.name).sort();
    const selectedVersionField = retainedResource?.version_field
      && (versionCandidates.includes(retainedResource.version_field) || versionFieldOptions.includes(retainedResource.version_field))
      ? retainedResource.version_field
      : versionCandidates.length === 1
        ? versionCandidates[0]
        : uniqueIntegerVersionField(table, versionCandidates);
    if (!selectedVersionField && !verificationOnly) diagnostics.push({
      code: versionCandidates.length ? "ACTION_RULE_VERSION_SELECTION_REQUIRED" : "ACTION_RULE_VERSION_REQUIRED",
      applies_to: "update",
      resource: resourceName,
      message: versionFieldOptions.length
        ? `UPDATE needs a reviewed conflict counter. Structurally suitable fields: ${versionFieldOptions.join(", ")}. If the source owner identifies a maintained counter, use the guided counter review; structural suitability alone is not its business meaning. Private verification is still available without a version.`
        : versionCandidates.length
        ? "UPDATE only: no unique conflict counter is selected. This does not block using this resource for private verification. Runner rechecks verification facts at execution; do not request a version for a resource that the action does not change."
        : "UPDATE only: no inspected conflict field is available, so this resource cannot be changed by a versioned update. Private verification remains supported without a version: Runner reloads, locks and compares the reviewed facts at execution. No schema change or writer grant is needed merely to verify this resource.",
    });
    const canonical: ActionRuleCatalogResourceV1 = {
      name: resourceName,
      source: input.boundary.source,
      engine: input.inspection.engine,
      schema: table.schema,
      table: table.name,
      primary_key: primaryKey,
      ...(tenantKey && supportedNames.has(tenantKey)
        ? { tenant_key: tenantKey }
        : {}),
      ...(principalKey && supportedNames.has(principalKey)
        ? { principal_scope_key: principalKey }
        : {}),
      ...(selectedVersionField ? { version_field: selectedVersionField } : {}),
      ...(verificationOnly ? { verification_only: true as const } : {}),
      fields: supportedFields,
    };
    resources.push(canonical);

    const modelVisible = new Set([
      ...(resource?.selectable_fields ?? []),
      ...Object.keys(resource?.filterable_fields ?? {}),
      ...(resource?.sortable_fields ?? []),
      ...(resource?.groupable_fields ?? []),
      ...(resource?.aggregate_measures ?? []),
      ...(resource?.count_distinct_fields ?? []),
      ...Object.keys(resource?.time_bucket_fields ?? {}),
    ]);
    const guardFields = new Set([
      primaryKey,
      tenantKey,
      principalKey,
      selectedVersionField,
    ].filter((value): value is string => value !== undefined));
    const keptOut = new Set(resource?.kept_out_fields ?? []);
    const withheld = new Set(resource?.model_withheld_fields ?? []);
    const fields: ActionRuleAuthoringFieldV1[] = supportedFields.map((field) => {
      const column = table.columns.find((candidate) => candidate.name === field.name)!;
      const role = guardFields.has(field.name)
        ? "guard"
        : modelVisible.has(field.name) && !keptOut.has(field.name) && !withheld.has(field.name)
          ? "model_visible"
          : "runner_verification_only";
      return {
        ...field,
        ...(resource?.field_metadata?.[field.name]?.label ? { label: resource.field_metadata[field.name]!.label } : {}),
        ...(resource?.field_metadata?.[field.name]?.description ? { description: resource.field_metadata[field.name]!.description } : {}),
        role,
        writable: !verificationOnly && table.writable
          && !column.generated
          && !column.identity
          && !column.suggestions.immutable
          && !guardFields.has(field.name),
        ...(field.type.kind === "string" && field.type.enum?.length
          ? { enum_source: "schema" as const }
          : {}),
      };
    });
    authoringResources.push({
      name: resourceName,
      ...(resource?.label ? { label: resource.label } : {}),
      ...(resource?.description ? { description: resource.description } : {}),
      primary_key: primaryKey,
      tenant_scope: input.boundary.organization_scope
        ? "single_organization"
        : tenantKey
          ? "direct"
          : "unsupported_derived",
      ...(tenantKey ? { tenant_key: tenantKey } : {}),
      principal_scope: principalKey
        ? "direct"
        : resource?.rls_session?.principal_setting
          ? "postgres_rls"
          : resource?.principal_scope
            ? "unsupported_derived"
            : "none",
      ...(principalKey ? { principal_key: principalKey } : {}),
      ...(resource?.rls_session?.principal_setting
        ? { principal_rls_setting: resource.rls_session.principal_setting }
        : {}),
      version_candidates: versionCandidates,
      version_field_options: versionFieldOptions,
      ...(selectedVersionField ? { selected_version_field: selectedVersionField } : {}),
      ...(verificationOnly ? { verification_only: true as const } : {}),
      operations: {
        update: !verificationOnly && table.writable && selectedVersionField !== undefined,
        insert: !verificationOnly && table.writable
          && input.boundary.organization_scope === undefined
          && supportsProposalIdDeduplication(table, primaryKey, tenantKey),
      },
      fields,
      source_constraints: actionRuleSourceConstraints(table),
    });
  }

  const resourceNames = new Set(resources.map((resource) => resource.name));
  const relationships = input.inspection.tables
    .filter((table) => resourceNames.has(resourceId(table)))
    .flatMap((table) => actionRuleRelationshipsForTable(table, tables, resourceNames, diagnostics))
    .sort((left, right) => left.name.localeCompare(right.name));
  const catalog: ActionRuleCatalogV1 = {
    schema_version: ACTION_RULE_CATALOG_VERSION,
    generation_lock_fingerprint: input.boundary.generation_lock_fingerprint,
    resources,
    relationships,
  };
  const material = {
    schema_version: ACTION_RULE_AUTHORING_CATALOG_VERSION,
    source: input.boundary.source,
    engine: input.inspection.engine,
    read_boundary_name: input.boundary.pack.name,
    generation_lock_fingerprint: input.boundary.generation_lock_fingerprint,
    resources: authoringResources,
    relationships,
    supported_language: {
      comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
      predicates: ["all", "any", "not", "null_check", "in", "exists"],
      aggregates: ["count", "sum", "min", "max"],
      arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"],
      effects: ["single_row_update", "single_row_insert"],
      atomic_updates: { maximum_records: 4, same_source: true, versioned_updates_only: true, all_or_nothing: true },
      complete_collections: { strategy: "complete_locked", shape: "inverse_foreign_key_from_one_scoped_parent", visibility_and_phantoms_reverified: true },
    },
    diagnostics,
  } as const;
  return {
    catalog,
    authoring: {
      ...material,
      digest: canonicalJsonDigest(material),
    },
  };
}

function uniqueIntegerVersionField(
  table: TableInfo,
  candidates: string[],
): string | undefined {
  // Only compare fields already identified as conflict candidates. Ordinary
  // integer business fields never become version counters by this preference.
  const counters = candidates.filter((name) => {
    const column = table.columns.find((item) => item.name === name);
    return column && actionRuleTypeForColumn(column)?.kind === "integer";
  });
  if (counters.length !== 1) return undefined;
  const selected = counters[0]!;
  const alternatives = candidates.filter((candidate) => candidate !== selected);
  if (!alternatives.length) return selected;
  return alternatives.every((candidate) => {
    const column = table.columns.find((item) => item.name === candidate);
    return column !== undefined && actionRuleTypeForColumn(column)?.kind === "timestamp";
  }) ? selected : undefined;
}

function supportsProposalIdDeduplication(
  table: TableInfo,
  primaryKey: string,
  tenantKey?: string,
): boolean {
  const identity = table.columns.find((column) => column.name === primaryKey);
  if (!identity || identity.generated || identity.identity || actionRuleTypeForColumn(identity)?.kind !== "string") {
    return false;
  }
  const allowed = new Set([primaryKey, tenantKey].filter((value): value is string => value !== undefined));
  const uniqueSets = [
    table.primary_key,
    ...table.unique_constraints.map((constraint) => constraint.columns),
    ...table.indexes.filter((index) => index.unique).map((index) => index.columns ?? []),
  ];
  return uniqueSets.some((columns) =>
    columns.length > 0 && columns.every((column) => allowed.has(column)));
}

function resourceId(table: Pick<TableInfo, "schema" | "name">): string {
  return `${table.schema}.${table.name}`;
}
