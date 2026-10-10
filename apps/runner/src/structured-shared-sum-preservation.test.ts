import { expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createActionRuleAuthority } from "@synapsor-runner/action-rules";
import { reviewedSharedSumFixture } from "../../../packages/action-rules/src/testing/reviewed-shared-sum-fixture.js";
import { assertStructuredSharedSumRewriteAvailable } from "./structured-shared-sum-preservation.js";

it("refuses reconstruction of a saved shared bundle when a replacement omits its bundle-level designation",()=>{
  // Constructor fixture only: this attributed shape is not native operator
  // authentication. No artifact is injected into a public project or activated.
  const original=reviewedSharedSumFixture().authority.authority;
  const before=canonicalJsonDigest(original);
  const rebuild=()=>createActionRuleAuthority({name:original.name,action_boundary_name:original.action_boundary.name,
    catalog:original.catalog,rules:original.rules,approval_classes:original.approval_classes});
  expect(rebuild().authority.shared_sum).toBeUndefined();
  expect(()=>{assertStructuredSharedSumRewriteAvailable(original);rebuild();}).toThrow("STRUCTURED_DRAFT_SHARED_SUM_REVIEW_REQUIRED");
  expect(canonicalJsonDigest(original)).toBe(before);
});

it("keeps ordinary bundles available without inventing a shared review",()=>{
  const reviewed=reviewedSharedSumFixture().authority.authority;
  const ordinary=createActionRuleAuthority({name:reviewed.name,action_boundary_name:reviewed.action_boundary.name,
    catalog:reviewed.catalog,rules:reviewed.rules,approval_classes:reviewed.approval_classes}).authority;
  expect(()=>assertStructuredSharedSumRewriteAvailable(ordinary)).not.toThrow();
  expect(()=>assertStructuredSharedSumRewriteAvailable()).not.toThrow();
});
