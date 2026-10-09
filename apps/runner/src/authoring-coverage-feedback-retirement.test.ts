import { describe, expect, it } from "vitest";
import { coverageFinding, CoverageComponentError } from "./authoring-coverage-feedback.js";
import { CoverageSourceLinesError } from "./authoring-source-coverage.js";
import { policyTextSnapshot } from "./authoring-policy-source.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";

describe("B64 I04457 source coverage diagnostic retirement", () => {
  it.each([false, true])("does not infer structural omission from arbitrary English error prose (wrapped=%s)", wrapped => {
    const raw = new Error("Unaccounted source lines: 2, 3. Arbitrary external failure.");
    const finding = coverageFinding(wrapped ? new CoverageComponentError("/passages/0", raw) : raw, "/passages", {});
    expect(finding.code).toBe("COVERAGE_VALIDATION_INCOMPLETE");
    expect(finding.structural).toBe(false);
    expect(finding.typed_reason).toBeUndefined();
  });
  it("uses the host error type and exact ranges when presentation changes", () => {
    const source = policyTextSnapshot(Buffer.from("One\nTwo\nThree"), "rules");
    const error = new CoverageSourceLinesError(source.digest, [2, 3]);
    error.message = "Nicht erfasst";
    const finding = coverageFinding(new CoverageComponentError("/passages", error), "/other", {});
    expect(finding).toMatchObject({ code: "COVERAGE_SOURCE_LINES_MISSING", structural: true,
      typed_reason: "source_lines.missing", source_digest: source.digest, missing_ranges: [{ start: 2, end: 3 }], omitted_range_count: 0 });
  });
  it("retains the actual strict parser omission refusal and its typed finding", () => {
    const source = policyTextSnapshot(Buffer.from("Only paid invoices qualify.\nRefund at most $25.\nNever refund twice."), "rules");
    const args = { passages: [{ start: 1, end: 1, disposition: "implemented", interpretation: "Paid invoice", draft_paths: ["/rule/max"] }] };
    let failure: unknown;
    try { parsePolicyCoverage(args, source, { rule: { max: 25 } }, ""); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CoverageSourceLinesError);
    expect(coverageFinding(failure, "/passages", args)).toMatchObject({ code: "COVERAGE_SOURCE_LINES_MISSING",
      structural: true, typed_reason: "source_lines.missing", missing_ranges: [{ start: 2, end: 3 }] });
  });
});
