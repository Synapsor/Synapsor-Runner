import { describe, expect, it } from "vitest";
import { boundaryMapFieldReview, describeInspectedBoundaryField, type BoundaryMapOperationFlags } from "./boundary-map-presentation.js";
const none: BoundaryMapOperationFlags = {return_value:false,filter:false,sort:false,group:false,measure:false,presence:false,distinct:false,time:false};
describe("typed Read field presentation", () => {
  it("retains review for model-facing private roles independently of wording", () => {
    const review = boundaryMapFieldReview(["private_policy_candidate"], "MODEL", {...none,return_value:true});
    expect(review.review_required).toBe(true);
    expect(boundaryMapFieldReview(["private_policy_candidate"], "RUNNER", {...none,filter:true}).review_required).toBe(true);
    expect(boundaryMapFieldReview(["private_policy_candidate"], "MODEL", none).review_required).toBe(false);
    expect(boundaryMapFieldReview(["private_policy_candidate"], "KEPT", none).review_required).toBe(false);
  });
  it("keeps unknown role prose from inventing review or authority", () => {
    expect(boundaryMapFieldReview(["record identity", "REVIEW:"], "MODEL", {...none,return_value:true})).toEqual({review_required:false});
  });
  it("describes opaque references for both typed identity roles", () => {
    for (const role of ["record_identity", "internal_identifier_candidate"]) {
      const result=boundaryMapFieldReview([role],"RUNNER",{...none,return_value:true});
      expect(result.review_required).toBe(false);
      expect(result.note).toContain("opaque obj_* references");
    }
  });
  it("renders only inspected enum values, not asserted evidence prose", () => {
    const field={name:"state",data_type:"text",enum_values:["WAITING","READY"],evidence:["database enum values: invented"]};
    expect(describeInspectedBoundaryField("public.tasks",field)).toContain("WAITING, READY");
    expect(describeInspectedBoundaryField("public.tasks",field)).not.toContain("invented");
    expect(describeInspectedBoundaryField("public.tasks",{name:"state",data_type:"text"})).not.toContain("database-declared values");
  });
});
