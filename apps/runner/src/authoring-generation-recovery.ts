import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError, authoringTransportObservation, completedProviderContentError, type ProviderHttpInput, type ProviderHttpResult, type AuthoringTransportObservation, type AskAuthoringEpisodeBudget } from "./model-provider-transport.js";

type Digest = `sha256:${string}`;
/** A decision about future consumption, never a claim about the old outcome. */
export type AuthoringInterruptedDisposition = {
  id: string; operation_id: string; attempt_id: string; operation_digest: Digest;
  prior_context_digest: Digest; checkpoint_digest: Digest; state_digest: Digest;
  current_context_digest: Digest; root_operation_id: string;
  actor: "local_installation_operator"; reviewed_at: string;
  decision: "discard_unaccepted_output" | "stop_and_review_current";
  status: "permitted" | "admitted" | "local_review"; replacement_operation_id?: string;
  episode_id?: string;
};
export type AuthoringHostEpisode = {
  id: string; key_digest: Digest; conversational: boolean;
  /** Prospective controller origin; never backfilled onto historical owners. */
  context_digest?: Digest;
  iterations_used: number; tool_calls_used: number;
  correction_used: boolean; wording_correction_used: boolean;
  /** Existing Read representation correction, distinct from general repair. */
  naming_evidence_correction_used?: true;
};

export type AuthoringQuestionCompletion = {
  operation_id: string;
  request_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  response_digest: `sha256:${string}`;
};
export type AuthoringQuestionHandoff = {
  consumer: "action_rule_clarification" | "planning" | "read_clarification" | "read_value_context" | "read_revision_instruction" | "read_revision_clarification" | "read_revision_prerequisite" | "policy_clarification" | "input_policy" | "version_maintenance";
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
  episode_id?: string;
  recovery_of?: { disposition_id: string; root_operation_id: string };
  checkpoint_seen?: true;
  question_handoff?: AuthoringQuestionHandoff;
  /** Exact durable consumption of a non-question Action result. Minted only
   * from the live decoder sequence and committed with its owning Resume CAS. */
  action_checkpoint?: { consumer: "action_rule_components"; kind: "version_interpretation" | "compiled_draft";
    material_digest: `sha256:${string}`; response_digest: `sha256:${string}` };
  /** Consumption of this exact native Read adapter result, separate from human consent. */
  read_checkpoint?: { consumer: "read_revision"; kind: "private_prerequisite" | "prerequisite_mapping";
    material_digest: `sha256:${string}`; response_digest: `sha256:${string}`;
    decision?: { digest: `sha256:${string}`; actor: "local_installation_operator"; recorded_at: string } };
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
  interrupted_dispositions?: AuthoringInterruptedDisposition[];
  episodes?: AuthoringHostEpisode[];
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
  episode_id?: string;
  last_episode_id?: string;
  producer_corrections?: {correction_used: boolean; wording_correction_used: boolean; naming_evidence_correction_used?: true};
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
    "ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE", "ASK_GENERATION_INTERRUPTED_RECOVERY_UNAVAILABLE",
    "ASK_GENERATION_LEGACY_BUDGET_UNAVAILABLE"].includes(error.code));
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
  if (!s || typeof s !== "object" || !exactKeys(s,["version","policy","operations","interrupted_dispositions","episodes"]) || s.version !== 1 || !Array.isArray(s.operations) || s.operations.length > 4096) throw invalid();
  if (s.policy) {
    const p = s.policy;
    if (!exactKeys(p,["maximum_additional_attempts","duplicate_generation_charges","provider","model","destination_digest","actor","reviewed_at"]) || ![0,1,2].includes(p.maximum_additional_attempts) || typeof p.duplicate_generation_charges !== "boolean"
      || p.actor !== "local_installation_operator" || !date(p.reviewed_at) || !digest(p.destination_digest)
      || !["openai","openrouter","anthropic","openai_compatible"].includes(p.provider)
      || typeof p.model !== "string" || !p.model.length || p.model.length > 128) throw invalid();
  }
  const seen = new Set<string>();
  for (const op of s.operations) {
    if (!op || typeof op !== "object" || !exactKeys(op,["id","request_digest","context_digest","deadline","state","episode_id","recovery_of","checkpoint_seen","question_handoff","action_checkpoint","read_checkpoint","producer_input","manual_recovery","attempts"]) || !id(op.id) || seen.has(op.id) || !digest(op.request_digest) || !digest(op.context_digest) || !date(op.deadline)
      || !["in_flight","unsent","unknown","partial","received","handled","checkpointed","refused"].includes(op.state)
      || op.checkpoint_seen !== undefined && op.checkpoint_seen !== true
      || !Array.isArray(op.attempts) || !op.attempts.length || op.attempts.length > 3
      || op.episode_id !== undefined && !id(op.episode_id)
      || op.recovery_of !== undefined && (!op.recovery_of || !exactKeys(op.recovery_of,["disposition_id","root_operation_id"])
        || !id(op.recovery_of.disposition_id) || !id(op.recovery_of.root_operation_id))) throw invalid();
    if (op.action_checkpoint !== undefined) {
      const c = op.action_checkpoint;
      if (!c || typeof c !== "object" || Array.isArray(c)
        || !exactKeys(c, ["consumer", "kind", "material_digest", "response_digest"])
        || c.consumer !== "action_rule_components" || !["version_interpretation", "compiled_draft"].includes(c.kind)
        || !digest(c.material_digest) || !digest(c.response_digest)
        || op.state !== "checkpointed" || op.checkpoint_seen !== true || op.attempts.at(-1)?.outcome !== "response") throw invalid();
    }
    if (op.read_checkpoint !== undefined) {
      const c = op.read_checkpoint;
      if (!c || typeof c !== "object" || Array.isArray(c)
        || !exactKeys(c, ["consumer", "kind", "material_digest", "response_digest", "decision"])
        || c.consumer !== "read_revision" || !["private_prerequisite", "prerequisite_mapping"].includes(c.kind)
        || !digest(c.material_digest) || !digest(c.response_digest)
        || op.state !== "checkpointed" || op.checkpoint_seen !== true || op.attempts.at(-1)?.outcome !== "response") throw invalid();
    }
    if (op.read_checkpoint?.decision !== undefined) {
      const d = op.read_checkpoint.decision;
      if (op.read_checkpoint.kind !== "prerequisite_mapping" || !d || typeof d !== "object" || Array.isArray(d) || !exactKeys(d, ["digest", "actor", "recorded_at"])
        || !digest(d.digest) || d.actor !== "local_installation_operator" || !date(d.recorded_at)) throw invalid();
    }
    if (op.producer_input !== undefined) {
      const p = op.producer_input;
      if (!p || typeof p !== "object") throw invalid();
      if (p.consumer === "action_rule_components") {
        if (!exactKeys(p,["consumer","operator_message","program_resume_revision","logical_turn_id"])
          || typeof p.operator_message !== "string" || !p.operator_message.trim()
          || p.operator_message.length > 4_000 || p.program_resume_revision !== undefined && !digest(p.program_resume_revision)
          || p.logical_turn_id !== undefined && !id(p.logical_turn_id)) throw invalid();
      } else if (p.consumer === "authoring_turn") {
        if (!exactKeys(p,["consumer","episode_id"]) || !id(p.episode_id) || p.episode_id !== op.episode_id) throw invalid();
      } else if (p.consumer === "policy_coverage") {
        if (!exactKeys(p,["consumer","episode_id","context_digest","submission_number"])
          || !id(p.episode_id) || !digest(p.context_digest) || !Number.isSafeInteger(p.submission_number)
          || p.submission_number < 1 || p.submission_number > 3) throw invalid();
      } else throw invalid();
    }
    if (op.question_handoff !== undefined) {
      const h = op.question_handoff;
      if (!h || typeof h !== "object" || Array.isArray(h) || !exactKeys(h, ["consumer","question","answered","checkpoint_digest","question_digest","response_digest","recorded_at"])
        || !["action_rule_clarification", "planning", "read_clarification", "read_value_context", "read_revision_instruction", "read_revision_clarification", "read_revision_prerequisite", "policy_clarification", "input_policy", "version_maintenance"].includes(h.consumer) || typeof h.question !== "string" || !h.question.trim() || h.question.length > 20_000
        || canonicalJsonDigest(h.question) !== h.question_digest || !digest(h.checkpoint_digest) || !digest(h.question_digest)
        || !digest(h.response_digest) || !date(h.recorded_at) || op.attempts.at(-1)?.outcome !== "response" || op.state !== "checkpointed" || op.checkpoint_seen !== true) throw invalid();
      if (h.answered !== undefined && (!h.answered || typeof h.answered !== "object" || Array.isArray(h.answered) || !exactKeys(h.answered,["answer","actor","recorded_at","checkpoint_digest"])
        || typeof h.answered.answer !== "string" || !h.answered.answer.trim() || h.answered.answer.length > (h.consumer === "read_revision_prerequisite" ? 8_000 : 4_000)
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
  if (s.episodes !== undefined) {
    if (!Array.isArray(s.episodes) || s.episodes.length > 4096) throw invalid();
    for (const e of s.episodes) {
      if (!e || !exactKeys(e,["id","key_digest","context_digest","conversational","iterations_used","tool_calls_used","correction_used","wording_correction_used","naming_evidence_correction_used"])
        || !id(e.id) || seen.has(e.id) || !digest(e.key_digest) || e.context_digest !== undefined && !digest(e.context_digest) || typeof e.conversational !== "boolean"
        || !Number.isSafeInteger(e.iterations_used) || e.iterations_used < 0 || e.iterations_used > (e.conversational ? 12 : 6)
        || !Number.isSafeInteger(e.tool_calls_used) || e.tool_calls_used < 0 || e.tool_calls_used > (e.conversational ? 24 : 8)
        || typeof e.correction_used !== "boolean" || typeof e.wording_correction_used !== "boolean"
        || e.naming_evidence_correction_used !== undefined && e.naming_evidence_correction_used !== true) throw invalid();
      seen.add(e.id);
    }
  }
  for (const op of s.operations) if (op.episode_id && !s.episodes?.some(e => e.id === op.episode_id)) throw invalid();
  if (s.interrupted_dispositions !== undefined) {
    if (!Array.isArray(s.interrupted_dispositions) || s.interrupted_dispositions.length > 4096) throw invalid();
    const disposed = new Set<string>();
    for (const d of s.interrupted_dispositions) {
      const op = s.operations.find(o => o.id === d?.operation_id), replacement = s.operations.find(o => o.id === d?.replacement_operation_id);
      if (!d || !exactKeys(d,["id","operation_id","attempt_id","operation_digest","prior_context_digest","checkpoint_digest","state_digest",
        "current_context_digest","root_operation_id","actor","reviewed_at","decision","status","replacement_operation_id","episode_id"])
        || !id(d.id) || seen.has(d.id) || !op || disposed.has(op.id)
        || d.actor !== "local_installation_operator" || !date(d.reviewed_at)
        || !["permitted","admitted","local_review"].includes(d.status)
        || (d.status === "local_review" ? d.decision !== "stop_and_review_current" || d.replacement_operation_id !== undefined
          : d.decision !== "discard_unaccepted_output" || !id(d.replacement_operation_id) || d.replacement_operation_id === op.id)
        || ![d.operation_digest,d.prior_context_digest,d.checkpoint_digest,d.state_digest,d.current_context_digest].every(digest)
        || !authoringTransportOperationUnresolved(op) || canonicalJsonDigest(op) !== d.operation_digest || op.attempts.at(-1)!.id !== d.attempt_id
        || op.context_digest !== d.prior_context_digest || rootOperationId(op) !== d.root_operation_id
        || d.episode_id !== op.episode_id || d.status === "permitted" && replacement !== undefined
        || d.status === "admitted" && (!replacement || replacement.recovery_of?.disposition_id !== d.id
          || replacement.recovery_of.root_operation_id !== d.root_operation_id || replacement.episode_id !== d.episode_id)) throw invalid();
      seen.add(d.id); disposed.add(op.id);
    }
    if (s.interrupted_dispositions.filter(d => d.status === "permitted").length > 1) throw invalid();
  }
  for (const [index, op] of s.operations.entries()) if (op.recovery_of) {
    const d = s.interrupted_dispositions?.find(d => d.id === op.recovery_of!.disposition_id);
    const prior = d && s.operations.findIndex(o => o.id === d.operation_id);
    if (!d || d.status !== "admitted" || d.replacement_operation_id !== op.id || prior === undefined || prior < 0 || prior >= index
      || !s.operations.slice(0,index).some(o => o.id === op.recovery_of!.root_operation_id && !o.recovery_of)) throw invalid();
  }
  for (const op of s.operations) if (chainAttempts(s,rootOperationId(op)) > 3) throw invalid();
}

function rootOperationId(op: AuthoringTransportOperation): string { return op.recovery_of?.root_operation_id ?? op.id; }
function chainAttempts(s: AuthoringTransportState, root: string): number {
  return s.operations.filter(o => rootOperationId(o) === root).reduce((n,o) => n + o.attempts.length,0);
}
function disposedOperation(s: AuthoringTransportState, operationId: string): boolean {
  return Boolean(s.interrupted_dispositions?.some(d => d.operation_id === operationId));
}
export function authoringTransportOperationUnresolved(op: AuthoringTransportOperation, owned: ReadonlySet<string> = new Set()): boolean {
  return ["in_flight","unsent","unknown","partial"].includes(op.state)
    || !owned.has(op.id) && !["checkpointed","refused"].includes(op.state) || Boolean(op.manual_recovery?.failure_code);
}
export function unresolvedAuthoringTransportOperations(state: AuthoringTransportState, owned: ReadonlySet<string> = new Set()): AuthoringTransportOperation[] {
  validateAuthoringTransportState(state);
  return state.operations.filter(op => !disposedOperation(state,op.id) && authoringTransportOperationUnresolved(op,owned));
}
export function authoringInterruptedRecoveryNeeded(state: AuthoringTransportState | undefined): boolean {
  return Boolean(state && unresolvedAuthoringTransportOperations(state,storage.getStore()?.owned).length);
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
export async function authoringManualProducerInput<C extends NonNullable<ProviderHttpInput["authoringInput"]>["consumer"]>(consumer: C): Promise<Extract<NonNullable<ProviderHttpInput["authoringInput"]>, {consumer:C}> | undefined> {
  const host = storage.getStore()?.host;
  if (!host) return undefined;
  const state = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  validateAuthoringTransportState(state);
  const op = state.operations.find(item => item.manual_recovery?.status === "permitted" && !disposedOperation(state,item.id));
  if (!op?.producer_input) return undefined; // Never fabricate origin for historical records.
  if (op.producer_input.consumer !== consumer || await currentRecoveryContext(host) !== op.context_digest)
    throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  return structuredClone(op.producer_input) as Extract<NonNullable<ProviderHttpInput["authoringInput"]>, {consumer:C}>;
}
/** Exact origin of the explicitly selected unfinished producer. Historical
 * records without an origin cannot acquire one from a similar current target. */
export async function authoringInterruptedProducerInput<C extends NonNullable<ProviderHttpInput["authoringInput"]>["consumer"]>(consumer: C): Promise<Extract<NonNullable<ProviderHttpInput["authoringInput"]>, {consumer:C}> | undefined> {
  const host = storage.getStore()?.host;
  if (!host) return undefined;
  const state = structuredClone(host.read() ?? {version:1 as const,operations:[]});
  validateAuthoringTransportState(state);
  const disposition = state.interrupted_dispositions?.find(d => d.status === "permitted");
  if (!disposition) return authoringManualProducerInput(consumer);
  const op = state.operations.find(o => o.id === disposition.operation_id);
  if (!op?.producer_input) return interruptedRecoveryUnavailable("This historical step has no recorded producer origin. Inspect current saved work or start a separately reviewed job; no controller or allowance was invented.");
  if (op.producer_input.consumer !== consumer || await currentRecoveryContext(host) !== disposition.current_context_digest)
    throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  return structuredClone(op.producer_input) as Extract<NonNullable<ProviderHttpInput["authoringInput"]>, {consumer:C}>;
}
function manualRecoveryUnavailable(message: string): never {
  throw new AskError("ASK_GENERATION_MANUAL_RECOVERY_UNAVAILABLE", message, 409);
}
function manualRecoveryTarget(state: AuthoringTransportState): AuthoringTransportOperation {
  const unresolved = state.operations.filter(op => !disposedOperation(state,op.id) && ["in_flight","unsent","unknown","partial","received","handled"].includes(op.state));
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

export type AuthoringInterruptedRecoveryPreview = Omit<AuthoringInterruptedDisposition,
  "id" | "actor" | "reviewed_at" | "decision" | "status" | "replacement_operation_id"> & {
    remaining_attempts: number; unresolved_operation_count: number;
  };
function interruptedRecoveryUnavailable(message: string): never {
  throw new AskError("ASK_GENERATION_INTERRUPTED_RECOVERY_UNAVAILABLE",message,409);
}
/** Inspection only. The host owns business/currentness review and its write CAS. */
export async function prepareAuthoringInterruptedRecovery(checkpointDigest: Digest, currentContext?: Digest,
  operationId?: string): Promise<AuthoringInterruptedRecoveryPreview> {
  const frame = storage.getStore(), host = frame?.host;
  if (!host || frame!.active || !digest(checkpointDigest)) return interruptedRecoveryUnavailable("The saved job is unavailable or a generation is active. No disposition was recorded.");
  const state = structuredClone(host.read() ?? {version:1 as const,operations:[]});
  const targets = unresolvedAuthoringTransportOperations(state,frame!.owned);
  const op = operationId === undefined && targets.length === 1 ? targets[0] : targets.find(o => o.id === operationId);
  if (!op || state.interrupted_dispositions?.some(d => d.status === "permitted"))
    return interruptedRecoveryUnavailable("Select one exact unresolved step for local inspection. Other unfinished work remains retained; an existing continuation permission cannot be replaced.");
  const context = await currentRecoveryContext(host);
  if (currentContext !== undefined && context !== currentContext) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  return {operation_id:op.id,attempt_id:op.attempts.at(-1)!.id,operation_digest:canonicalJsonDigest(op),
    prior_context_digest:op.context_digest,checkpoint_digest:checkpointDigest,state_digest:canonicalJsonDigest(state),
    current_context_digest:context,root_operation_id:rootOperationId(op),remaining_attempts:3-chainAttempts(state,rootOperationId(op)),
    unresolved_operation_count:targets.length,
    ...(op.episode_id ? {episode_id:op.episode_id} : {})};
}
/** Record non-completion and one linked continuation; no HTTP, result adoption
 * or callback replay. The caller obtains explicit default-No consent first. */
export async function permitAuthoringInterruptedRecovery(preview: AuthoringInterruptedRecoveryPreview,
  options: {mode?: "linked_generation" | "local_review"} = {}): Promise<void> {
  const frame = storage.getStore(), host = frame?.host;
  if (!host || frame!.active) return interruptedRecoveryUnavailable("Another generation is active or the saved job is unavailable.");
  frame!.active = true;
  try {
    const state = structuredClone(host.read() ?? {version:1 as const,operations:[]});
    const targets = unresolvedAuthoringTransportOperations(state,frame!.owned), op = targets.find(o => o.id === preview.operation_id);
    if (!op || targets.length !== preview.unresolved_operation_count || !digest(preview.checkpoint_digest) || canonicalJsonDigest(state) !== preview.state_digest
      || canonicalJsonDigest(op) !== preview.operation_digest
      || op.attempts.at(-1)!.id !== preview.attempt_id || rootOperationId(op) !== preview.root_operation_id
      || op.context_digest !== preview.prior_context_digest || op.episode_id !== preview.episode_id
      || await currentRecoveryContext(host) !== preview.current_context_digest) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
    if (state.interrupted_dispositions?.some(d => d.status === "permitted")
      || options.mode !== "local_review" && targets.length !== 1
      || options.mode !== "local_review" && chainAttempts(state,rootOperationId(op)) >= 3)
      return interruptedRecoveryUnavailable("Other unresolved steps require local inspection, or the finite chain or existing permission cannot be renewed.");
    const {remaining_attempts:_remaining,unresolved_operation_count:_count,...record} = structuredClone(preview);
    state.interrupted_dispositions = [...state.interrupted_dispositions ?? [],{...record,id:randomUUID(),
      actor:"local_installation_operator",reviewed_at:new Date().toISOString(),
      ...(options.mode === "local_review" ? {status:"local_review" as const,decision:"stop_and_review_current" as const}
        : {status:"permitted" as const,decision:"discard_unaccepted_output" as const,replacement_operation_id:randomUUID()})}];
    await writeRecoveryState(host,state);
  } finally { frame!.active = false; }
}

/** Run at the existing Resume CAS as well as the transport writer. A disposition
 * permanently freezes the old operation, including all uncertainty evidence. */
export function assertAuthoringTransportAdvance(previous: AuthoringTransportState | undefined, next: AuthoringTransportState): void {
  validateAuthoringTransportState(next);
  if (!previous) return;
  validateAuthoringTransportState(previous);
  if (next.operations.length < previous.operations.length) throw invalid();
  for (const [index,old] of previous.operations.entries()) {
    const current = next.operations[index]!;
    if (current.id !== old.id || current.request_digest !== old.request_digest || current.context_digest !== old.context_digest
      || current.deadline !== old.deadline || current.episode_id !== old.episode_id
      || canonicalJsonDigest(current.recovery_of ?? null) !== canonicalJsonDigest(old.recovery_of ?? null)
      || disposedOperation(previous,old.id) && canonicalJsonDigest(current) !== canonicalJsonDigest(old)) throw invalid();
    if (current.attempts.length < old.attempts.length) throw invalid();
    for (const [i,a] of old.attempts.entries()) if (current.attempts[i]?.id !== a.id
      || current.attempts[i]?.started_at !== a.started_at
      || a.outcome !== "in_flight" && canonicalJsonDigest(current.attempts[i]) !== canonicalJsonDigest(a)) throw invalid();
  }
  const prior = previous.interrupted_dispositions ?? [], after = next.interrupted_dispositions ?? [];
  if (after.length < prior.length || after.length > prior.length + 1) throw invalid();
  for (const [i,old] of prior.entries()) {
    const current = after[i]; if (!current) throw invalid();
    const expected = old.status === "permitted" && current.status === "admitted" ? {...old,status:"admitted"} : old;
    if (canonicalJsonDigest(current) !== canonicalJsonDigest(expected)) throw invalid();
  }
  if (after.length > prior.length && after.at(-1)!.state_digest !== canonicalJsonDigest(previous)) throw invalid();
  const episodes = previous.episodes ?? [], nextEpisodes = next.episodes ?? [];
  if (nextEpisodes.length < episodes.length) throw invalid();
  for (const [i,e] of episodes.entries()) {
    const n = nextEpisodes[i];
    if (!n || n.id !== e.id || n.key_digest !== e.key_digest || n.context_digest !== e.context_digest || n.conversational !== e.conversational
      || n.iterations_used < e.iterations_used || n.tool_calls_used < e.tool_calls_used
      || e.correction_used && !n.correction_used || e.wording_correction_used && !n.wording_correction_used
      || e.naming_evidence_correction_used && !n.naming_evidence_correction_used) throw invalid();
  }
}

export type AuthoringHostEpisodeBudget = AskAuthoringEpisodeBudget & {
  ownerId: string; reserveCorrection(): Promise<boolean>; reserveWordingCorrection(): Promise<boolean>; release(): void;
};
type ProducerCorrectionKind = "semantic" | "wording" | "read_naming";
/** A new producer must not adopt the preceding producer's ephemeral owner.
 * This does not touch a saved linked permission, history or any counter. */
export function beginAuthoringProducerInvocation(): void {
  const frame = storage.getStore(); if (frame) frame.last_episode_id = undefined;
}
export function authoringInterruptedProducerCorrections(): {correction_used: boolean; wording_correction_used: boolean; naming_evidence_correction_used: boolean} {
  const frame = storage.getStore(), state = frame?.host?.read();
  if (state) validateAuthoringTransportState(state);
  const linked = state?.interrupted_dispositions?.find(d => d.status === "permitted");
  const manual = state?.operations.find(o => o.manual_recovery?.status === "permitted" && !disposedOperation(state,o.id));
  const owner = linked?.episode_id ?? manual?.episode_id;
  const saved = owner && state?.episodes?.find(e => e.id === owner);
  return {correction_used:Boolean(saved && saved.correction_used || frame?.producer_corrections?.correction_used),
    wording_correction_used:Boolean(saved && saved.wording_correction_used || frame?.producer_corrections?.wording_correction_used),
    naming_evidence_correction_used:Boolean(saved && saved.naming_evidence_correction_used || frame?.producer_corrections?.naming_evidence_correction_used)};
}
/** Reserve on the actual completed producer episode, before its correction
 * request. Explicit domain controllers continue to use their own reservation. */
export async function reserveAuthoringProducerCorrection(kind: ProducerCorrectionKind): Promise<boolean> {
  const frame = storage.getStore(), host = frame?.host;
  if (!host?.available()) return true; // Existing non-persisted producer behavior.
  if (frame!.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE","An authoring generation is still active.",409);
  const state = structuredClone(host.read()!); validateAuthoringTransportState(state);
  const owner = frame!.last_episode_id, episode = state.episodes?.find(e => e.id === owner);
  const op = [...state.operations].reverse().find(o => o.episode_id === owner && frame!.owned.has(o.id)
    && o.attempts.at(-1)?.outcome === "response" && !disposedOperation(state,o.id));
  if (!episode || !op) return false; // Never invent a historical budget owner.
  if (await currentRecoveryContext(host) !== op.context_digest) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  const flag = kind === "semantic" ? "correction_used" : kind === "wording" ? "wording_correction_used" : "naming_evidence_correction_used";
  if (episode[flag]) return false;
  episode[flag] = true; if (kind === "read_naming") episode.correction_used = true;
  await writeRecoveryState(host,state); return true;
}
/** Carry only this existing correction into its next ordinary episode. Each
 * ordinary Read follow-up still retains its independent normal6/8 allowance. */
export async function withAuthoringProducerCorrection<T>(kind: ProducerCorrectionKind, run: () => Promise<T>): Promise<T> {
  const frame = storage.getStore(), previous = frame?.producer_corrections;
  if (frame) frame.producer_corrections = {correction_used:kind !== "wording" || previous?.correction_used === true,
    wording_correction_used:kind === "wording" || previous?.wording_correction_used === true,
    ...(kind === "read_naming" || previous?.naming_evidence_correction_used ? {naming_evidence_correction_used:true} : {})};
  try { return await run(); } finally { if (frame) frame.producer_corrections = previous; }
}
/** An explicit domain controller must not inherit an enclosing fallback pool. */
export function suspendAuthoringHostEpisodeBudget(): () => void {
  const frame = storage.getStore(), previous = frame?.episode_id;
  if (frame) frame.episode_id = undefined;
  return () => { if (frame && frame.episode_id === undefined) frame.episode_id = previous; };
}
/** Fallback for an existing producer with no explicit budget adapter. A normal
 * successful invocation can start another episode; an interrupted continuation
 * must inherit its recorded owner and corrections, even if wording changed. */
export async function createAuthoringHostEpisodeBudget(input: {keyDigest: Digest; conversational: boolean}): Promise<AuthoringHostEpisodeBudget | undefined> {
  const admitted = authoringGenerationAdmissionState();
  if (!admitted?.host.available()) return undefined;
  const {frame,host,initial,interrupted,manual} = admitted;
  if (!digest(input.keyDigest)) throw invalid();
  const current = await currentRecoveryContext(host);
  if (!interrupted && initial.interrupted_dispositions?.some(d => d.status === "local_review" && d.current_context_digest === current))
    return interruptedRecoveryUnavailable("The same unfinished step remains under local review. Its disposition did not grant another provider episode.");
  if (interrupted && !interrupted.episode_id) throw new AskError("ASK_GENERATION_LEGACY_BUDGET_UNAVAILABLE",
    "This historical step has no durable fallback-budget owner. Inspect or continue through supported local review; no new zeroed provider allowance was created.",409);
  const previousOwner = frame.episode_id;
  const continuationOwner = interrupted?.episode_id ?? manual?.episode_id;
  let episode = continuationOwner ? initial.episodes?.find(e => e.id === continuationOwner) : undefined;
  if (!continuationOwner) {
    const orphaned = (initial.episodes ?? []).filter(e => e.key_digest === input.keyDigest
      && !initial.operations.some(op => op.episode_id === e.id));
    if (orphaned.some(e => e.context_digest === undefined && (e.iterations_used > 0 || e.tool_calls_used > 0 || e.correction_used || e.wording_correction_used || e.naming_evidence_correction_used)))
      throw new AskError("ASK_GENERATION_LEGACY_BUDGET_UNAVAILABLE", "An unfinished historical controller has no provable current target. No zeroed allowance was created.",409);
    const currentOwners = orphaned.filter(e => e.context_digest === current);
    if (currentOwners.length > 1) throw new AskError("ASK_GENERATION_LEGACY_BUDGET_UNAVAILABLE", "More than one unfinished controller matches this step. Preserve its limits for supported local inspection.",409);
    episode = currentOwners[0];
  }
  if (episode && episode.conversational !== input.conversational) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  if (!episode) {
    episode = {id:randomUUID(),key_digest:input.keyDigest,context_digest:current,conversational:input.conversational,
      iterations_used:0,tool_calls_used:0,correction_used:frame.producer_corrections?.correction_used === true,
      wording_correction_used:frame.producer_corrections?.wording_correction_used === true,
      ...(frame.producer_corrections?.naming_evidence_correction_used ? {naming_evidence_correction_used:true} : {})};
    await writeRecoveryState(host,{...initial,episodes:[...initial.episodes ?? [],episode]});
  }
  const owner = episode.id; frame.episode_id = owner;
  const change = async (run: (e: AuthoringHostEpisode) => boolean) => {
    if (frame.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE","An authoring generation is still active.",409);
    const state = structuredClone(host.read()!); validateAuthoringTransportState(state);
    const e = state.episodes?.find(e => e.id === owner); if (!e) throw invalid();
    if (!run(e)) return false;
    await currentRecoveryContext(host); await writeRecoveryState(host,state); return true;
  };
  return {ownerId:owner,
    admitIteration:async()=>{ if (!await change(e=>{if(e.iterations_used >= (e.conversational?12:6))return false;e.iterations_used++;return true;}))
      throw new AskError("ASK_TOOL_BUDGET_EXCEEDED","The saved authoring episode is exhausted; recovery cannot renew its counters.",422); },
    reserveToolBatch:async n=>{ if (!Number.isSafeInteger(n)||n<1||n>4) throw invalid();
      if (!await change(e=>{if(e.tool_calls_used+n>(e.conversational?24:8))return false;e.tool_calls_used+=n;return true;}))
        throw new AskError("ASK_TOOL_BUDGET_EXCEEDED","The saved authoring callback allowance is exhausted.",422); },
    reserveCorrection:()=>change(e=>{if(e.correction_used)return false;e.correction_used=true;return true;}),
    reserveWordingCorrection:()=>change(e=>{if(e.wording_correction_used)return false;e.wording_correction_used=true;return true;}),
    release:()=>{if(frame.episode_id===owner)frame.episode_id=previousOwner;frame.last_episode_id=owner;},
  };
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
  for (const [index, op] of copy.operations.entries()) if (index >= questionBoundary && frame?.owned.has(op.id) && !disposedOperation(copy,op.id)) {
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
  if (!last || !op || disposedOperation(host.read()!,op.id) || !frame!.owned.has(op.id) || op.state !== "handled" && op.state !== "checkpointed") {
    throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The completed question has no current local consumer association.", 409);
  }
  const completion = {operation_id: op.id, request_digest: op.request_digest, context_digest: op.context_digest,
    response_digest: canonicalJsonDigest(last.body)};
  const completed = results.map(result => {
    const id = resultOperations.get(result), sibling = host.read()?.operations.find(item => item.id === id);
    if (!sibling || disposedOperation(host.read()!,sibling.id) || !frame!.owned.has(sibling.id) || !["handled", "checkpointed", "refused"].includes(sibling.state)
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
      if (!op || disposedOperation(frame.host.read()!,op.id) || !frame.owned.has(ref.id) || op.request_digest !== ref.request_digest || op.context_digest !== ref.context_digest
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

/** Prepare only this live, actually consumed Action sequence for the SAME
 * currentness/CAS save as its semantic material. Saved JSON cannot mint the
 * ephemeral decoder association, and this function performs no independent write. */
export function authoringActionCheckpoint(state: AuthoringTransportState,
  completion: AuthoringQuestionCompletion,
  record: Omit<NonNullable<AuthoringTransportOperation["action_checkpoint"]>, "response_digest">): AuthoringTransportState {
  const frame = storage.getStore();
  const known = authoringQuestionSequenceCompletion([completion]);
  const refs = frame?.completedTurns.get(canonicalJsonDigest(completion));
  if (!known || !refs?.length || canonicalJsonDigest(known) !== canonicalJsonDigest(completion)) {
    throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The Action result has no current consumed sequence. No historical operation was acknowledged.", 409);
  }
  const copy = structuredClone(state), last = copy.operations.find(op => op.id === completion.operation_id);
  if (!last || last.request_digest !== completion.request_digest || last.context_digest !== completion.context_digest
    || !["handled", "checkpointed"].includes(last.state) || last.attempts.at(-1)?.outcome !== "response") throw invalid();
  const checkpoint = { ...record, response_digest: completion.response_digest };
  if (last.action_checkpoint && canonicalJsonDigest(last.action_checkpoint) !== canonicalJsonDigest(checkpoint)) throw invalid();
  for (const ref of refs) {
    const op = copy.operations.find(item => item.id === ref.id);
    if (!op || disposedOperation(copy,op.id) || !frame?.owned.has(op.id) || op.request_digest !== ref.request_digest || op.context_digest !== ref.context_digest
      || op.attempts.at(-1)?.id !== ref.attempt_id || op.attempts.at(-1)?.outcome !== "response"
      || !["handled", "checkpointed", "refused"].includes(op.state)) throw invalid();
    if (op.state === "handled") { op.state = "checkpointed"; op.checkpoint_seen = true; }
  }
  last.action_checkpoint = checkpoint;
  last.state = "checkpointed"; last.checkpoint_seen = true;
  validateAuthoringTransportState(copy);
  return copy;
}

/** Same live decoder/CAS contract as the existing component adapter. No
 * question is invented for an internal request or an exact mapping review. */
export function authoringReadCheckpoint(state: AuthoringTransportState | undefined,
  completion: AuthoringQuestionCompletion,
  record: Omit<NonNullable<AuthoringTransportOperation["read_checkpoint"]>, "response_digest" | "decision">): AuthoringTransportState {
  const known = authoringQuestionSequenceCompletion([completion]), frame = storage.getStore();
  const refs = frame?.completedTurns.get(canonicalJsonDigest(completion));
  if (!state || !known || !refs?.length || canonicalJsonDigest(known) !== canonicalJsonDigest(completion))
    throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The Read result has no current completed consumer association.", 409);
  const copy = structuredClone(state), last = copy.operations.find(op => op.id === completion.operation_id);
  if (!last || last.request_digest !== completion.request_digest || last.context_digest !== completion.context_digest
    || !["handled", "checkpointed"].includes(last.state) || last.attempts.at(-1)?.outcome !== "response") throw invalid();
  const checkpoint = { ...record, response_digest: completion.response_digest };
  if (last.read_checkpoint && canonicalJsonDigest(last.read_checkpoint) !== canonicalJsonDigest(checkpoint)) throw invalid();
  for (const ref of refs) {
    const op = copy.operations.find(item => item.id === ref.id);
    if (!op || disposedOperation(copy,op.id) || !frame?.owned.has(op.id) || op.request_digest !== ref.request_digest || op.context_digest !== ref.context_digest
      || op.attempts.at(-1)?.id !== ref.attempt_id || op.attempts.at(-1)?.outcome !== "response"
      || !["handled", "checkpointed", "refused"].includes(op.state)) throw invalid();
    if (op.state === "handled") { op.state = "checkpointed"; op.checkpoint_seen = true; }
  }
  last.read_checkpoint = checkpoint; last.state = "checkpointed"; last.checkpoint_seen = true;
  validateAuthoringTransportState(copy); return copy;
}
export function assertAuthoringReadCheckpoint(state: AuthoringTransportState | undefined,
  completion: AuthoringQuestionCompletion,
  record: Omit<NonNullable<AuthoringTransportOperation["read_checkpoint"]>, "response_digest" | "decision">): void {
  const op = state?.operations.find(item => item.id === completion.operation_id);
  if (!op || op.state !== "checkpointed" || op.checkpoint_seen !== true || op.attempts.at(-1)?.outcome !== "response"
    || op.request_digest !== completion.request_digest || op.context_digest !== completion.context_digest
    || !op.read_checkpoint
    || op.read_checkpoint.consumer !== record.consumer || op.read_checkpoint.kind !== record.kind
    || op.read_checkpoint.material_digest !== record.material_digest || op.read_checkpoint.response_digest !== completion.response_digest)
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: The Read adapter has no exact committed native result. Preserve the saved job for inspection.");
}

/** Called under the owning human review/currentness/CAS save. This associates
 * the explicit decision with its previously consumed exact proposal; it neither
 * mints a completion nor permits another call. Reopen can only reuse its match. */
export function authoringReadDecisionCheckpoint(state: AuthoringTransportState | undefined,
  completion: AuthoringQuestionCompletion, material: unknown, decision: unknown): AuthoringTransportState {
  assertAuthoringReadCheckpoint(state, completion, { consumer: "read_revision", kind: "prerequisite_mapping",
    material_digest: canonicalJsonDigest(material) });
  const copy = structuredClone(state!), receipt = copy.operations.find(op => op.id === completion.operation_id)!.read_checkpoint!;
  const digest = canonicalJsonDigest(decision);
  if (receipt.decision && receipt.decision.digest !== digest) throw invalid();
  receipt.decision ??= { digest, actor: "local_installation_operator", recorded_at: new Date().toISOString() };
  validateAuthoringTransportState(copy); return copy;
}
export function assertAuthoringReadDecision(state: AuthoringTransportState | undefined,
  completion: AuthoringQuestionCompletion, material: unknown, decision: unknown): void {
  assertAuthoringReadCheckpoint(state, completion, { consumer: "read_revision", kind: "prerequisite_mapping",
    material_digest: canonicalJsonDigest(material) });
  if (state!.operations.find(op => op.id === completion.operation_id)!.read_checkpoint!.decision?.digest !== canonicalJsonDigest(decision))
    throw new Error("BOUNDARY_AUTHORING_RESUME_INVALID: The private mapping has no exact saved operator decision.");
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
  if (!op || disposedOperation(copy,op.id) || !["handled", "checkpointed"].includes(op.state) || op.request_digest !== completion.request_digest
    || op.context_digest !== completion.context_digest || op.attempts.at(-1)?.outcome !== "response") throw invalid();
  // The final question may follow successfully handled tools in the SAME turn.
  // Bind their known consumption to this atomic checkpoint, not to a later
  // generic save that could also promote unrelated/historical handled output.
  for (const ref of frame.completedTurns.get(canonicalJsonDigest(completion)) ?? []) {
    const sibling = copy.operations.find(item => item.id === ref.id);
    if (!sibling || disposedOperation(copy,sibling.id) || !frame.owned.has(sibling.id) || sibling.request_digest !== ref.request_digest
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
  try { assertAuthoringTransportAdvance(host.read(),state); await host.write(state); }
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

/** Read-only admission fence, shared with saved logical-turn reservation.
 * It neither acknowledges a result nor grants a retry; recovery checks it again
 * before its request-specific currentness, CAS and upstream admission. */
function authoringGenerationAdmissionState() {
  const frame = storage.getStore(), host = frame?.host;
  if (!frame || !host) return undefined;
  if (frame.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE", "Another authoring generation is still active.", 409);
  const initial = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  validateAuthoringTransportState(initial);
  const stoppedReplacement = initial.operations.find(op => op.manual_recovery?.failure_code && !disposedOperation(initial,op.id));
  if (stoppedReplacement) throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
    `${stoppedReplacement.manual_recovery!.failure_code}: The permitted replacement was refused. Its finite permission is used; the original unknown attempt and saved progress remain recorded. Resume cannot open another generation for this pending step.`, 409);
  const manual = initial.operations.find(op => op.manual_recovery?.status === "permitted" && !disposedOperation(initial,op.id));
  const interrupted = initial.interrupted_dispositions?.find(d => d.status === "permitted");
  if (unresolvedAuthoringTransportOperations(initial,frame.owned).some(op => op.id !== manual?.id)) {
    throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The saved job contains an unfinished generation or unacknowledged local result. Inspect/reconcile its exact saved progress; restart cannot reset the attempt allowance.", 409);
  }
  return {frame, host, initial, manual, interrupted};
}

export function assertAuthoringGenerationAdmission(): void {
  authoringGenerationAdmissionState();
}

/** One generation, never a tool/producer/save retry. The HTTP owner alone mints
 * A/B evidence. Missing evidence cannot turn a dependency/guard error into retry. */
export async function recoverAuthoringGeneration(input: ProviderHttpInput,
  request: (input: ProviderHttpInput) => Promise<ProviderHttpResult>,
  admitProducerIteration?: () => Promise<void>): Promise<ProviderHttpResult> {
  const admitted = authoringGenerationAdmissionState();
  if (!admitted) {
    await admitProducerIteration?.();
    try { return await request(input); }
    catch (e) { throw transportStop(authoringTransportObservation(e), e); }
  }
  const {frame, host, initial, manual, interrupted} = admitted;
  if (!host.available()) {
    if (manual || interrupted) return manualRecoveryUnavailable("The saved generation boundary is not current and available. No replacement request was sent.");
    await admitProducerIteration?.();
    try { return await request(input); }
    catch (e) { throw transportStop(authoringTransportObservation(e), e); }
  }
  if (!manual && initial.operations.length >= 4096) throw new AskError("ASK_GENERATION_HISTORY_LIMIT", "The saved generation history reached its local record bound. Preserve and inspect it before continuing.", 409);
  const context = await currentRecoveryContext(host);
  if (!interrupted && initial.interrupted_dispositions?.some(d => d.status === "local_review" && d.current_context_digest === context))
    return interruptedRecoveryUnavailable("The same unfinished step remains under local review. No generation permission was granted by its disposition.");
  if (interrupted && context !== interrupted.current_context_digest) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  if (interrupted) {
    const origin = initial.operations.find(o => o.id === interrupted.operation_id)?.producer_input;
    if (origin && canonicalJsonDigest(origin) !== canonicalJsonDigest(input.authoringInput ?? null))
      throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  }
  if (interrupted?.episode_id && frame.episode_id !== interrupted.episode_id) throw new AskError("ASK_GENERATION_LEGACY_BUDGET_UNAVAILABLE",
    "The linked request must use its original saved episode owner. No provider allowance was renewed.",409);
  const body = structuredClone(input.body), requestDigest = canonicalJsonDigest({body, endpoint: input.endpoint.href, stream: input.stream?.format ?? null});
  if (manual && (manual.context_digest !== context || manual.request_digest !== requestDigest || !pureLocalGeneration(input)
    || manual.attempts.at(-1)!.no_response_boundary?.destination_digest !== canonicalJsonDigest(input.endpoint.origin)
    || manual.attempts.at(-1)!.no_response_boundary?.model !== body.model
    || canonicalJsonDigest(manual.producer_input ?? null) !== canonicalJsonDigest(input.authoringInput ?? null))) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  // A certain local refusal must not consume the original producer allowance.
  // Once its reservation is durable, later drift or lost acknowledgement stays charged.
  if (admitProducerIteration) {
    await admitProducerIteration();
    if (await currentRecoveryContext(host) !== context) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
  }
  const op: AuthoringTransportOperation = manual ?? {id: interrupted?.replacement_operation_id ?? randomUUID(), request_digest: requestDigest, context_digest: context,
    deadline: new Date(Date.now() + (input.timeoutMs ?? 30_000)).toISOString(), state: "in_flight", attempts: [],
    ...(frame.episode_id ? {episode_id:frame.episode_id} : {}),
    ...(interrupted ? {recovery_of:{disposition_id:interrupted.id,root_operation_id:interrupted.root_operation_id}} : {}),
    ...(input.authoringInput ? {producer_input: structuredClone(input.authoringInput)} : {})};
  // Explicit replacement has its own finite request deadline. Never extend or
  // rewrite the original operation's expired deadline or failed attempt.
  const operationDeadline = manual ? new Date(Date.now() + (input.timeoutMs ?? 30_000)).toISOString() : op.deadline;
  const policy = initial.policy;
  const allowed = !manual && host.allowRetries?.() !== false && policy && policy.model === body.model && policy.destination_digest === canonicalJsonDigest(input.endpoint.origin)
    ? policy.maximum_additional_attempts : 0;
  if (frame.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE", "Another authoring generation is still active.", 409);
  frame.active = true; frame.owned.add(op.id);
  let priorB = initial.operations.filter(old => rootOperationId(old) === rootOperationId(op))
    .reduce((count,old) => count + old.attempts.filter(attempt => attempt.outcome === "B").length,0);
  try {
    for (let ordinal = 0; ordinal <= allowed; ordinal++) {
      const currentState = host.read() ?? initial;
      if (chainAttempts(currentState,rootOperationId(op)) >= 3) throw new AskError("ASK_GENERATION_RECOVERY_EXHAUSTED",
        "The original three-attempt chain is exhausted; linked requests cannot reset it.",502);
      input.signal.throwIfAborted();
      if (await currentRecoveryContext(host) !== context) throw new AskError("ASK_GENERATION_CONTEXT_CHANGED", "The saved source, permissions or parent changed. This generation will not be retargeted.", 409);
      let remaining = Date.parse(operationDeadline) - Date.now();
      if (remaining <= 0) throw new AskError("ASK_GENERATION_DEADLINE", "The original generation deadline expired. Saved progress is retained.", 504);
      const attempt = {id: randomUUID(), started_at: new Date().toISOString(), outcome: "in_flight" as AuthoringTransportOperation["attempts"][number]["outcome"]};
      op.attempts.push(attempt); op.state = "in_flight";
      if (manual) Object.assign(op.manual_recovery!, {status: "admitted", replacement_attempt_id: attempt.id, attempt_deadline: operationDeadline});
      const save = async () => {
        const s = structuredClone(host.read() ?? initial), index = s.operations.findIndex(x => x.id === op.id);
        if (disposedOperation(s,op.id)) throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
          "An operator disposition stopped consumption of this old operation. Its late result cannot write or be acknowledged.",409);
        if (index < 0) s.operations.push(structuredClone(op)); else s.operations[index] = structuredClone(op);
        if (interrupted) {
          const d = s.interrupted_dispositions?.find(d=>d.id===interrupted.id);
          if (!d || d.replacement_operation_id !== op.id) throw invalid();
          d.status = "admitted";
        }
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
        if (await currentRecoveryContext(host) !== context) throw currentnessFailure("BOUNDARY_AUTHORING_RESUME_CHANGED");
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
