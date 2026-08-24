import { readCapturedExploreParameterizedSql } from "./explore-parameterized-sql.js";

type AuditRecord = Record<string, unknown>;

export type ReconstructedExploreAuditQuery = {
  source: "captured_parameterized_sql" | "legacy_safe_template";
  title: string;
  statement: string;
  caveats: string[];
};


/**
 * Describes a normalized plan without recovering literals or claiming that the
 * original model/user wording was persisted.
 */
export function describeExploreAuditPlan(normalizedPlan: unknown): string | undefined {
  const plan = record(normalizedPlan);
  const kind = text(plan.kind);
  const resourceId = identifier(plan.resource);
  if (!resourceId || (kind !== "rows" && kind !== "aggregate")) return undefined;
  const resource = humanWords(resourceId.split(".").pop() ?? resourceId);

  if (kind === "rows") {
    const fields = strings(plan.select).map(humanWords);
    return sentence(`Rows from ${resource}${fields.length ? ` returning ${joinWords(fields)}` : ""}${auditFilterSuffix(plan)}`);
  }

  const measures = records(plan.measures).map(describeMeasure).filter(Boolean);
  const dimensions = records(plan.dimensions).map(describeDimension).filter(Boolean);
  const timeBucket = record(plan.time_bucket);
  const timeField = identifier(timeBucket.field);
  if (timeField) dimensions.push(`${humanWords(identifier(timeBucket.bucket)) || "time"} ${humanWords(timeField)}`);

  const onlyCount = measures.length === 1 && measures[0] === "record count";
  const subject = onlyCount
    ? resource
    : `${measures.length ? joinWords(measures) : "Reviewed aggregate"} for ${resource}`;
  const grouping = dimensions.length ? ` grouped by ${joinWords(dimensions)}` : "";
  const comparison = Object.keys(record(plan.comparison)).length ? " comparing two reviewed periods" : "";
  return sentence(`${subject}${grouping}${comparison}${auditFilterSuffix(plan)}`);
}

/**
 * Describes a refused operation using only boundary-validated metadata that
 * Runner chose to persist. It never falls back to the original request.
 */
export function describeExploreAuditAttempt(attemptedAccess: unknown): string | undefined {
  const attempt = record(attemptedAccess);
  const resourceId = identifier(attempt.resource);
  if (!resourceId) return undefined;
  const resource = humanWords(resourceId.split(".").pop() ?? resourceId);
  const field = humanWords(identifier(attempt.field));
  const operation = humanWords(identifier(attempt.operation));
  if (field && operation) return sentence(`Refused ${operation} on ${field} in ${resource}`);
  if (field) return sentence(`Refused access to ${field} in ${resource}`);
  if (operation) return sentence(`Refused ${operation} on ${resource}`);
  return sentence(`Refused reviewed Explore request on ${resource}`);
}


function describeMeasure(value: AuditRecord): string {
  const derived = identifier(value.derived_measure);
  if (derived) return `reviewed ${humanWords(derived)}`;
  const operation = identifier(value.function).toLowerCase() || "measure";
  const field = humanWords(identifier(value.field));
  if (operation === "count") return "record count";
  if (operation === "count_distinct") return `unique ${field || "records"}`;
  const prefix: Record<string, string> = {
    sum: "total",
    avg: "average",
    stddev_samp: "sample standard deviation of",
    stddev_pop: "population standard deviation of",
    var_samp: "sample variance of",
    var_pop: "population variance of",
    null_count: "missing values in",
    non_null_count: "present values in",
    completion_rate: "completion rate for",
  };
  return `${prefix[operation] ?? humanWords(operation)}${field ? ` ${field}` : ""}`.trim();
}


function describeDimension(value: AuditRecord): string {
  const field = identifier(value.field);
  if (field) return humanWords(field);
  if (typeof value.numeric_band === "string") return humanWords(value.numeric_band);
  const band = record(value.numeric_band);
  const bandField = identifier(band.field);
  return bandField ? `${humanWords(bandField)} bands` : "";
}


function auditFilterSuffix(plan: AuditRecord): string {
  const filterCount = records(plan.where).length;
  const hasWindow = Object.keys(record(plan.time_window)).length > 0;
  const parts = [
    ...(filterCount ? [`${filterCount} reviewed ${filterCount === 1 ? "filter" : "filters"}`] : []),
    ...(hasWindow ? ["one reviewed time window"] : []),
  ];
  return parts.length ? ` with ${joinWords(parts)}` : "";
}


function humanWords(value: string | undefined): string {
  return (value ?? "").replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim();
}


function joinWords(values: string[]): string {
  if (values.length < 2) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}


function sentence(value: string): string {
  const normalized = value.trim();
  return normalized ? `${normalized[0]!.toUpperCase()}${normalized.slice(1)}.` : normalized;
}

type ReconstructInput = {
  normalizedPlan: unknown;
  parameterizedSql?: unknown;
  scopeApplication?: unknown;
  trustedScope?: unknown;
  tenantRecorded?: boolean;
  principalRecorded?: boolean;
};

/**
 * Prefers the value-free parameterized SQL captured at execution time. Older
 * records retain the explicit non-executable template instead of pretending a
 * later reconstruction is the statement that ran.
 */
export function presentExploreAuditQuery(
  input: ReconstructInput,
): ReconstructedExploreAuditQuery | undefined {
  const captured = readCapturedExploreParameterizedSql(input.parameterizedSql);
  if (!captured) return reconstructExploreAuditQuery(input);

  const statement = captured.statements.length === 1
    ? captured.statements[0]!.statement
    : captured.statements.map((item, index) => [
        `-- Statement ${index + 1}${item.period ? ` (${item.period})` : ""}`,
        item.statement,
      ].join("\n")).join("\n\n");
  const parameterSummary = captured.statements.map((item, index) =>
    `Statement ${index + 1}${item.period ? ` (${item.period})` : ""}: ${item.parameter_count} redacted parameter${item.parameter_count === 1 ? "" : "s"}; types ${item.parameter_types.join(", ") || "none"}.`);
  return {
    source: "captured_parameterized_sql",
    title: "Captured parameterized source SQL",
    statement,
    caveats: [
      `Captured before source execution from the parameterized ${captured.engine === "postgres" ? "PostgreSQL" : "MySQL"} statement shape Runner handed to the driver.`,
      "Parameter values were not persisted; placeholders remain where the driver bound trusted scope and reviewed filter values.",
      "The model never received this SQL. This operator record is not executable without the separately held parameter values.",
      ...parameterSummary,
    ],
  };
}

/**
 * Builds a fail-closed SQL template from redacted audit metadata only. The
 * exact compiled statement is intentionally not persisted, so missing values,
 * relationship expressions, and derived scope remain explicit placeholders.
 */
export function reconstructExploreAuditQuery(
  input: ReconstructInput,
): ReconstructedExploreAuditQuery | undefined {
  const plan = record(input.normalizedPlan);
  const kind = text(plan.kind);
  const resource = identifier(plan.resource);
  if (!resource || (kind !== "rows" && kind !== "aggregate")) return undefined;

  const caveats = [
    "Reconstructed from the reviewed normalized plan; this is not the exact SQL Runner executed.",
    "Named :value_n parameters replace filters because raw values and driver parameter positions are not stored.",
    "Fail-closed 1 = 0 and NULL placeholders mark required scope, relationship, band, or metric SQL that the audit record cannot reconstruct.",
  ];
  const scope = scopeClauses(input);
  caveats.push(...scope.caveats);
  caveats.push(...relationshipCaveats(plan));
  const requiresSqlGuard = requiresSqlReconstructionGuard(plan);
  if (requiresSqlGuard) {
    caveats.push("This template contains a required 1 = 0 guard and returns no source rows until every missing SQL expression is restored.");
  }
  const predicates = [
    ...scope.predicates,
    ...(requiresSqlGuard ? ["1 = 0 /* REQUIRED SQL reconstruction; see notes */"] : []),
  ];
  const bindings = redactedBindings();

  const lines = kind === "rows"
    ? reconstructRows(plan, resource, predicates, scope.comments, bindings)
    : reconstructAggregate(plan, resource, predicates, scope.comments, bindings);
  return {
    source: "legacy_safe_template",
    title: "Non-executable legacy audit SQL template",
    statement: lines.join("\n"),
    caveats,
  };
}

function reconstructRows(
  plan: AuditRecord,
  resource: string,
  scopePredicates: string[],
  scopeComments: string[],
  bindings: RedactedBindings,
): string[] {
  const selected = strings(plan.select).map(identifier).filter(Boolean);
  const where = [
    ...filterPredicates(plan.where, bindings),
    ...timeWindowPredicates(plan.time_window, bindings),
    ...scopePredicates,
  ];
  const lines = [
    `SELECT ${selected.length ? selected.join(", ") : "NULL /* reviewed row fields were not recorded */ AS unavailable"}`,
    `FROM ${resource}`,
    ...scopeComments.map((comment) => `-- ${comment}`),
    ...whereLines(where),
  ];
  const orderBy = records(plan.order_by).map((entry) => {
    const field = identifier(entry.field);
    const direction = text(entry.direction)?.toUpperCase() === "DESC" ? "DESC" : "ASC";
    return field ? `${field} ${direction}` : undefined;
  }).filter((value): value is string => Boolean(value));
  if (orderBy.length) lines.push(`ORDER BY ${orderBy.join(", ")}`);
  const limit = positiveInteger(plan.limit);
  if (limit) lines.push(`LIMIT ${limit}`);
  return lines;
}

function reconstructAggregate(
  plan: AuditRecord,
  resource: string,
  scopePredicates: string[],
  scopeComments: string[],
  bindings: RedactedBindings,
): string[] {
  const dimensions = records(plan.dimensions).map(dimensionExpressions).filter((entry): entry is GroupingExpression => Boolean(entry));
  const timeBucket = record(plan.time_bucket);
  const timeBucketExpression: GroupingExpression | undefined = identifier(timeBucket.field)
    ? {
        select: "NULL AS time_bucket /* reviewed time-bucket SQL required */",
        group: "time_bucket",
      }
    : undefined;
  const groupingExpressions = [...dimensions, ...(timeBucketExpression ? [timeBucketExpression] : [])];
  const grouping = groupingExpressions.map((entry) => entry.group);
  const measures = records(plan.measures).map(measureExpression).filter(Boolean);
  const select = [
    ...groupingExpressions.map((entry) => entry.select),
    ...(measures.length ? measures : ["COUNT(*) AS count"]),
  ];
  const where = [
    ...filterPredicates(plan.where, bindings),
    ...timeWindowPredicates(plan.time_window, bindings),
    ...scopePredicates,
  ];
  const lines = [
    "SELECT",
    ...select.map((entry, index) => `  ${entry}${index < select.length - 1 ? "," : ""}`),
    `FROM ${resource}`,
    ...(identifier(plan.relationship)
      ? [`-- aggregate base uses reviewed relationship ${identifier(plan.relationship)}`]
      : []),
    ...scopeComments.map((comment) => `-- ${comment}`),
    ...whereLines(where),
  ];
  if (grouping.length) lines.push("GROUP BY", ...grouping.map((entry, index) => `  ${entry}${index < grouping.length - 1 ? "," : ""}`));

  const comparison = record(plan.comparison);
  if (identifier(comparison.field)) {
    lines.push(`-- comparison field: ${fieldExpression(comparison.field, comparison.relationship)}`);
    const ranges = records(comparison.ranges).map((range) =>
      `[${bindings.render(range.start)}, ${bindings.render(range.end)})`);
    if (ranges.length) lines.push(`-- comparison ranges: ${ranges.join(" versus ")}`);
  }

  const orderBy = record(plan.order_by);
  const orderDirection = text(orderBy.direction)?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  if (text(orderBy.kind) === "measure") {
    const measureIndex = positiveInteger(orderBy.index) ?? 0;
    lines.push(`ORDER BY ${grouping.length + measureIndex + 1} ${orderDirection} /* reviewed measure ${measureIndex + 1} */`);
  } else if (text(orderBy.kind) === "comparison_change") {
    lines.push(`-- ORDER BY reviewed comparison ${identifier(orderBy.change) || "change"} ${orderDirection}; comparison transform SQL was not stored`);
  } else if (text(orderBy.kind) === "time_bucket") {
    if (timeBucketExpression) lines.push(`ORDER BY ${dimensions.length + 1} ${orderDirection} /* reviewed time bucket */`);
  }
  const topN = positiveInteger(plan.top_n);
  if (topN) lines.push(`LIMIT ${topN}`);
  return lines;
}

type GroupingExpression = {
  select: string;
  group: string;
};


function dimensionExpressions(value: AuditRecord): GroupingExpression | undefined {
  const field = identifier(value.field);
  if (field) {
    const relationship = identifier(value.relationship);
    return relationship
      ? {
          select: `NULL AS ${field} /* reviewed relationship JOIN required */`,
          group: field,
        }
      : { select: field, group: field };
  }
  if (typeof value.numeric_band === "string") {
    const band = identifier(value.numeric_band) || "reviewed_band";
    return {
      select: `NULL AS ${band} /* reviewed band SQL required */`,
      group: band,
    };
  }
  const band = record(value.numeric_band);
  const bandField = identifier(band.field);
  if (!bandField) return undefined;
  const alias = `${bandField}_band`;
  return {
    select: `NULL AS ${alias} /* reviewed auto-band SQL required */`,
    group: alias,
  };
}

function measureExpression(value: AuditRecord): string {
  const derived = identifier(value.derived_measure);
  if (derived) return `NULL /* REQUIRED reviewed metric ${derived}; formula SQL not stored */ AS ${derived}`;
  const operation = identifier(value.function)?.toUpperCase();
  if (!operation) return "";
  const field = identifier(value.field);
  const argument = field ? fieldExpression(field, value.relationship) : "*";
  if (operation === "COUNT_DISTINCT") return `COUNT(DISTINCT ${argument}) AS count_distinct_${field || "rows"}`;
  if (operation === "NULL_COUNT") return `SUM(CASE WHEN ${argument} IS NULL THEN 1 ELSE 0 END) AS null_count_${field || "rows"}`;
  if (operation === "NON_NULL_COUNT") return `SUM(CASE WHEN ${argument} IS NULL THEN 0 ELSE 1 END) AS non_null_count_${field || "rows"}`;
  if (operation === "COMPLETION_RATE") return `AVG(CASE WHEN ${argument} IS NULL THEN 0.0 ELSE 1.0 END) AS completion_rate_${field || "rows"}`;
  return `${operation}(${argument}) AS ${operation.toLowerCase()}${field ? `_${field.replaceAll(".", "_")}` : ""}`;
}

function filterPredicates(value: unknown, bindings: RedactedBindings): string[] {
  return records(value).map((filter) => {
    const field = identifier(filter.field);
    const operation = text(filter.op)?.toLowerCase();
    if (!field || !operation) return undefined;
    const left = fieldExpression(field, filter.relationship);
    const operator = {
      eq: "=",
      neq: "<>",
      lt: "<",
      lte: "<=",
      gt: ">",
      gte: ">=",
      in: "IN",
    }[operation];
    if (!operator) return undefined;
    const placeholder = bindings.render(filter.value);
    return operation === "in" ? `${left} IN (${placeholder})` : `${left} ${operator} ${placeholder}`;
  }).filter((value): value is string => Boolean(value));
}

function timeWindowPredicates(value: unknown, bindings: RedactedBindings): string[] {
  const window = record(value);
  const field = identifier(window.field);
  if (!field) return [];
  const expression = fieldExpression(field, window.relationship);
  return [
    `${expression} >= ${bindings.render(window.start)}`,
    `${expression} < ${bindings.render(window.end)}`,
  ];
}

function scopeClauses(input: ReconstructInput): {
  predicates: string[];
  comments: string[];
  caveats: string[];
} {
  const application = record(input.scopeApplication);
  const tenant = record(application.tenant);
  const principal = record(application.principal);
  const predicates: string[] = [];
  const comments: string[] = [];
  const caveats: string[] = [];

  if (tenant.predicate_applied === true) {
    predicates.push(scopePredicate("tenant", tenant));
    caveats.push(`Tenant scope: predicate applied by Runner through ${scopeDescription(tenant)}.`);
  } else if (text(tenant.kind)) {
    comments.push(`tenant predicate not applied: ${scopeDescription(tenant)}`);
  } else if (record(input.trustedScope).tenant_bound === true || input.tenantRecorded) {
    predicates.push("1 = 0 /* REQUIRED Runner tenant scope; see notes */");
    caveats.push("Exact tenant-predicate metadata was not recorded for this legacy event.");
  }

  if (principal.predicate_applied === true) {
    predicates.push(scopePredicate("principal", principal));
    caveats.push(`Principal scope: predicate applied by Runner through ${scopeDescription(principal)}.`);
  } else if (text(principal.kind)) {
    comments.push(`principal predicate not applied: ${scopeDescription(principal)}`);
  } else if (record(input.trustedScope).principal_bound === true || input.principalRecorded) {
    predicates.push("1 = 0 /* REQUIRED Runner principal scope; see notes */");
    caveats.push("Exact principal-predicate metadata was not recorded for this legacy event.");
  }
  return { predicates, comments, caveats };
}

function scopeDescription(scope: AuditRecord): string {
  const kind = identifier(scope.kind) || "reviewed scope";
  const column = identifier(scope.column);
  const path = identifier(scope.path_id);
  if (column) return `${kind} column ${column}`;
  if (path) return `${kind} path ${path}`;
  return kind.replaceAll("_", " ");
}

function scopePredicate(kind: "tenant" | "principal", scope: AuditRecord): string {
  const column = identifier(scope.column);
  const path = identifier(scope.path_id);
  if (column) {
    return `${column} = :trusted_${kind} /* Runner ${kind} scope */`;
  }
  return `1 = 0 /* REQUIRED Runner ${kind} scope; see notes${path ? ` for ${path}` : ""} */`;
}

function whereLines(predicates: string[]): string[] {
  if (!predicates.length) return [];
  return [
    "WHERE",
    ...predicates.map((predicate, index) => `  ${index === 0 ? "" : "AND "}${predicate}`),
  ];
}

function fieldExpression(fieldValue: unknown, relationshipValue: unknown): string {
  const field = identifier(fieldValue) || "<reviewed field>";
  const relationship = identifier(relationshipValue);
  return relationship
    ? "NULL /* REQUIRED relationship JOIN; see notes */"
    : field;
}


type RedactedBindings = {
  render(value: unknown): string;
};


function redactedBindings(): RedactedBindings {
  let index = 0;
  return {
    render(_value: unknown): string {
      index += 1;
      return `:value_${index} /* redacted */`;
    },
  };
}


function relationshipCaveats(plan: AuditRecord): string[] {
  const candidates = [
    ...records(plan.dimensions),
    ...records(plan.measures),
    ...records(plan.where),
    record(plan.time_bucket),
    record(plan.time_window),
    record(plan.comparison),
  ];
  const seen = new Set<string>();
  const caveats: string[] = [];
  for (const candidate of candidates) {
    const relationship = identifier(candidate.relationship);
    if (!relationship || seen.has(relationship)) continue;
    seen.add(relationship);
    const field = identifier(candidate.field) || "reviewed field";
    caveats.push(`Relationship field ${field} uses reviewed path ${relationship}; exact JOIN SQL was not persisted.`);
  }
  return caveats;
}


function requiresSqlReconstructionGuard(plan: AuditRecord): boolean {
  if (strings(plan.select).length === 0 && text(plan.kind) === "rows") return true;
  const dimensions = records(plan.dimensions);
  const measures = records(plan.measures);
  const relationshipCarriers = [
    ...dimensions,
    ...measures,
    ...records(plan.where),
    record(plan.time_bucket),
    record(plan.time_window),
    record(plan.comparison),
  ];
  return relationshipCarriers.some((entry) => Boolean(identifier(entry.relationship)))
    || dimensions.some((entry) => entry.numeric_band !== undefined)
    || measures.some((entry) => Boolean(identifier(entry.derived_measure)))
    || Boolean(identifier(record(plan.time_bucket).field))
    || Object.keys(record(plan.comparison)).length > 0;
}

function records(value: unknown): AuditRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function record(value: unknown): AuditRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as AuditRecord
    : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, 512) : undefined;
}

function identifier(value: unknown): string {
  return text(value)?.replace(/[^A-Za-z0-9_.$:-]/g, "_") ?? "";
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}
