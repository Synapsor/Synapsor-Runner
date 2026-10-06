import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import type { ReadCurrentStatePrerequisiteSelection } from "./read-prerequisite.js";
import { parseReadPrerequisiteBusinessDecisions, type ReadPrerequisiteBusinessDecision, type ReadPrerequisiteDecision } from "./read-prerequisite-decisions.js";

type Digest = `sha256:${string}`;

/** Pending producer payloads are shared with the model adapter without importing that adapter. */
export type ModelReadPrerequisiteProposal = {
  candidate_id: Digest;
  selection: Omit<ReadCurrentStatePrerequisiteSelection, "semantic_consent">;
  source_description: string;
  positive_state_description: string;
  selection_digest: Digest;
};

export type ModelReadPrerequisiteClarification = { question: string; reason: string;
  /** Host-generated identity and question, not the model's claimed equivalence. */
  decision?: ReadPrerequisiteDecision;
  applicability?: "unanswered" | "changed";
};

export type ReadPrerequisiteCheckpointPending = ({ kind: "clarification"; request: ModelReadPrerequisiteClarification;
    decision?: { state: "answered"; answer: string } }
    | { kind: "semantic_confirmation"; proposal: ModelReadPrerequisiteProposal;
      decision?: { state: "confirmed"; operator_evidence: string } | { state: "revise"; instruction: string } })
    & { completion?: AuthoringQuestionCompletion };

export type ReadPrerequisiteCheckpoint = {
  schema_version: "synapsor.read-prerequisite-checkpoint.v1";
  input_digest: Digest; tool_digest: Digest;
  /** Exact approved inputs, before this producer's own confirmed additions. */
  seed: { approved_business_clarifications: Array<{ question: string; answer: string }>;
    approved_business_decisions: ReadPrerequisiteBusinessDecision[] };

  state: {
    correction_used: boolean; issue: string; new_questions: number;
    answers: Array<{ question: string; answer: string }>;
    confirmed_answers: Array<{ question: string; answer: string }>;
    saved_decisions: ReadPrerequisiteBusinessDecision[];
    questions: string[]; replayed_decisions: string[];
    questioned_proposal?: ModelReadPrerequisiteProposal;
    metrics: { business_questions: number; reused_business_answers: number; repeated_business_questions: number;
      renewed_business_questions: number; semantic_reviews: number };
  };
  digest: Digest;
} & ({ stage: "waiting" | "decided"; pending: ReadPrerequisiteCheckpointPending; dispatch_question?: never }
  | { stage: "dispatching"; dispatch_question: string; pending?: never });
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).every(k => allowed.includes(k) && x[k] !== undefined);
const hash = (x: unknown) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/u.test(x);
const text = (x: unknown, max: number) => typeof x === "string" && !!x.trim() && x.length <= max;
const count = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
const invalid = () => new Error("READ_PREREQUISITE_CHECKPOINT_INVALID: Preserve the malformed or changed private Read mapping for inspection.");
function proposal(x: unknown): boolean {
  return obj(x) && keys(x, ["candidate_id", "selection", "source_description", "positive_state_description", "selection_digest"])
    && hash(x.candidate_id) && hash(x.selection_digest) && obj(x.selection)
    && text(x.source_description, 1000) && text(x.positive_state_description, 1000);
}
export function readPrerequisiteCheckpoint(input: ReadPrerequisiteCheckpoint extends infer C ? C extends ReadPrerequisiteCheckpoint ? Omit<C, "schema_version" | "digest"> : never : never): ReadPrerequisiteCheckpoint {
  const body = { schema_version: "synapsor.read-prerequisite-checkpoint.v1" as const, ...structuredClone(input) };
  return parseReadPrerequisiteCheckpoint({ ...body, digest: canonicalJsonDigest(body) });
}
/** JSON storage is not consent or a transport acknowledgement. The producer
 * checks the exact current input/catalog and reparses every retained proposal. */
export function parseReadPrerequisiteCheckpoint(value: unknown): ReadPrerequisiteCheckpoint {
  if (!obj(value) || !keys(value, ["schema_version", "input_digest", "tool_digest", "stage", "seed", "pending", "dispatch_question", "state", "digest"])
    || value.schema_version !== "synapsor.read-prerequisite-checkpoint.v1"
    || ![value.input_digest, value.tool_digest, value.digest].every(hash)
    || !["waiting", "decided", "dispatching"].includes(String(value.stage)) || !obj(value.state) || (value.stage === "dispatching" ? value.pending !== undefined || !text(value.dispatch_question,64*1024) : !obj(value.pending) || value.dispatch_question!==undefined)) throw invalid();
  if (!obj(value.seed) || !keys(value.seed, ["approved_business_clarifications", "approved_business_decisions"])) throw invalid();
  const history = (x: unknown): x is Array<{ question: string; answer: string }> => Array.isArray(x) && x.length <= 16
    && Buffer.byteLength(JSON.stringify(x)) <= 64 * 1024
    && x.every(a => obj(a) && keys(a, ["question", "answer"]) && text(a.question, 4000) && text(a.answer, 8000));
  if (!history(value.seed.approved_business_clarifications)) throw invalid();
  parseReadPrerequisiteBusinessDecisions(value.seed.approved_business_decisions);
  const p = obj(value.pending) ? value.pending : {}, s = value.state;
  if(value.stage!=="dispatching") {
  if (!keys(p, p.kind === "clarification" ? ["kind", "request", "completion", "decision"] : ["kind", "proposal", "completion", "decision"])) throw invalid();
  if (p.kind === "clarification") {
    if (!obj(p.request) || !keys(p.request, ["question", "reason", "decision", "applicability"])
      || !text(p.request.question, 4000) || !text(p.request.reason, 500)
      || p.request.applicability !== undefined && !["unanswered", "changed"].includes(String(p.request.applicability))) throw invalid();
  } else if (p.kind !== "semantic_confirmation" || !proposal(p.proposal)) throw invalid();
  if (p.completion !== undefined) {
    const c = p.completion;
    if (!obj(c) || !keys(c, ["operation_id", "request_digest", "context_digest", "response_digest"])
      || typeof c.operation_id !== "string" || !/^[a-f0-9-]{36}$/u.test(c.operation_id)
      || ![c.request_digest, c.context_digest, c.response_digest].every(hash)) throw invalid();
  }
  if (value.stage === "waiting" ? p.decision !== undefined : !obj(p.decision)) throw invalid();
  if (p.decision !== undefined) {
    const d = p.decision;
    if (!obj(d) || (p.kind === "clarification"
      ? !keys(d, ["state", "answer"]) || d.state !== "answered" || !text(d.answer, 8000)
      : d.state === "confirmed" ? !keys(d, ["state", "operator_evidence"]) || !text(d.operator_evidence, 2000)
      : d.state !== "revise" || !keys(d, ["state", "instruction"]) || !text(d.instruction, 8000))) throw invalid();
  }
  }
  if (!keys(s, ["correction_used", "issue", "new_questions", "answers", "confirmed_answers", "saved_decisions", "questions", "replayed_decisions", "questioned_proposal", "metrics"])
    || typeof s.correction_used !== "boolean" || typeof s.issue !== "string" || s.issue.length > 4000
    || !count(s.new_questions) || (s.new_questions as number) > 3
    || !history(s.answers) || !history(s.confirmed_answers)
    || s.confirmed_answers.some(a => !(s.answers as Array<{ question: string; answer: string }>).some(b => a.question === b.question && a.answer === b.answer))
    || !Array.isArray(s.questions) || s.questions.length > 19 || s.questions.some(q => !text(q, 4000)) || new Set(s.questions).size !== s.questions.length
    || !Array.isArray(s.replayed_decisions) || s.replayed_decisions.some(d => !hash(d)) || new Set(s.replayed_decisions).size !== s.replayed_decisions.length
    || s.questioned_proposal !== undefined && !proposal(s.questioned_proposal)
    || !obj(s.metrics) || !keys(s.metrics, ["business_questions", "reused_business_answers", "repeated_business_questions", "renewed_business_questions", "semantic_reviews"])
    || ["business_questions", "reused_business_answers", "repeated_business_questions", "renewed_business_questions", "semantic_reviews"]
      .some(key => !count((s.metrics as Record<string, unknown>)[key])) || s.metrics.business_questions !== s.new_questions) throw invalid();
  if(value.stage!=="dispatching") {
  if (p.kind === "clarification") {
    const request = p.request as Record<string, unknown>;
    const key = obj(request.decision) ? request.decision.decision_id : (request.question as string).trim().toLowerCase();
    if ((s.new_questions as number) < 1 || !s.questions.includes(key)) throw invalid();
    if (value.stage === "decided") {
      const last = s.answers.at(-1), decision = p.decision as Record<string, unknown>;
      if (!obj(last) || last.question !== request.question || last.answer !== decision.answer) throw invalid();
    }
  } else if ((s.metrics.semantic_reviews as number) < 1) throw invalid();
  }
  parseReadPrerequisiteBusinessDecisions(s.saved_decisions);
  if(value.stage==="dispatching" && Buffer.byteLength(JSON.stringify(value))>64*1024)throw invalid();
  const { digest, ...body } = value;
  if (canonicalJsonDigest(body) !== digest) throw invalid();
  return structuredClone(value) as ReadPrerequisiteCheckpoint;
}
