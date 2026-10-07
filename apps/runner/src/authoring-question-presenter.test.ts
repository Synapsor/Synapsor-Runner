import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { assertInputInteractionResponse, type InputInteraction, type InputInteractionBinding } from "./authoring-input-interaction.js";
import { assertVersionInteractionResponse, type VersionInteraction, type VersionInteractionBinding } from "./authoring-version-interaction.js";
import { operatorBusinessReadback, type OperatorBusinessContext } from "./authoring-operator-presentation.js";
import { presentSourceInputInteraction, presentVersionInteraction } from "./authoring-question-presenter.js";

const digest = canonicalJsonDigest;
const inputBinding: InputInteractionBinding = { root_id: "declared-input-root", root_semantic_digest: digest("input root"),
  question_id: "declared-input-question", question_revision: 2, question_semantic_digest: digest("input question"),
  context_digest: digest("current Source and selected program"), scope_digest: digest("input scope") };
const versionBinding: VersionInteractionBinding = { turn_id: "declared-owning-action-turn", root_question_id: "declared-version-root",
  question_id: "declared-version-question", question_revision: 1, question_digest: digest("version question"),
  pending_version_digest: digest("actual owning marker"), context_digest: digest("current structural proof"), scope_digest: digest("version scope") };
const context: OperatorBusinessContext = { references: [{ resource: "dispatch.parcels", field: "note_text",
  label: "handover note", origin: "policy_term" }] };
const material = ["Exact target: dispatch.parcels.note_text", "Keep every unrelated requirement."];
const words = "How long may the handover note be?\r\nCount spaces as characters.";
const inputQuestion = (): InputInteraction => ({ kind: "question", binding: inputBinding, text: words,
  material, preserveWhitespace: true, recordPolicyAnswer: false });
const versionQuestion = (): VersionInteraction => ({ kind: "question", binding: versionBinding, text: words,
  material, preserveWhitespace: true, recordPolicyAnswer: false });
type Session = Pick<BoundaryReviewInteractiveSession, "promptText" | "confirm" | "chooseOption">;
type Chat = Pick<BoundaryAuthoringChat, "readOperator" | "rememberDetails" | "runner" | "streamModel">;
function ports(raw?: string) {
  const session: Session = { promptText: vi.fn(async () => raw), confirm: vi.fn(async () => false),
    chooseOption: vi.fn(async () => undefined) };
  const chat: Chat = { rememberDetails: vi.fn(), runner: vi.fn(), streamModel: vi.fn(async () => {}),
    readOperator: vi.fn(async (_default, assertCurrent) => { await assertCurrent?.(); return raw; }) };
  const assertCurrent = vi.fn(async () => {});
  return { session, chat, assertCurrent, businessContext: context };
}

describe("stateless typed Input and Version presentation", () => {
  it.each([undefined, "", " \t ", "I'm not sure", "  one through 64 — 😀\t "])(
    "Input passes exact raw words or cancellation to its unchanged host: %j", async raw => {
      const p = ports(raw), view = inputQuestion(), before = structuredClone(view);
      const response = await presentSourceInputInteraction({ ...p, view });
      expect(response).toEqual({ kind: "answer", binding: view.binding, raw: raw ?? null });
      assertInputInteractionResponse(view, response);
      expect(p.chat.rememberDetails).toHaveBeenCalledWith("INPUT QUESTION DETAILS", material);
      expect(p.chat.runner).toHaveBeenCalledWith("Before you answer", operatorBusinessReadback(material, context));
      expect(p.chat.streamModel).toHaveBeenCalledWith(words.split(/\r?\n/u));
      expect(p.chat.readOperator).toHaveBeenCalledWith(undefined, p.assertCurrent,
        { recordPolicyAnswer: false, preserveWhitespace: true });
      expect(p.assertCurrent).toHaveBeenCalledTimes(1); // Called by the actual reader contract, not an added presenter check.
      expect(p.session.promptText).not.toHaveBeenCalled(); expect(view).toEqual(before);
    });

  it.each([undefined, "", " \t ", "I'm not sure", "  Every writer — café\t "])(
    "Version preserves literal words and its own pre-wait ordering: %j", async raw => {
      const p = ports(raw), view = versionQuestion(), events: string[] = [];
      p.assertCurrent.mockImplementation(async () => { events.push("current"); });
      p.chat.streamModel = vi.fn(async () => { events.push("display"); });
      p.chat.readOperator = vi.fn(async (_default, current) => { events.push("reader"); await current?.(); return raw; });
      const response = await presentVersionInteraction({ ...p, view });
      expect(response).toEqual({ kind: "answer", binding: view.binding, raw: raw ?? null });
      assertVersionInteractionResponse(view, response);
      expect(events).toEqual(["current", "display", "reader", "current"]);
      expect(p.chat.streamModel).toHaveBeenCalledWith([words]);
      expect(p.chat.readOperator).toHaveBeenCalledWith(undefined, p.assertCurrent,
        { recordPolicyAnswer: false, preserveWhitespace: true });
      expect(p.chat.rememberDetails).not.toHaveBeenCalled(); expect(p.chat.runner).not.toHaveBeenCalled();
      expect(p.session.promptText).not.toHaveBeenCalled();
    });

  it.each(["no-chat", "no-reader"] as const)("Input alone retains the terminal fallback: %s", async mode => {
    const p = ports("  exact fallback 😀\t "), view = inputQuestion();
    if (mode === "no-reader") delete p.chat.readOperator;
    const response = await presentSourceInputInteraction({ ...p, view, chat: mode === "no-chat" ? undefined : p.chat });
    expect(response).toEqual({ kind: "answer", binding: view.binding, raw: "  exact fallback 😀\t " });
    expect(p.session.promptText).toHaveBeenCalledWith(words,
      { context: material, recordPolicyAnswer: false, preserveWhitespace: true });
    expect(p.chat.streamModel).not.toHaveBeenCalled(); expect(p.assertCurrent).not.toHaveBeenCalled();
  });

  it("a missing Version chat reader returns cancellation without inventing a terminal answer", async () => {
    const p = ports("must not be used"); delete p.chat.readOperator;
    const view = versionQuestion(), response = await presentVersionInteraction({ ...p, view });
    expect(response).toEqual({ kind: "answer", binding: view.binding, raw: null });
    expect(p.assertCurrent).toHaveBeenCalledTimes(1); expect(p.chat.streamModel).toHaveBeenCalledWith([words]);
    expect(p.session.promptText).not.toHaveBeenCalled();
  });

  it.each(["question", "readback"] as const)("Version refuses stale %s before display or consent", async kind => {
    const p = ports("unused"), error = new Error("DECLARED_STALE_CURRENT_PROOF");
    p.assertCurrent.mockRejectedValue(error);
    const view: VersionInteraction = kind === "question" ? versionQuestion()
      : { kind: "readback", binding: versionBinding, lines: material, defaultValue: false };
    await expect(presentVersionInteraction({ ...p, view })).rejects.toBe(error);
    expect(p.chat.streamModel).not.toHaveBeenCalled(); expect(p.chat.readOperator).not.toHaveBeenCalled();
    expect(p.session.confirm).not.toHaveBeenCalled();
  });

  it.each(["input", "version"] as const)("%s propagates the real reader currentness failure without returning words", async stage => {
    const p = ports("unused"), error = new Error("DECLARED_CONTEXT_CHANGED_DURING_OPERATOR_WAIT");
    let checks = 0;
    p.assertCurrent.mockImplementation(async () => { if (++checks === (stage === "input" ? 1 : 2)) throw error; });
    const result = stage === "input" ? presentSourceInputInteraction({ ...p, view: inputQuestion() })
      : presentVersionInteraction({ ...p, view: versionQuestion() });
    await expect(result).rejects.toBe(error);
    expect(p.session.confirm).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined])("readbacks return only explicit decisions and retain exact details: %j", async accepted => {
    for (const stage of ["input", "version"] as const) {
      const p = ports(); p.session.confirm = vi.fn(async (_question, options) => {
        expect(options?.defaultValue).toBe(false);
        expect(options?.context).toEqual(operatorBusinessReadback(material, context));
        expect(options?.exactDetails?.lines).toEqual(material);
        expect(options?.exactDetails?.lines).not.toBe(material);
        return accepted;
      });
      if (stage === "input") {
        const view: InputInteraction = { kind: "readback", binding: { ...inputBinding, proposal_digest: digest("exact note bounds") },
          lines: material, defaultValue: false };
        const response = await presentSourceInputInteraction({ ...p, view });
        expect(response).toEqual({ kind: "decision", binding: view.binding, accepted: accepted ?? null });
        assertInputInteractionResponse(view, response);
        expect(p.session.confirm).toHaveBeenCalledWith("Save this exact attributed input-policy interpretation?", expect.objectContaining({
          exactDetails: { title: "CURRENT INPUT INTERPRETATION", lines: material } }));
        expect(p.assertCurrent).not.toHaveBeenCalled();
      } else {
        const view: VersionInteraction = { kind: "readback", binding: { ...versionBinding, proposal_digest: digest("exact counter testimony") },
          lines: material, defaultValue: false };
        const response = await presentVersionInteraction({ ...p, view });
        expect(response).toEqual({ kind: "decision", binding: view.binding, accepted: accepted ?? null });
        assertVersionInteractionResponse(view, response);
        expect(p.session.confirm).toHaveBeenCalledWith("Record this planned counter maintenance for the current setup?", expect.objectContaining({
          exactDetails: { title: "CURRENT COUNTER STATEMENT", lines: material } }));
        expect(p.assertCurrent).toHaveBeenCalledTimes(1);
      }
      expect(p.chat.streamModel).not.toHaveBeenCalled(); expect(p.session.promptText).not.toHaveBeenCalled();
    }
  });

  it("Input without an actionable question keeps pending without a picker, question or new consent", async () => {
    const p = ports(), view: InputInteraction = { kind: "pending", binding: inputBinding,
      material, canAnswer: false, sourceInterpretation: true, defaultValue: "keep" };
    const response = await presentSourceInputInteraction({ ...p, view });
    expect(response).toEqual({ kind: "pending", binding: view.binding, choice: "keep" });
    expect(p.chat.runner).toHaveBeenCalledWith("INPUT POLICY STILL PENDING", expect.arrayContaining([
      "Reopening does not invent an answer or renew the authoring allowance."]));
    expect(p.session.chooseOption).not.toHaveBeenCalled(); expect(p.session.confirm).not.toHaveBeenCalled();
    expect(p.chat.readOperator).not.toHaveBeenCalled();
  });

  it.each(["answer", "keep", undefined, "unrecognized"])("both actionable pending views retain Keep defaults and their distinct labels: %j", async choice => {
    for (const retained of [false, true]) {
      const p = ports(); p.session.chooseOption = vi.fn(async (_title, _options, config) => {
        expect(config?.initialValue).toBe("keep"); expect(config?.reviewOnly).toBe(true);
        expect(config?.context).toEqual(operatorBusinessReadback(material, context)); return choice;
      });
      const input: InputInteraction = { kind: "pending", binding: inputBinding, material,
        canAnswer: true, sourceInterpretation: retained, defaultValue: "keep" };
      expect(await presentSourceInputInteraction({ ...p, view: input })).toEqual({ kind: "pending", binding: input.binding,
        choice: choice === "answer" ? "answer" : "keep" });
      expect(p.session.chooseOption).toHaveBeenLastCalledWith("SAVED INPUT-POLICY DECISION", [
        { value: "keep", label: "Keep this decision pending" },
        { value: "answer", label: retained ? "Review the saved interpretation again" : "Answer the saved question" },
      ], expect.objectContaining({ displayContext: true }));
      const version: VersionInteraction = { kind: "pending", binding: versionBinding, material,
        canAnswer: true, hasRawAnswer: retained, defaultValue: "keep" };
      expect(await presentVersionInteraction({ ...p, view: version })).toEqual({ kind: "pending", binding: version.binding,
        choice: choice === "answer" ? "answer" : "keep" });
      expect(p.session.chooseOption).toHaveBeenLastCalledWith("SAVED CHANGED-RECORD QUESTION", [
        { value: "keep", label: "Keep this decision pending" },
        { value: "answer", label: retained ? "Answer again; keep the earlier answer" : "Answer the saved question" },
      ], expect.not.objectContaining({ displayContext: true }));
      expect(p.session.confirm).not.toHaveBeenCalled(); expect(p.chat.readOperator).not.toHaveBeenCalled();
    }
  });
});
