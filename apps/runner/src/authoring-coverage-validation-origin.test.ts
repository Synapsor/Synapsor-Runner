import { describe, expect, it } from "vitest";
import { CoverageComponentError, CoverageValidationError, coverageFinding,
  type CoverageValidationFailureReason } from "./authoring-coverage-feedback.js";

const failures = [
  ["reference_missing", "Draft pointer(s) not present: arbitrary", "COVERAGE_REFERENCE_MISSING", true],
  ["deployment_component_mixed", "draft_paths must contain only arbitrary", "COVERAGE_DEPLOYMENT_COMPONENT_MIXED", true],
  ["counter_reference_overbroad", "Counter requirements must name an exact referenced arbitrary", "COUNTING_REFERENCE_OVERBROAD", true],
  ["field_evidence_unavailable", "Field privacy evidence is not present: arbitrary", "COVERAGE_FIELD_EVIDENCE_UNAVAILABLE", false],
  ["structure_invalid", "Each passage must be an object", "COVERAGE_STRUCTURE_INVALID", true],
  ["evidence_value_mismatch", "Mechanical evidence mismatch at arbitrary", "COVERAGE_EVIDENCE_VALUE_MISMATCH", true],
  ["privacy_conflict", "Field coverage mismatch: arbitrary", "COVERAGE_PRIVACY_CONFLICT", false],
  ["counter_structure_invalid", "Invalid counter requirements record", "COVERAGE_COUNTER_STRUCTURE_INVALID", true],
  ["override_unestablished", "An override must reference an actual operator message.", "COVERAGE_OVERRIDE_UNESTABLISHED", false],
  ["obligation_structure_invalid", "Invalid application obligation record", "COVERAGE_OBLIGATION_STRUCTURE_INVALID", true],
] as const satisfies ReadonlyArray<readonly [CoverageValidationFailureReason, string, string, boolean]>;

for (const [reason, prose, code, structural] of failures) {
  describe(`B64 closed coverage rejection origin ${reason}`, () => {
    it.each([false, true])("does not classify arbitrary prose (wrapped=%s)", wrapped => {
      const error = new Error(prose);
      const finding = coverageFinding(wrapped ? new CoverageComponentError("/passages/0", error) : error, "/", {});
      expect(finding).toMatchObject({ code: "COVERAGE_VALIDATION_INCOMPLETE", structural: false });
      expect(finding.typed_reason).toBeUndefined();
    });
    it.each([false, true])("uses the real closed error despite localized presentation (wrapped=%s)", wrapped => {
      const error = new CoverageValidationError(reason, "Geprüfte Ablehnung");
      const finding = coverageFinding(wrapped ? new CoverageComponentError("/passages/0", error) : error, "/", {});
      expect(finding).toMatchObject({ code, structural });
      expect(finding.reason).not.toContain("Geprüfte");
      expect(finding.repair.length).toBeGreaterThan(20);
    });
    it("does not accept a serialized or provider-created reason object", () => {
      const fake = { name: "CoverageValidationError", reason, message: prose };
      expect(coverageFinding(fake, "/", {})).toMatchObject({ code: "COVERAGE_VALIDATION_INCOMPLETE", structural: false });
    });
  });
}
