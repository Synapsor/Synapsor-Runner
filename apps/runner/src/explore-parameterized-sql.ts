export const EXPLORE_PARAMETERIZED_SQL_SCHEMA_VERSION =
  "synapsor.explore-parameterized-sql.v1" as const;

export type ExploreParameterType =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "string";

export type CapturedExploreParameterizedSql = {
  schema_version: typeof EXPLORE_PARAMETERIZED_SQL_SCHEMA_VERSION;
  engine: "postgres" | "mysql";
  provenance: "captured_before_source_execution";
  parameter_values_persisted: false;
  model_received_sql: false;
  statements: Array<{
    statement: string;
    parameter_count: number;
    parameter_types: ExploreParameterType[];
    period?: "period_1" | "period_2";
  }>;
};

type CompiledStatementInput = {
  sql: string;
  params: unknown[];
  period?: "period_1" | "period_2";
};

/**
 * Captures only the parameterized statement shape that Runner hands to the
 * source driver. Parameter values never enter the returned audit object.
 */
export function captureExploreParameterizedSql(input: {
  engine: "postgres" | "mysql";
  statements: CompiledStatementInput[];
}): CapturedExploreParameterizedSql {
  return {
    schema_version: EXPLORE_PARAMETERIZED_SQL_SCHEMA_VERSION,
    engine: input.engine,
    provenance: "captured_before_source_execution",
    parameter_values_persisted: false,
    model_received_sql: false,
    statements: input.statements.map((statement) => ({
      statement: statement.sql,
      parameter_count: statement.params.length,
      parameter_types: statement.params.map(parameterType),
      ...(statement.period ? { period: statement.period } : {}),
    })),
  };
}

/**
 * Treats ledger payloads as untrusted input and returns only a complete,
 * bounded capture. Malformed or future-version records fall back to the
 * non-executable audit template.
 */
export function readCapturedExploreParameterizedSql(
  value: unknown,
): CapturedExploreParameterizedSql | undefined {
  if (!isRecord(value)
    || value.schema_version !== EXPLORE_PARAMETERIZED_SQL_SCHEMA_VERSION
    || (value.engine !== "postgres" && value.engine !== "mysql")
    || value.provenance !== "captured_before_source_execution"
    || value.parameter_values_persisted !== false
    || value.model_received_sql !== false
    || !Array.isArray(value.statements)
    || value.statements.length < 1
    || value.statements.length > 2) {
    return undefined;
  }

  const statements: CapturedExploreParameterizedSql["statements"] = [];
  for (const candidate of value.statements) {
    if (!isRecord(candidate)
      || typeof candidate.statement !== "string"
      || candidate.statement.length < 1
      || candidate.statement.length > 1_000_000
      || !Number.isSafeInteger(candidate.parameter_count)
      || Number(candidate.parameter_count) < 0
      || !Array.isArray(candidate.parameter_types)
      || candidate.parameter_types.length !== candidate.parameter_count
      || !candidate.parameter_types.every(isParameterType)
      || (candidate.period !== undefined
        && candidate.period !== "period_1"
        && candidate.period !== "period_2")) {
      return undefined;
    }
    statements.push({
      statement: candidate.statement,
      parameter_count: Number(candidate.parameter_count),
      parameter_types: [...candidate.parameter_types] as ExploreParameterType[],
      ...(candidate.period ? { period: candidate.period } : {}),
    });
  }

  return {
    schema_version: EXPLORE_PARAMETERIZED_SQL_SCHEMA_VERSION,
    engine: value.engine,
    provenance: "captured_before_source_execution",
    parameter_values_persisted: false,
    model_received_sql: false,
    statements,
  };
}

function parameterType(value: unknown): ExploreParameterType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

function isParameterType(value: unknown): value is ExploreParameterType {
  return value === "array"
    || value === "boolean"
    || value === "integer"
    || value === "null"
    || value === "number"
    || value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
