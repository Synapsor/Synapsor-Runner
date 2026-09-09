import { describe, expect, it } from "vitest";
import { parseBoundaryReviewResources } from "./boundary-review-decision-file.js";

describe("structured boundary resource input", () => {
  it.each([
    { resource_id: "university.students", include: "false" },
    { resource_id: "university.students", selectable_fields: "student_id" },
    { resource_id: "university.students", principal_scope_path: 7 },
    { resource_id: "university.students", relationship_ids: ["institution", false] },
  ])("refuses malformed public resource input %#", (resource) => {
    expect(() => parseBoundaryReviewResources([resource], {
      actor: "external_draft", reason: "Pending human review.",
    })).toThrow();
  });

  it("assigns fixed reviewer facts after strict parsing", () => {
    expect(parseBoundaryReviewResources([{
      resource_id: "university.students", include: true,
      tenant_scope_path: "institution",
      relationship_ids: ["institution"],
      withhold_from_model_fields: ["student_id"],
      preserve_unselected_fields: ["student_id"],
    }], { actor: "external_draft", reason: "Pending human review." })).toEqual([
      expect.objectContaining({ actor: "external_draft", reason: "Pending human review.", include: true }),
    ]);
  });
});
