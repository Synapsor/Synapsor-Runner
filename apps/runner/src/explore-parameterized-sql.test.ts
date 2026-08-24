import { describe, expect, it } from "vitest";
import {
  captureExploreParameterizedSql,
  readCapturedExploreParameterizedSql,
} from "./explore-parameterized-sql.js";

describe("Explore parameterized SQL audit capture", () => {
  it("retains the exact reviewed JOIN shape without retaining any parameter value", () => {
    const captured = captureExploreParameterizedSql({
      engine: "postgres",
      statements: [{
        sql: [
          'SELECT t3."college_name", AVG(t0."term_gpa")',
          'FROM "institutional_research"."student_term_enrollments" t0',
          'JOIN "institutional_research"."programs" t1 ON t0."program_id" = t1."id"',
          'JOIN "institutional_research"."departments" t2 ON t1."department_id" = t2."id"',
          'JOIN "institutional_research"."colleges" t3 ON t2."college_id" = t3."id"',
          'WHERE t0."tenant_id" = $1 GROUP BY t3."college_name" LIMIT $2',
        ].join(" "),
        params: ["university-secret", 25],
      }],
    });

    expect(captured).toMatchObject({
      engine: "postgres",
      parameter_values_persisted: false,
      model_received_sql: false,
      statements: [{
        parameter_count: 2,
        parameter_types: ["string", "integer"],
      }],
    });
    expect(captured.statements[0]?.statement).toContain(
      'JOIN "institutional_research"."colleges" t3 ON t2."college_id" = t3."id"',
    );
    expect(JSON.stringify(captured)).not.toContain("university-secret");
  });

  it("preserves comparison statement periods while omitting both parameter arrays", () => {
    const captured = captureExploreParameterizedSql({
      engine: "mysql",
      statements: [
        { sql: "SELECT COUNT(*) FROM `events` WHERE `tenant_id` = ? AND `at` >= ?", params: ["north", "2026-01-01"], period: "period_1" },
        { sql: "SELECT COUNT(*) FROM `events` WHERE `tenant_id` = ? AND `at` >= ?", params: ["north", "2026-02-01"], period: "period_2" },
      ],
    });

    expect(captured.statements.map((statement) => statement.period)).toEqual(["period_1", "period_2"]);
    expect(JSON.stringify(captured)).not.toMatch(/north|2026-01-01|2026-02-01/);
    expect(readCapturedExploreParameterizedSql(captured)).toEqual(captured);
  });

  it("rejects malformed or value-bearing ledger metadata", () => {
    const base = captureExploreParameterizedSql({
      engine: "postgres",
      statements: [{ sql: "SELECT 1 WHERE $1 = $1", params: [true] }],
    });
    expect(readCapturedExploreParameterizedSql({
      ...base,
      parameter_values_persisted: true,
      parameter_values: ["secret"],
    })).toBeUndefined();
    expect(readCapturedExploreParameterizedSql({
      ...base,
      statements: [{ ...base.statements[0], parameter_count: 2 }],
    })).toBeUndefined();
  });
});
