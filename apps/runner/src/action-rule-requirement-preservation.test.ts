import { describe, expect, it } from "vitest";
import { structuredTestAction } from "./structured-authoring-test-fixture.js";
import type { ActionRequirementProposals } from "./authoring-action-requirements.js";
import { assertActionRuleCountExecutionProposalsPreserved as check } from "./action-rule-requirement-preservation.js";
import { actionRuleTrustedFailure } from "./action-rule-authoring-error.js";

function fixture() {
  const baseline = structuredTestAction("quantity", "q_av", 100, 20);
  const proposals: ActionRequirementProposals = [
    { id: "count", kind: "approval_count", target: { slot: "approval.shared_limits", outcome: baseline.outcome, limit_id: "joint_company" },
      intent: "replace", previous_limits: structuredClone(baseline.approval.shared_limits),
      value: { state: "proposed", basis: "rolling_approved_events", scope: "tenant", maximum: 2, window_seconds: 3600, selector: { kind: "all_outcomes" } } },
    { id: "execution", kind: "execution", target: { slot: "effect.writeback", outcome: baseline.outcome }, value: { state: "proposed", mode: "proposal_only" } },
  ];
  const candidate = { ...structuredClone(baseline), schema_version: "synapsor.action-rule-model-draft.v3" as const, requirement_proposals: proposals };
  candidate.approval.shared_limits[1]! = { id: "joint_company", kind: "count", scope: "tenant", maximum: 2, window_seconds: 3600 };
  candidate.effect.writeback = "proposal_only";
  return { baseline, candidate, proposals };
}

describe("scoped count/execution proposal preservation DATA", () => {
  it("matches selected limits and execution while preserving the full unrelated inventory", () => {
    const f = fixture(), before = structuredClone(f);
    expect(() => check(f)).not.toThrow();
    expect(f).toEqual(before);
  });
  it("retains unrelated total limits as well as count limits", () => {
    const f = fixture();
    const total = { id: "money_total", kind: "total" as const, scope: "tenant" as const, maximum: 5000, window_seconds: 86400, field: "amount" };
    f.baseline.approval.shared_limits.push(total); f.candidate.approval.shared_limits.push(structuredClone(total));
    const p = f.proposals[0]!; if (p.kind !== "approval_count") throw new Error("fixture");
    p.previous_limits = structuredClone(f.baseline.approval.shared_limits);
    expect(() => check(f)).not.toThrow();
    f.candidate.approval.shared_limits.at(-1)!.maximum++;
    expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
  });
  it("checks multiple selected counts against one complete baseline inventory", () => {
    const f = fixture(), p = structuredClone(f.proposals[0]!);
    if (p.kind !== "approval_count" || p.value.state !== "proposed") throw new Error("fixture");
    p.id = "second_count"; p.target.limit_id = "joint_overall"; p.value.scope = "boundary";
    f.proposals.push(p);
    f.candidate.approval.shared_limits[0]! = { id: "joint_overall", kind: "count", scope: "boundary", maximum: 2, window_seconds: 3600 };
    expect(() => check(f)).not.toThrow();
    f.candidate.approval.shared_limits[1]!.maximum++;
    expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
  });
  it("refuses a per-outcome replacement of a reviewed pooled count", () => {
    const f = fixture(); f.candidate.approval.shared_limits[1]!.capability = f.baseline.outcome;
    expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
  });
  it("refuses drift in each count tuple field", () => {
    for (const change of [{ scope: "boundary" }, { maximum: 3 }, { window_seconds: 86400 }, { id: "different" }, { kind: "total", field: "units" }]) {
      const f = fixture(); Object.assign(f.candidate.approval.shared_limits[1]!, change);
      expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
    }
  });
  it("refuses dropping, changing, adding or reordering unrelated limits", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => f.candidate.approval.shared_limits.pop(),
      (f: ReturnType<typeof fixture>) => { f.candidate.approval.shared_limits[0]!.maximum = 100; },
      (f: ReturnType<typeof fixture>) => f.candidate.approval.shared_limits.push({ ...f.candidate.approval.shared_limits[0]!, id: "extra" }),
      (f: ReturnType<typeof fixture>) => f.candidate.approval.shared_limits.reverse(),
    ]) { const f = fixture(); mutate(f); expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET"); }
  });
  it("refuses an incomplete or stale prior inventory even when the candidate matches it", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { const p = f.proposals[0]!; if (p.kind === "approval_count") p.previous_limits.pop(); },
      (f: ReturnType<typeof fixture>) => { f.baseline.approval.shared_limits[0]!.maximum++; },
    ]) { const f = fixture(); mutate(f); expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET"); }
  });
  it("retains exact count meaning when requested", () => {
    const f = fixture(), p = f.proposals[0]!;
    if (p.kind !== "approval_count") throw new Error("fixture");
    p.intent = "retain"; p.value = { state: "proposed", basis: "rolling_approved_events", scope: "tenant", maximum: 3, window_seconds: 86400, selector: { kind: "all_outcomes" } };
    f.candidate.approval.shared_limits = structuredClone(f.baseline.approval.shared_limits);
    expect(() => check(f)).not.toThrow();
  });
  it("supports an exact outcome selector without flattening other limits", () => {
    const f = fixture(), p = f.proposals[0]!;
    if (p.kind !== "approval_count" || p.value.state !== "proposed") throw new Error("fixture");
    p.value.selector = { kind: "outcome", outcome: f.baseline.outcome };
    f.candidate.approval.shared_limits[1]!.capability = f.baseline.outcome;
    expect(() => check(f)).not.toThrow();
  });
  it("refuses foreign outcomes, resource or suggestion targets in this Rule consumer", () => {
    for (const target of [{ slot: "approval.shared_limits", outcome: "warehouse.other", limit_id: "joint_company" },
      { slot: "resource.policy.shared_limits", resource: "warehouse.items", limit_id: "joint_company" },
      { slot: "suggestion.approval_policy_proposal.shared_limits", outcome: "warehouse.quantity", limit_id: "joint_company" }]) {
      const f = fixture(); Object.assign(f.proposals[0]!, { target }); expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
    }
    const f = fixture(); f.proposals[1]!.target = { slot: "effect.writeback", outcome: "warehouse.other" };
    expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
  });
  it("refuses unknowns, missing kinds, extra domain kinds and altered proposal metadata", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.proposals[0]!.value = { state: "unknown", reason: "unsupported_basis" }; },
      (f: ReturnType<typeof fixture>) => { f.proposals.splice(0, 1); },
      (f: ReturnType<typeof fixture>) => { f.proposals.pop(); },
      (f: ReturnType<typeof fixture>) => { f.proposals.push({ id: "duration", kind: "trusted_scope_duration", target: { slot: "resource.policy.shared_limits", resource: "warehouse.items", limit_id: "joint_company" }, previous_limits: structuredClone(f.baseline.approval.shared_limits), value: { state: "proposed", scope: "tenant", window_seconds: 60 } }); },
      (f: ReturnType<typeof fixture>) => { f.candidate.requirement_proposals = structuredClone(f.proposals); f.candidate.requirement_proposals[0]!.id = "changed"; },
    ]) { const f = fixture(); mutate(f); expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET"); }
  });
  it("refuses execution drift and a renamed baseline", () => {
    const f = fixture(); f.candidate.effect.writeback = "supervised"; expect(() => check(f)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
    const g = fixture(); g.baseline.outcome = "warehouse.other"; expect(() => check(g)).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
  });
  it("requires explicit empty prior inventory for a new draft, never inventing no duty", () => {
    const f = fixture(), p = f.proposals[0]!; if (p.kind !== "approval_count") throw new Error("fixture");
    p.previous_limits = []; f.candidate.approval.shared_limits = [f.candidate.approval.shared_limits[1]!];
    expect(() => check({ ...f, baseline: null })).not.toThrow();
    expect(() => check({ ...f, baseline: undefined } as unknown as Parameters<typeof check>[0])).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
    const missing = structuredClone(f.baseline); Reflect.deleteProperty(missing.approval, "shared_limits");
    expect(() => check({ ...f, baseline: missing })).toThrow("ACTION_RULE_REQUIREMENTS_UNMET");
  });
  it("returns a registered terminal refusal without a model repair loop", () => {
    const f = fixture(); f.candidate.effect.writeback = "supervised";
    try { check(f); throw new Error("unexpected acceptance"); } catch (error) {
      expect(actionRuleTrustedFailure(error)).toMatchObject({ code: "ACTION_RULE_REQUIREMENTS_UNMET", presentation: "terminal" });
    }
  });
});
