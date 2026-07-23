import { describe, expect, it } from "vitest";
import {
  PrivacyBoundaryError,
  enforcePrivacyBudgets,
  shapePrivacySuppressedGroups,
} from "./privacy-boundary.js";

describe("shared aggregate privacy boundary", () => {
  it("suppresses small cohorts and applies top-N independently per reviewed period", () => {
    const result = shapePrivacySuppressedGroups({
      rows: [
        { region: "west", count: 12, cohort: 12, period: "period_1" },
        { region: "tiny", count: 2, cohort: 2, period: "period_1" },
        { region: "east", count: 9, cohort: 9, period: "period_2" },
      ],
      output_fields: ["region", "count", "period"],
      cohort_field: "cohort",
      minimum_cohort_size: 5,
      maximum_groups: 10,
      top_n: 1,
      period_field: "period",
      periods: ["period_1", "period_2"],
    });
    expect(result).toEqual({
      groups: [
        { region: "west", count: 12, period: "period_1" },
        { region: "east", count: 9, period: "period_2" },
      ],
      suppressed_groups: 1,
      returned_cells: 6,
    });
  });

  it("fails closed on group overflow and privacy-budget exhaustion", () => {
    expect(() => shapePrivacySuppressedGroups({
      rows: [{ count: 5, cohort: 5 }, { count: 6, cohort: 6 }],
      output_fields: ["count"],
      cohort_field: "cohort",
      minimum_cohort_size: 2,
      maximum_groups: 1,
      top_n: 1,
    })).toThrowError(expect.objectContaining({ code: "GROUP_LIMIT_EXCEEDED" }));
    expect(() => enforcePrivacyBudgets({
      limits: {
        max_queries_per_session: 10,
        rate_limit_per_minute: 10,
        max_extracted_cells_per_session: 100,
        max_differencing_queries: 2,
        max_response_cells: 50,
      },
      snapshot: {
        query_count: 2,
        queries_last_minute: 2,
        extracted_cells: 10,
        differencing_attempts: 2,
      },
      estimated_response_cells: 10,
      aggregate: true,
    })).toThrowError(PrivacyBoundaryError);
  });
});
