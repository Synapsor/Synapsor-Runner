import type { ActionRuleCatalogRelationshipV1 } from "@synapsor-runner/action-rules";
import type { ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import type { ColumnInfo, TableInfo } from "@synapsor-runner/schema-inspector";

export type ActionRuleSchemaDiagnostic = {
  code: string;
  applies_to?: "update";
  resource?: string;
  field?: string;
  relationship?: string;
  target_resource?: string;
  message: string;
};

export function actionRuleRelationshipsForTable(
  table: TableInfo,
  tables: Map<string, TableInfo>,
  resourceNames: Set<string>,
  diagnostics: ActionRuleSchemaDiagnostic[],
): ActionRuleCatalogRelationshipV1[] {
  const from = `${table.schema}.${table.name}`;
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
      ...(foreignKey.required_singleton_proof && pairs.length === 1
        ? { required_singleton_proof: structuredClone(foreignKey.required_singleton_proof) } : {}),
    }];
  });
}

export function uniqueKey(table: TableInfo, columns: string[]): boolean {
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
