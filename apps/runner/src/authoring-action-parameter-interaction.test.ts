import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { manualSemanticActionDraft } from "./manual-semantic-action-editor.js";
import { compileActionRuleModelDraft, type ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { semanticActionBusinessReviewLines } from "./boundary-commands.js";
import { createBoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { AnalyticsShellIo } from "./analytics-shell.js";
import { buildActionParameterReview, applyActionParameterEvent, type ActionParameterReviewInput, type ActionParameterTarget } from "./authoring-action-parameter-review.js";
import { runActionParameterInteraction, type ActionParameterCurrent, type ActionParameterInteractionPorts, type ActionParameterAcknowledgement } from "./authoring-action-parameter-interaction.js";
import { values, catalog, boundary, readDigest } from "./test-fixtures/typed-action-parameter.js";
function fixture(kind: ActionParameterTarget["kind"] = "required_approvals") {
  const builtCatalog = catalog(), readBoundary = boundary();
  const compile = (draft: ActionRuleModelDraftV1) => {
    const compiled = compileActionRuleModelDraft({ draft, builtCatalog, readBoundary, readBoundaryDigest: readDigest });
    return { draft: compiled.draft, business_lines: semanticActionBusinessReviewLines(compiled, readBoundary) };
  };
  const baseline = compile(manualSemanticActionDraft(values())).draft;
  function domain(working = baseline, revision = 1): ActionParameterReviewInput {
    const common = { label: kind === "required_approvals" ? "Required reviewers" : "Automatic unit threshold", expected_baseline_approval_digest: digest(baseline.approval), expected_approval_digest: digest(working.approval) };
    const target: ActionParameterTarget = kind === "required_approvals" ? { ...common, kind } : { ...common, kind, input_name: "threshold", expected_expression_digest: digest(working.approval.auto_approve_when), expected_input_digest: digest(working.inputs![0]) };
    return { baseline, working, compile, expected_baseline_digest: digest(baseline), proposal_id: "declared current proposal", proposal_revision: revision,
      applicability_digest: digest("host current scope"), operation_id: "same current operation", origin: revision > 1 ? "operator_edit" : "model_proposal", baseline_origin: "saved_confirmed", targets: [target] };
  }
  let current: ActionParameterCurrent = { domain: domain(), view: buildActionParameterReview(domain()).view,
    native: { question_id: "declared-test-question", question_revision: 1, question_digest: digest("initial question") } };
  const calls: string[] = [], submitted: unknown[] = [];
  const ack = (): ActionParameterAcknowledgement => structuredClone({ native: current.native, binding: current.view.binding });
  // Explicit test owner ports; real protected file/CAS integration belongs to
  // Main. Compile and presentation paths here are actual production functions.
  const ports: ActionParameterInteractionPorts = {
    loadCurrent: async () => { calls.push("load"); return current; },
    assertCurrent: async expected => { if (digest(expected) !== digest(ack())) throw new Error("native currentness refused"); },
    submitField: async ({ expected, event }) => {
      calls.push("submit"); await ports.assertCurrent(expected); submitted.push(event);
      const applied = applyActionParameterEvent(current.domain, event);
      const next = domain(applied.candidate, current.domain.proposal_revision + 1);
      current = { domain: next, view: buildActionParameterReview(next).view, native: { question_id: current.native.question_id,
        question_revision: current.native.question_revision + 1, question_digest: digest({ previous: current.native, event }) } };
      calls.push("field-ack"); return ack();
    },
    recordDecision: async ({ expected, accepted }) => {
      await ports.assertCurrent(expected); calls.push(`decision:${accepted}`);
      current = { ...current, native: { ...current.native, question_digest: digest({ prior: current.native, accepted }) } };
      return ack();
    },
  };
  return { ports, calls, submitted, current: () => current, change: (value: ActionParameterCurrent) => { current = value; } };
}
function session(choices: string[], raw: string[] = [], accepted?: boolean) {
  return { chooseOption: vi.fn(async () => choices.shift()), promptText: vi.fn(async () => raw.shift()), confirm: vi.fn(async () => accepted),
    present: vi.fn(), rememberDetails: vi.fn() };
}
describe("bounded direct Action parameter interaction", () => {
  it.each(["required_approvals", "approval_threshold"] as const)("saves exact %s edit before reread/display and explicit grouped confirmation", async kind => {
    const f = fixture(kind), ui = session(["edit", "field:0", "review"], [kind === "required_approvals" ? "2" : "60"], true);
    const out = await runActionParameterInteraction({ ports: f.ports, session: ui });
    expect(out.kind).toBe("confirmed"); expect(f.calls).toEqual(["load", "submit", "field-ack", "load", "load", "decision:true"]);
    if (kind === "required_approvals") expect(f.current().domain.working.approval.required_approvals).toBe(2);
    else expect(f.current().domain.working.approval.auto_approve_when).toMatchObject({ right: { value: 60 } });
    expect(f.submitted).toHaveLength(1); expect(f.submitted[0]).not.toHaveProperty("candidate"); expect(ui.confirm).toHaveBeenCalledOnce();
  });
  it("Enter records keep but never confirms; pause preserves the owner's unconfirmed record", async () => {
    const f = fixture(), before = digest(f.current().domain.working);
    const out = await runActionParameterInteraction({ ports: f.ports, session: session(["edit", "field:0", "pause"], [""]) });
    expect(out.kind).toBe("paused"); expect(f.calls).not.toContain("decision:true");
    expect(f.submitted[0]).toMatchObject({ kind: "keep_suggestion" }); expect(f.submitted[0]).not.toHaveProperty("raw");
    expect(digest(f.current().domain.working)).toBe(before);
  });
  it("returns actual unsupported text to the ordinary correction route without model or save", async () => {
    const f = fixture(), raw = "2 but only after supervisor review";
    const out = await runActionParameterInteraction({ ports: f.ports, session: session(["edit", "field:0", "describe"], [raw]) });
    expect(out).toMatchObject({ kind: "correction", raw }); expect(f.calls).toEqual(["load"]); expect(f.submitted).toHaveLength(0);
  });
  it.each([false, undefined])("default-No/cancel remains pending after separate recorded decision (%j)", async accepted => {
    const f = fixture(), out = await runActionParameterInteraction({ ports: f.ports, session: session(["review"], [], accepted) });
    expect(out.kind).toBe("pending"); expect(f.calls).toContain(`decision:${accepted ?? null}`); expect(f.calls.some(call => call === "decision:true")).toBe(false);
  });
  it("failed protected field save never reloads, displays a later state or confirms", async () => {
    const f = fixture(), ui = session(["edit", "field:0", "review"], ["2"], true);
    const ports = { ...f.ports, submitField: async () => { f.calls.push("failed-save"); throw new Error("protected CAS failed"); } };
    await expect(runActionParameterInteraction({ ports, session: ui })).rejects.toThrow("protected CAS failed");
    expect(f.calls).toEqual(["load", "failed-save"]); expect(ui.chooseOption).toHaveBeenCalledTimes(2); expect(ui.confirm).not.toHaveBeenCalled();
  });
  it("rejects a later competing revision after ACK rather than adopting latest", async () => {
    const f = fixture(), ui = session(["edit", "field:0", "review"], ["2"], true);
    const ports = { ...f.ports, submitField: async (input: Parameters<ActionParameterInteractionPorts["submitField"]>[0]) => {
      const acknowledged = await f.ports.submitField(input), current = f.current();
      f.change({ ...current, native: { ...current.native, question_revision: current.native.question_revision + 1, question_digest: digest("competitor") } });
      return acknowledged;
    } };
    await expect(runActionParameterInteraction({ ports, session: ui })).rejects.toThrow("INTERACTION_STALE"); expect(ui.confirm).not.toHaveBeenCalled();
  });
  it("rejects incomplete or foreign host view before first display", async () => {
    const f = fixture(), ui = session(["pause"]), current = f.current();
    f.change({ ...current, view: { ...current.view, normalized_lines: ["short false claim"] } });
    await expect(runActionParameterInteraction({ ports: f.ports, session: ui })).rejects.toThrow("INTERACTION_STALE"); expect(ui.chooseOption).not.toHaveBeenCalled();
  });
  it.each(["proposal", "question"] as const)("refuses a final decision ACK advancing the displayed %s revision", async changed => {
    const f = fixture(), ui = session(["review"], [], true);
    const ports = { ...f.ports, recordDecision: async (input: Parameters<ActionParameterInteractionPorts["recordDecision"]>[0]) => {
      const acknowledged = await f.ports.recordDecision(input);
      return changed === "proposal"
        ? { ...acknowledged, binding: { ...acknowledged.binding, proposal_revision: acknowledged.binding.proposal_revision + 1 } }
        : { ...acknowledged, native: { ...acknowledged.native, question_revision: acknowledged.native.question_revision + 1 } };
    } };
    await expect(runActionParameterInteraction({ ports, session: ui })).rejects.toThrow("INTERACTION_STALE");
    expect(f.calls).toEqual(["load", "load", "decision:true"]);
  });
  it("actual B48 conversation session uses the same production interaction without a provider", async () => {
    const f = fixture(), choices = ["edit", "field:0", "review", "yes"], words = ["2"], writes: string[] = [];
    const io: AnalyticsShellIo = { read: async () => words.shift(), readWithEscape: async () => words.shift(), readConversation: async () => words.shift(),
      choose: async () => choices.shift(), write: text => { writes.push(text); }, writeChunk: text => { writes.push(text); },
      setStatus: () => {}, clearStatus: () => {}, isTerminal: () => true, columns: () => 100, onInterrupt: () => () => {}, close: () => {} };
    const chat = createBoundaryAuthoringChat({ io, color: false }), guide = vi.fn(async () => "not permitted"); chat.setPermissionGuide!(guide);
    expect((await runActionParameterInteraction({ ports: f.ports, session: chat.session })).kind).toBe("confirmed");
    expect(f.current().domain.working.approval.required_approvals).toBe(2); expect(guide).not.toHaveBeenCalled();
    expect(writes.join("\n")).toContain("2 distinct warehouse reviewer approvals"); chat.close();
  });
});
