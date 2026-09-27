import { describe, expect, it } from "vitest";
import { scopedExploreQueryToolOutputSchema } from "./analytics-output-schema.js";
import { withResultEvidence } from "./result-evidence.js";

// DERIVED final envelopes. Actual bounded-query authorization and cache
// behavior are exercised through the real runtime in scoped-explore.test.ts.
const cursor = `cur_${"a".repeat(43)}`;
const pagination = { page_item_count: 2, has_more: true, next_cursor: cursor,
  total: { kind: "exact_bounded_query_result", value: 5 }, continuation: "same_bounded_result",
  consistency: "fixed_original_query_result", guidance: "Continue this bounded result only." };
const base = { ok: true, kind: "rows", source_database_changed: false,
  outcome: { type: "success", status: "ok", result: { pagination } }, data: [{ name: "a" }, { name: "b" }],
  row_continuation: { page_rows: 2, offset: 0, original_result_rows: 5, original_query_limit: 10,
    source_query_executed_this_call: true, reference_expiry: "unchanged" } };

describe("bounded row continuation output and evidence", () => {
  it("keeps exact bounded result totals separate from query/population completeness", () => {
    const output = withResultEvidence("app.explore_data", base);
    expect(scopedExploreQueryToolOutputSchema.parse(output)).toEqual(output);
    expect(output.result_evidence).toMatchObject({ family: "source.rows", returned: { count: 2, unit: "rows" }, coverage: { status: "unknown" }, next_step: "continue_page" });
    expect(output.evidence_summary).toContain("not a source-population total");
    const last = withResultEvidence("app.explore_data", { ...base,
      outcome: { ...base.outcome, result: { pagination: { ...pagination, has_more: false, next_cursor: null } } },
      row_continuation: { ...base.row_continuation, offset: 4, source_query_executed_this_call: false } });
    expect(scopedExploreQueryToolOutputSchema.parse(last)).toEqual(last);
    expect(last.result_evidence).toMatchObject({ coverage: { status: "unknown" }, next_step: "use_authorized_status" });
    expect(last.evidence_summary).toContain("does not renew reference expiry");
  });
  it("retains the legacy envelope and rejects mixed modes or invented renewal", () => {
    const legacy = { page_item_count: 2, has_more: null, next_cursor: null, total: { kind: "unavailable" },
      continuation: "not_supported", consistency: "single_read_only_transaction", guidance: "Completeness unknown." };
    expect(scopedExploreQueryToolOutputSchema.safeParse({ ...base, row_continuation: undefined, outcome: { ...base.outcome, result: { pagination: legacy } } }).success).toBe(true);
    for (const invalid of [ { ...pagination, next_cursor: "forged" }, { ...pagination, total: { kind: "source_population", value: 5 } },
      { ...pagination, consistency: "single_read_only_transaction" }, { ...legacy, has_more: false } ]) {
      expect(scopedExploreQueryToolOutputSchema.safeParse({ ...base, outcome: { ...base.outcome, result: { pagination: invalid } } }).success).toBe(false);
    }
    expect(scopedExploreQueryToolOutputSchema.safeParse({ ...base, row_continuation: { ...base.row_continuation, reference_expiry: "renewed" } }).success).toBe(false);
    expect(scopedExploreQueryToolOutputSchema.safeParse({ ...base, row_continuation: { ...base.row_continuation, invented_snapshot: true } }).success).toBe(false);
  });
});
