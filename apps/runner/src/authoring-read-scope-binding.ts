import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { z } from "zod";
import { parseReadScopeRecord, type ReadScopeRecord } from "./read-structured-scope.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import { operatorSubmissionOriginSchema } from "./authoring-operator-submission-origin.js";
import { normalizeReadWorkloadSet, readWorkloadSetDigest, type ReadWorkloadSet } from "./read-workload-assist.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform(value => value as `sha256:${string}`);
const completion = z.object({ operation_id: z.string().min(1).max(100), request_digest: digest,
  context_digest: digest, response_digest: digest }).strict();
const envelope = z.object({ mode: z.enum(["review", "missing_answer", "replacement_answer"]), record: z.unknown(), completion,
  requirement_id: z.string().trim().min(1).max(256).optional(),
  review_question_id: z.string().uuid().optional(),
  predecessor_id: z.string().uuid().optional() }).strict();
const operatorEnvelope = envelope.omit({completion:true}).extend({version:z.literal(2),mode:z.literal("review"),origin:operatorSubmissionOriginSchema,
  workload:z.unknown(),analysis:z.object({analysis_id:z.string().regex(/^rw_[a-f0-9]{32}$/u),analysis_digest:digest,workload_digest:digest}).strict(),
}).strict();
/** Native OperatorQuestion payload; no separate meaning store or acceptance bit. */
export type ModelReadScopeQuestionBinding = { mode: "review" | "missing_answer" | "replacement_answer"; record: ReadScopeRecord;
  completion: AuthoringQuestionCompletion; requirement_id?: string; review_question_id?: string; predecessor_id?: string };
export type OperatorReadScopeQuestionBindingV2 = Omit<z.infer<typeof operatorEnvelope>,"record"|"workload"> & {
  record:ReadScopeRecord;workload:ReadWorkloadSet;completion?:never;
};
export type ReadScopeQuestionBinding = ModelReadScopeQuestionBinding | OperatorReadScopeQuestionBindingV2;
export function parseReadScopeQuestionBinding(value: unknown): ReadScopeQuestionBinding {
  const parsed = z.union([envelope,operatorEnvelope]).safeParse(value);
  if (!parsed.success) throw new Error("AUTHORING_QUESTION_INVALID: Malformed typed Read scope binding.");
  const record = parseReadScopeRecord(parsed.data.record);
  if (parsed.data.mode === "missing_answer"
    ? !record.proposal.requirements.some(r => r.id === parsed.data.requirement_id && r.disposition === "unresolved")
    : parsed.data.requirement_id !== undefined) {
    throw new Error("AUTHORING_QUESTION_INVALID: The scope question does not identify its missing requirement.");
  }
  if (parsed.data.mode === "replacement_answer" ? parsed.data.review_question_id === undefined : parsed.data.review_question_id !== undefined)
    throw new Error("AUTHORING_QUESTION_INVALID: A replacement answer must identify its existing reviewed proposal.");
  if ("version" in parsed.data) {
    const raw=parsed.data,workload=normalizeReadWorkloadSet(raw.workload);
    if(canonicalJsonDigest(workload)!==canonicalJsonDigest(raw.workload)||workload.source.kind!=="operator_exact_plan"
      ||Object.keys(workload.source).length!==1||canonicalJsonDigest(raw)!==canonicalJsonDigest(value)
      ||record.proposal.applicability!=="read_requested"||!record.analysis_digest
      ||raw.analysis.analysis_id!==`rw_${raw.analysis.analysis_digest.slice(7,39)}`
      ||raw.analysis.workload_digest!==readWorkloadSetDigest(workload)
      ||raw.origin.action_baseline_digest!==null)
      throw new Error("AUTHORING_QUESTION_INVALID: Retain the exact explicit operator workload and immutable analysis reference; no model or no-Read analysis was inferred.");
    return {...raw,record,workload};
  }
  return { ...parsed.data, record };
}
export function readScopeModelCompletion(binding:ReadScopeQuestionBinding):AuthoringQuestionCompletion {
  if("version" in binding)throw new Error("AUTHORING_QUESTION_INVALID: An operator submission has no model completion.");
  return binding.completion;
}
/** The native generation owner records this exact proposal before any wait. */
export function readScopeConsumption(binding: ReadScopeQuestionBinding) {
  readScopeModelCompletion(binding);
  return { consumer: "read_scope" as const, kind: "scope_proposal" as const,
    material_digest: canonicalJsonDigest(binding.record) };
}
