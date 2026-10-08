import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { InputInteraction, InputInteractionResponse } from "./authoring-input-interaction.js";
import type { VersionInteraction, VersionInteractionResponse } from "./authoring-version-interaction.js";
import type { AuthoringQuestionInteraction, AuthoringQuestionResponse } from "./authoring-question-interaction.js";
import type { ReadMeaningInteraction, ReadMeaningInteractionResponse } from "./authoring-read-meaning-interaction.js";
import type { ReadScopeInteraction, ReadScopeInteractionResponse } from "./authoring-read-scope-host.js";
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
  localOnly?: true;
}): Promise<Decision<Binding>> {
  const accepted = await input.session.confirm(input.question, {
    ...(input.localOnly ? localTypedOptions : {}),
    context: operatorBusinessReadback([...input.view.lines], input.businessContext),
    defaultValue: false,
    exactDetails: { title: input.detailsTitle, lines: [...input.view.lines] },
  });
  return { kind: "decision", binding: input.view.binding, accepted: accepted ?? null };
}

/** Render the existing grouped native scope question; all lineage, currentness
 * and persistence remain in its protected host. */
export async function presentReadScopeInteraction(input: { view: ReadScopeInteraction; session: Session;
  businessContext?: OperatorBusinessContext }): Promise<ReadScopeInteractionResponse> {
  const { view } = input;
  if (view.kind === "readback") return presentReadback({ view, session: input.session,
    localOnly: true,
    businessContext: input.businessContext, question: "Confirm this complete Read scope and analyzed plan?",
    detailsTitle: "EXACT CURRENT READ SCOPE" });
  const choice = await input.session.chooseOption?.("READ SCOPE IS STILL PENDING", [
    { value: "keep", label: "Keep this scope pending" },
    ...(view.canReview ? [{ value: "review", label: "Review the same complete proposal" }] : []),
    ...(view.canReplace ? [{ value: "replace", label: "Use the ordinary scope replacement route" }] : []),
  ], { ...localTypedOptions, initialValue: "keep", reviewOnly: true, context: operatorBusinessReadback([...view.material], input.businessContext) });
  return { kind: "pending", binding: view.binding,
    choice: choice === "review" && view.canReview ? "review" : choice === "replace" && view.canReplace ? "replace" : "keep" };
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
      ...(view.canReview === false ? [] : [{ value: "review", label: "Review the retained answer" }]),
      ...(view.canReview === undefined || view.canReplace ? [{ value: "replace", label: "Answer again; retain the earlier words" }] : []),
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


/** Egress views contain only material already selected by their host. Rendering
 * has no Source, provider, permission-cache or persistence capability. */
export interface MetadataEgressView {
  readonly providerLabel: string;
  readonly destination?: string;
  readonly privateRead?: { readonly mappingLines: readonly string[]; readonly fingerprint: string };
}

export async function presentMetadataEgress(input: {
  view: MetadataEgressView; session: Pick<Session, "confirm">; chat?: Pick<Chat, "rememberDetails">;
}): Promise<boolean | undefined> {
  const { view } = input;
  const destination = view.destination === undefined ? [] : [`Destination: ${view.destination}`];
  const exactDetails = { title: "MODEL METADATA EGRESS", lines: [
    `Provider: ${view.providerLabel}`,
    ...destination,
    "Sends: the job you type, its read and proposal intents, and reviewed structural metadata.",
    "For verified Actions, structural metadata may include Runner-only field names, types, relationships, roles, and schema-declared ENUM/CHECK allowlists needed to draft private verification rules.",
    ...(view.privateRead ? ["Existing private Read evidence is also included for policy review. Exact mapping (metadata and reviewed meaning only):",
      ...view.privateRead.mappingLines, `Private Read metadata fingerprint: ${view.privateRead.fingerprint}`] : []),
    "Later in this same job, business-policy answers and reviewed-name clarifications you type may be sent for translation into an exact draft.",
    "Never sent automatically: rows, observed values, credentials, endpoint URLs, SQL, or trusted tenant/principal values.",
    "Runner-only field metadata is not added to model-facing Read authority and its row values remain private.",
    "Observed values require their own exact preview and permission. Model output remains untrusted and cannot activate, approve, apply, or write.",
    "Bounded requests: one short welcome, job planning, Read mapping, Action mapping, concise validated chat replies, and one correction only after a refusal.",
  ] };
  input.chat?.rememberDetails(exactDetails.title, [...exactDetails.lines]);
  return input.session.confirm(
    `Send this Boundary-authoring conversation and reviewed structural context to ${view.providerLabel}?`, {
      defaultValue: false,
      decisionKind: "disclosure",
      exactDetails,
      context: [
        `Provider: ${view.providerLabel}`,
        ...destination,
        "Sends: your job and business answers + reviewed structural metadata.",
        "Verified Actions may include private verification field names/types, but never their row values.",
        ...(view.privateRead ? ["Includes the saved private access-check mapping. View exact Runner details to inspect its source, fields and reviewed meaning before allowing this model transfer."] : []),
        "Does not send: rows, observed values, SQL, credentials, or trusted identity values.",
        "Model suggestions remain untrusted. Choose View exact Runner details now for the complete egress record; later /details shows the latest validation.",
      ],
    });
}

export function rememberSavedMetadataEgress(input: {
  providerLabel: string; chat: Pick<Chat, "rememberDetails">;
}): void {
  input.chat.rememberDetails("MODEL METADATA EGRESS", [
    `Provider: ${input.providerLabel}`,
    "Reusing the explicit metadata permission saved with this interrupted job.",
    "The permission is bound to this provider/model and the unchanged Boundary generation, schema, and database-role posture.",
    "Starting a new job, changing the model, or changing reviewed database authority requires a new permission.",
    "Never sent automatically: rows, observed values, credentials, endpoint URLs, SQL, or trusted tenant/principal values.",
    "Model output remains untrusted and cannot activate, approve, apply, or write.",
  ]);
}

export interface PolicyAttachmentView {
  readonly name: string;
  readonly version: number;
  readonly bytes: number;
  readonly lines: number;
  readonly digest: string;
  readonly textLines: readonly string[];
}

export async function showPolicyAttachmentPreview(input: {
  view: PolicyAttachmentView; session: Pick<BoundaryReviewInteractiveSession, "showReviewDetails">;
}): Promise<void> {
  const { view } = input;
  await input.session.showReviewDetails?.(`${view.name} v${view.version}`, [
    `${view.bytes} bytes | ${view.lines} lines | ${view.digest}`,
    ...view.textLines.map((line, index) => `${index + 1} | ${line}`),
    "Untrusted business context. This text grants no authority and is never evaluated by the runtime.",
  ]);
}

export function showPolicyAttachmentTransfer(input: {
  view: PolicyAttachmentView; destination: string; chat: Pick<BoundaryAuthoringChat, "checkpoint">;
}): void {
  const { view } = input;
  input.chat.checkpoint("Review attached rules", [
    `${view.name} v${view.version} | ${view.bytes} bytes | ${view.lines} lines (complete)`,
    `Destination: ${input.destination}`,
    "Sends this text with the reviewed schema, existing draft and business conversation. Prior metadata permission does not cover this new source.",
    "Snapshot retained locally in .synapsor/boundary-authoring/policy-sources (owner-only). /rules can view or permanently remove it; runtime requests never include this source.",
  ]);
}

/** Deliberately direct local session ports: unapproved text must never enter a
 * model permission narration just because the operator inspects a consent. */
export async function choosePolicyAttachmentTransfer(session: Pick<Session, "chooseOption">): Promise<string | undefined> {
  return session.chooseOption?.("SEND ATTACHED RULES", [
    { value: "send", label: "Use this complete text with the named model" },
    { value: "view", label: "Preview every line locally" },
    { value: "cancel", label: "Cancel; keep current rules and draft" },
  ], { initialValue: "cancel" });
}

export function showPolicyAttachmentReady(input: {
  view: PolicyAttachmentView; chat: Pick<BoundaryAuthoringChat, "checkpoint">;
}): void {
  input.chat.checkpoint("Rules ready for this conversation", [
    `${input.view.name} v${input.view.version}; previous source versions are retained locally until removed.`,
    "No draft or authority has changed yet. The model must translate and Runner must validate any revision; unsupported rules remain review concerns.",
  ]);
}

export async function choosePolicyAttachmentReview(session: Pick<Session, "chooseOption">): Promise<string | undefined> {
  return session.chooseOption?.("USE THE SAVED ATTACHMENT", [
    { value: "review", label: "Review this saved job against the attached rules" },
    { value: "continue", label: "Return to the conversation; keep the current draft" },
  ], { initialValue: "continue", reviewOnly: true });
}

/** Exact disabled-edit presentation. The caller supplies differences from its
 * current native baseline and owns validation, currentness, Save and ACK. */
export async function presentActionEditSave(input: {
  session: Pick<Session, "confirm">;
  chat?: Pick<Chat, "rememberDetails">;
  instruction: string;
  exactChanges: string[];
}): Promise<boolean | undefined> {
  const { session, chat, instruction, exactChanges } = input;
  chat?.rememberDetails("EXACT DISABLED ACTION EDIT", exactChanges);
  return session.confirm("Save this exact disabled Action edit?", { defaultValue: false, context: [
    `Requested edit: ${instruction}`, ...exactChanges,
    "Confirm only the requested changes. A model's changed-fields list does not authorize additional privacy, effect, approval or time-limit changes.",
    "Decline to keep the request pending and preserve the saved rules. Read, Action and execution activation remain separate."],
    exactDetails: { title: "EXACT DISABLED ACTION EDIT", lines: exactChanges } });
}

/** The operator already requested this disabled Source reconciliation. Display
 * its full native before/after without adding a second primary Save consent. */
export function rememberRequestedActionRevision(input: {
  chat: Pick<Chat, "rememberDetails">;
  differences: readonly string[];
  before: unknown;
  after: unknown;
}): void {
  input.chat.rememberDetails("Exact Action revision", [
    ...input.differences, "Before:", ...JSON.stringify(input.before, null, 2).split("\n"),
    "After:", ...JSON.stringify(input.after, null, 2).split("\n"),
  ]);
}

/** Return only the operator's explicit disposition. This does not persist it,
 * fulfill an edit, replace a baseline or grant activation authority. */
export async function presentUnchangedActionRequest(input: {
  session: Pick<Session, "confirm" | "chooseOption">;
  instruction: string;
  current: { outcome: string; require: unknown; approval: unknown };
}): Promise<"confirmed_current" | "cancelled" | undefined> {
  const { session, instruction, current: draft } = input;
  if (!await session.confirm("Close this Action request with the current rule unchanged?", {
    defaultValue: false,
    context: ["The compiled business policy is unchanged. A new explanation or digest does not prove this request was fulfilled.",
      `Pending request: ${instruction}`, `Outcome: ${draft.outcome}`, `Current eligibility: ${JSON.stringify(draft.require)}`,
      `Current approval: ${JSON.stringify(draft.approval)}`,
      "Choose No to keep the edit pending. Closing requires a separate explicit reason; no replacement will be saved."],
  })) return undefined;
  const choice = await session.chooseOption?.("UNCHANGED ACTION REQUEST", [
    { value: "pending", label: "Keep the edit pending" },
    { value: "confirmed_current", label: "The displayed current rule already satisfies my request" },
    { value: "cancelled", label: "Cancel this edit request; keep the current rule" },
  ], { initialValue: "pending", reviewOnly: true, displayContext: true,
    context: ["This records your disposition only. It does not prove a new edit, publish rules or discard other unfinished work.", `Request: ${instruction}`] });
  return choice === "confirmed_current" || choice === "cancelled" ? choice : undefined;
}

// B64 typed fields share the existing presenter/session. The domain remains the
// sole owner of event application, currentness, protected persistence and saves.
import type { TypedReviewView, TypedReviewField, TypedFieldEvent, TypedReviewResponse,
  TypedReviewConfirmation, TypedFieldSelection } from "./authoring-typed-review.js";
import { decodeTypedFieldLiteral, formatTypedFieldValue, isValidTypedFieldValue } from "./authoring-typed-field-codec.js";
import { safeTerminalText } from "./analytics-shell-render.js";

type TypedSession = Pick<BoundaryReviewInteractiveSession,
  "promptText" | "confirm" | "chooseOption" | "present" | "rememberDetails" | "showReviewDetails">;
const localTypedOptions = { decisionKind: "business_review" as const, localOnly: true };
const originLabels: Record<TypedFieldSelection["origin"], string> = {
  saved_confirmed: "previously confirmed", saved_unconfirmed: "saved, unconfirmed",
  model_proposal: "assistant proposal, unconfirmed", operator_edit: "operator edit, unconfirmed",
};
function selectionText(selection: TypedFieldSelection): string {
  return `${formatTypedFieldValue(selection.value)}${selection.value.kind === "money" ? ` ${selection.value.currency}` : ""} (${originLabels[selection.origin]})`;
}
/** Complete host-derived review, including noneditable duties and changes. */
export function typedReviewCardLines(view: TypedReviewView): string[] {
  return ["Runner business review — " + view.status, "COMPLETE PROPOSED RULES", ...view.normalized_lines,
    "CHANGES", ...(view.change_lines.length ? view.change_lines : ["No change lines supplied; no claim of unchanged rules is inferred."]),
    "EDITABLE BUSINESS VALUES", ...view.fields.flatMap(field => [field.label,
      ...(field.current ? [`Current: ${selectionText(field.current)}`] : []),
      ...(field.suggestion ? [`Suggestion: ${selectionText(field.suggestion)}${isValidTypedFieldValue(field, field.suggestion.value) ? "" : " — INVALID; cannot keep"}`]
        : ["No suggestion; this value is not chosen for you."]),
      ...(field.explanation ? [field.explanation] : [])]),
    ...(view.unresolved.length ? ["UNRESOLVED", ...view.unresolved] : []),
    "Value edits remain unconfirmed. This review does not activate, execute or authorize model disclosure."
  ].map(safeTerminalText);
}
function unresolvedTypedFields(view: TypedReviewView): TypedReviewField[] {
  return view.fields.filter(field => field.required && !(field.suggestion && isValidTypedFieldValue(field, field.suggestion.value))
    && !(field.current && isValidTypedFieldValue(field, field.current.value)));
}
function typedReviewIsUnresolved(view: TypedReviewView): boolean {
  return view.unresolved.length > 0 || unresolvedTypedFields(view).length > 0
    || view.fields.some(field => field.suggestion && !isValidTypedFieldValue(field, field.suggestion.value));
}
function fieldIdentity(view: TypedReviewView, field: TypedReviewField) {
  return { binding: view.binding, field_id: field.id, target_digest: field.target_digest, dependencies_digest: field.dependencies_digest };
}

/** Returns one bound event to the existing host. No decoded client value or raw
 * testimony is manufactured for Enter. Every wait checks the host's currentness. */
export async function presentTypedAuthoringReview(input: {
  view: TypedReviewView; session: TypedSession; assertCurrent: () => Promise<void>;
}): Promise<TypedReviewResponse> {
  const view = structuredClone(input.view), { session } = input;
  if (view.decision_kind !== "business_review" || new Set(view.fields.map(field => field.id)).size !== view.fields.length)
    throw new Error("TYPED_REVIEW_VIEW_INVALID: Reopen the exact current business proposal.");
  const wait = async <T>(fn: () => Promise<T>): Promise<T> => {
    await input.assertCurrent(); const result = await fn(); await input.assertCurrent(); return result;
  };
  const pause = (): TypedReviewResponse => ({ kind: "pause", binding: view.binding });
  const choose = (title: string, choices: { value: string; label: string; detail?: string; disabled?: boolean }[],
    context: string[], initialValue = "pause") => wait(async () => session.chooseOption?.(safeTerminalText(title),
      choices.map(choice => ({ ...choice, label: safeTerminalText(choice.label), ...(choice.detail ? { detail: safeTerminalText(choice.detail) } : {}) })),
      { ...localTypedOptions, context: context.map(safeTerminalText), displayContext: true, reviewOnly: true, initialValue }));
  const prompt = (title: string, context: string[]) => wait(() => session.promptText(safeTerminalText(title), {
    ...localTypedOptions, context: context.map(safeTerminalText), recordPolicyAnswer: false, preserveWhitespace: true,
  }));
  const lines = typedReviewCardLines(view);
  const exactLines = [...lines, ...(view.technical_lines?.length ? ["EXACT TECHNICAL DETAILS", ...view.technical_lines.map(safeTerminalText)] : [])];
  await input.assertCurrent();
  session.rememberDetails?.(safeTerminalText(view.title), exactLines);
  for (;;) {
    const choice = await choose(view.title, [
      { value: "edit", label: "Edit a value" }, { value: "missing", label: "Resolve missing details" },
      { value: "sequential", label: "Review one by one" }, { value: "describe", label: "Describe a correction" },
      { value: "review", label: "Review the complete proposal", disabled: typedReviewIsUnresolved(view) },
      { value: "details", label: "View exact Runner details" }, { value: "pause", label: "Pause; keep this proposal unconfirmed" },
    ], lines);
    if (choice === undefined || choice === "pause") return pause();
    if (choice === "details") {
      await wait(async () => { if (session.showReviewDetails) await session.showReviewDetails(safeTerminalText(view.title), exactLines);
        else session.present?.(safeTerminalText(view.title), exactLines); });
      continue;
    }
    if (choice === "review") {
      if (typedReviewIsUnresolved(view)) {
        session.present?.("REVIEW STILL PENDING", ["Resolve the missing business decisions before the exact grouped review."]); continue;
      }
      return { kind: "review", binding: view.binding };
    }
    if (choice === "describe") {
      const raw = await prompt("Describe the correction", ["Your exact words remain an unconfirmed correction request. This local entry makes no model call."]);
      return raw === undefined || !raw.trim() ? pause() : { kind: "describe_correction", binding: view.binding, raw };
    }
    const fields = choice === "missing" ? unresolvedTypedFields(view) : view.fields;
    if (!["edit", "missing", "sequential"].includes(choice)) throw new Error("TYPED_REVIEW_CHOICE_INVALID");
    if (!fields.length) { session.present?.("NO EDITABLE MISSING VALUE", ["Unresolved meaning may need the ordinary correction route; no policy is chosen automatically."]); continue; }
    let index = 0;
    if (choice !== "sequential") {
      const selected = await choose("Choose a business value", [
        ...fields.map((field, i) => ({ value: `field:${i}`, label: field.label })), { value: "pause", label: "Back to the complete proposal" },
      ], []);
      if (selected === undefined || selected === "pause") continue;
      index = fields.findIndex((_field, i) => selected === `field:${i}`);
      if (index < 0) throw new Error("TYPED_REVIEW_FIELD_INVALID");
    }
    for (;;) {
      const field = fields[index]!;
      const validSuggestion = field.suggestion && isValidTypedFieldValue(field, field.suggestion.value);
      const context = [field.label, ...(field.explanation ? [field.explanation] : []),
        ...(field.current ? [`Current: ${selectionText(field.current)}`] : []),
        ...(field.suggestion ? [`Suggestion: ${selectionText(field.suggestion)}`] : []),
        validSuggestion ? "Enter keeps this exact displayed suggestion in the working proposal; it does not confirm it."
          : "No valid suggestion is available to keep. Blank input leaves this field pending."];
      if (choice === "sequential") {
        const navigation = await choose(`Value ${index + 1} of ${fields.length}`, [
          { value: "open", label: "Keep or edit this value" },
          ...(index > 0 ? [{ value: "previous", label: "Previous value" }] : []),
          ...(index + 1 < fields.length ? [{ value: "next", label: "Next value without changing this one" }] : []),
          { value: "pause", label: "Back to the complete proposal" },
        ], context);
        if (navigation === "previous" && index > 0) { index--; continue; }
        if (navigation === "next" && index + 1 < fields.length) { index++; continue; }
        if (navigation !== "open") break;
      }
      let event: TypedFieldEvent;
      if (field.kind === "choice") {
        const selected = await choose(field.label, [
          ...(validSuggestion ? [{ value: "keep", label: "Keep the displayed suggestion (unconfirmed)" }] : []),
          ...field.options.map((option, i) => ({ value: `option:${i}`, label: option.label })),
          { value: "pending", label: "Leave this value pending" }, { value: "pause", label: "Back to complete proposal" },
        ], context, validSuggestion ? "keep" : "pending");
        if (selected === undefined || selected === "pause") break;
        if (selected === "keep" && validSuggestion) event = { ...fieldIdentity(view, field), kind: "keep_suggestion" };
        else if (selected === "pending") event = { ...fieldIdentity(view, field), kind: "leave_pending" };
        else { const option = field.options.find((_option, i) => selected === `option:${i}`);
          if (!option || !decodeTypedFieldLiteral(field, option.value).ok) throw new Error("TYPED_REVIEW_OPTION_INVALID");
          event = { ...fieldIdentity(view, field), kind: "select_option", value: option.value }; }
      } else {
        const raw = await prompt(field.label, context);
        if (raw === undefined) break;
        if (raw === "") {
          event = { ...fieldIdentity(view, field), kind: validSuggestion ? "keep_suggestion" : "leave_pending" };
          if (!validSuggestion) session.present?.("VALUE STILL PENDING", ["Enter one exact value, or use Describe a correction. No suggestion was inferred."]);
        } else {
          const decoded = decodeTypedFieldLiteral(field, raw);
          if (!decoded.ok) {
            const resolution = await choose("VALUE NOT APPLIED", [
              { value: "retry", label: "Edit this value again" }, { value: "describe", label: "Use these exact words to describe a correction" },
              { value: "pending", label: "Leave the value pending" }, { value: "pause", label: "Back to complete proposal" },
            ], [decoded.message, `Your exact text: ${raw}`]);
            if (resolution === "retry") continue;
            if (resolution === "describe") return { kind: "describe_correction", binding: view.binding, raw };
            if (resolution !== "pending") break;
            event = { ...fieldIdentity(view, field), kind: "leave_pending" };
          } else event = { ...fieldIdentity(view, field), kind: "replace_literal", raw };
        }
      }
      return { kind: "field_event", event };
    }
  }
}

/** Existing host invokes this only after validating a complete current proposal.
 * A returned Yes is only a business review decision, never a save or activation. */
export async function confirmTypedAuthoringReview(input: {
  view: TypedReviewView; session: TypedSession; assertCurrent: () => Promise<void>;
}): Promise<TypedReviewConfirmation> {
  const view = structuredClone(input.view);
  await input.assertCurrent();
  if (view.decision_kind !== "business_review" || typedReviewIsUnresolved(view))
    throw new Error("TYPED_REVIEW_UNRESOLVED: Resolve current missing business decisions before confirmation.");
  const lines = typedReviewCardLines(view);
  const exactLines = [...lines, ...(view.technical_lines?.length ? ["EXACT TECHNICAL DETAILS", ...view.technical_lines.map(safeTerminalText)] : [])];
  const accepted = await input.session.confirm("Confirm this exact complete business proposal?", {
    ...localTypedOptions, defaultValue: false, context: lines, exactDetails: { title: safeTerminalText(view.title), lines: exactLines },
  });
  await input.assertCurrent();
  return { kind: "decision", binding: view.binding, accepted: accepted ?? null };
}
