import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { BoundaryReviewInteractiveSession, BoundaryPromptChoice } from "./boundary-cli-picker.js";
import { assertReadMeaningInteractionResponse, type ReadMeaningInteraction, type ReadMeaningInteractionBinding } from "./authoring-read-meaning-interaction.js";
import { assertBusinessStatementResponse, type BusinessStatementInteraction, type BusinessStatementBinding } from "./authoring-business-statement-interaction.js";
import { operatorBusinessReadback, presentOperatorClarification, type OperatorBusinessContext } from "./authoring-operator-presentation.js";
import { presentReadMeaningInteraction, presentBusinessStatementInteraction, rememberActionQuestionDetails, promptActionBusinessQuestion } from "./authoring-question-presenter.js";

const readBinding: ReadMeaningInteractionBinding = { question_id: "declared-read-question", question_revision: 2,
  question_digest: digest("question"), handoff_digest: digest("handoff"), assistance_digest: digest("assistance"),
  context_digest: digest("context"), scope_digest: digest("scope") };
const statementBinding: BusinessStatementBinding = { question_id: "declared-business-question", question_revision: 3,
  question_digest: digest("business-question"), handoff_id: "declared-handoff", handoff_digest: digest("business-handoff"),
  context_digest: digest("context"), scope_digest: digest("scope") };
const request = { resource: "dispatch.parcels", field: "units", question: "What do the parcel units mean?", reason: "Meaning is missing." };
const words = "What do the parcel units mean?\r\nKeep the existing business bound.";
const material = ["Exact target: dispatch.parcels.units", "Preserve the existing bound."];
const context: OperatorBusinessContext = { references: [{ resource: request.resource, field: request.field,
  label: "parcel units", origin: "policy_term" }] };
type Session = Pick<BoundaryReviewInteractiveSession, "promptText" | "confirm" | "chooseOption">;
type Chat = Pick<BoundaryAuthoringChat, "readOperator" | "rememberDetails" | "runner" | "streamModel">;
function ports(raw?: string) {
  const session: Session = { promptText: vi.fn(async () => raw), confirm: vi.fn(async () => false), chooseOption: vi.fn(async () => undefined) };
  const chat: Chat = { rememberDetails: vi.fn(), runner: vi.fn(), streamModel: vi.fn(async () => {}),
    readOperator: vi.fn(async (_value, current) => { await current?.(); return raw; }) };
  return { session, chat, businessContext: context, assertCurrent: vi.fn(async () => {}) };
}
const readQuestion = (): ReadMeaningInteraction => ({ kind: "question", binding: readBinding, text: words, material,
  request, preserveWhitespace: true, recordPolicyAnswer: false });
const businessQuestion = (): BusinessStatementInteraction => ({ kind: "question", binding: statementBinding,
  text: words, material, preserveWhitespace: true, recordPolicyAnswer: false });

describe("Read meaning and Action statement remain stateless stage-specific presentations", () => {
  it.each([undefined, "", " \t ", "I'm not sure", "  Each parcel — café 🧭\t "])("Read returns literal raw or cancellation: %j", async raw => {
    const p = ports(raw), view = readQuestion(), before = structuredClone(view);
    const response = await presentReadMeaningInteraction({ ...p, view, questionMaterial: material });
    expect(response).toEqual({ kind: "answer", binding: view.binding, raw: raw ?? null });
    assertReadMeaningInteractionResponse(view, response);
    expect(p.session.promptText).toHaveBeenCalledWith(presentOperatorClarification(words, { stage: "read", context, target: request }),
      { context: material, preserveWhitespace: true, recordPolicyAnswer: false });
    expect(p.assertCurrent).not.toHaveBeenCalled(); expect(p.chat.readOperator).not.toHaveBeenCalled();
    expect(p.session.confirm).not.toHaveBeenCalled(); expect(view).toEqual(before);
  });

  it.each(["meaning", "decline", "replacement"] as const)("Read %s uses exact attributed details and default-No", async purpose => {
    for (const accepted of [true, false, undefined]) {
      const p = ports(), view: ReadMeaningInteraction = { kind: "readback", binding: readBinding, purpose, lines: material, defaultValue: false };
      p.session.confirm = vi.fn(async (_caption, options) => {
        expect(options?.defaultValue).toBe(false);
        expect(options?.context).toEqual(purpose === "decline"
          ? ["This is a local decision, not business meaning or a model request. No keeps the exact saved question available to answer on Resume."]
          : operatorBusinessReadback(material, context));
        expect(options?.exactDetails).toEqual({ title: purpose === "decline" ? "CURRENT READ QUESTION"
          : purpose === "replacement" ? "CURRENT READ MEANING REPLACEMENT" : "CURRENT READ MEANING", lines: material });
        expect(options?.exactDetails?.lines).not.toBe(material); return accepted;
      });
      const response = await presentReadMeaningInteraction({ ...p, view, questionMaterial: [] });
      expect(response).toEqual({ kind: "decision", binding: view.binding, accepted: accepted ?? null });
      assertReadMeaningInteractionResponse(view, response);
      expect(p.session.confirm).toHaveBeenCalledWith(purpose === "decline" ? "Decline this Read question? No keeps it pending."
        : purpose === "replacement" ? "Use this new answer as the current interpretation?" : "Record these exact words as the meaning for this task?", expect.any(Object));
      expect(p.session.promptText).not.toHaveBeenCalled(); expect(p.assertCurrent).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("Read pending replacement availability remains %j", async canReplace => {
    for (const choice of [undefined, "keep", "review", ...(canReplace ? ["replace"] : [])]) {
      const p = ports(), view: ReadMeaningInteraction = { kind: "pending", binding: readBinding, material, canReplace, defaultValue: "keep" };
      p.session.chooseOption = vi.fn(async (_caption, choices, options) => {
        expect(choices.map((c: BoundaryPromptChoice) => c.value)).toEqual(canReplace ? ["keep", "review", "replace"] : ["keep", "review"]);
        expect(options).toEqual({ initialValue: "keep", context: material }); return choice;
      });
      const response = await presentReadMeaningInteraction({ ...p, view, questionMaterial: [] });
      expect(response).toEqual({ kind: "pending", binding: view.binding, choice: choice ?? "keep" });
      assertReadMeaningInteractionResponse(view, response);
      expect(p.session.chooseOption).toHaveBeenCalledWith("SAVED MEANING IS STILL PENDING", expect.any(Array), expect.any(Object));
      expect(p.session.confirm).not.toHaveBeenCalled(); expect(p.session.promptText).not.toHaveBeenCalled();
    }
  });

  it.each(["read", "action"] as const)("the shared statement returns exact raw with its caller's %s stage", async stage => {
    for (const raw of [undefined, "", " \t ", "I'm not sure", "  Only available parcels 🧭\t "]) {
      const p = ports(), view = businessQuestion(), before = structuredClone(view), prompt = vi.fn(async () => raw);
      const response = await presentBusinessStatementInteraction({ ...p, view, stage, prompt });
      expect(response).toEqual({ kind: "answer", binding: view.binding, raw: raw ?? null });
      assertBusinessStatementResponse(view, response);
      expect(prompt).toHaveBeenCalledWith(presentOperatorClarification(words, { stage, context }));
      expect(view).toEqual(before); expect(p.session.confirm).not.toHaveBeenCalled();
    }
  });

  it.each([true, false, undefined])("statement readback preserves exact question prefix and explicit decision: %j", async accepted => {
    const p = ports(), view: BusinessStatementInteraction = { kind: "readback", binding: statementBinding, question: words, lines: material, defaultValue: false };
    p.session.confirm = vi.fn(async (_caption, options) => {
      expect(options?.defaultValue).toBe(view.defaultValue); expect(options?.context).toEqual(operatorBusinessReadback(material, context));
      expect(options?.exactDetails).toEqual({ title: "EXACT BUSINESS STATEMENT", lines: [words, ...material] }); return accepted;
    });
    const prompt = vi.fn(async () => "unused"), response = await presentBusinessStatementInteraction({ ...p, view, stage: "action", prompt });
    expect(response).toEqual({ kind: "decision", binding: view.binding, accepted: accepted ?? null });
    assertBusinessStatementResponse(view, response); expect(prompt).not.toHaveBeenCalled();
    expect(p.session.confirm).toHaveBeenCalledWith("Record this exact statement for the current question?", expect.any(Object));
  });

  it.each([undefined, "keep", "review", "replace", "unknown-choice"])("statement pending retains existing three choices and Keep fallback: %j", async choice => {
    const p = ports(), view: BusinessStatementInteraction = { kind: "pending", binding: statementBinding, lines: material, defaultValue: "keep", canReplace: false };
    p.session.chooseOption = vi.fn(async (_caption, choices, options) => {
      expect(choices.map((c: BoundaryPromptChoice) => c.value)).toEqual(["keep", "review", "replace"]); // Existing statement contract, unlike initial Read's canReplace display.
      expect(options).toEqual({ initialValue: "keep", reviewOnly: true, context: operatorBusinessReadback(material, context) }); return choice;
    });
    const response = await presentBusinessStatementInteraction({ ...p, view, stage: "read", prompt: vi.fn(async () => "unused") });
    expect(response).toEqual({ kind: "pending", binding: view.binding, choice: choice === "review" || choice === "replace" ? choice : "keep" });
    assertBusinessStatementResponse(view, response); expect(p.session.confirm).not.toHaveBeenCalled();
  });

  it("absent pickers preserve each stage's Keep response without asking or inferring", async () => {
    const p = ports(); delete p.session.chooseOption;
    expect(await presentReadMeaningInteraction({ ...p, view: { kind: "pending", binding: readBinding, material, canReplace: true, defaultValue: "keep" }, questionMaterial: [] }))
      .toEqual({ kind: "pending", binding: readBinding, choice: "keep" });
    expect(await presentBusinessStatementInteraction({ ...p, view: { kind: "pending", binding: statementBinding, lines: material, canReplace: true, defaultValue: "keep" }, stage: "action", prompt: vi.fn(async () => "unused") }))
      .toEqual({ kind: "pending", binding: statementBinding, choice: "keep" });
    expect(p.session.confirm).not.toHaveBeenCalled();
  });

  it.each(["draft", "edit"] as const)("Action %s details remain separate and exact", phase => {
    const p = ports(); rememberActionQuestionDetails({ phase, question: words, chat: p.chat });
    expect(p.chat.rememberDetails).toHaveBeenCalledWith(phase === "draft" ? "CURRENT ACTION QUESTION" : "ACTION EDIT QUESTION DETAILS",
      phase === "draft" ? [words, "This question has not changed a saved draft. The model can prepare supported metadata relationships itself; source rows are not available here."] : [words]);
    expect(p.chat.streamModel).not.toHaveBeenCalled(); expect(p.chat.readOperator).not.toHaveBeenCalled();
  });

  it("Action drafting keeps multiline display and only its genuine reader performs currentness", async () => {
    const p = ports("  Only available parcels. 🧭\t ");
    expect(await promptActionBusinessQuestion({ ...p, phase: "draft", displayed: words })).toBe("  Only available parcels. 🧭\t ");
    expect(p.chat.streamModel).toHaveBeenCalledWith(words.split(/\r?\n/u)); expect(p.chat.readOperator).toHaveBeenCalledWith(undefined, p.assertCurrent,
      { recordPolicyAnswer: false, preserveWhitespace: true });
    expect(p.assertCurrent).toHaveBeenCalledTimes(1); expect(p.session.promptText).not.toHaveBeenCalled();
  });

  it.each(["absent-chat", "absent-reader"] as const)("Action drafting retains literal terminal fallback: %s", async mode => {
    const p = ports(" \t I'm not sure 🧭 "); if (mode === "absent-reader") delete p.chat.readOperator;
    expect(await promptActionBusinessQuestion({ ...p, phase: "draft", displayed: words, chat: mode === "absent-chat" ? undefined : p.chat })).toBe(" \t I'm not sure 🧭 ");
    expect(p.session.promptText).toHaveBeenCalledWith(words, { context: ["BUSINESS QUESTION"], recordPolicyAnswer: false, preserveWhitespace: true });
    expect(p.chat.streamModel).not.toHaveBeenCalled(); expect(p.assertCurrent).not.toHaveBeenCalled();
  });

  it("Action editing preserves single-element display and optional reader without terminal fallback or an added check", async () => {
    const p = ports("  edited words 🧭\t ");
    expect(await promptActionBusinessQuestion({ session: p.session, chat: p.chat, phase: "edit", displayed: words })).toBe("  edited words 🧭\t ");
    expect(p.chat.streamModel).toHaveBeenCalledWith([words]); expect(p.chat.readOperator).toHaveBeenCalledWith(undefined, undefined,
      { recordPolicyAnswer: false, preserveWhitespace: true });
    expect(p.assertCurrent).not.toHaveBeenCalled(); delete p.chat.readOperator;
    expect(await promptActionBusinessQuestion({ session: p.session, chat: p.chat, phase: "edit", displayed: words })).toBeUndefined();
    expect(p.session.promptText).not.toHaveBeenCalled();
  });

  it("real reader currentness failure propagates without returning a stale answer", async () => {
    const p = ports("stale answer"), error = new Error("DECLARED_SOURCE_CHANGED_DURING_WAIT"); p.assertCurrent.mockRejectedValue(error);
    await expect(promptActionBusinessQuestion({ ...p, phase: "draft", displayed: words })).rejects.toBe(error);
    expect(p.session.confirm).not.toHaveBeenCalled();
  });
});
