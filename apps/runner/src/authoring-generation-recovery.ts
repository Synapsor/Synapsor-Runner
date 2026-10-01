import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError, authoringTransportObservation, completedProviderContentError, type ProviderHttpInput, type ProviderHttpResult, type AuthoringTransportObservation } from "./model-provider-transport.js";

export type AuthoringQuestionCompletion = {
  operation_id: string;
  request_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  response_digest: `sha256:${string}`;
};
export type AuthoringQuestionHandoff = {
  consumer: "action_rule_clarification" | "planning" | "read_clarification" | "read_value_context" | "read_revision_instruction" | "read_revision_clarification" | "policy_clarification";
  question: string;
  answered?: {answer: string; actor: "local_installation_operator"; recorded_at: string; checkpoint_digest: `sha256:${string}`};
  checkpoint_digest: `sha256:${string}`;
  question_digest: `sha256:${string}`;
  response_digest: `sha256:${string}`;
  recorded_at: string;
};
export type AuthoringTransportOperation = {
  id: string;
  request_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  deadline: string;
  state: "in_flight" | "unsent" | "unknown" | "partial" | "received" | "handled" | "checkpointed" | "refused";
  checkpoint_seen?: true;
  question_handoff?: AuthoringQuestionHandoff;
  producer_input?: ProviderHttpInput["authoringInput"];
  manual_recovery?: {
    id: string;
    actor: "local_installation_operator";
    reviewed_at: string;
    prior_attempt_id: string;
    checkpoint_digest: `sha256:${string}`;
    state_digest: `sha256:${string}`;
    status: "permitted" | "admitted";
    replacement_attempt_id?: string;
    attempt_deadline?: string;
    /** A known nonsemantic refusal consumes this one replacement; it must not
     * reopen the same pending step under a new generation ID. */
    failure_code?: string;
  };
  attempts: { id: string; started_at: string; outcome: "in_flight" | "A" | "B" | "C" | "response"; phase?: AuthoringTransportObservation["phase"]; code?: string;
    /** Minted at the owning generation boundary only after native close and
     * before any result is returned to an adapter/consumer. Older records do
     * not acquire these facts from error prose or protected capture imports. */
    no_response_boundary?: {
      version: 1;
      transport_closed: true;
      headers_received: false;
      content_received: false;
      response_consumer: "not_started";
      pure_local_generation: true;
      owner_cancelled: false;
      destination_digest: `sha256:${string}`;
      model: string;
      recorded_at: string;
    };
  }[];
};
export type AuthoringTransportState = {
  version: 1;
  policy?: {
    maximum_additional_attempts: 0 | 1 | 2;
    duplicate_generation_charges: boolean;
    provider: string;
    model: string;
    destination_digest: `sha256:${string}`;
    actor: "local_installation_operator";
    reviewed_at: string;
  };
  operations: AuthoringTransportOperation[];
};
export type AuthoringGenerationHost = {
  read(): AuthoringTransportState | undefined;
  write(state: AuthoringTransportState): Promise<void>;
  /** Checks disk Source, authority, consent and the exact acknowledged resume. */
  current(): Promise<`sha256:${string}`>;
  available(): boolean;
  /** Tracking may become available after a reviewed rescan without renewing retry consent. */
  allowRetries?(): boolean;
  progress?(message: string): void;
};
type CompletedTurnOperation = { id: string; request_digest: `sha256:${string}`; context_digest: `sha256:${string}`; attempt_id: string };
type Frame = { host?: AuthoringGenerationHost; owned: Set<string>; active: boolean;
  /** Ephemeral associations minted from real response identities only after a
   * decoder/callback turn completes. Never loaded from a saved checkpoint. */
  completedTurns: Map<string, CompletedTurnOperation[]> };
const storage = new AsyncLocalStorage<Frame>();
const resultOperations = new WeakMap<ProviderHttpResult, string>();
const manualReplacementStops = new WeakSet<object>();
const manualReplacementRefusals = new Set(["ASK_PROVIDER_TOOL_SCHEMA_REJECTED", "ASK_PROVIDER_CREDIT_REQUIRED",
  "ASK_PROVIDER_MODEL_UNAVAILABLE", "ASK_PROVIDER_AUTHENTICATION_FAILED", "ASK_PROVIDER_PERMISSION_DENIED",
  "ASK_PROVIDER_RATE_LIMITED", "ASK_PROVIDER_REQUEST_INVALID", "ASK_PROVIDER_REDIRECT_REFUSED",
  "ASK_PROVIDER_DESTINATION_REFUSED", "ASK_PROVIDER_REQUEST_TOO_LARGE"]);
export function isAuthoringGenerationStop(error: unknown): error is AskError {
  return error instanceof AskError && (manualReplacementStops.has(error) || ["ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "ASK_GENERATION_OUTCOME_UNKNOWN",
    "ASK_GENERATION_NOT_SENT", "ASK_GENERATION_CONTEXT_CHANGED", "ASK_GENERATION_DEADLINE",
    "ASK_GENERATION_RECOVERY_EXHAUSTED", "ASK_GENERATION_ALREADY_ACTIVE", "ASK_GENERATION_HISTORY_LIMIT",
    "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE"].includes(error.code));
}

export function withAuthoringGenerationRecovery<T>(run: () => T, inheritCompletedOperations = false): T {
  const parent = storage.getStore();
  // A public saved Review can be the next consumer of a completed routing plan
  // in this same live call chain. Transfer only those real owned completions;
  // never infer ownership from a stored record after process/session restart.
  const owned = new Set(inheritCompletedOperations && parent && !parent.active
    ? (parent.host?.read()?.operations ?? []).filter(op => parent.owned.has(op.id)
      && ["handled","checkpointed","refused"].includes(op.state)).map(op => op.id) : []);
  return storage.run({owned, active: false, completedTurns: new Map()}, run);
}
export function configureAuthoringGenerationRecovery(host: AuthoringGenerationHost): void {
  const frame = storage.getStore();
  if (frame) frame.host = host;
}
const exactKeys = (v: object, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const invalid = () => new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Saved transport recovery data is invalid.");
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const id = (v: unknown) => typeof v === "string" && /^[a-f0-9-]{36}$/u.test(v);
export function validateAuthoringTransportState(value: unknown): asserts value is AuthoringTransportState {
  const s = value as AuthoringTransportState;
  if (!s || typeof s !== "object" || !exactKeys(s,["version","policy","operations"]) || s.version !== 1 || !Array.isArray(s.operations) || s.operations.length > 4096) throw invalid();
  if (s.policy) {
    const p = s.policy;
    if (!exactKeys(p,["maximum_additional_attempts","duplicate_generation_charges","provider","model","destination_digest","actor","reviewed_at"]) || ![0,1,2].includes(p.maximum_additional_attempts) || typeof p.duplicate_generation_charges !== "boolean"
      || p.actor !== "local_installation_operator" || !date(p.reviewed_at) || !digest(p.destination_digest)
      || !["openai","openrouter","anthropic","openai_compatible"].includes(p.provider)
      || typeof p.model !== "string" || !p.model.length || p.model.length > 128) throw invalid();
  }
  const seen = new Set<string>();
  for (const op of s.operations) {
    if (!op || typeof op !== "object" || !exactKeys(op,["id","request_digest","context_digest","deadline","state","checkpoint_seen","question_handoff","producer_input","manual_recovery","attempts"]) || !id(op.id) || seen.has(op.id) || !digest(op.request_digest) || !digest(op.context_digest) || !date(op.deadline)
      || !["in_flight","unsent","unknown","partial","received","handled","checkpointed","refused"].includes(op.state)
      || op.checkpoint_seen !== undefined && op.checkpoint_seen !== true
      || !Array.isArray(op.attempts) || !op.attempts.length || op.attempts.length > 3) throw invalid();
    if (op.producer_input !== undefined) {
      const p = op.producer_input;
      if (!p || typeof p !== "object" || !exactKeys(p,["consumer","operator_message","program_resume_revision"])
        || p.consumer !== "action_rule_components" || typeof p.operator_message !== "string" || !p.operator_message.trim()
        || p.operator_message.length > 4_000 || p.program_resume_revision !== undefined && !digest(p.program_resume_revision)) throw invalid();
    }
    if (op.question_handoff !== undefined) {
      const h = op.question_handoff;
      if (!h || typeof h !== "object" || Array.isArray(h) || !exactKeys(h, ["consumer","question","answered","checkpoint_digest","question_digest","response_digest","recorded_at"])
        || !["action_rule_clarification", "planning", "read_clarification", "read_value_context", "read_revision_instruction", "read_revision_clarification", "policy_clarification"].includes(h.consumer) || typeof h.question !== "string" || !h.question.trim() || h.question.length > 20_000
        || canonicalJsonDigest(h.question) !== h.question_digest || !digest(h.checkpoint_digest) || !digest(h.question_digest)
        || !digest(h.response_digest) || !date(h.recorded_at) || op.attempts.at(-1)?.outcome !== "response" || op.state !== "checkpointed" || op.checkpoint_seen !== true) throw invalid();
      if (h.answered !== undefined && (!h.answered || typeof h.answered !== "object" || Array.isArray(h.answered) || !exactKeys(h.answered,["answer","actor","recorded_at","checkpoint_digest"])
        || typeof h.answered.answer !== "string" || !h.answered.answer.trim() || h.answered.answer.length > 4_000
        || h.answered.actor !== "local_installation_operator" || !date(h.answered.recorded_at) || !digest(h.answered.checkpoint_digest))) throw invalid();
    }
    seen.add(op.id);
    for (const a of op.attempts) {
      if (!a || typeof a !== "object" || !exactKeys(a,["id","started_at","outcome","phase","code","no_response_boundary"]) || !id(a.id) || seen.has(a.id) || !date(a.started_at) || !["in_flight","A","B","C","response"].includes(a.outcome)
        || a.phase !== undefined && !["resolution","connection","request","headers","response"].includes(a.phase)
        || a.code !== undefined && !/^(?:E[A-Z0-9_]{1,48}|ERR_[A-Z0-9_]{1,48})$/u.test(a.code)) throw invalid();
      seen.add(a.id);
      if (a.no_response_boundary !== undefined) {
        const b = a.no_response_boundary;
        if (!b || typeof b !== "object" || !exactKeys(b,["version","transport_closed","headers_received","content_received","response_consumer","pure_local_generation","owner_cancelled","destination_digest","model","recorded_at"])
          || a.outcome !== "B" || !["connection","request"].includes(a.phase ?? "") || b.version !== 1
          || b.transport_closed !== true || b.headers_received !== false || b.content_received !== false
          || b.response_consumer !== "not_started" || b.pure_local_generation !== true || b.owner_cancelled !== false
          || !digest(b.destination_digest) || typeof b.model !== "string" || !b.model.length || b.model.length > 128 || !date(b.recorded_at)) throw invalid();
      }
    }
    if (op.manual_recovery !== undefined) {
      const m = op.manual_recovery, prior = op.attempts.findIndex(a => a.id === m?.prior_attempt_id);
      if (!m || typeof m !== "object" || !exactKeys(m,["id","actor","reviewed_at","prior_attempt_id","checkpoint_digest","state_digest","status","replacement_attempt_id","attempt_deadline","failure_code"])
        || !id(m.id) || seen.has(m.id) || m.actor !== "local_installation_operator" || !date(m.reviewed_at)
        || !digest(m.checkpoint_digest) || !digest(m.state_digest) || prior < 0 || !op.attempts[prior]!.no_response_boundary
        || op.attempts.slice(0, prior).some(a => a.outcome === "B") || prior >= 2
        || !["permitted","admitted"].includes(m.status)
        || m.status === "permitted" && (op.state !== "unknown" || prior !== op.attempts.length - 1 || m.replacement_attempt_id !== undefined || m.attempt_deadline !== undefined)
        || m.status === "admitted" && (!id(m.replacement_attempt_id) || !date(m.attempt_deadline) || op.attempts[prior + 1]?.id !== m.replacement_attempt_id)
        || m.failure_code !== undefined && (m.status !== "admitted" || op.state !== "refused"
          || !manualReplacementRefusals.has(m.failure_code) || op.attempts.at(-1)?.id !== m.replacement_attempt_id)) throw invalid();
      seen.add(m.id);
    }
  }
}

export type AuthoringManualRecoveryPreview = {
  operation_id: string;
  attempt_id: string;
  checkpoint_digest: `sha256:${string}`;
  state_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
};
/** Restore only product-authored producer inputs for the exact permitted step.
 * The caller still constructs the complete request normally; its final digest
 * must match at admission. This neither imports a response nor ignores CAS. */
export async function authoringManualProducerInput(consumer: NonNullable<ProviderHttpInput["authoringInput"]>["consumer"]): Promise<ProviderHttpInput["authoringInput"]> {
  const host = storage.getStore()?.host;
  if (!host) return undefined;
  const state = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  validateAuthoringTransportState(state);
  const op = state.operations.find(item => item.manual_recovery?.status === "permitted");
  if (!op?.producer_input) return undefined; // Never fabricate origin for historical records.
  if (op.producer_input.consumer !== consumer || await currentRecoveryContext(host) !== op.context_digest)
    throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  return structuredClone(op.producer_input);
}
function manualRecoveryUnavailable(message: string): never {
  throw new AskError("ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE", message, 409);
}
function manualRecoveryTarget(state: AuthoringTransportState): AuthoringTransportOperation {
  const unresolved = state.operations.filter(op => ["in_flight","unsent","unknown","partial","received","handled"].includes(op.state));
  if (unresolved.length !== 1) return manualRecoveryUnavailable("One exact unresolved generation is required. Other unfinished or unacknowledged work remains fenced; no response was acknowledged.");
  const op = unresolved[0]!, attempt = op.attempts.at(-1)!;
  if (op.state !== "unknown" || attempt.outcome !== "B" || !attempt.no_response_boundary)
    return manualRecoveryUnavailable("The saved attempt lacks the complete durable no-response, closed-transport and pure-generation boundary. Partial output, unknown consumption and historical records without those facts remain fenced.");
  if (op.manual_recovery?.status === "permitted")
    return manualRecoveryUnavailable("One replacement permission is already saved. Resume may use it once for the exact operation; another confirmation cannot replace it.");
  if (op.manual_recovery || op.attempts.length >= 3 || op.attempts.slice(0, -1).some(a => a.outcome === "B"))
    return manualRecoveryUnavailable("The finite replacement permission or generation-attempt allowance is already used. Resume cannot reset it; the original attempts remain recorded.");
  return op;
}
/** Public local operator review only; no generation, acknowledgement, automatic
 * policy change or provider-cost reconciliation occurs in either function. */
export async function prepareAuthoringManualRecovery(checkpointDigest: `sha256:${string}`): Promise<AuthoringManualRecoveryPreview> {
  const frame = storage.getStore(), host = frame?.host;
  if (!host || frame!.active || !digest(checkpointDigest)) return manualRecoveryUnavailable("The current saved job is unavailable or a generation is still active. No replacement permission was created.");
  const state = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  validateAuthoringTransportState(state);
  const op = manualRecoveryTarget(state), context = await currentRecoveryContext(host);
  if (context !== op.context_digest) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  return {operation_id: op.id, attempt_id: op.attempts.at(-1)!.id, checkpoint_digest: checkpointDigest,
    state_digest: canonicalJsonDigest(state), context_digest: context};
}
export async function permitAuthoringManualRecovery(preview: AuthoringManualRecoveryPreview): Promise<void> {
  const frame = storage.getStore(), host = frame?.host;
  if (!host || frame!.active) return manualRecoveryUnavailable("Another generation is active or this saved job is unavailable.");
  // Serialize confirmation with generation/admission in this live owner. A
  // separate process still needs the existing saved-checkpoint CAS at write.
  frame!.active = true;
  try {
    const state = structuredClone(host.read() ?? {version: 1 as const, operations: []});
    validateAuthoringTransportState(state);
    const op = manualRecoveryTarget(state);
    if (!digest(preview.checkpoint_digest) || canonicalJsonDigest(state) !== preview.state_digest || op.id !== preview.operation_id
      || op.attempts.at(-1)!.id !== preview.attempt_id || await currentRecoveryContext(host) !== preview.context_digest
      || op.context_digest !== preview.context_digest) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
    op.manual_recovery = {id: randomUUID(), actor: "local_installation_operator", reviewed_at: new Date().toISOString(),
      prior_attempt_id: preview.attempt_id, checkpoint_digest: preview.checkpoint_digest, state_digest: preview.state_digest, status: "permitted"};
    await writeRecoveryState(host, state);
  } finally { frame!.active = false; }
}

/** Called only by the existing acknowledged business-checkpoint writer. A
 * checkpoint while a callback is running is not itself callback completion. */
export function authoringTransportCheckpoint(state: AuthoringTransportState | undefined): AuthoringTransportState | undefined {
  if (!state) return undefined;
  const copy = structuredClone(state), frame = storage.getStore();
  // A typed question handoff proves only its own consumer. Never let a later
  // generic pause/answer save retroactively acknowledge an earlier operation
  // that was still uncheckpointed when the question committed. Ordinary B32
  // component checkpoints (before or after that boundary) keep their behavior.
  const questionBoundary = copy.operations.reduce((last, op, index) => op.question_handoff !== undefined ? index : last, -1);
  for (const [index, op] of copy.operations.entries()) if (index >= questionBoundary && frame?.owned.has(op.id)) {
    if (op.state === "received") op.checkpoint_seen = true;
    else if (op.state === "handled") { op.checkpoint_seen = true; op.state = "checkpointed"; }
  }
  return copy;
}
/** Called after the real turn decoder/consumer has returned successfully. The
 * last actual response remains associated by object identity, never by supplied JSON. */
export function authoringQuestionCompletion(results: readonly ProviderHttpResult[]): AuthoringQuestionCompletion | undefined {
  const frame = storage.getStore(), host = frame?.host;
  if (!host?.available()) return undefined;
  const last = results.at(-1), operationId = last && resultOperations.get(last);
  const op = host.read()?.operations.find(item => item.id === operationId);
  if (!last || !op || !frame!.owned.has(op.id) || op.state !== "handled" && op.state !== "checkpointed") {
    throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The completed question has no current local consumer association.", 409);
  }
  const completion = {operation_id: op.id, request_digest: op.request_digest, context_digest: op.context_digest,
    response_digest: canonicalJsonDigest(last.body)};
  const completed = results.map(result => {
    const id = resultOperations.get(result), sibling = host.read()?.operations.find(item => item.id === id);
    if (!sibling || !frame!.owned.has(sibling.id) || !["handled", "checkpointed", "refused"].includes(sibling.state)
      || sibling.attempts.at(-1)?.outcome !== "response") throw new AskError(
        "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The completed turn has an unacknowledged consumer. No historical operation was acknowledged.", 409);
    return {id: sibling.id, request_digest: sibling.request_digest, context_digest: sibling.context_digest,
      attempt_id: sibling.attempts.at(-1)!.id};
  });
  frame!.completedTurns.set(canonicalJsonDigest(completion), completed);
  return completion;
}

/** Associate only explicitly consumed turns of one bounded producer with its
 * final question. The caller obtains these completions from actual decoded
 * result identities. No saved operation scan or generic checkpoint promotion. */
export function authoringQuestionSequenceCompletion(completions: readonly AuthoringQuestionCompletion[]): AuthoringQuestionCompletion | undefined {
  const frame = storage.getStore();
  if (!frame?.host?.available()) return undefined;
  if (!completions.length || completions.length > 16) throw invalid();
  const consumed = new Map<string, CompletedTurnOperation>();
  for (const completion of completions) {
    const refs = frame.completedTurns.get(canonicalJsonDigest(completion));
    if (!refs?.length) throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
      "The bounded question sequence has no current completed consumer association.", 409);
    for (const ref of refs) {
      const op = frame.host.read()?.operations.find(item => item.id === ref.id);
      if (!op || !frame.owned.has(ref.id) || op.request_digest !== ref.request_digest || op.context_digest !== ref.context_digest
        || op.attempts.at(-1)?.id !== ref.attempt_id || op.attempts.at(-1)?.outcome !== "response"
        || !["handled", "checkpointed", "refused"].includes(op.state)) throw invalid();
      const prior = consumed.get(ref.id);
      if (prior && canonicalJsonDigest(prior) !== canonicalJsonDigest(ref)) throw invalid();
      consumed.set(ref.id, ref);
    }
  }
  const last = completions.at(-1)!;
  frame.completedTurns.set(canonicalJsonDigest(last), [...consumed.values()]);
  return structuredClone(last);
}

/** Prepare one exact question handoff for the SAME coordinated resume write as
 * its component checkpoint. This does not write a second acknowledgement file. */
export function authoringQuestionCheckpoint(state: AuthoringTransportState | undefined,
  checkpoint: {digest: `sha256:${string}`; consumer?: AuthoringQuestionHandoff["consumer"]; pending_question?: {question: string; completion?: AuthoringQuestionCompletion}}): AuthoringTransportState | undefined {
  if (!checkpoint.pending_question) return state;
  const completion = checkpoint.pending_question.completion, frame = storage.getStore();
  if (!state || !completion || !frame?.owned.has(completion.operation_id)) throw new AskError(
    "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The question cannot be committed without its current completed generation. No historical operation was acknowledged.", 409);
  const copy = structuredClone(state), op = copy.operations.find(item => item.id === completion.operation_id);
  if (!op || !["handled", "checkpointed"].includes(op.state) || op.request_digest !== completion.request_digest
    || op.context_digest !== completion.context_digest || op.attempts.at(-1)?.outcome !== "response") throw invalid();
  // The final question may follow successfully handled tools in the SAME turn.
  // Bind their known consumption to this atomic checkpoint, not to a later
  // generic save that could also promote unrelated/historical handled output.
  for (const ref of frame.completedTurns.get(canonicalJsonDigest(completion)) ?? []) {
    const sibling = copy.operations.find(item => item.id === ref.id);
    if (!sibling || !frame.owned.has(sibling.id) || sibling.request_digest !== ref.request_digest
      || sibling.context_digest !== ref.context_digest || sibling.attempts.at(-1)?.id !== ref.attempt_id
      || sibling.attempts.at(-1)?.outcome !== "response" || !["handled", "checkpointed", "refused"].includes(sibling.state)) throw invalid();
    if (sibling.state === "handled") { sibling.state = "checkpointed"; sibling.checkpoint_seen = true; }
  }
  op.question_handoff = {consumer: checkpoint.consumer ?? "action_rule_clarification", question: checkpoint.pending_question.question, checkpoint_digest: checkpoint.digest,
    question_digest: canonicalJsonDigest(checkpoint.pending_question.question), response_digest: completion.response_digest,
    recorded_at: new Date().toISOString()};
  op.state = "checkpointed"; op.checkpoint_seen = true;
  return copy;
}

export function assertAuthoringQuestionHandoff(state: AuthoringTransportState | undefined,
  checkpoint: {digest: `sha256:${string}`; consumer?: AuthoringQuestionHandoff["consumer"]; pending_question?: {question: string; completion?: AuthoringQuestionCompletion}} | undefined): void {
  const pending = checkpoint?.pending_question;
  if (!pending) return;
  const c = pending.completion, op = c && state?.operations.find(item => item.id === c.operation_id), h = op?.question_handoff;
  if (!c || !op || !h || op.state !== "checkpointed" || op.checkpoint_seen !== true
    || op.request_digest !== c.request_digest || op.context_digest !== c.context_digest
    || h.answered || h.consumer !== (checkpoint!.consumer ?? "action_rule_clarification") || h.checkpoint_digest !== checkpoint!.digest || h.question_digest !== canonicalJsonDigest(pending.question)
    || h.response_digest !== c.response_digest) throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: The pending question has no exact committed consumer handoff. Preserve the saved state for inspection.");
}

/** The public consumer calls this inside its currentness/CAS checkpoint write.
 * The old question acknowledgement remains history; this records a separate
 * attributable answer, not another transport completion or retry allowance. */
export function authoringQuestionAnswerCheckpoint(state: AuthoringTransportState | undefined,
  previous: Parameters<typeof assertAuthoringQuestionHandoff>[1],
  next: {digest: `sha256:${string}`; operator_messages?: string[]; pending_question?: unknown}): AuthoringTransportState | undefined {
  if (!previous?.pending_question || next.pending_question) return state;
  assertAuthoringQuestionHandoff(state, previous);
  const answer = next.operator_messages?.at(-1);
  if (!answer?.trim()) throw invalid();
  const copy = structuredClone(state!);
  const op = copy.operations.find(item => item.id === previous.pending_question!.completion!.operation_id)!;
  op.question_handoff!.answered = {answer, actor: "local_installation_operator", recorded_at: new Date().toISOString(), checkpoint_digest: next.digest};
  return copy;
}

const hostCurrentnessCodes = new Set(["POLICY_SOURCE_CHANGED", "POLICY_REVIEW_CANDIDATE_CHANGED",
  "POLICY_REVIEW_SUBJECT_CHANGED", "BOUNDARY_AUTHORING_RESUME_CHANGED"]);
/** Safe reason minted only while checking/writing the local recovery host.
 * Remains terminal through optional producers; saved Review can explain its
 * known currentness veto without treating it as an unknown write result. */
const hostCurrentnessReasons = new WeakMap<object, string>();
export function authoringGenerationCurrentnessCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? hostCurrentnessReasons.get(error) : undefined;
}
function currentnessFailure(code: string): AskError {
  const error = new AskError("ASK_GENERATION_CONTEXT_CHANGED", `${code}: The saved source or review changed. No stale generation result was accepted; inspect the current saved job before continuing.`, 409);
  hostCurrentnessReasons.set(error, code);
  return error;
}
function hostRecoveryFailure(error: unknown): AskError {
  const code = error instanceof Error ? (error as Error & {code?: unknown}).code : undefined;
  return typeof code === "string" && hostCurrentnessCodes.has(code)
    ? currentnessFailure(code)
    : new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
      "The saved generation record could not be acknowledged. Preserve and inspect the exact saved job and attempt history before continuing; no automatic generation or callback replay is permitted.", 409);
}
async function currentRecoveryContext(host: AuthoringGenerationHost): Promise<`sha256:${string}`> {
  try { return await host.current(); } catch (error) { throw hostRecoveryFailure(error); }
}
/** A rejected acknowledgement does not establish whether its write committed.
 * Keep the last durable record and stop the caller before any fallback/reissue. */
async function writeRecoveryState(host: AuthoringGenerationHost, state: AuthoringTransportState): Promise<void> {
  try { await host.write(state); }
  catch (error) { throw hostRecoveryFailure(error); }
}
export async function authoringGenerationHandled(results: readonly ProviderHttpResult[]): Promise<void> {
  const host = storage.getStore()?.host;
  if (!host?.available()) return;
  const wanted = new Set(results.map(r => resultOperations.get(r)).filter(Boolean));
  if (!wanted.size) return;
  const s = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  let changed = false;
  for (const op of s.operations) if (wanted.has(op.id) && op.state === "received") {
    op.state = op.checkpoint_seen ? "checkpointed" : "handled"; changed = true;
  }
  if (changed) await writeRecoveryState(host, s);
}
/** A callback that threw may have saved before losing its acknowledgement.
 * Persist that uncertainty even with retries disabled; never repair it by
 * generating the callback's arguments again. Full semantic refusals before a
 * callback are different: the response was received and safely rejected. */
export async function authoringGenerationFailed(results: readonly ProviderHttpResult[], callbackMayHaveRun: boolean): Promise<void> {
  const host = storage.getStore()?.host;
  if (!host?.available()) return;
  const wanted = new Set(results.map(r => resultOperations.get(r)).filter(Boolean));
  const s = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  let changed = false;
  for (const op of s.operations) if (wanted.has(op.id) && op.state === "received") {
    op.state = callbackMayHaveRun ? "partial" : "refused"; changed = true;
  }
  if (changed) await writeRecoveryState(host, s);
}
function pureLocalGeneration(input: ProviderHttpInput): boolean {
  const b = input.body;
  if (["background","conversation","previous_response_id","webhook","webhooks"].some(k => k in b)) return false;
  // Explicit provider-hosted storage is outside this local replacement
  // contract, including chat routes where storage is otherwise optional.
  if (b.store === true) return false;
  if ((input.stream?.format === "openai_responses" || /\/responses\/?$/u.test(input.endpoint.pathname)) && b.store !== false) return false;
  if (!Array.isArray(b.tools) && b.tools !== undefined) return false;
  return (b.tools as Record<string, unknown>[] | undefined ?? []).every(t => input.stream?.format === "anthropic"
    ? typeof t.name === "string" && t.input_schema !== undefined && t.type === undefined
    : t.type === "function" && (typeof t.name === "string" || typeof t.function === "object"));
}
function transportStop(observation: AuthoringTransportObservation | undefined, original: unknown): unknown {
  // A fully read content refusal and known local/permanent admission errors keep
  // their existing semantics. Unknown dependency errors must not become a
  // narrator/producer fallback merely because they lack native phase evidence.
  if (completedProviderContentError(original) || isAuthoringGenerationStop(original)) return original;
  if (original instanceof AskError && ["ASK_CANCELLED", "ASK_PROVIDER_REQUEST_INVALID", "ASK_PROVIDER_REDIRECT_REFUSED", "ASK_PROVIDER_DESTINATION_REFUSED",
    "ASK_PROVIDER_REQUEST_TOO_LARGE"].includes(original.code)) return original;
  if (!observation) return new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
    "The generation failed without sufficient transport-phase evidence. Saved progress is retained; inspect its recorded attempt and local state before continuing. No automatic generation or callback replay is permitted.", 502);
  return new AskError(observation.classification === "C" ? "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"
    : observation.classification === "B" ? "ASK_GENERATION_OUTCOME_UNKNOWN" : "ASK_GENERATION_NOT_SENT",
  observation.classification === "C"
    ? "The provider response was interrupted or incomplete. Saved progress is retained. Inspect the current saved job before continuing; no automatic generation or draft replay is permitted."
    : observation.classification === "B"
      ? "The connection was interrupted before response headers. The provider may have processed and charged for this generation. Saved progress is retained; the permitted recovery is unavailable or exhausted."
      : "The connection failed before an API request could be sent. Saved progress is retained; inspect connection settings and the saved recovery policy.", 502);
}

/** One generation, never a tool/producer/save retry. The HTTP owner alone mints
 * A/B evidence. Missing evidence cannot turn a dependency/guard error into retry. */
export async function recoverAuthoringGeneration(input: ProviderHttpInput,
  request: (input: ProviderHttpInput) => Promise<ProviderHttpResult>): Promise<ProviderHttpResult> {
  const frame = storage.getStore(), host = frame?.host;
  if (!frame || !host) {
    try { return await request(input); }
    catch (e) { throw transportStop(authoringTransportObservation(e), e); }
  }
  if (frame.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE", "Another authoring generation is still active.", 409);
  const initial = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  validateAuthoringTransportState(initial);
  const stoppedReplacement = initial.operations.find(op => op.manual_recovery?.failure_code);
  if (stoppedReplacement) throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
    `${stoppedReplacement.manual_recovery!.failure_code}: The permitted replacement was refused. Its finite permission is used; the original unknown attempt and saved progress remain recorded. Resume cannot open another generation for this pending step.`, 409);
  const manual = initial.operations.find(op => op.manual_recovery?.status === "permitted");
  if (initial.operations.some(op => op.id !== manual?.id && (["in_flight", "unsent", "unknown", "partial"].includes(op.state)
    || !frame.owned.has(op.id) && op.state !== "checkpointed" && op.state !== "refused"))) {
    throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The saved job contains an unfinished generation or unacknowledged local result. Inspect/reconcile its exact saved progress; restart cannot reset the attempt allowance.", 409);
  }
  if (!host.available()) {
    if (manual) return manualRecoveryUnavailable("The saved generation boundary is not current and available. No replacement request was sent.");
    try { return await request(input); }
    catch (e) { throw transportStop(authoringTransportObservation(e), e); }
  }
  if (!manual && initial.operations.length >= 4096) throw new AskError("ASK_GENERATION_HISTORY_LIMIT", "The saved generation history reached its local record bound. Preserve and inspect it before continuing.", 409);
  const context = await currentRecoveryContext(host);
  const body = structuredClone(input.body), requestDigest = canonicalJsonDigest({body, endpoint: input.endpoint.href, stream: input.stream?.format ?? null});
  if (manual && (manual.context_digest !== context || manual.request_digest !== requestDigest || !pureLocalGeneration(input)
    || manual.attempts.at(-1)!.no_response_boundary?.destination_digest !== canonicalJsonDigest(input.endpoint.origin)
    || manual.attempts.at(-1)!.no_response_boundary?.model !== body.model
    || canonicalJsonDigest(manual.producer_input ?? null) !== canonicalJsonDigest(input.authoringInput ?? null))) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  const op: AuthoringTransportOperation = manual ?? {id: randomUUID(), request_digest: requestDigest, context_digest: context,
    deadline: new Date(Date.now() + (input.timeoutMs ?? 30_000)).toISOString(), state: "in_flight", attempts: [],
    ...(input.authoringInput ? {producer_input: structuredClone(input.authoringInput)} : {})};
  // Explicit replacement has its own finite request deadline. Never extend or
  // rewrite the original operation's expired deadline or failed attempt.
  const operationDeadline = manual ? new Date(Date.now() + (input.timeoutMs ?? 30_000)).toISOString() : op.deadline;
  const policy = initial.policy;
  const allowed = !manual && host.allowRetries?.() !== false && policy && policy.model === body.model && policy.destination_digest === canonicalJsonDigest(input.endpoint.origin)
    ? policy.maximum_additional_attempts : 0;
  if (frame.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE", "Another authoring generation is still active.", 409);
  frame.active = true; frame.owned.add(op.id);
  let priorB = 0;
  try {
    for (let ordinal = 0; ordinal <= allowed; ordinal++) {
      input.signal.throwIfAborted();
      if (await currentRecoveryContext(host) !== context) throw new AskError("ASK_GENERATION_CONTEXT_CHANGED", "The saved source, permissions or parent changed. This generation will not be retargeted.", 409);
      let remaining = Date.parse(operationDeadline) - Date.now();
      if (remaining <= 0) throw new AskError("ASK_GENERATION_DEADLINE", "The original generation deadline expired. Saved progress is retained.", 504);
      const attempt = {id: randomUUID(), started_at: new Date().toISOString(), outcome: "in_flight" as AuthoringTransportOperation["attempts"][number]["outcome"]};
      op.attempts.push(attempt); op.state = "in_flight";
      if (manual) Object.assign(op.manual_recovery!, {status: "admitted", replacement_attempt_id: attempt.id, attempt_deadline: operationDeadline});
      const save = async () => {
        const s = structuredClone(host.read() ?? initial), index = s.operations.findIndex(x => x.id === op.id);
        if (index < 0) s.operations.push(structuredClone(op)); else s.operations[index] = structuredClone(op);
        await writeRecoveryState(host, s);
      };
      await save();
      input.signal.throwIfAborted();
      remaining = Date.parse(operationDeadline) - Date.now();
      if (remaining <= 0) throw new AskError("ASK_GENERATION_DEADLINE", "The original generation deadline expired before dispatch. No new request was sent; preserve the saved attempt record.", 504);
      const deadline = AbortSignal.timeout(remaining), signal = AbortSignal.any([input.signal, deadline]);
      let result: ProviderHttpResult;
      try {
        result = await request({...input, body: structuredClone(body), signal, timeoutMs: remaining,
          headers: {...input.headers, "x-client-request-id": attempt.id, "x-synapsor-generation-id": op.id, "x-synapsor-generation-attempt": String(op.attempts.length)}});
        if (signal.aborted) throw new AskError(input.signal.aborted ? "ASK_CANCELLED" : "ASK_GENERATION_DEADLINE",
          "The generation ended after cancellation or its original deadline. Late output was not accepted; inspect the saved attempt.", 499);
      } catch (e) {
        const observation = authoringTransportObservation(e);
        attempt.outcome = completedProviderContentError(e) ? "response" : observation?.classification ?? "C";
        if (observation) Object.assign(attempt, {phase: observation.phase, ...(observation.code ? {code: observation.code} : {})});
        if (!completedProviderContentError(e) && observation?.classification === "B" && observation.transient
          && observation.cleanup_complete && !observation.headers_received && !input.signal.aborted && !deadline.aborted
          && pureLocalGeneration(input) && typeof body.model === "string") {
          Object.assign(attempt, {no_response_boundary: {version: 1, transport_closed: true, headers_received: false,
            content_received: false, response_consumer: "not_started", pure_local_generation: true, owner_cancelled: false,
            destination_digest: canonicalJsonDigest(input.endpoint.origin), model: body.model, recorded_at: new Date().toISOString()}});
        }
        const permanent = e instanceof AskError && ["ASK_PROVIDER_REQUEST_INVALID", "ASK_PROVIDER_REDIRECT_REFUSED", "ASK_PROVIDER_DESTINATION_REFUSED"].includes(e.code);
        op.state = permanent || completedProviderContentError(e) ? "refused" : observation?.classification === "A" ? "unsent" : observation?.classification === "B" ? "unknown" : "partial";
        if (manual && e instanceof AskError && manualReplacementRefusals.has(e.code)) {
          op.state = "refused";
          op.manual_recovery!.failure_code = e.code;
          manualReplacementStops.add(e); // Preserve the precise refusal through fallback callers.
        }
        await save();
        const b = observation?.classification === "B";
        const retry = observation?.transient && observation.cleanup_complete && observation.classification !== "C"
          && !input.signal.aborted && !deadline.aborted && ordinal < allowed
          && (!b || policy?.duplicate_generation_charges === true && priorB === 0 && pureLocalGeneration(input));
        if (!retry) throw transportStop(observation, e);
        if (b) priorB++;
        host.progress?.("Connection interrupted; one permitted generation retry is underway. Provider charges may apply twice; saved Actions are retained.");
        await delay(Math.min(ordinal === 0 ? 2000 : 5000, Math.max(0, Date.parse(operationDeadline) - Date.now())), undefined, {signal: input.signal});
        continue;
      }
      op.state = "received"; attempt.outcome = "response";
      await save(); // Failed acknowledgement is C; never return output for use.
      resultOperations.set(result, op.id);
      return result;
    }
    throw new AskError("ASK_GENERATION_RECOVERY_EXHAUSTED", "The finite generation recovery allowance is exhausted.", 502);
  } finally { frame.active = false; }
}
