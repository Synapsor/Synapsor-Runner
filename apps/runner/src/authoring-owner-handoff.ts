import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";

/** A host checkpoint for a question, not a business decision or permission.
 * Provider consumption, when present, is bound separately by the ordinary
 * generation ledger in the same coordinated resume write. */
export type AuthoringOwnerHandoff = {
  id: string;
  consumer: "planning" | "read_clarification" | "read_value_context" | "policy_clarification";
  scope_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  question: string;
  recorded_at: string;
  digest: `sha256:${string}`;
  completion?: AuthoringQuestionCompletion;
} & ({ state: "waiting" } | {
  state: "answered";
  answer: string;
  actor: "local_installation_operator";
  answered_at: string;
  answer_context_digest: `sha256:${string}`;
});

export function ownerHandoffCheckpoint(record: AuthoringOwnerHandoff) {
  return { digest: record.digest, consumer: record.consumer,
    ...(record.state === "waiting" ? { pending_question: { question: record.question,
      ...(record.completion ? { completion: record.completion } : {}) } } : {}) };
}

export function createOwnerHandoff(input: Pick<AuthoringOwnerHandoff,
  "consumer" | "scope_digest" | "context_digest" | "question" | "completion">): AuthoringOwnerHandoff {
  const body = { id: randomUUID(), consumer: input.consumer, scope_digest: input.scope_digest,
    context_digest: input.context_digest, question: input.question.trim(), recorded_at: new Date().toISOString(),
    ...(input.completion ? { completion: structuredClone(input.completion) } : {}) };
  const result = { ...body, digest: canonicalJsonDigest(body), state: "waiting" as const };
  parseOwnerHandoffs([result]);
  return result;
}

export function answerOwnerHandoff(record: AuthoringOwnerHandoff, answer: string,
  context: `sha256:${string}`): AuthoringOwnerHandoff {
  if (record.state !== "waiting") throw invalid();
  const result = { ...record, state: "answered" as const, answer: answer.trim(),
    actor: "local_installation_operator" as const, answered_at: new Date().toISOString(), answer_context_digest: context };
  parseOwnerHandoffs([result]);
  return result;
}

export function parseOwnerHandoffs(value: unknown): AuthoringOwnerHandoff[] {
  if (!Array.isArray(value) || value.length > 64) throw invalid();
  const ids = new Set<string>();
  let waiting = false;
  for (const record of value) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw invalid();
    const keys = ["id", "consumer", "scope_digest", "context_digest", "question", "recorded_at", "digest", "completion", "state",
      ...(record.state === "answered" ? ["answer", "actor", "answered_at", "answer_context_digest"] : [])];
    if (Object.keys(record).some(key => !keys.includes(key)) || typeof record.id !== "string" || record.id.length > 100
      || ids.has(record.id) || !["planning", "read_clarification", "read_value_context", "policy_clarification"].includes(record.consumer)
      || !digest(record.scope_digest) || !digest(record.context_digest) || !digest(record.digest)
      || typeof record.question !== "string" || !record.question.trim() || record.question.length > 4000
      || !date(record.recorded_at) || !["waiting", "answered"].includes(record.state) || waiting) throw invalid();
    ids.add(record.id);
    const { state, answer, actor, answered_at, answer_context_digest, digest: identity, ...body } = record;
    if (canonicalJsonDigest(body) !== identity) throw invalid();
    if (record.completion && (Object.keys(record.completion).some(key => !["operation_id", "request_digest", "context_digest", "response_digest"].includes(key))
      || typeof record.completion.operation_id !== "string" || !digest(record.completion.request_digest)
      || !digest(record.completion.context_digest) || !digest(record.completion.response_digest))) throw invalid();
    if (state === "waiting") waiting = true;
    else if (typeof answer !== "string" || !answer.trim() || answer.length > 4000 || actor !== "local_installation_operator"
      || !date(answered_at) || !digest(answer_context_digest)) throw invalid();
  }
  return structuredClone(value) as AuthoringOwnerHandoff[];
}
function digest(value: unknown): value is `sha256:${string}` { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function date(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function invalid(): Error { return new Error("BOUNDARY_AUTHORING_RESUME_INVALID: The saved owner-question handoff is invalid. Preserve the job for inspection."); }
