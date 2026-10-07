import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { InputInteraction, InputInteractionResponse } from "./authoring-input-interaction.js";
import type { VersionInteraction, VersionInteractionResponse } from "./authoring-version-interaction.js";
import type { AuthoringQuestionInteraction, AuthoringQuestionResponse } from "./authoring-question-interaction.js";
import { operatorBusinessReadback, type OperatorBusinessContext } from "./authoring-operator-presentation.js";

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
