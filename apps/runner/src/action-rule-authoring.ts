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
  ColumnInfo,
  SchemaInspection,
  TableInfo,
} from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";

export const ACTION_RULE_AUTHORING_CATALOG_VERSION =
  "synapsor.action-rule-authoring-catalog.v1" as const;

export type ActionRuleAuthoringFieldV1 = {
  name: string;
  type: ActionRuleScalarTypeSpecV1;
  nullable: boolean;
  role: "model_visible" | "runner_verification_only" | "guard";
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
  operations: {
    update: boolean;
    insert: boolean;
  };
  fields: ActionRuleAuthoringFieldV1[];
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
    aggregates: readonly [];
    arithmetic: readonly ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration"];
    effects: readonly ["single_row_update", "single_row_insert"];
  };
  diagnostics: Array<{
    code: string;
    resource?: string;
    field?: string;
    relationship?: string;
    target_resource?: string;
    message: string;
  }>;
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
    const selectedVersionField = retainedResource?.version_field
      && versionCandidates.includes(retainedResource.version_field)
      ? retainedResource.version_field
      : versionCandidates.length === 1
        ? versionCandidates[0]
        : conventionalIntegerVersionField(table, versionCandidates);
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
        role,
        writable: table.writable
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
      ...(selectedVersionField ? { selected_version_field: selectedVersionField } : {}),
      operations: {
        update: table.writable && selectedVersionField !== undefined,
        insert: table.writable
          && input.boundary.organization_scope === undefined
          && supportsProposalIdDeduplication(table, primaryKey, tenantKey),
      },
      fields,
    });
  }

  const resourceNames = new Set(resources.map((resource) => resource.name));
  const relationships = input.inspection.tables
    .filter((table) => resourceNames.has(resourceId(table)))
    .flatMap((table) => directRelationships(table, tables, resourceNames, diagnostics))
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
      aggregates: [],
      arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration"],
      effects: ["single_row_update", "single_row_insert"],
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

function conventionalIntegerVersionField(
  table: TableInfo,
  candidates: string[],
): string | undefined {
  if (!candidates.includes("version")) return undefined;
  const version = table.columns.find((column) => column.name === "version");
  if (!version || actionRuleTypeForColumn(version)?.kind !== "integer") return undefined;
  const alternatives = candidates.filter((candidate) => candidate !== "version");
  if (!alternatives.length) return "version";
  return alternatives.every((candidate) => {
    const column = table.columns.find((item) => item.name === candidate);
    return column !== undefined && actionRuleTypeForColumn(column)?.kind === "timestamp";
  }) ? "version" : undefined;
}

function directRelationships(
  table: TableInfo,
  tables: Map<string, TableInfo>,
  resourceNames: Set<string>,
  diagnostics: ActionRuleAuthoringCatalogV1["diagnostics"],
): ActionRuleCatalogRelationshipV1[] {
  const from = resourceId(table);
  return table.foreign_keys.flatMap((foreignKey) => {
    const to = `${foreignKey.referenced_schema}.${foreignKey.referenced_table}`;
    if (!resourceNames.has(to)) return [];
    const reject = (code: string, reason: string): [] => {
      diagnostics.push({
        code, resource: from, target_resource: to, relationship: foreignKey.name,
        message: `Relationship ${foreignKey.name}: ${reason}`,
      });
      return [];
    };
    if (foreignKey.action_rule_issue) {
      return reject("ACTION_RULE_RELATIONSHIP_PROOF_UNSUPPORTED", foreignKey.action_rule_issue === "non_exact_collation"
        ? "nondeterministic collation cannot prove Runner's exact key equality. This is a database comparison limitation, not an operator permission."
        : "the database has not validated this foreign key. Operator review cannot establish its schema proof.");
    }
    if (foreignKey.columns.length < 1 || foreignKey.columns.length > 16
      || foreignKey.columns.length !== foreignKey.referenced_columns.length
      || new Set(foreignKey.columns).size !== foreignKey.columns.length
      || new Set(foreignKey.referenced_columns).size !== foreignKey.referenced_columns.length) {
      return reject("ACTION_RULE_RELATIONSHIP_KEY_UNSUPPORTED", "requires 1 through 16 complete, non-repeated key pairs. Operator approval cannot repair incomplete schema metadata.");
    }
    const target = tables.get(to);
    const targetUnique = target !== undefined && uniqueKey(target, foreignKey.referenced_columns);
    if (!targetUnique) {
      return reject("ACTION_RULE_RELATIONSHIP_UNBOUNDED", "the complete referenced key needs a proven unconditional primary/unique key. Partial, expression, unusable or unverified indexes cannot prove one target row.");
    }
    const pairs = foreignKey.columns.map((local_field, index) => ({ local_field, target_field: foreignKey.referenced_columns[index]! }));
    const localColumns = pairs.map((pair) => table.columns.find((column) => column.name === pair.local_field));
    const targetColumns = pairs.map((pair) => target!.columns.find((column) => column.name === pair.target_field));
    if (localColumns.some((column, index) => !column || !targetColumns[index]
      || !actionRuleTypeForColumn(column) || actionRuleTypeForColumn(column)?.kind !== actionRuleTypeForColumn(targetColumns[index]!)?.kind)) {
      return reject("ACTION_RULE_RELATIONSHIP_TYPE_UNSUPPORTED", "every key component needs a compatible portable scalar type; no cast or guessed comparison is permitted.");
    }
    return [{
      name: foreignKey.name,
      from_resource: from,
      to_resource: to,
      ...(pairs.length === 1 ? pairs[0]! : { field_pairs: pairs }),
      cardinality: "many_to_one",
      nullable: localColumns.some((column) => column!.nullable),
      target_unique: true,
    }];
  });
}

function uniqueKey(table: TableInfo, columns: string[]): boolean {
  const sameKey = (key: string[]): boolean => key.length === columns.length
    && new Set(key).size === key.length && key.every((field) => columns.includes(field));
  const usable = (name: string): boolean => !table.indexes.some((index) => index.name === name
    && (index.catalog_usable === false || index.catalog_partial === true || index.catalog_full_columns === false));
  return (sameKey(table.primary_key) && usable("PRIMARY"))
    || table.unique_constraints.some((constraint) =>
      sameKey(constraint.columns) && usable(constraint.name))
    || table.indexes.some((index) =>
      index.unique === true && index.catalog_usable === true && index.catalog_partial === false
      && index.catalog_full_columns !== false && index.catalog_key_columns !== undefined && index.catalog_key_columns.every(Boolean)
      && sameKey(index.catalog_key_columns));
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

export function actionRuleTypeForColumn(
  column: Pick<ColumnInfo, "name" | "data_type" | "enum_values">,
): ActionRuleScalarTypeSpecV1 | undefined {
  const dataType = column.data_type.trim().toLocaleLowerCase("en-US");
  if (/^(?:bool|boolean)$/u.test(dataType)) return { kind: "boolean" };
  if (/^(?:smallint|integer|int|bigint|tinyint|mediumint|serial|bigserial)(?:\b|\()/u.test(dataType)) {
    const unit = inferredIntegerUnit(column.name);
    return { kind: "integer", ...(unit ? { unit } : {}) };
  }
  if (/^(?:date)$/u.test(dataType)) return { kind: "date" };
  if (/^(?:timestamp|timestamp without time zone|timestamp with time zone|timestamptz|datetime)(?:\b|\()/u.test(dataType)) {
    return { kind: "timestamp" };
  }
  const enumValues = [...new Set(column.enum_values ?? [])].sort();
  if (enumValues.length) {
    return {
      kind: "string",
      max_length: Math.max(1, ...enumValues.map((value) => value.length)),
      enum: enumValues,
      comparison: "exact",
    };
  }
  if (/^(?:uuid)$/u.test(dataType)) {
    return { kind: "string", max_length: 36, comparison: "exact" };
  }
  const length = boundedStringLength(dataType);
  if (length !== undefined) {
    return { kind: "string", max_length: length, comparison: "exact" };
  }
  if (/^(?:character varying|varchar|character|char|text|tinytext|mediumtext|longtext)$/u.test(dataType)) {
    // information_schema does not currently retain declared character length.
    // This portable runtime bound fails closed if a loaded value is longer.
    return { kind: "string", max_length: 4_096, comparison: "exact" };
  }
  return undefined;
}

function boundedStringLength(dataType: string): number | undefined {
  const match = /^(?:character varying|varchar|character|char|binary|varbinary)\s*\(\s*(\d+)\s*\)$/u.exec(dataType);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : undefined;
}

function inferredIntegerUnit(name: string): string | undefined {
  const normalized = name.toLocaleLowerCase("en-US");
  if (/(?:^|_)cents?$/u.test(normalized)) return "minor_currency_units";
  for (const unit of ["seconds", "minutes", "hours", "days", "units", "items", "rows"] as const) {
    if (normalized.endsWith(`_${unit}`)) return unit;
  }
  return undefined;
}
