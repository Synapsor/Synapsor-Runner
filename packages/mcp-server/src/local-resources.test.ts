import { describe, expect, it } from "vitest";
import { projectOperatorOnlyAuditMetadata } from "./local-resources.js";

describe("model-facing local resource projection", () => {
  it("removes operator SQL recursively from evidence and replay metadata", () => {
    const projected = projectOperatorOnlyAuditMetadata({
      evidence: {
        payload: {
          parameterized_sql_included: true,
          parameter_values_persisted: false,
          parameterized_sql: {
            statements: [{ statement: "SELECT secret_column FROM private_table" }],
          },
        },
        query_audit: [{
          payload: {
            parameterized_sql: { statements: [{ statement: "SELECT 1" }] },
          },
        }],
      },
    });

    expect(projected).toMatchObject({
      evidence: {
        payload: {
          parameterized_sql_included: true,
          parameter_values_persisted: false,
        },
        query_audit: [{ payload: {} }],
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/SELECT|secret_column|private_table/);
  });
});
