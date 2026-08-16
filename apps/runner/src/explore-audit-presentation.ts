type AuditRecord = Record<string, unknown>;

export type ReconstructedExploreAuditQuery = {
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
  scopeApplication?: unknown;
  trustedScope?: unknown;
  tenantRecorded?: boolean;
  principalRecorded?: boolean;
};

/**
 * Builds a SQL-like operator explanation from redacted audit metadata only.
 * It is deliberately not executable SQL and never renders stored literal values.
 */
export function reconstructExploreAuditQuery(
  input: ReconstructInput,
): ReconstructedExploreAuditQuery | undefined {
  const plan = record(input.normalizedPlan);
  const kind = text(plan.kind);
  const resource = identifier(plan.resource);
  if (!resource || (kind !== "rows" && kind !== "aggregate")) return undefined;

  const caveats = [
    "Reconstructed from the reviewed normalized plan; this is not captured or executable SQL.",
    "Filter values are keyed placeholders because raw values are not stored.",
  ];
  const scope = scopeClauses(input);
  caveats.push(...scope.caveats);

  const lines = kind === "rows"
    ? reconstructRows(plan, resource, scope.predicates, scope.comments)
    : reconstructAggregate(plan, resource, scope.predicates, scope.comments);
  return { statement: lines.join("\n"), caveats };
}

function reconstructRows(
  plan: AuditRecord,
  resource: string,
  scopePredicates: string[],
  scopeComments: string[],
): string[] {
  const selected = strings(plan.select).map(identifier).filter(Boolean);
  const where = [
    ...filterPredicates(plan.where),
    ...timeWindowPredicates(plan.time_window),
    ...scopePredicates,
  ];
  const lines = [
    `SELECT ${selected.length ? selected.join(", ") : "<reviewed fields>"}`,
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
): string[] {
  const dimensions = records(plan.dimensions).map(dimensionExpression).filter(Boolean);
  const timeBucket = record(plan.time_bucket);
  const timeBucketExpression = identifier(timeBucket.field)
    ? `TIME_BUCKET(${identifier(timeBucket.field)}, ${identifier(timeBucket.bucket) || "reviewed_interval"}${relationshipSuffix(timeBucket.relationship)})`
    : undefined;
  const grouping = [...dimensions, ...(timeBucketExpression ? [timeBucketExpression] : [])];
  const measures = records(plan.measures).map(measureExpression).filter(Boolean);
  const select = [...grouping, ...(measures.length ? measures : ["COUNT(*) AS count"])];
  const where = [
    ...filterPredicates(plan.where),
    ...timeWindowPredicates(plan.time_window),
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
      `[${literalPlaceholder(range.start)}, ${literalPlaceholder(range.end)})`);
    if (ranges.length) lines.push(`-- comparison ranges: ${ranges.join(" versus ")}`);
  }

  const orderBy = record(plan.order_by);
  const orderDirection = text(orderBy.direction)?.toUpperCase() === "ASC" ? "ASC" : "DESC";
  if (text(orderBy.kind) === "measure") {
    lines.push(`ORDER BY measure_${(positiveInteger(orderBy.index) ?? 0) + 1} ${orderDirection}`);
  } else if (text(orderBy.kind) === "comparison_change") {
    lines.push(`ORDER BY comparison_${identifier(orderBy.change) || "change"}_${(positiveInteger(orderBy.index) ?? 0) + 1} ${orderDirection}`);
  } else if (text(orderBy.kind) === "time_bucket") {
    lines.push(`ORDER BY time_bucket ${orderDirection}`);
  }
  const topN = positiveInteger(plan.top_n);
  if (topN) lines.push(`LIMIT ${topN}`);
  return lines;
}

function dimensionExpression(value: AuditRecord): string {
  const field = identifier(value.field);
  if (field) return fieldExpression(field, value.relationship);
  if (typeof value.numeric_band === "string") {
    return `REVIEWED_BAND(${identifier(value.numeric_band)})`;
  }
  const band = record(value.numeric_band);
  const bandField = identifier(band.field);
  if (!bandField) return "";
  return `AUTO_BAND(${bandField}, ${identifier(band.method) || "reviewed_method"}, ${positiveInteger(band.buckets) ?? "reviewed_count"})`;
}

function measureExpression(value: AuditRecord): string {
  const derived = identifier(value.derived_measure);
  if (derived) return `REVIEWED_METRIC(${derived}) AS ${derived}`;
  const operation = identifier(value.function)?.toUpperCase();
  if (!operation) return "";
  const field = identifier(value.field);
  const argument = field ? fieldExpression(field, value.relationship) : "*";
  if (operation === "COUNT_DISTINCT") return `COUNT(DISTINCT ${argument}) AS count_distinct_${field || "rows"}`;
  if (operation === "NULL_COUNT" || operation === "NON_NULL_COUNT" || operation === "COMPLETION_RATE") {
    return `${operation}(${argument}) AS ${operation.toLowerCase()}_${field || "rows"}`;
  }
  return `${operation}(${argument}) AS ${operation.toLowerCase()}${field ? `_${field.replaceAll(".", "_")}` : ""}`;
}

function filterPredicates(value: unknown): string[] {
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
    const placeholder = literalPlaceholder(filter.value);
    return operation === "in" ? `${left} IN (${placeholder})` : `${left} ${operator} ${placeholder}`;
  }).filter((value): value is string => Boolean(value));
}

function timeWindowPredicates(value: unknown): string[] {
  const window = record(value);
  const field = identifier(window.field);
  if (!field) return [];
  const expression = fieldExpression(field, window.relationship);
  return [
    `${expression} >= ${literalPlaceholder(window.start)}`,
    `${expression} < ${literalPlaceholder(window.end)}`,
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
    predicates.push(`RUNNER_TENANT_PREDICATE(${scopeFunctionArgument(tenant)})`);
    caveats.push(`Tenant scope: predicate applied by Runner through ${scopeDescription(tenant)}.`);
  } else if (text(tenant.kind)) {
    comments.push(`tenant predicate not applied: ${scopeDescription(tenant)}`);
  } else if (record(input.trustedScope).tenant_bound === true || input.tenantRecorded) {
    comments.push("trusted tenant context was bound; this legacy record does not identify the exact predicate shape");
    caveats.push("Exact tenant-predicate metadata was not recorded for this legacy event.");
  }

  if (principal.predicate_applied === true) {
    predicates.push(`RUNNER_PRINCIPAL_PREDICATE(${scopeFunctionArgument(principal)})`);
    caveats.push(`Principal scope: predicate applied by Runner through ${scopeDescription(principal)}.`);
  } else if (text(principal.kind)) {
    comments.push(`principal predicate not applied: ${scopeDescription(principal)}`);
  } else if (record(input.trustedScope).principal_bound === true || input.principalRecorded) {
    comments.push("trusted principal context was bound; this legacy record does not identify the exact predicate shape");
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

function scopeFunctionArgument(scope: AuditRecord): string {
  const kind = identifier(scope.kind) || "reviewed_scope";
  const column = identifier(scope.column);
  const path = identifier(scope.path_id);
  return [kind, column || path].filter(Boolean).join("_");
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
  return relationship ? `RELATED(${field}, ${relationship})` : field;
}

function relationshipSuffix(value: unknown): string {
  const relationship = identifier(value);
  return relationship ? `, ${relationship}` : "";
}

function literalPlaceholder(value: unknown): string {
  const keyedHash = identifier(record(value).keyed_hash);
  if (keyedHash) return `:keyed(${keyedHash.slice(0, 12)}...)`;
  return ":redacted";
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
