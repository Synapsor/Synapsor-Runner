import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import type { TypedReviewView } from "./authoring-typed-review.js";
import { presentTypedAuthoringReview, confirmTypedAuthoringReview, typedReviewCardLines } from "./authoring-question-presenter.js";
const view = (): TypedReviewView => ({ binding: { proposal_id: "dock-quorum", proposal_revision: 2, proposal_digest: digest("canonical proposal"), applicability_digest: digest("current scope"), operation_id: "bounded edit", view_digest: digest("entire card") }, decision_kind: "business_review", status: "unconfirmed", title: "Review dispatch rules", normalized_lines: ["At least two reviewers approve dispatch; retain current eligibility."], change_lines: ["Reviewer quorum: 1 → 2", "Preserve the private hold restriction."], unresolved: [], fields: [{ id: "quorum", target_digest: digest("exact quorum"), dependencies_digest: digest("rule dependencies"), label: "Reviewers", required: true, kind: "integer", minimum: 1, maximum: 5, current: { origin: "saved_confirmed", value: { kind: "integer", value: 1 } }, suggestion: { origin: "model_proposal", value: { kind: "integer", value: 2 } } }] });
function ports(choices: (string | undefined)[], raws: (string | undefined)[] = []) {
  return { session: { chooseOption: vi.fn(async () => choices.shift()), promptText: vi.fn(async (_prompt: string, _options?: unknown) => raws.shift()), confirm: vi.fn(async (_prompt: string, _options?: unknown) => false as boolean | undefined), rememberDetails: vi.fn(), present: vi.fn(), showReviewDetails: vi.fn(async () => {}) }, assertCurrent: vi.fn(async () => {}) };
}
describe("shared typed business presenter", () => {
  it("Enter keeps exact suggestion with no raw answer or confirmation", async () => {
    const p = ports(["edit", "field:0"], [""]); const v = view();
    const result = await presentTypedAuthoringReview({ view: v, ...p });
    expect(result).toEqual({ kind: "field_event", event: { kind: "keep_suggestion", binding: v.binding, field_id: "quorum", target_digest: v.fields[0]!.target_digest, dependencies_digest: v.fields[0]!.dependencies_digest } });
    expect(p.session.confirm).not.toHaveBeenCalled(); expect(p.session.promptText.mock.calls[0]?.[1]).not.toHaveProperty("defaultValue");
  });
  it("literal replacement returns exact raw not client-decoded authority", async () => {
    const p = ports(["edit", "field:0"], ["3"]);
    expect(await presentTypedAuthoringReview({ view: view(), ...p })).toMatchObject({ kind: "field_event", event: { kind: "replace_literal", raw: "3" } });
    expect(p.session.confirm).not.toHaveBeenCalled();
  });
  it("missing or invalid suggestion cannot be kept with Enter", async () => {
    for (const suggestion of [undefined, { origin: "model_proposal" as const, value: { kind: "integer" as const, value: 99 } }]) {
      const v = view(); const field = { ...v.fields[0]!, suggestion }; const p = ports(["edit", "field:0"], [""]);
      expect(await presentTypedAuthoringReview({ view: { ...v, fields: [field] }, ...p })).toMatchObject({ kind: "field_event", event: { kind: "leave_pending" } });
    }
  });
  it("preserves a mixed literal for an explicit correction route without guessing", async () => {
    const raw = "3, but only for urgent shipments"; const p = ports(["edit", "field:0", "describe"], [raw]);
    expect(await presentTypedAuthoringReview({ view: view(), ...p })).toMatchObject({ kind: "describe_correction", raw });
    expect(p.session.confirm).not.toHaveBeenCalled();
  });
  it("renders every normalized/diff/unresolved item, with escaped untrusted control text", () => {
    const v = view(); const lines = typedReviewCardLines({ ...v, unresolved: ["Missing count scope"], normalized_lines: [...v.normalized_lines, "\u001b[31mUntrusted"] });
    expect(lines.join("\n")).toContain("Preserve the private hold restriction."); expect(lines.join("\n")).toContain("Missing count scope"); expect(lines.join("\n")).not.toContain("\u001b");
  });
  it("details and grouped review remain local and confirmation separate/default-No", async () => {
    const v = view(), p = ports(["details", "review"]);
    expect(await presentTypedAuthoringReview({ view: v, ...p })).toEqual({ kind: "review", binding: v.binding });
    expect(p.session.showReviewDetails).toHaveBeenCalledOnce(); expect(p.session.confirm).not.toHaveBeenCalled();
    expect(await confirmTypedAuthoringReview({ view: v, ...p })).toEqual({ kind: "decision", binding: v.binding, accepted: false });
    expect(p.session.confirm.mock.calls[0]?.[1]).toMatchObject({ defaultValue: false, decisionKind: "business_review", localOnly: true });
  });
  it("checks currentness after a field wait and never returns stale events", async () => {
    const p = ports(["edit", "field:0"], ["2"]); p.session.promptText.mockImplementation(async () => { p.assertCurrent.mockRejectedValue(new Error("stale")); return "2"; });
    await expect(presentTypedAuthoringReview({ view: view(), ...p })).rejects.toThrow("stale"); expect(p.session.confirm).not.toHaveBeenCalled();
  });
  it("pause/EOF never confirms; unresolved cannot invoke final confirmation", async () => {
    const p = ports([undefined]); expect(await presentTypedAuthoringReview({ view: view(), ...p })).toMatchObject({ kind: "pause" });
    await expect(confirmTypedAuthoringReview({ view: { ...view(), unresolved: ["Counter meaning"] }, ...p })).rejects.toThrow("TYPED_REVIEW_UNRESOLVED"); expect(p.session.confirm).not.toHaveBeenCalled();
  });
  it("sequential navigation uses the same fields and preserves provenance", async () => {
    const v = view(), second = { ...v.fields[0]!, id: "other", label: "Other quorum", target_digest: digest("other") };
    const p = ports(["sequential", "next", "open"], [""]);
    expect(await presentTypedAuthoringReview({ view: { ...v, fields: [...v.fields, second] }, ...p })).toMatchObject({ kind: "field_event", event: { field_id: "other", target_digest: second.target_digest, kind: "keep_suggestion" } });
  });
});

import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { AnalyticsShellIo } from "./analytics-shell.js";
it("actual conversation adapter keeps typed details/literal editing and confirmation off the model route", async () => {
  const writes: string[] = [], choices = ["edit", "field:0", "no"], reads = ["/details", "/attach unexpected.txt", "2"];
  const chosen: { title: string; initialValue?: string }[] = [];
  const io: AnalyticsShellIo = { read: async () => reads.shift(), readWithEscape: async () => reads.shift(),
    readConversation: async () => reads.shift(), choose: async choice => { chosen.push(choice); return choices.shift(); },
    write: text => { writes.push(text); }, writeChunk: text => { writes.push(text); }, setStatus: () => {}, clearStatus: () => {},
    isTerminal: () => true, columns: () => 100, onInterrupt: () => () => {}, close: () => {} };
  const chat = createBoundaryAuthoringChat({ io, color: false }); const guide = vi.fn(async () => "must not be called"); chat.setPermissionGuide!(guide); const sourceCommand = vi.fn(async () => true); chat.setSourceCommandHandler!(sourceCommand);
  const v = { ...view(), title: "APPROVE proposed quorum (business review only)" };
  const assertCurrent = vi.fn(async () => {});
  expect(await presentTypedAuthoringReview({ view: v, session: chat.session, assertCurrent })).toMatchObject({ kind: "field_event", event: { kind: "replace_literal", raw: "2" } });
  expect(await confirmTypedAuthoringReview({ view: v, session: chat.session, assertCurrent })).toMatchObject({ accepted: false });
  expect(guide).not.toHaveBeenCalled(); expect(sourceCommand).not.toHaveBeenCalled(); expect(chosen.at(-1)).toMatchObject({ title: "CONFIRM REVIEWED DECISION", initialValue: "no" });
  expect(writes.join("\n")).toContain("Preserve the private hold restriction."); chat.close();
});
