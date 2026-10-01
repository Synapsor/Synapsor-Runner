import { Buffer } from "node:buffer";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import type { ModelReadClarificationRequest, ModelReadClarificationDecision, ModelReadValueRequest, ModelReadValueContextDecision } from "./read-authoring-contract-types.js";
import { safeReadWorkloadDiagnostic, type ReadWorkloadDiagnostic } from "./read-workload-diagnostics.js";

type Digest = `sha256:${string}`;
export type ReadWorkloadAssistanceQuestion = {
  question: string;
  completion?: AuthoringQuestionCompletion;
} & (
  | { kind: "clarification"; request: ModelReadClarificationRequest; decision?: ModelReadClarificationDecision }
  | { kind: "value"; request: ModelReadValueRequest; decision?: ModelReadValueContextDecision }
  | { kind: "relationship"; request: ModelReadClarificationRequest; decision?: { state: "relationship_reviewed" } }
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
  stage: "waiting" | "decided";
  pending_question: ReadWorkloadAssistanceQuestion;
  state: {
    call_count: number; attempt: number; phase: ReadWorkloadDiagnostic["phase"];
    correction_used: boolean; relationship_reviews: number; relationship_review_limit: 0 | 3;
    clarified_targets: Array<ModelReadClarificationRequest & { answer: string }>;
    clarification_answers: string[];
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
};

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max;
const count = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const request = (v: unknown, value = false) => record(v) && exact(v, ["resource", "field", "category", "reason", "question", "answer"])
  && text(v.resource, 256) && (value ? text(v.field, 256) : v.field === undefined || text(v.field, 256))
  && (v.category === undefined || ["business_meaning", "relationship_support"].includes(v.category as string))
  && text(v.reason, 500) && text(v.question, 500);
const provided = (v: unknown) => record(v) && exact(v, ["state", "resource", "field", "values", "egressAcknowledged"])
  && v.state === "provided" && text(v.resource, 256) && text(v.field, 256) && v.egressAcknowledged === true
  && Array.isArray(v.values) && v.values.length > 0 && v.values.length <= 32 && v.values.every(x => text(x, 200))
  && new Set(v.values).size === v.values.length && JSON.stringify(v.values).length <= 4_000;

export class ReadWorkloadAssistancePausedError extends Error {
  readonly code = "READ_WORKLOAD_AUTHORING_PAUSED";
  constructor() { super("READ_WORKLOAD_AUTHORING_PAUSED: The assistance question remains pending. No decline, replacement generation or Read authority was inferred."); }
}

export function readWorkloadAssistanceCheckpoint(input: Omit<ReadWorkloadAssistanceCheckpoint, "schema_version" | "digest">): ReadWorkloadAssistanceCheckpoint {
  const body = { schema_version: "synapsor.read-workload-assistance-checkpoint.v1" as const, ...structuredClone(input) };
  return parseReadWorkloadAssistanceCheckpoint({ ...body, digest: canonicalJsonDigest(body) });
}

/** Bounded operator answer attributed to the canonical typed decision. This is
 * not provider consumption, Source acceptance or permission to query values. */
export function readWorkloadAssistanceDecisionAnswer(question: ReadWorkloadAssistanceQuestion): string {
  assertAssistanceQuestion(question, "decided");
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
  if (!record(value) || !exact(value, ["kind", "request", "question", "completion", "decision"])
    || !["clarification", "value", "relationship"].includes(value.kind as string)
    || !request(value.request, value.kind === "value") || !text(value.question, 500)
    || value.question !== (value.request as Record<string, unknown>).question
    || (stage === "waiting" ? value.decision !== undefined : !record(value.decision))) throw fail();
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
      : value.kind === "value" ? !(provided(d) || exact(d, ["state"]) && d.state === "without_values")
        : !exact(d, ["state"]) || d.state !== "relationship_reviewed") throw fail();
  }
}

/** Storage shape only. The producer also re-parses every retained target and
 * decision against its CURRENT catalog and compares exact canonical input. */
export function parseReadWorkloadAssistanceCheckpoint(value: unknown): ReadWorkloadAssistanceCheckpoint {
  const fail = () => new Error("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_INVALID: Preserve the pending Read assistance state; it is malformed or changed.");
  if (!record(value) || !exact(value, ["schema_version", "input_digest", "boundary_digest", "catalog_digest", "tool_digest", "stage", "pending_question", "state", "digest"])
    || value.schema_version !== "synapsor.read-workload-assistance-checkpoint.v1"
    || ![value.input_digest, value.boundary_digest, value.catalog_digest, value.tool_digest, value.digest].every(digest)
    || !["waiting", "decided"].includes(value.stage as string) || !record(value.state) || !record(value.pending_question)) throw fail();
  const q = value.pending_question, s = value.state;
  assertAssistanceQuestion(q, value.stage as "waiting" | "decided");
  const flags = ["correction_used", "clarification_from_invalid_naming", "clarification_resolved", "mechanical_clarification_resolved",
    "value_request_resolved", "repeated_assistance_request", "naming_evidence_correction_used"];
  if (!exact(s, ["call_count", "attempt", "phase", "relationship_reviews", "relationship_review_limit", "clarified_targets", "clarification_answers",
    ...flags, "resolved_mechanical_request", "naming_correction_workload", "approved_value_context", "diagnostics", "usage"])
    || !count(s.call_count, 11) || !count(s.attempt, 16) || !["initial", "correction", "follow-up"].includes(s.phase as string)
    || ![0, 3].includes(s.relationship_review_limit as number) || !count(s.relationship_reviews, s.relationship_review_limit as number)
    || flags.some(k => typeof s[k] !== "boolean") || !Array.isArray(s.clarified_targets) || s.clarified_targets.length > 4
    || s.clarified_targets.some(x => !request(x) || !text(x.answer, 1_000))
    || !Array.isArray(s.clarification_answers) || s.clarification_answers.length !== s.clarified_targets.length || s.clarification_answers.some(x => !text(x, 2_500))
    || s.resolved_mechanical_request !== undefined && !request(s.resolved_mechanical_request)
    || s.naming_correction_workload !== undefined && !digest(s.naming_correction_workload)
    || s.approved_value_context !== undefined && !provided(s.approved_value_context)
    || !Array.isArray(s.diagnostics) || s.diagnostics.length > 6) throw fail();
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
