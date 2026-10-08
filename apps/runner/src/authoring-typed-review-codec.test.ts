import { describe, expect, it } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { parseTypedReviewView, parseTypedFieldEvent, validateTypedFieldEvent } from "./authoring-typed-review-codec.js";
import type { TypedReviewView } from "./authoring-typed-review.js";
function view(): TypedReviewView {
  return { binding: { proposal_id: "approval-change", proposal_revision: 3, proposal_digest: digest("complete candidate"),
    applicability_digest: digest("domain"), operation_id: "current bounded operation", view_digest: digest("host full view") },
    decision_kind: "business_review", status: "unconfirmed", title: "Review business parameters", normalized_lines: ["At most USD60, otherwise2reviewers; keep private hold."],
    change_lines: ["Amount50→60"], unresolved: [], technical_lines: ["Host exact component diff"],
    fields: [{ id: "amount", target_digest: digest("money target"), dependencies_digest: digest("money dependencies"), label: "Amount", required: true,
      kind: "money", currency: "USD", scale: 2, minimum_minor: 0, maximum_minor: 100000,
      suggestion: { origin: "model_proposal", value: { kind: "money", minor_units: 6000, currency: "USD", scale: 2 } } }] };
}
function event(v = view()) { return { kind: "replace_literal", binding: v.binding, field_id: v.fields[0]!.id,
  target_digest: v.fields[0]!.target_digest, dependencies_digest: v.fields[0]!.dependencies_digest, raw: "60.01" }; }
describe("strict host view and operator event runtime codec", () => {
  it("clones a bounded exact view without minting actor or confirmation", () => {
    const v = view(), parsed = parseTypedReviewView(v); expect(parsed).toEqual(v); expect(parsed).not.toBe(v);
    expect(parsed).not.toHaveProperty("actor"); expect(parsed).not.toHaveProperty("confirmation");
  });
  it.each(["actor", "confirmed", "authority_granted", "revision", "callback", "storage_path"])("rejects extra view authority key %s", key => {
    expect(() => parseTypedReviewView({ ...view(), [key]: true })).toThrow("TYPED_REVIEW_INVALID");
  });
  it("rejects unknown status, kind, overflow, malformed digest and duplicate IDs/options", () => {
    const v = view();
    for (const binding of [{ ...v.binding, proposal_revision: Infinity }, { ...v.binding, proposal_digest: `${v.binding.proposal_digest}\n` }, { ...v.binding, operation_id: "" }])
      expect(() => parseTypedReviewView({ ...v, binding })).toThrow("INVALID");
    expect(() => parseTypedReviewView({ ...v, status: "active" })).toThrow("INVALID");
    expect(() => parseTypedReviewView({ ...v, fields: [...v.fields, ...v.fields] })).toThrow("INVALID");
    expect(() => parseTypedReviewView({ ...v, fields: [{ ...v.fields[0], maximum_minor: Number.MAX_SAFE_INTEGER + 1 }] })).toThrow("INVALID");
    expect(() => parseTypedReviewView({ ...v, fields: [{ ...v.fields[0], kind: "arbitrary_json" }] })).toThrow("INVALID");
    expect(() => parseTypedReviewView({ ...v, fields: [{ id: "choice", target_digest: digest(1), dependencies_digest: digest(2), label: "Choice", required: true, kind: "choice", options: [{ value: "x", label: "X" }, { value: "x", label: "Again" }] }] })).toThrow("INVALID");
  });
  it("strictly validates field events and reparses exact money before host application", () => {
    const e = event(); expect(parseTypedFieldEvent(e)).toEqual(e);
    expect(validateTypedFieldEvent(view(), e)).toEqual({ event: e, value: { kind: "money", currency: "USD", scale: 2, minor_units: 6001 } });
    for (const raw of ["60.001", "60 but only VIP", "", "60\n", 60])
      expect(() => validateTypedFieldEvent(view(), { ...e, raw })).toThrow("INVALID");
  });
  it("allows pending and exact keep without fabricating a raw answer", () => {
    const { raw: _raw, ...e } = event(), keep = { ...e, kind: "keep_suggestion" };
    expect(validateTypedFieldEvent(view(), keep)).toEqual({ event: keep, value: { kind: "money", minor_units: 6000, currency: "USD", scale: 2 } });
    expect(validateTypedFieldEvent(view(), { ...e, kind: "leave_pending" })).toEqual({ event: { ...e, kind: "leave_pending" } });
    expect(() => validateTypedFieldEvent({ ...view(), fields: [{ ...view().fields[0]!, suggestion: undefined }] }, keep)).toThrow("INVALID");
    expect(() => parseTypedFieldEvent({ ...keep, raw: "60" })).toThrow("INVALID");
  });
  it.each(["actor", "accepted", "value", "confirmed", "source_digest", "revision"])("rejects fabricated event key %s", key => {
    expect(() => parseTypedFieldEvent({ ...event(), [key]: true })).toThrow("INVALID");
  });
  it("refuses stale view/application/operation and foreign field dependencies", () => {
    const v = view(), e = event(v);
    for (const key of ["proposal_digest", "applicability_digest", "view_digest"] as const)
      expect(() => validateTypedFieldEvent(v, { ...e, binding: { ...e.binding, [key]: digest("foreign") } })).toThrow("STALE");
    for (const key of ["target_digest", "dependencies_digest"] as const)
      expect(() => validateTypedFieldEvent(v, { ...e, [key]: digest("foreign") })).toThrow("STALE");
    expect(() => validateTypedFieldEvent(v, { ...e, field_id: "another amount" })).toThrow("STALE");
    expect(() => validateTypedFieldEvent(v, { ...e, binding: { ...e.binding, operation_id: "fresh" } })).toThrow("STALE");
  });
  it("retains safely represented out-of-bounds suggestions as invalid display but refuses keep", () => {
    const v = view(), field = v.fields[0]!;
    const invalid = { ...v, fields: [{ ...field, suggestion: { origin: "model_proposal" as const,
      value: { kind: "money" as const, minor_units: 100001, currency: "USD", scale: 2 } } }] };
    expect(parseTypedReviewView(invalid)).toEqual(invalid);
    const { raw: _raw, ...e } = event(invalid);
    expect(() => validateTypedFieldEvent(invalid, { ...e, kind: "keep_suggestion" })).toThrow("INVALID");
  });
  it("bounds structural depth by fixed shapes and arrays/text without dropping content", () => {
    expect(() => parseTypedReviewView({ ...view(), normalized_lines: ["x".repeat(32769)] })).toThrow("INVALID");
    expect(() => parseTypedReviewView({ ...view(), change_lines: Array(513).fill("change") })).toThrow("INVALID");
    expect(() => parseTypedFieldEvent({ ...event(), raw: "x".repeat(513) })).toThrow("INVALID");
  });
});
