import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { z } from "zod";
import { parseReadScopeRecord, type ReadScopeRecord } from "./read-structured-scope.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(value => value as `sha256:${string}`);
const completion = z.object({ operation_id: z.string().min(1).max(100), request_digest: digest,
  context_digest: digest, response_digest: digest }).strict();
const envelope = z.object({ mode: z.enum(["review", "missing_answer", "replacement_answer"]), record: z.unknown(), completion,
  requirement_id: z.string().trim().min(1).max(256).optional(),
  review_question_id: z.string().uuid().optional(),
  predecessor_id: z.string().uuid().optional() }).strict();
/** Native OperatorQuestion payload; no separate meaning store or acceptance bit. */
export type ReadScopeQuestionBinding = { mode: "review" | "missing_answer" | "replacement_answer"; record: ReadScopeRecord;
  completion: AuthoringQuestionCompletion; requirement_id?: string; review_question_id?: string; predecessor_id?: string };
export function parseReadScopeQuestionBinding(value: unknown): ReadScopeQuestionBinding {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) throw new Error("AUTHORING_QUESTION_INVALID: Malformed typed Read scope binding.");
  const record = parseReadScopeRecord(parsed.data.record);
  if (parsed.data.mode === "missing_answer"
    ? !record.proposal.requirements.some(r => r.id === parsed.data.requirement_id && r.disposition === "unresolved")
    : parsed.data.requirement_id !== undefined) {
    throw new Error("AUTHORING_QUESTION_INVALID: The scope question does not identify its missing requirement.");
  }
  if (parsed.data.mode === "replacement_answer" ? parsed.data.review_question_id === undefined : parsed.data.review_question_id !== undefined)
    throw new Error("AUTHORING_QUESTION_INVALID: A replacement answer must identify its existing reviewed proposal.");
  return { ...parsed.data, record };
}
/** The native generation owner records this exact proposal before any wait. */
export function readScopeConsumption(binding: ReadScopeQuestionBinding) {
  return { consumer: "read_scope" as const, kind: "scope_proposal" as const,
    material_digest: canonicalJsonDigest(binding.record) };
}
