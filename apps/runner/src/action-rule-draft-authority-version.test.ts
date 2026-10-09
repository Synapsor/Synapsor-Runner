import { describe, expect, it } from "vitest";
import { createActionRuleAuthority } from "@synapsor-runner/action-rules";
import { actionRuleModelDraftFromAuthority, parseActionRuleModelDraftProposal, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { actionRuleTrustedFailure } from "./action-rule-authoring-error.js";
import { experimentalSharedSumFixture } from "../../../packages/action-rules/src/testing/experimental-shared-sum-fixture.js";
import { reviewedSharedSumFixture } from "../../../packages/action-rules/src/testing/reviewed-shared-sum-fixture.js";
import { weightedConstraintFixture } from "../../../packages/action-rules/src/testing/weighted-constraint-fixture.js";

const review: ActionRuleModelDraftV1["review"] = { when: "When the reviewed rule is eligible.", then: "Apply the reviewed effect.",
  refused: ["Outside reviewed scope."], human_review: "One independent reviewer.",
  examples: [{ kind: "eligible", scenario: "Eligible Source row.", result: "Review the derived effect." }] };
describe("actual authority version dispatch into the existing Action draft", () => {
  it("keeps weighted authority intact and reports the unsupported authoring path as terminal", () => {
    const f = weightedConstraintFixture();
    const { authority } = createActionRuleAuthority({ name: "weighted_draft_dispatch", action_boundary_name: "weighted.actions",
      catalog: f.catalog, rules: f.entries, shared_sum: f.shared_sum });
    const before = structuredClone(authority);
    let failure: unknown;
    try { actionRuleModelDraftFromAuthority({ authority, outcome: "shared.credit", review }); } catch (error) { failure = error; }
    expect(actionRuleTrustedFailure(failure)).toMatchObject({ origin: "authoring", presentation: "terminal",
      code: "ACTION_RULE_SHARED_SUM_PROTOCOL_REQUIRED", path: "authority.shared_sum" });
    expect(authority).toEqual(before);
  });
  it("retains the legacy unshared authority draft version", () => {
    const { authority } = experimentalSharedSumFixture().authority, before = structuredClone(authority);
    const draft = actionRuleModelDraftFromAuthority({ authority, outcome: "shared.credit", review });
    expect(draft.schema_version).toBe("synapsor.action-rule-model-draft.v1");
    expect(draft).not.toHaveProperty("shared_sum_proposal");
    expect(parseActionRuleModelDraftProposal(draft)).toEqual(draft);
    expect(authority).toEqual(before);
  });
  it("retains the exact same-unit designation in the existing shared draft version", () => {
    const f = reviewedSharedSumFixture(), authority = f.authority.authority, before = structuredClone(authority);
    const draft = actionRuleModelDraftFromAuthority({ authority, outcome: "shared.credit", review });
    expect(draft.schema_version).toBe("synapsor.action-rule-model-draft.v2");
    expect(draft.shared_sum_proposal).toEqual(f.shared_sum.designation);
    expect(parseActionRuleModelDraftProposal(draft)).toEqual(draft);
    expect(authority).toEqual(before);
  });
});
