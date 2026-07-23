export type PrivacyBudgetLimits = {
  max_queries_per_session: number;
  rate_limit_per_minute: number;
  max_extracted_cells_per_session: number;
  max_differencing_queries: number;
  max_response_cells: number;
};

export type PrivacyBudgetSnapshot = {
  query_count: number;
  queries_last_minute: number;
  extracted_cells: number;
  differencing_attempts: number;
};

export type PrivacyBoundaryErrorCode =
  | "QUERY_BUDGET_EXHAUSTED"
  | "RATE_LIMIT_EXHAUSTED"
  | "EXTRACTION_BUDGET_EXHAUSTED"
  | "DIFFERENCING_BUDGET_EXHAUSTED"
  | "GROUP_LIMIT_EXCEEDED"
  | "INVALID_COHORT_SIZE";

export class PrivacyBoundaryError extends Error {
  constructor(public readonly code: PrivacyBoundaryErrorCode, message: string) {
    super(message);
    this.name = "PrivacyBoundaryError";
  }
}

export function enforcePrivacyBudgets(input: {
  limits: PrivacyBudgetLimits;
  snapshot: PrivacyBudgetSnapshot;
  estimated_response_cells: number;
  aggregate: boolean;
}): void {
  if (input.snapshot.query_count >= input.limits.max_queries_per_session) {
    throw new PrivacyBoundaryError("QUERY_BUDGET_EXHAUSTED", "The reviewed per-session query budget is exhausted.");
  }
  if (input.snapshot.queries_last_minute >= input.limits.rate_limit_per_minute) {
    throw new PrivacyBoundaryError("RATE_LIMIT_EXHAUSTED", "The reviewed request rate is exhausted.");
  }
  if (input.estimated_response_cells > input.limits.max_response_cells
    || input.snapshot.extracted_cells + input.estimated_response_cells > input.limits.max_extracted_cells_per_session) {
    throw new PrivacyBoundaryError("EXTRACTION_BUDGET_EXHAUSTED", "The reviewed response or cumulative extraction budget would be exceeded.");
  }
  if (input.aggregate && input.snapshot.differencing_attempts >= input.limits.max_differencing_queries) {
    throw new PrivacyBoundaryError("DIFFERENCING_BUDGET_EXHAUSTED", "Repeated aggregate comparisons exhausted the reviewed differencing budget.");
  }
}

/**
 * Apply the common aggregate privacy boundary after a parameterized query.
 *
 * Callers provide already-normalized output rows. This function is the single
 * implementation of cohort suppression, total-group overflow refusal, per-
 * period top-N, and returned-cell accounting used by authoring Explore and
 * protected named capabilities.
 */
export function shapePrivacySuppressedGroups(input: {
  rows: Array<Record<string, unknown>>;
  output_fields: string[];
  cohort_field: string;
  minimum_cohort_size: number;
  maximum_groups: number;
  top_n: number;
  period_field?: string;
  periods?: string[];
}): {
  groups: Array<Record<string, unknown>>;
  suppressed_groups: number;
  returned_cells: number;
} {
  const periods = input.period_field ? input.periods ?? [] : [undefined];
  if (input.period_field && periods.length === 0) {
    throw new PrivacyBoundaryError("GROUP_LIMIT_EXCEEDED", "A period field requires an explicit bounded period set.");
  }
  for (const period of periods) {
    const count = period === undefined
      ? input.rows.length
      : input.rows.filter((row) => row[input.period_field!] === period).length;
    if (count > input.maximum_groups) {
      throw new PrivacyBoundaryError("GROUP_LIMIT_EXCEEDED", `Aggregate result exceeds the reviewed maximum of ${input.maximum_groups} groups.`);
    }
  }

  let suppressedGroups = 0;
  const visible = input.rows.flatMap((row) => {
    const cohortSize = Number(row[input.cohort_field]);
    if (!Number.isSafeInteger(cohortSize) || cohortSize < 0) {
      throw new PrivacyBoundaryError("INVALID_COHORT_SIZE", "Aggregate cohort size must be a non-negative safe integer.");
    }
    if (cohortSize < input.minimum_cohort_size) {
      suppressedGroups += 1;
      return [];
    }
    return [Object.fromEntries(input.output_fields.map((field) => [field, row[field]]))];
  });

  const groups = input.period_field
    ? periods.flatMap((period) =>
      visible.filter((row) => row[input.period_field!] === period).slice(0, input.top_n))
    : visible.slice(0, input.top_n);
  return {
    groups,
    suppressed_groups: suppressedGroups,
    returned_cells: groups.length * input.output_fields.length,
  };
}
