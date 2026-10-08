import { parseOperatorClarificationGateState, type OperatorClarificationGateState } from "./authoring-operator-presentation.js";
import { normalizeReadMeaningAttempts, type ReadMeaningAttempt } from "./read-meaning-evidence.js";
import { Buffer } from "node:buffer";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import type { ModelReadClarificationRequest, ModelReadClarificationDecision, ModelReadValueRequest, ModelReadValueContextDecision } from "./read-authoring-contract-types.js";
import { safeReadWorkloadDiagnostic, type ReadWorkloadDiagnostic } from "./read-workload-diagnostics.js";
import { parseReadScopeRecord, type ReadScopeRecord } from "./read-structured-scope.js";

type Digest = `sha256:${string}`;
export type ReadScopeAnswerReference = { question_id: string; revision: number; answer_id: string };
export type ReadScopeAssistanceRequest = { scope: ReadScopeRecord; requirement_digest: string; question: string };
/** Host-only review of one received response. Indices identify immutable
 * response events, not merely repeated answer text. Neither shape is a model tool. */
export type ReadClarificationReplacement = {
  previous_index: number; previous_digest: Digest; context_digest: Digest;
  proposed_answer?: string; confirmed?: true;
};
export type ReadReviewedClarificationReplacement = {
  previous_index: number; next_index: number; previous_digest: Digest; next_digest: Digest;
  context_digest: Digest; actor: "local_installation_operator";
};
export type ReadWorkloadAssistanceQuestion = {
  question: string;
  completion?: AuthoringQuestionCompletion;
} & (
  | { kind: "clarification"; request: ModelReadClarificationRequest; decision?: ModelReadClarificationDecision; replacement?: ReadClarificationReplacement }
  | { kind: "value"; request: ModelReadValueRequest; decision?: ModelReadValueContextDecision }
  | { kind: "relationship"; request: ModelReadClarificationRequest; decision?: { state: "relationship_reviewed" } }
  | { kind: "scope"; request: ReadScopeAssistanceRequest;
      decision?: { state: "answered"; answer_reference: ReadScopeAnswerReference } }
);

/** State of the real bounded producer at an assistance boundary. It carries no
 * failed submission, model claims of authority or independent review verdict.
 * Main owns the coordinated Source/currentness/CAS and generation handoff. */
export type ReadWorkloadAssistanceCheckpoint = {
  schema_version: "synapsor.read-workload-assistance-checkpoint.v1";
  input_digest: Digest;
  boundary_digest: Digest;
  catalog_digest: Digest;
  tool_digest: Digest;
  state: {
    /** Immutable invocation identity; native answer/review bookkeeping is separate. */
    scope_producer_binding?: Digest;
    /** Original wording-only input; never an operator answer or completion. */
    wording?: OperatorClarificationGateState;
    call_count: number; attempt: number; phase: ReadWorkloadDiagnostic["phase"];
    correction_used: boolean; relationship_reviews: number; relationship_review_limit: 0 | 3;
    clarified_targets: Array<ModelReadClarificationRequest & { answer: string }>;
    clarification_answers: string[];
    /** Native captured-answer identities, not interpreted meanings or grants. */
    scope_answers?: Array<{ request: ReadScopeAssistanceRequest; answer_reference: ReadScopeAnswerReference }>;
    /** Operator-origin corrections to an actual completed grouped review. */
    scope_replacements?: Array<{ review_question_id: string; answer_reference: ReadScopeAnswerReference }>;
    /** The original response list is append-only. Only these operator-reviewed
     * edges select a later current interpretation; history is never removed. */
    reviewed_replacements?: ReadReviewedClarificationReplacement[];
    /** Attributed nonanswers remain history, not resolved meaning. */
    unresolved_answers?: ReadMeaningAttempt[];
    clarification_from_invalid_naming: boolean; clarification_resolved: boolean;
    mechanical_clarification_resolved: boolean; value_request_resolved: boolean;
    repeated_assistance_request: boolean; naming_evidence_correction_used: boolean;
    resolved_mechanical_request?: ModelReadClarificationRequest;
    naming_correction_workload?: Digest;
    approved_value_context?: Extract<ModelReadValueContextDecision, { state: "provided" }>;
    diagnostics: ReadWorkloadDiagnostic[];
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
  digest: Digest;
} & ({ stage: "waiting" | "decided"; pending_question: ReadWorkloadAssistanceQuestion; dispatch_question?: never }
  | { stage: "dispatching"; dispatch_question: string; pending_question?: never;
      previous_question?: { stage: "waiting" | "decided"; pending_question: ReadWorkloadAssistanceQuestion } });

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max;
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const request = (v: unknown, value = false) => record(v) && exact(v, ["resource", "field", "category", "reason", "question", "answer", "reason_binding"])
  && text(v.resource, 256) && (value ? text(v.field, 256) : v.field === undefined || text(v.field, 256))
  && (v.category === undefined || ["business_meaning", "relationship_support"].includes(v.category as string))
  && text(v.reason, 500) && text(v.question, 500)
  && (v.reason_binding === undefined || !value && v.field === undefined && v.category !== "relationship_support"
    && record(v.reason_binding) && exact(v.reason_binding, ["kind", "alternatives", "digest"])
    && v.reason_binding.kind === "requested_read_scope" && digest(v.reason_binding.digest)
    && Array.isArray(v.reason_binding.alternatives) && v.reason_binding.alternatives.length > 0
    && v.reason_binding.alternatives.every(id => text(id, 256))
    && new Set(v.reason_binding.alternatives).size === v.reason_binding.alternatives.length
    && v.reason_binding.alternatives.includes(v.resource));
const provided = (v: unknown) => record(v) && exact(v, ["state", "resource", "field", "values", "egressAcknowledged"])
  && v.state === "provided" && text(v.resource, 256) && text(v.field, 256) && v.egressAcknowledged === true
  && Array.isArray(v.values) && v.values.length > 0 && v.values.length <= 32 && v.values.every(x => text(x, 200))
  && new Set(v.values).size === v.values.length && JSON.stringify(v.values).length <= 4_000;

export class ReadWorkloadAssistancePausedError extends Error {
  readonly code = "READ_WORKLOAD_AUTHORING_PAUSED";
  constructor(detail = "The assistance question remains pending. No decline, replacement generation or Read authority was inferred.") { super(`READ_WORKLOAD_AUTHORING_PAUSED: ${detail}`); }
}

export function readWorkloadAssistanceCheckpoint(input: ReadWorkloadAssistanceCheckpoint extends infer C ? C extends ReadWorkloadAssistanceCheckpoint ? Omit<C, "schema_version" | "digest"> : never : never): ReadWorkloadAssistanceCheckpoint {
  const body = { schema_version: "synapsor.read-workload-assistance-checkpoint.v1" as const, ...structuredClone(input) };
  return parseReadWorkloadAssistanceCheckpoint({ ...body, digest: canonicalJsonDigest(body) });
}

/** Bounded operator answer attributed to the canonical typed decision. This is
 * not provider consumption, Source acceptance or permission to query values. */
export function readWorkloadAssistanceDecisionAnswer(question: ReadWorkloadAssistanceQuestion): string {
  assertAssistanceQuestion(question, "decided");
  if (question.kind === "scope") throw new Error("READ_SCOPE_NATIVE_ANSWER_REQUIRED: Resolve the captured native answer reference; no operator words may be synthesized from a checkpoint.");
  if (question.kind === "clarification") {
    return question.decision!.state === "answered"
      ? question.decision!.answer : "Declined the exact Read clarification.";
  }
  if (question.kind === "value") {
    return question.decision!.state === "provided"
      ? JSON.stringify(question.decision!.values) : "Declined the requested Read value context.";
  }
  return "Confirmed the exact generated Read relationship review.";
}

function assertAssistanceQuestion(value: unknown, stage: "waiting" | "decided"): void {
  const fail = () => new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: Preserve the pending Read assistance state; it is malformed or changed.");
  if (!record(value) || !exact(value, ["kind", "request", "question", "completion", "decision", "replacement"])
    || !["clarification", "value", "relationship", "scope"].includes(value.kind as string)
    || !(value.kind === "scope" ? validScopeRequest(value.request) : request(value.request, value.kind === "value")) || !text(value.question, 500)
    || value.question !== (value.request as Record<string, unknown>).question
    || (stage === "waiting" ? value.decision !== undefined : !record(value.decision))) throw fail();
  if (value.replacement !== undefined) {
    const r = value.replacement;
    if (value.kind !== "clarification" || !record(r)
      || !exact(r, ["previous_index", "previous_digest", "context_digest", "proposed_answer", "confirmed"])
      || !count(r.previous_index, 3) || !digest(r.previous_digest) || !digest(r.context_digest)
      || r.proposed_answer !== undefined && !text(r.proposed_answer, 1_000)
      || r.confirmed !== undefined && r.confirmed !== true
      || stage === "waiting" && r.confirmed !== undefined
      || stage === "decided" && record(value.decision) && value.decision.state === "answered"
        && (r.confirmed !== true || r.proposed_answer !== value.decision.answer)
      || record(value.decision) && value.decision.state === "declined" && (r.confirmed !== undefined || r.proposed_answer !== undefined)) throw fail();
  }
  if (value.completion !== undefined) {
    const c = value.completion;
    if (!record(c) || !exact(c, ["operation_id", "request_digest", "context_digest", "response_digest"])
      || typeof c.operation_id !== "string" || !/^[a-f0-9-]{36}$/u.test(c.operation_id)
      || ![c.request_digest, c.context_digest, c.response_digest].every(digest)) throw fail();
  }
  if (value.decision !== undefined) {
    const d = value.decision as Record<string, unknown>;
    if (value.kind === "clarification" ? !exact(d, ["state", "answer"]) || !["answered", "declined"].includes(d.state as string)
      || (d.state === "answered" ? !text(d.answer, 1_000) : d.answer !== undefined)
      : value.kind === "scope" ? !exact(d, ["state", "answer_reference"]) || d.state !== "answered" || !validScopeAnswerReference(d.answer_reference)
      : value.kind === "value" ? !(provided(d) || exact(d, ["state"]) && d.state === "without_values")
        : !exact(d, ["state"]) || d.state !== "relationship_reviewed") throw fail();
  }
}

function validScopeAnswerReference(value: unknown): value is ReadScopeAnswerReference {
  return record(value) && exact(value, ["question_id", "revision", "answer_id"])
    && text(value.question_id, 256) && text(value.answer_id, 256) && count(value.revision, Number.MAX_SAFE_INTEGER) && (value.revision as number) > 0;
}
function validScopeRequest(value: unknown): value is ReadScopeAssistanceRequest {
  if (!record(value) || !exact(value, ["scope", "requirement_digest", "question"]) || !digest(value.requirement_digest) || !text(value.question, 500)) return false;
  try {
    const scope = parseReadScopeRecord(value.scope);
    const bound = scope.requirement_bindings.find(binding => binding.digest === value.requirement_digest);
    return !!bound && scope.proposal.requirements.some(requirement => requirement.id === bound.id && requirement.disposition === "unresolved");
  } catch { return false; }
}

/** Storage shape only. The producer also re-parses every retained target and
 * decision against its CURRENT catalog and compares exact canonical input. */
export function parseReadWorkloadAssistanceCheckpoint(value: unknown): ReadWorkloadAssistanceCheckpoint {
  const fail = () => new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: Preserve the pending Read assistance state; it is malformed or changed.");
  if (!record(value) || !exact(value, ["schema_version", "input_digest", "boundary_digest", "catalog_digest", "tool_digest", "stage", "pending_question", "dispatch_question", "previous_question", "state", "digest"])
    || value.schema_version !== "synapsor.read-workload-assistance-checkpoint.v1"
    || ![value.input_digest, value.boundary_digest, value.catalog_digest, value.tool_digest, value.digest].every(digest)
    || !["waiting", "decided", "dispatching"].includes(value.stage as string) || !record(value.state) || (value.stage === "dispatching" ? value.pending_question !== undefined || !text(value.dispatch_question, 64 * 1024) : !record(value.pending_question) || value.dispatch_question !== undefined)) throw fail();
  if (value.previous_question !== undefined) {
    const prior = value.previous_question;
    if (value.stage !== "dispatching" || !record(prior) || !exact(prior, ["stage", "pending_question"])
      || !["waiting", "decided"].includes(prior.stage as string)) throw fail();
    assertAssistanceQuestion(prior.pending_question, prior.stage as "waiting" | "decided");
  }
  const q = record(value.pending_question) ? value.pending_question : {}, s = value.state;
  if (value.stage !== "dispatching") assertAssistanceQuestion(q, value.stage as "waiting" | "decided");
  const flags = ["correction_used", "clarification_from_invalid_naming", "clarification_resolved", "mechanical_clarification_resolved",
    "value_request_resolved", "repeated_assistance_request", "naming_evidence_correction_used"];
  if (!exact(s, ["scope_producer_binding", "call_count", "attempt", "phase", "relationship_reviews", "relationship_review_limit", "clarified_targets", "clarification_answers", "scope_answers", "scope_replacements", "unresolved_answers", "reviewed_replacements",
    ...flags, "wording", "resolved_mechanical_request", "naming_correction_workload", "approved_value_context", "diagnostics", "usage"])
    || !count(s.call_count, 11) || !count(s.attempt, 16) || !["initial", "correction", "follow-up"].includes(s.phase as string)
    || ![0, 3].includes(s.relationship_review_limit as number) || !count(s.relationship_reviews, s.relationship_review_limit as number)
    || flags.some(k => typeof s[k] !== "boolean") || !Array.isArray(s.clarified_targets) || s.clarified_targets.length > 4
    || s.clarified_targets.some(x => !request(x) || !text(x.answer, 1_000))
    || !Array.isArray(s.clarification_answers) || s.clarification_answers.length !== s.clarified_targets.length || s.clarification_answers.some(x => !text(x, 2_500))
    || s.resolved_mechanical_request !== undefined && !request(s.resolved_mechanical_request)
    || s.naming_correction_workload !== undefined && !digest(s.naming_correction_workload)
    || s.approved_value_context !== undefined && !provided(s.approved_value_context)
    || !Array.isArray(s.diagnostics) || s.diagnostics.length > 6) throw fail();
  if (s.wording !== undefined) {
    try { if (parseOperatorClarificationGateState(s.wording).stage !== "read") throw new Error("wrong wording stage"); }
    catch { throw fail(); }
  }
  if (s.unresolved_answers !== undefined) {
    const attempts = normalizeReadMeaningAttempts(s.unresolved_answers);
    if (attempts.length + s.clarified_targets.length > 4) throw fail();
  }
  if (s.scope_answers !== undefined) {
    if (!Array.isArray(s.scope_answers) || s.scope_answers.length + s.clarified_targets.length + ((s.unresolved_answers as unknown[] | undefined)?.length ?? 0) > 4
      || s.scope_answers.some(answer => !record(answer) || !exact(answer, ["request", "answer_reference"])
        || !validScopeRequest(answer.request) || !validScopeAnswerReference(answer.answer_reference))) throw fail();
    const identities = s.scope_answers.map(answer => canonicalJsonDigest(answer.answer_reference));
    if (new Set(identities).size !== identities.length) throw fail();
  }
  if (s.scope_producer_binding !== undefined && !digest(s.scope_producer_binding)) throw fail();
  if (s.scope_replacements !== undefined) {
    if (!Array.isArray(s.scope_replacements)
      || s.scope_replacements.length + ((s.scope_answers as unknown[] | undefined)?.length ?? 0)
        + s.clarified_targets.length + ((s.unresolved_answers as unknown[] | undefined)?.length ?? 0) > 4
      || s.scope_replacements.some(answer => !record(answer) || !exact(answer, ["review_question_id", "answer_reference"])
        || !text(answer.review_question_id, 100) || !validScopeAnswerReference(answer.answer_reference))) throw fail();
    const identities = s.scope_replacements.map(answer => canonicalJsonDigest(answer.answer_reference));
    if (new Set(identities).size !== identities.length) throw fail();
  }
  if (s.reviewed_replacements !== undefined) {
    if (!Array.isArray(s.reviewed_replacements) || s.reviewed_replacements.length > 3) throw fail();
    for (const r of s.reviewed_replacements) {
      if (!record(r) || !exact(r, ["previous_index", "next_index", "previous_digest", "next_digest", "context_digest", "actor"])
        || !count(r.previous_index, 3) || !count(r.next_index, 3) || (r.previous_index as number) >= (r.next_index as number)
        || ![r.previous_digest, r.next_digest, r.context_digest].every(digest) || r.actor !== "local_installation_operator") throw fail();
    }
  }
  const pendingReplacement = record(q) ? q.replacement : undefined;
  if (record(pendingReplacement) && pendingReplacement.proposed_answer !== undefined
    && s.clarified_targets.length + ((s.unresolved_answers as unknown[] | undefined)?.length ?? 0) >= 4) throw fail();
  for (const d of s.diagnostics) if (!record(d) || !exact(d, ["attempt", "phase", "category", "code", "reasons"])
    || !count(d.attempt, 16) || !["initial", "correction", "follow-up"].includes(d.phase as string)
    || !["required_tool", "provider_response", "provider_request", "validation"].includes(d.category as string)
    || !text(d.code, 80) || !Array.isArray(d.reasons) || d.reasons.length > 6 || d.reasons.some(x => typeof x !== "string" || x.length > 700)
    || canonicalJsonDigest(safeReadWorkloadDiagnostic(d as unknown as ReadWorkloadDiagnostic)) !== canonicalJsonDigest(d)) throw fail();
  if (s.usage !== undefined && (!record(s.usage) || !exact(s.usage, ["input_tokens", "output_tokens", "total_tokens"])
    || Object.values(s.usage).some(v => !count(v, 1_000_000_000)))) throw fail();
  const { digest: hash, ...body } = value;
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 || canonicalJsonDigest(body) !== hash) throw fail();
  return structuredClone(value) as ReadWorkloadAssistanceCheckpoint;
}
