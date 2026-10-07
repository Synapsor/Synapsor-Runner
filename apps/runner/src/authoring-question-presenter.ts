import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { InputInteraction, InputInteractionResponse } from "./authoring-input-interaction.js";
import type { VersionInteraction, VersionInteractionResponse } from "./authoring-version-interaction.js";
import type { AuthoringQuestionInteraction, AuthoringQuestionResponse } from "./authoring-question-interaction.js";
import type { ReadMeaningInteraction, ReadMeaningInteractionResponse } from "./authoring-read-meaning-interaction.js";
import type { BusinessStatementInteraction, BusinessStatementResponse } from "./authoring-business-statement-interaction.js";
import { presentOperatorClarification, operatorBusinessReadback, type OperatorBusinessContext } from "./authoring-operator-presentation.js";

type Session = Pick<BoundaryReviewInteractiveSession, "promptText" | "confirm" | "chooseOption">;
type Chat = Pick<BoundaryAuthoringChat, "readOperator" | "rememberDetails" | "runner" | "streamModel">;
type Readback<Binding> = Extract<AuthoringQuestionInteraction<Binding>, { kind: "readback" }>;
type Decision<Binding> = Extract<AuthoringQuestionResponse<Binding>, { kind: "decision" }>;

/** Render only an existing attributed business readback. This function has no
 * save, generation, consent-admission or authority port. Each host still checks
 * its own binding/currentness and records the explicit returned decision. */
async function presentReadback<Binding>(input: {
  view: Readback<Binding>; session: Pick<Session, "confirm">; businessContext?: OperatorBusinessContext;
  question: string; detailsTitle: string;
}): Promise<Decision<Binding>> {
  const accepted = await input.session.confirm(input.question, {
    context: operatorBusinessReadback([...input.view.lines], input.businessContext),
    defaultValue: false,
    exactDetails: { title: input.detailsTitle, lines: [...input.view.lines] },
  });
  return { kind: "decision", binding: input.view.binding, accepted: accepted ?? null };
}

/** Stateless Input view adapter. Its host retains all pre/post-wait checks,
 * literal raw capture, pending transitions, Source append and Resume CAS. */
export async function presentSourceInputInteraction(input: {
  view: InputInteraction; assertCurrent: () => Promise<void>; session: Session;
  chat?: Chat; businessContext?: OperatorBusinessContext;
}): Promise<InputInteractionResponse> {
  const { view, chat } = input;
  if (view.kind === "question") {
    let raw: string | null;
    if (chat?.readOperator) {
      chat.rememberDetails("INPUT QUESTION DETAILS", [...view.material]);
      chat.runner("Before you answer", operatorBusinessReadback([...view.material], input.businessContext));
      await chat.streamModel(view.text.split(/\r?\n/u));
      raw = (await chat.readOperator(undefined, input.assertCurrent,
        { recordPolicyAnswer: false, preserveWhitespace: true })) ?? null;
    } else raw = (await input.session.promptText(view.text,
      { context: [...view.material], recordPolicyAnswer: false, preserveWhitespace: true })) ?? null;
    return { kind: "answer", binding: view.binding, raw };
  }
  if (view.kind === "readback") return presentReadback({ view, session: input.session,
    businessContext: input.businessContext, question: "Save this exact attributed input-policy interpretation?",
    detailsTitle: "CURRENT INPUT INTERPRETATION" });
  if (!view.canAnswer) {
    chat?.runner("INPUT POLICY STILL PENDING", [
      "No complete interpretation or missing-business question is saved. Inspect or change the attached policy through its ordinary reviewed route.",
      "Reopening does not invent an answer or renew the authoring allowance.",
    ]);
    return { kind: "pending", binding: view.binding, choice: "keep" };
  }
  const choice = await input.session.chooseOption?.("SAVED INPUT-POLICY DECISION", [
    { value: "keep", label: "Keep this decision pending" },
    { value: "answer", label: view.sourceInterpretation ? "Review the saved interpretation again" : "Answer the saved question" },
  ], { initialValue: "keep", reviewOnly: true, displayContext: true,
    context: operatorBusinessReadback([...view.material], input.businessContext) });
  return { kind: "pending", binding: view.binding, choice: choice === "answer" ? "answer" : "keep" };
}

/** Version keeps its existing chat-only reader and explicit checks before
 * question display and readback. It does not adopt Input's terminal fallback. */
export async function presentVersionInteraction(input: {
  view: VersionInteraction; assertCurrent: () => Promise<void>; session: Session;
  chat: Chat; businessContext?: OperatorBusinessContext;
}): Promise<VersionInteractionResponse> {
  const { view, chat } = input;
  if (view.kind === "question") {
    await input.assertCurrent();
    await chat.streamModel([view.text]);
    const raw = await chat.readOperator?.(undefined, input.assertCurrent,
      { recordPolicyAnswer: false, preserveWhitespace: true });
    return { kind: "answer", binding: view.binding, raw: raw ?? null };
  }
  if (view.kind === "readback") {
    await input.assertCurrent();
    return presentReadback({ view, session: input.session, businessContext: input.businessContext,
      question: "Record this planned counter maintenance for the current setup?",
      detailsTitle: "CURRENT COUNTER STATEMENT" });
  }
  const choice = await input.session.chooseOption?.("SAVED CHANGED-RECORD QUESTION", [
    { value: "keep", label: "Keep this decision pending" },
    { value: "answer", label: view.hasRawAnswer ? "Answer again; keep the earlier answer" : "Answer the saved question" },
  ], { initialValue: "keep", reviewOnly: true,
    context: operatorBusinessReadback([...view.material], input.businessContext) });
  return { kind: "pending", binding: view.binding, choice: choice === "answer" ? "answer" : "keep" };
}

/** Native Read meaning display only; its host retains question history, Source
 * applicability, literal capture, replacement consent and accepted remapping. */
export async function presentReadMeaningInteraction(input: {
  session: Session;
  questionMaterial: string[];
  businessContext?: OperatorBusinessContext;
  view: ReadMeaningInteraction;
}): Promise<ReadMeaningInteractionResponse> {
  const { view } = input;
  if (view.kind === "question") {
    const raw = await input.session.promptText(presentOperatorClarification(view.text,
      { stage: "read", context: input.businessContext, target: view.request }), {
      preserveWhitespace: true, recordPolicyAnswer: false,
      context: input.questionMaterial,
    });
    return { kind: "answer", binding: view.binding, raw: raw ?? null };
  }
  if (view.kind === "readback") {
    const decline = view.purpose === "decline", replacement = view.purpose === "replacement";
    const accepted = await input.session.confirm(decline ? "Decline this Read question? No keeps it pending."
      : replacement ? "Use this new answer as the current interpretation?" : "Record these exact words as the meaning for this task?", {
      defaultValue: false,
      context: decline ? ["This is a local decision, not business meaning or a model request. No keeps the exact saved question available to answer on Resume."]
        : operatorBusinessReadback([...view.lines], input.businessContext),
      exactDetails: { title: decline ? "CURRENT READ QUESTION" : replacement ? "CURRENT READ MEANING REPLACEMENT" : "CURRENT READ MEANING", lines: [...view.lines] },
    });
    return { kind: "decision", binding: view.binding, accepted: accepted ?? null };
  }
  const choice = await input.session.chooseOption?.("SAVED MEANING IS STILL PENDING", [
    { value: "keep", label: "Keep this meaning pending [recommended]", detail: "The earlier response stays saved; no meaning or model request is inferred." },
    { value: "review", label: "Review the saved answer", detail: "Reopen its exact readback without asking again or adopting it automatically." },
    ...(view.canReplace ? [{ value: "replace", label: "Replace the answer", detail: "Answer this same question again; retain the earlier words and review the new response explicitly." }] : []),
  ], { initialValue: "keep", context: [...view.material] });
  return { kind: "pending", binding: view.binding, choice: choice === "review" || choice === "replace" ? choice : "keep" };
}


/** Shared Action/Read-revision statement display; the existing host owns the
 * supplied stage binding, all pre/post-wait checks and Source/Resume commits. */
export async function presentBusinessStatementInteraction(input: {
  view: BusinessStatementInteraction; stage: "read" | "action"; session: Session;
  businessContext?: OperatorBusinessContext; prompt(displayed: string): Promise<string | undefined>;
}): Promise<BusinessStatementResponse> {
  const { view } = input;
  if (view.kind === "question") {
    const displayed = presentOperatorClarification(view.text,
      { stage: input.stage, context: input.businessContext });
    return { kind: "answer", binding: view.binding, raw: await input.prompt(displayed) ?? null };
  }
  if (view.kind === "pending") {
    const choice = await input.session.chooseOption?.("SAVED BUSINESS STATEMENT", [
      { value: "keep", label: "Keep this decision pending" },
      { value: "review", label: "Review the retained answer" },
      { value: "replace", label: "Answer again; retain the earlier words" },
    ], { initialValue: "keep", reviewOnly: true,
      context: operatorBusinessReadback([...view.lines], input.businessContext) });
    return { kind: "pending", binding: view.binding,
      choice: choice === "review" || choice === "replace" ? choice : "keep" };
  }
  const yes = await input.session.confirm("Record this exact statement for the current question?", {
    defaultValue: view.defaultValue, context: operatorBusinessReadback([...view.lines], input.businessContext),
    exactDetails: { title: "EXACT BUSINESS STATEMENT", lines: [view.question, ...view.lines] },
  });
  return { kind: "decision", binding: view.binding, accepted: yes ?? null };
}

/** These details retain their existing location before opening the native host. */
export function rememberActionQuestionDetails(input: {
  phase: "draft" | "edit"; question: string; chat?: Pick<Chat, "rememberDetails">;
}): void {
  if (input.phase === "draft") input.chat?.rememberDetails("CURRENT ACTION QUESTION", [input.question,
    "This question has not changed a saved draft. The model can prepare supported metadata relationships itself; source rows are not available here."]);
  else input.chat?.rememberDetails("ACTION EDIT QUESTION DETAILS", [input.question]);
}

/** Drafting keeps its literal multiline reader and terminal fallback. Editing
 * keeps its single-element chat stream and optional reader, without an added
 * currentness callback or fallback. The surrounding host owns those checks. */
export async function promptActionBusinessQuestion(input: {
  displayed: string; session: Session;
} & ({ phase: "draft"; chat?: Chat; assertCurrent: () => Promise<void> }
  | { phase: "edit"; chat: Chat; assertCurrent?: never })): Promise<string | undefined> {
  if (input.phase === "edit") {
    await input.chat.streamModel([input.displayed]);
    return input.chat.readOperator?.(undefined, undefined, { recordPolicyAnswer: false, preserveWhitespace: true });
  }
  if (input.chat?.readOperator) {
    await input.chat.streamModel(input.displayed.split(/\r?\n/u));
    return input.chat.readOperator(undefined, input.assertCurrent, { recordPolicyAnswer: false, preserveWhitespace: true });
  }
  return input.session.promptText(input.displayed, { context: ["BUSINESS QUESTION"], recordPolicyAnswer: false, preserveWhitespace: true });
}
