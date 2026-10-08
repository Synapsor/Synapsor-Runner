import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { manualSemanticActionDraft } from "./manual-semantic-action-editor.js";
import { semanticActionBusinessReviewLines } from "./boundary-commands.js";
import { buildActionParameterReview, applyActionParameterEvent, type ActionParameterReviewInput, type ActionParameterTarget } from "./authoring-action-parameter-review.js";
import type { TypedFieldEvent } from "./authoring-typed-review.js";
import { values, catalog, boundary, readDigest } from "./test-fixtures/typed-action-parameter.js";
function fixture(domain = "warehouse") {
  // Two separately declared synthetic domains; no hidden model/oracle input.
  const adapt = <T>(value: T): T => JSON.parse(JSON.stringify(value).replaceAll("warehouse", domain));
  const builtCatalog = adapt(catalog()), readBoundary = adapt(boundary());
  const compile = (draft: ActionRuleModelDraftV1) => {
    const compiled = compileActionRuleModelDraft({ draft, builtCatalog, readBoundary, readBoundaryDigest: readDigest });
    return { draft: compiled.draft, business_lines: semanticActionBusinessReviewLines(compiled, readBoundary) };
  };
  const baseline = compile(adapt(manualSemanticActionDraft(values()))).draft;
  return { baseline, compile };
}
function input(kind: ActionParameterTarget["kind"], domain?: string): ActionParameterReviewInput {
  const f = fixture(domain), baseline = f.baseline, working = structuredClone(baseline);
  const common = { label: kind === "required_approvals" ? "Reviewers" : "Automatic approval limit", expected_baseline_approval_digest: digest(baseline.approval), expected_approval_digest: digest(working.approval) };
  const target: ActionParameterTarget = kind === "required_approvals" ? { ...common, kind }
    : { ...common, kind, input_name: "threshold", expected_expression_digest: digest(working.approval.auto_approve_when), expected_input_digest: digest(working.inputs![0]) };
  return { baseline, working, expected_baseline_digest: digest(baseline), proposal_id: "selected-parameter-review", proposal_revision: 1,
    applicability_digest: digest("current domain scope and Source"), operation_id: "exact bounded edit", origin: "model_proposal", baseline_origin: "saved_confirmed", targets: [target], compile: f.compile };
}
function event(i: ActionParameterReviewInput, amendment: { kind: "replace_literal"; raw: string } | { kind: "keep_suggestion" } | { kind: "leave_pending" } | { kind: "select_option"; value: string }): TypedFieldEvent {
  const p = buildActionParameterReview(i), f = p.view.fields[0]!;
  return { ...amendment, binding: p.view.binding, field_id: f.id, target_digest: f.target_digest, dependencies_digest: f.dependencies_digest };
}
describe("bounded Action parameter domain adapter", () => {
  it.each(["warehouse", "studio"])("changes quorum1→2 through actual compiler in %s, preserving every other duty", domain => {
    const i = input("required_approvals", domain), before = structuredClone(i.working), e = event(i, { kind: "replace_literal", raw: "2" });
    const result = applyActionParameterEvent(i, e);
    expect(result.state).toBe("unconfirmed"); expect(result.candidate.approval.required_approvals).toBe(2);
    expect({ ...result.candidate, approval: before.approval }).toEqual(before); expect(result.candidate.review).toEqual(before.review);
    expect({ ...result.candidate.approval, required_approvals: 1 }).toEqual(before.approval); expect(i.working).toEqual(before);
    expect(result.event).toEqual(e); expect(result).not.toHaveProperty("confirmation");
  });
  it("amends a supported exact integer threshold with actual compilation", () => {
    const i = input("approval_threshold"), result = applyActionParameterEvent(i, event(i, { kind: "replace_literal", raw: "60" }));
    expect(result.candidate.approval.auto_approve_when).toMatchObject({ kind: "compare", operator: "lte", right: { kind: "literal", value: 60 } });
    expect(result.candidate.require).toEqual(i.baseline.require); expect(result.candidate.approval.shared_limits).toEqual(i.baseline.approval.shared_limits);
    expect(result.candidate.review).toEqual(i.baseline.review);
  });
  it("edits an exact supported money threshold through the real compiler without float conversion", () => {
    const built = catalog(), read = boundary(), money = { kind: "money_minor" as const, currency: "USD" };
    for (const resource of [...built.catalog.resources, ...built.authoring.resources]) {
      const field = resource.fields.find(item => item.name === "reorder_threshold")!; field.type = money;
    }
    const rawDraft = manualSemanticActionDraft(values()); rawDraft.inputs![0]!.type = money;
    const approve = rawDraft.approval.auto_approve_when!;
    if (approve.kind !== "compare" || approve.right.kind !== "literal") throw new Error("declared fixture shape");
    approve.right.value_type = money;
    const compile = (draft: ActionRuleModelDraftV1) => {
      const compiled = compileActionRuleModelDraft({ draft, builtCatalog: built, readBoundary: read, readBoundaryDigest: readDigest });
      return { draft: compiled.draft, business_lines: semanticActionBusinessReviewLines(compiled, read) };
    };
    const baseline = compile(rawDraft).draft;
    const i: ActionParameterReviewInput = { ...input("approval_threshold"), baseline, working: structuredClone(baseline),
      expected_baseline_digest: digest(baseline), compile,
      targets: [{ kind: "approval_threshold", label: "Automatic amount", input_name: "threshold", money_scale: 2,
        expected_baseline_approval_digest: digest(baseline.approval), expected_approval_digest: digest(baseline.approval),
        expected_expression_digest: digest(baseline.approval.auto_approve_when), expected_input_digest: digest(baseline.inputs![0]) }] };
    const result = applyActionParameterEvent(i, event(i, { kind: "replace_literal", raw: "2.99" }));
    expect(result.candidate.approval.auto_approve_when).toMatchObject({ right: { value: 299, value_type: money } });
    expect(result.event).toMatchObject({ kind: "replace_literal", raw: "2.99" });
    expect(() => applyActionParameterEvent(i, event(i, { kind: "replace_literal", raw: "2.999" }))).toThrow("INVALID");
  });
  it("changes strict/inclusive comparator only through declared choices", () => {
    const i = input("approval_comparator"), result = applyActionParameterEvent(i, event(i, { kind: "select_option", value: "lt" }));
    expect(result.candidate.approval.auto_approve_when).toMatchObject({ operator: "lt", right: { value: 100 } });
    expect(() => applyActionParameterEvent(i, event(i, { kind: "select_option", value: "less than usually" }))).toThrow("INVALID");
  });
  it("Enter retains proposed value without fabricated raw, confirmation, or other canonical changes", () => {
    const i = input("required_approvals"), e = event(i, { kind: "keep_suggestion" }), result = applyActionParameterEvent(i, e);
    expect(result.candidate).toEqual(i.working); expect(result.event).not.toHaveProperty("raw");
    expect(() => applyActionParameterEvent(i, { ...e, raw: "1" } as TypedFieldEvent)).toThrow("INVALID");
  });
  it.each(["2.0", "", "2; remove the hold", "11"])("does not coerce operator literal %j", raw => {
    const i = input("required_approvals"); expect(() => applyActionParameterEvent(i, event(i, { kind: "replace_literal", raw }))).toThrow("INVALID");
  });
  it("binds baseline, exact field, dependencies, application context, and revision", () => {
    const i = input("required_approvals"), e = event(i, { kind: "replace_literal", raw: "2" });
    for (const changed of [{ ...e, target_digest: digest("foreign") }, { ...e, dependencies_digest: digest("late") },
      { ...e, field_id: "approval_threshold" }, { ...e, binding: { ...e.binding, proposal_revision: 2 } }]) {
      expect(() => applyActionParameterEvent(i, changed)).toThrow("STALE");
    }
    expect(() => applyActionParameterEvent({ ...i, applicability_digest: digest("new scope") }, e)).toThrow("STALE");
    expect(() => buildActionParameterReview({ ...i, expected_baseline_digest: digest("new baseline") })).toThrow("STALE");
  });
  it("exposes noneditable effect/eligibility changes and removals independently of a short form", () => {
    const i = input("required_approvals"), working = structuredClone(i.working);
    working.require = { kind: "compare", operator: "gte", left: { kind: "input", name: "threshold" }, right: { kind: "literal", value: 0, value_type: { kind: "integer" } } }; working.ttl_seconds = 120;
    const p = buildActionParameterReview({ ...i, working });
    expect(p.canonical_changes.map(change => change.component)).toEqual(expect.arrayContaining(["require", "ttl_seconds"]));
    expect(p.view.change_lines.join("\n")).toContain("Eligibility requirements and exclusions changed");
    expect(p.view.technical_lines.join("\n")).toContain('"value":0');
    expect(p.preserved_components).toContain("Allowed effects and execution");
  });
  it("refuses complex expression editing rather than rewriting booleans or counters", () => {
    const i = input("approval_threshold"), working = structuredClone(i.working);
    working.approval.auto_approve_when = { kind: "all", expressions: [working.approval.auto_approve_when!] };
    const targets = i.targets.map(t => ({ ...t, expected_approval_digest: digest(working.approval) }));
    expect(() => buildActionParameterReview({ ...i, working, targets })).toThrow("UNSUPPORTED");
  });
  it("never advances an unconfirmed candidate when compiler rejects the amendment", () => {
    const i = input("required_approvals"), e = event(i, { kind: "replace_literal", raw: "2" });
    const compile = vi.fn((draft: ActionRuleModelDraftV1) => { if (draft.approval.required_approvals === 2) throw new Error("compiler refused"); return i.compile(draft); });
    expect(() => applyActionParameterEvent({ ...i, compile }, e)).toThrow("compiler refused"); expect(i.working.approval.required_approvals).toBe(1);
  });
});

// Existing declared manual Action fixture, retained without model/oracle answers.
