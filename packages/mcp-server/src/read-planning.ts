import path from "node:path";
import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import type {
  ProtectedReadSpec,
  ProtectedReadValueSpec,
} from "@synapsor/spec";
import type {
  RuntimeCapabilityConfig,
  TrustedContext,
} from "./runtime-types.js";
import {
  isSetSelectionCapability,
  readColumns,
} from "./capability-authority.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  hashJson,
} from "./safe-values.js";

export function buildSelect(capability: RuntimeCapabilityConfig, placeholderStyle: "$" | "?"): { sql: string } {
  if (capability.protected_read) {
    throw new McpRuntimeError("PROTECTED_READ_ARGS_REQUIRED", "Protected reads must be compiled with their validated arguments and trusted context.");
  }
  if (capability.kind === "aggregate_read") {
    const aggregate = capability.aggregate;
    if (!aggregate) throw new McpRuntimeError("AGGREGATE_DEFINITION_MISSING", "Aggregate capability is missing its reviewed definition.");
    const fixedTerms = aggregate.selection?.all ?? [];
    const where = fixedTerms.map((term, index) => `${quoteIdentifier(term.column, placeholderStyle)} = ${placeholderStyle === "$" ? `$${index + 1}` : "?"}`);
    if (capability.target.tenant_key) where.push(`${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${fixedTerms.length + 1}` : "?"}`);
    if (capability.target.principal_scope_key) where.push(`${quoteIdentifier(capability.target.principal_scope_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${fixedTerms.length + 2}` : "?"}`);
    const expression = aggregate.function === "count" && aggregate.count_mode === "rows"
      ? "COUNT(*)"
      : `${aggregate.function.toUpperCase()}(${quoteIdentifier(aggregate.column ?? "", placeholderStyle)})`;
    return { sql: `SELECT ${expression} AS aggregate_value, COUNT(*) AS group_size FROM ${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` };
  }
  const columns = readColumns(capability).map((column) => quoteIdentifier(column, placeholderStyle)).join(", ");
  if (isSetSelectionCapability(capability)) {
    const fixedTerms = capability.operation?.selection?.all ?? [];
    const where = fixedTerms.map((term, index) => `${quoteIdentifier(term.column, placeholderStyle)} = ${placeholderStyle === "$" ? `$${index + 1}` : "?"}`);
    if (capability.target.tenant_key) {
      const tenantIndex = fixedTerms.length + 1;
      where.push(`${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${tenantIndex}` : "?"}`);
    }
    if (capability.target.principal_scope_key) {
      const principalIndex = fixedTerms.length + 2;
      where.push(`${quoteIdentifier(capability.target.principal_scope_key, placeholderStyle)} = ${placeholderStyle === "$" ? `$${principalIndex}` : "?"}`);
    }
    const maxRows = capability.operation?.max_rows ?? 0;
    return {
      sql: `SELECT ${columns} FROM ${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)} WHERE ${where.join(" AND ")} ORDER BY ${quoteIdentifier(capability.target.primary_key, placeholderStyle)} ASC LIMIT ${maxRows + 1}`,
    };
  }
  const placeholders = placeholderStyle === "$" ? ["$1", "$2", "$3"] : ["?", "?", "?"];
  const where = [
    `${quoteIdentifier(capability.target.primary_key, placeholderStyle)} = ${placeholders[0]}`,
  ];
  if (capability.target.tenant_key) {
    where.push(`${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${placeholders[1]}`);
  }
  if (capability.target.principal_scope_key) {
    where.push(`${quoteIdentifier(capability.target.principal_scope_key, placeholderStyle)} = ${placeholders[2]}`);
  }
  const sql = `SELECT ${columns} FROM ${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)} WHERE ${where.join(" AND ")} LIMIT ${Math.max(1, capability.max_rows ?? 1)}`;
  return { sql };
}

export function runtimeReadQuery(
  capability: RuntimeCapabilityConfig,
  placeholderStyle: "$" | "?",
  args: Record<string, unknown>,
  context: TrustedContext,
): { sql: string; values: unknown[] } {
  if (capability.protected_read) {
    return buildProtectedReadQuery(capability, placeholderStyle, args, context);
  }
  return {
    sql: buildSelect(capability, placeholderStyle).sql,
    values: queryValues(capability, args, context),
  };
}

export function buildProtectedReadQuery(
  capability: RuntimeCapabilityConfig,
  placeholderStyle: "$" | "?",
  args: Record<string, unknown>,
  context: TrustedContext,
): { sql: string; values: unknown[] } {
  const protectedRead = capability.protected_read;
  if (!protectedRead) throw new McpRuntimeError("PROTECTED_READ_REQUIRED", "Protected read authority is missing.");
  const relationships = protectedRelationshipPaths(protectedRead);
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return placeholderStyle === "$" ? `$${values.length}` : "?";
  };
  const relationshipAliases = new Map<string, string>();
  for (const [pathIndex, relationship] of relationships.entries()) {
    relationshipAliases.set(
      relationship.name,
      protectedRelationshipAlias(pathIndex, relationship.links.length - 1),
    );
  }
  const field = (name: string, relationshipName?: string): string => {
    const alias = relationshipName === undefined ? "t0" : relationshipAliases.get(relationshipName);
    if (!alias) {
      throw new McpRuntimeError("PROTECTED_RELATIONSHIP_INVALID", "Protected field references an unreviewed relationship.");
    }
    return `${alias}.${quoteIdentifier(name, placeholderStyle)}`;
  };
  const fromClause = (): string => {
    const joins: string[] = [];
    for (const [pathIndex, relationship] of relationships.entries()) {
      let sourceAlias = "t0";
      let preserveUnmatched = false;
      for (const [linkIndex, link] of relationship.links.entries()) {
        const alias = protectedRelationshipAlias(pathIndex, linkIndex);
        preserveUnmatched ||= link.unmatched_rows === "keep_null";
        const conditions = [
          `${sourceAlias}.${quoteIdentifier(link.local_key, placeholderStyle)} = ${alias}.${quoteIdentifier(link.target_key, placeholderStyle)}`,
          `${alias}.${quoteIdentifier(link.tenant_key, placeholderStyle)} = ${bind(context.tenant_id)}`,
          ...(link.principal_scope_key
            ? [`${alias}.${quoteIdentifier(link.principal_scope_key, placeholderStyle)} = ${bind(context.principal)}`]
            : []),
        ];
        joins.push(
          ` ${preserveUnmatched ? "LEFT JOIN" : "JOIN"} ${quoteIdentifier(link.schema, placeholderStyle)}.${quoteIdentifier(link.table, placeholderStyle)} ${alias} ON ${conditions.join(" AND ")}`,
        );
        sourceAlias = alias;
      }
    }
    return `${quoteIdentifier(capability.target.schema, placeholderStyle)}.${quoteIdentifier(capability.target.table, placeholderStyle)} t0${joins.join("")}`;
  };
  const scopedWhere = (): string[] => {
    const where: string[] = [];
    if (capability.target.tenant_key) where.push(`t0.${quoteIdentifier(capability.target.tenant_key, placeholderStyle)} = ${bind(context.tenant_id)}`);
    if (capability.target.principal_scope_key) where.push(`t0.${quoteIdentifier(capability.target.principal_scope_key, placeholderStyle)} = ${bind(context.principal)}`);
    for (const predicate of protectedRead.predicates ?? []) {
      const reference = field(predicate.field, predicate.relationship);
      if (predicate.operator === "in") {
        where.push(`${reference} IN (${predicate.values.map((value) => bind(value)).join(", ")})`);
        continue;
      }
      const value = protectedReadValue(predicate.value, args);
      if (value === null) {
        if (predicate.operator !== "eq" && predicate.operator !== "neq") {
          throw new McpRuntimeError("PROTECTED_NULL_OPERATOR_INVALID", "NULL protected predicates support only eq and neq.");
        }
        where.push(`${reference} IS ${predicate.operator === "neq" ? "NOT " : ""}NULL`);
        continue;
      }
      const operator = {
        eq: "=",
        neq: "<>",
        lt: "<",
        lte: "<=",
        gt: ">",
        gte: ">=",
      }[predicate.operator];
      where.push(`${reference} ${operator} ${bind(value)}`);
    }
    return where;
  };

  if (protectedRead.mode === "rows") {
    const from = fromClause();
    const columns = capability.visible_columns.map((column) =>
      `t0.${quoteIdentifier(column, placeholderStyle)} AS ${quoteIdentifier(column, placeholderStyle)}`);
    const where = scopedWhere();
    const order = protectedRead.row_order_by?.length
      ? ` ORDER BY ${protectedRead.row_order_by.map((item) => `${field(item.field)} ${item.direction.toUpperCase()}`).join(", ")}`
      : ` ORDER BY t0.${quoteIdentifier(capability.target.primary_key, placeholderStyle)} ASC`;
    return {
      sql: `SELECT ${columns.join(", ")} FROM ${from}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${order} LIMIT ${protectedRead.limits.max_rows}`,
      values,
    };
  }

  const aggregate = protectedRead.aggregate;
  if (!aggregate) throw new McpRuntimeError("PROTECTED_AGGREGATE_REQUIRED", "Protected aggregate authority is missing.");
  const periodMover = aggregate.order_by?.kind === "comparison_change";
  const aggregateQuery = (
    range?: { start: ProtectedReadValueSpec; end: ProtectedReadValueSpec },
    period?: "period_1" | "period_2",
  ): string => {
    const from = fromClause();
    const where = scopedWhere();
    if (range && aggregate.comparison) {
      const reference = field(aggregate.comparison.field, aggregate.comparison.relationship);
      where.push(`${reference} >= ${bind(protectedReadValue(range.start, args))}`);
      where.push(`${reference} < ${bind(protectedReadValue(range.end, args))}`);
    }
    const select: string[] = [];
    const groups: string[] = [];
    for (const dimension of aggregate.dimensions ?? []) {
      const expression = field(dimension.field, dimension.relationship);
      select.push(`${expression} AS ${quoteIdentifier(dimension.name, placeholderStyle)}`);
      groups.push(expression);
    }
    if (aggregate.time_bucket && (!range || !periodMover)) {
      const expression = protectedTimeBucket(
        field(aggregate.time_bucket.field, aggregate.time_bucket.relationship),
        aggregate.time_bucket.bucket,
        placeholderStyle,
      );
      select.push(`${expression} AS ${quoteIdentifier(aggregate.time_bucket.name, placeholderStyle)}`);
      groups.push(expression);
    }
    for (const measure of aggregate.measures) {
      const expression = measure.function === "count"
        ? "COUNT(*)"
        : measure.function === "count_distinct"
          ? `COUNT(DISTINCT ${field(measure.field!, measure.relationship)})`
          : `${measure.function.toUpperCase()}(${field(measure.field!, measure.relationship)})`;
      select.push(`${expression} AS ${quoteIdentifier(measure.name, placeholderStyle)}`);
    }
    select.push(`COUNT(*) AS ${quoteIdentifier("__cohort_size", placeholderStyle)}`);
    if (period) select.push(`'${period}' AS ${quoteIdentifier("__period", placeholderStyle)}`);
    const order = aggregate.order_by?.kind === "measure"
      ? ` ORDER BY ${quoteIdentifier(aggregate.order_by.measure, placeholderStyle)} ${aggregate.order_by.direction.toUpperCase()}`
      : aggregate.order_by?.kind === "time_bucket" && !range
        ? ` ORDER BY ${quoteIdentifier(aggregate.time_bucket!.name, placeholderStyle)} ${aggregate.order_by.direction.toUpperCase()}`
        : groups.length
          ? ` ORDER BY ${groups.join(", ")}`
          : "";
    const ranked = aggregate.order_by?.kind === "measure"
      || aggregate.order_by?.kind === "comparison_change";
    const maximumGroups = ranked
      ? protectedRead.limits.max_ranked_groups ?? protectedRead.limits.max_groups
      : protectedRead.limits.max_groups;
    return `SELECT ${select.join(", ")} FROM ${from}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${groups.length ? ` GROUP BY ${groups.join(", ")}` : ""}${order} LIMIT ${maximumGroups + 1}`;
  };
  const ranges = aggregate.comparison?.ranges;
  if (!ranges?.length) return { sql: aggregateQuery(), values };
  const parts = ranges.map((range, index) => `(${aggregateQuery(range, index === 0 ? "period_1" : "period_2")})`);
  return {
    sql: `SELECT * FROM (${parts.join(" UNION ALL ")}) AS protected_periods`,
    values,
  };
}

export function protectedReadValue(value: ProtectedReadValueSpec, args: Record<string, unknown>): unknown {
  if ("fixed" in value) return value.fixed;
  const resolved = args[value.from_arg];
  if (resolved === undefined) throw new McpRuntimeError("ARGUMENT_REQUIRED", `${value.from_arg} is required.`);
  return resolved;
}

export function protectedTimeBucket(column: string, bucket: "day" | "week" | "month", placeholderStyle: "$" | "?"): string {
  if (placeholderStyle === "$") return `date_trunc('${bucket}', ${column})`;
  if (bucket === "day") return `DATE(${column})`;
  if (bucket === "week") return `DATE_SUB(DATE(${column}), INTERVAL WEEKDAY(${column}) DAY)`;
  return `DATE_FORMAT(${column}, '%Y-%m-01')`;
}

export function protectedStatementTimeout(capability: RuntimeCapabilityConfig, sourceTimeout: number | undefined): number | undefined {
  const protectedTimeout = capability.protected_read?.limits.statement_timeout_ms;
  if (protectedTimeout === undefined) return sourceTimeout;
  return sourceTimeout === undefined ? protectedTimeout : Math.min(protectedTimeout, sourceTimeout);
}

export function protectedReadTargets(capability: RuntimeCapabilityConfig): Array<{
  schema: string;
  table: string;
  principalScoped: boolean;
}> {
  const targets = new Map<string, {
    schema: string;
    table: string;
    principalScoped: boolean;
  }>();
  const addTarget = (target: { schema: string; table: string; principalScoped: boolean }): void => {
    const key = `${target.schema}\u0000${target.table}`;
    const existing = targets.get(key);
    targets.set(key, {
      ...target,
      principalScoped: target.principalScoped || Boolean(existing?.principalScoped),
    });
  };
  addTarget({
    schema: capability.target.schema,
    table: capability.target.table,
    principalScoped: Boolean(capability.target.principal_scope_key),
  });
  const relationship = capability.protected_read?.relationship;
  if (relationship) {
    addTarget({
      schema: relationship.schema,
      table: relationship.table,
      principalScoped: Boolean(relationship.principal_scope_key),
    });
  }
  for (const path of capability.protected_read?.relationships ?? []) {
    for (const link of path.links) {
      addTarget({
        schema: link.schema,
        table: link.table,
        principalScoped: Boolean(link.principal_scope_key),
      });
    }
  }
  return [...targets.values()];
}

export function protectedRelationshipPaths(
  protectedRead: ProtectedReadSpec,
): NonNullable<ProtectedReadSpec["relationships"]> {
  if (protectedRead.relationships?.length) return protectedRead.relationships;
  const relationship = protectedRead.relationship;
  if (!relationship) return [];
  return [{
    name: relationship.name,
    links: [{
      schema: relationship.schema,
      table: relationship.table,
      primary_key: relationship.primary_key,
      tenant_key: relationship.tenant_key,
      ...(relationship.principal_scope_key
        ? { principal_scope_key: relationship.principal_scope_key }
        : {}),
      local_key: relationship.local_key,
      target_key: relationship.target_key,
      cardinality: "many_to_one",
      max_fan_out: 1,
      unmatched_rows: "exclude",
    }],
  }];
}

export function protectedRelationshipAlias(pathIndex: number, linkIndex: number): string {
  return `r${pathIndex + 1}_${linkIndex + 1}`;
}

export function queryValues(capability: RuntimeCapabilityConfig, args: Record<string, unknown>, context: TrustedContext): unknown[] {
  if (capability.kind === "aggregate_read") return [
    ...(capability.aggregate?.selection?.all ?? []).map((term) => term.value),
    ...(capability.target.tenant_key ? [context.tenant_id] : []),
    ...(capability.target.principal_scope_key ? [context.principal] : []),
  ];
  if (isSetSelectionCapability(capability)) {
    return [
      ...(capability.operation?.selection?.all ?? []).map((term) => term.value),
      ...(capability.target.tenant_key ? [context.tenant_id] : []),
      ...(capability.target.principal_scope_key ? [context.principal] : []),
    ];
  }
  const pkValue = args[capability.lookup.id_from_arg];
  if (pkValue === undefined) throw new McpRuntimeError("LOOKUP_ARG_MISSING", `${capability.lookup.id_from_arg} is required.`);
  return [
    pkValue,
    ...(capability.target.tenant_key ? [context.tenant_id] : []),
    ...(capability.target.principal_scope_key ? [context.principal] : []),
  ];
}

export function quoteIdentifier(identifier: string, style: "$" | "?"): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new McpRuntimeError("UNSAFE_IDENTIFIER", `Unsafe identifier: ${identifier}`);
  return style === "$" ? `"${identifier}"` : `\`${identifier}\``;
}

export function queryFingerprintFor(capability: RuntimeCapabilityConfig, context: TrustedContext): string {
  const principalScope = capability.target.principal_scope_key ? {
    column: capability.target.principal_scope_key,
    value_fingerprint: canonicalJsonDigest({ principal: context.principal }),
  } : undefined;
  return hashJson({
    source: capability.source,
    target: capability.target,
    selection: capability.operation?.selection,
    max_rows: capability.operation?.max_rows,
    aggregate: capability.aggregate,
    columns: readColumns(capability),
    tenant_bound: Boolean(capability.target.tenant_key),
    tenant: context.tenant_id,
    ...(principalScope ? { principal_scope: principalScope } : {}),
  });
}
