import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import { policyTextSnapshot, policyTextLines, type PolicyTextSnapshot, type PolicySourceSession } from "./authoring-policy-source.js";
import { parseOperatorQuestions, type OperatorQuestion } from "./authoring-operator-question.js";
import { type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { parseReadWorkloadAssistanceCheckpoint, type ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import type { ReadWorkloadView } from "./read-workloads.js";
import type { ExactReadRequestBinding } from "./boundary-job-read-requests.js";
import type { BoundaryAuthoringResumeRead } from "./boundary-authoring-resume.js";
import { resolveNativeReadScope } from "./authoring-read-scope-question.js";

type Digest = `sha256:${string}`;
export type CurrentReadEvidenceRecords = {
  source?: PolicySourceSession;
  questions: readonly OperatorQuestion[];
  handoffs: readonly AuthoringOwnerHandoff[];
  history?: ReadWorkloadAssistanceCheckpoint;
  /** The current episode may be empty while an earlier accepted mapping has
   * useful evidence. Keep both native records; neither replaces the other. */
  checkpoint?: ReadWorkloadAssistanceCheckpoint;
  workloads: readonly ReadWorkloadView[];
  boundary: ExplorationBoundaryDraft;
  /** Structured scope uses the same derived owner, with native lineage rather
   * than the legacy statement/definition recognizer. */
  scope?: Omit<Parameters<typeof resolveNativeReadScope>[0], "questions" | "handoffs">;
};
export type CurrentStructuredReadEvidence = Parameters<typeof resolveNativeReadScope>[0];
export type ReadScopeReplacementOwner = Pick<CurrentStructuredReadEvidence, "questions" | "handoffs" | "generation" | "question_id" | "analysis">
  & { read: BoundaryAuthoringResumeRead };
/** Derive a continuation only from the exact native saved mapping and its real
 * consumed review. A dispatch history supplies spent counters, never replay. */
export function readScopeReplacementContinuation(input: ReadScopeReplacementOwner,
  current: Pick<CurrentStructuredReadEvidence, "expectedBinding" | "references" | "catalog">) {
  const resolved = resolveNativeReadScope({ ...input, ...current });
  const question = resolved.question;
  if (input.read.scope_question_id !== input.question_id || question.id !== input.question_id
    || question.read_scope?.mode !== "review" || question.read_scope.record.proposal.applicability !== "read_requested"
    || !question.disposition || question.confirmation || resolved.status === "stale" || !input.analysis
    || question.read_scope.record.analysis_digest !== canonicalJsonDigest(input.analysis) || !input.read.assistance_history)
    throw new Error("READ_SCOPE_REPLACEMENT_STALE: Reopen the exact declined mapped Read proposal with its saved producer history.");
  const history = parseReadWorkloadAssistanceCheckpoint(input.read.assistance_history);
  if (history.stage !== "dispatching" || !history.state.call_count || !history.state.attempt)
    throw new Error("READ_SCOPE_REPLACEMENT_HISTORY_REQUIRED: No completed Read dispatch history can be resumed for this proposal.");
  return { question, history };
}
export function currentStructuredReadEvidence(records: CurrentStructuredReadEvidence) {
  return resolveNativeReadScope(records);
}
export type ReadScopeHostContextInput = {
  request: { id: string; text: string };
  /** Already admitted by the protected Source consent owner. */
  source?: { session_id: string; snapshot: PolicyTextSnapshot };
  catalog: CurrentStructuredReadEvidence["catalog"] & { digest: Digest };
  binding: Pick<CurrentStructuredReadEvidence["expectedBinding"], "meaning_digest" | "applicability_digest" | "operation_digest">;
  records?: Pick<CurrentStructuredReadEvidence, "questions" | "handoffs" | "generation">;
  answerQuestionIds?: readonly string[];
  native?: Pick<CurrentStructuredReadEvidence, "question_id" | "analysis">;
};
/** Pure production inventory projection. Text remains provenance, not interpreted
 * scope; Source consent and coherent native loading remain protected host ports. */
export function projectReadScopeHostContext(input: ReadScopeHostContextInput) {
  const fail = (message: string): never => { throw new Error(`READ_SCOPE_CONTEXT_INVALID: ${message}`); };
  if (!input.request.id.trim() || input.request.id.length > 256 || !input.request.text.trim() || input.request.text.length > 4000)
    fail("The exact original request must fit the supported reference limit; it was not shortened.");
  const references: CurrentStructuredReadEvidence["references"][number][] = [{ kind: "request", id: input.request.id,
    digest: canonicalJsonDigest(input.request.text), text: input.request.text }];
  let sourceDigest: Digest = canonicalJsonDigest(null);
  if (input.source) {
    const { session_id, snapshot } = input.source;
    if (!session_id.trim() || session_id.length > 256) fail("The Source session identity is invalid.");
    const actual = policyTextSnapshot(Buffer.from(snapshot.text, "utf8"), snapshot.name, snapshot.version);
    if (actual.digest !== snapshot.digest || actual.bytes !== snapshot.bytes || actual.lines !== snapshot.lines)
      fail("The exact Source snapshot text, digest or numbering changed.");
    sourceDigest = actual.digest as Digest;
    const lines = policyTextLines(snapshot.text);
    let start = 0;
    while (start < lines.length) {
      let end = start, text = lines[start]!;
      if (text.length > 4000) fail("A Source line exceeds the supported reference limit; no text was truncated.");
      while (end + 1 < lines.length && text.length + 1 + lines[end + 1]!.length <= 4000) text += "\n" + lines[++end]!;
      if (text.trim()) references.push({ kind: "source", id: `source:${snapshot.version}:${start + 1}-${end + 1}`,
        digest: sourceDigest, source_id: session_id, start_line: start + 1, end_line: end + 1, text });
      start = end + 1;
    }
  }
  const records = input.records ?? { questions: [], handoffs: [] };
  const questions = parseOperatorQuestions(records.questions, records.handoffs, records.generation);
  const selected = input.answerQuestionIds ?? [];
  if (new Set(selected).size !== selected.length) fail("Duplicate acknowledged answer identity.");
  for (const id of selected) {
    const q = questions.find(q => q.id === id);
    if (!q) return fail("The acknowledged question is absent.");
    if (!["missing_answer", "replacement_answer"].includes(q.read_scope?.mode ?? "") || !q.raw_answer?.text.trim() || q.disposition
      || questions.some(next => next.read_scope?.predecessor_id === q.id)) fail("The acknowledged answer is absent, replaced or disposed.");
    if (q.raw_answer!.text.length > 4000) fail("The acknowledged answer exceeds the reference limit; it was not shortened.");
    references.push({ kind: "answer", id: `answer:${q.id}:${q.revision}:${q.raw_answer!.id}`,
      digest: canonicalJsonDigest(q.raw_answer), question_id: q.id, question_revision: q.revision,
      answer_id: q.raw_answer!.id, text: q.raw_answer!.text });
  }
  if (references.length > 1024 || new Set(references.map(ref => ref.id)).size !== references.length)
    fail("The exact reference inventory exceeds its bound or contains colliding identities.");
  const binding = { ...input.binding, request_digest: canonicalJsonDigest(input.request.text),
    source_digest: sourceDigest, catalog_digest: input.catalog.digest };
  const context = { binding, references, catalog: { resources: input.catalog.resources, relationships: input.catalog.relationships, ...(input.catalog.subject_scopes ? { subject_scopes: input.catalog.subject_scopes } : {}) },
    ...(input.native ? { native: { ...records, ...input.native } } : {}) };
  return structuredClone(context);
}

/** Revalidate the actual native lineage on each call, but bind only the scope
 * evidence it establishes. The producer's unrelated generation bookkeeping is
 * not a change to the operator's confirmed scope. Nothing is stored here. */
export function currentReadScopeContextDigest(input: {
  binding: CurrentStructuredReadEvidence["expectedBinding"];
  references: CurrentStructuredReadEvidence["references"];
  catalog: CurrentStructuredReadEvidence["catalog"];
  native?: Pick<CurrentStructuredReadEvidence, "questions" | "handoffs" | "generation" | "question_id" | "analysis">;
  reusable?: Pick<CurrentStructuredReadEvidence, "questions" | "handoffs" | "generation" | "question_id" | "analysis">;
  resumable?: Pick<CurrentStructuredReadEvidence, "questions" | "handoffs" | "generation" | "question_id" | "analysis">;
} | undefined, producerOwnedAnswerIds: ReadonlySet<string> = new Set()): Digest {
  if (!input) throw new Error("READ_SCOPE_PROTOCOL_REQUIRED: No scope evidence context is available.");
  const native = (value: typeof input.native) => {
    if (!value) return null;
    const current = currentStructuredReadEvidence({ ...value, expectedBinding: input.binding,
      references: input.references, catalog: input.catalog });
    return { requested_question_id: value.question_id, question_digest: current.question.digest,
      record_digest: current.record.digest, status: current.status, analysis_digest: canonicalJsonDigest(value.analysis ?? null) };
  };
  return canonicalJsonDigest({ binding: input.binding, references: input.references.filter(ref => ref.kind !== "answer" || !producerOwnedAnswerIds.has(ref.question_id)), catalog: input.catalog,
    native: native(input.native), reusable: native(input.reusable), resumable: native(input.resumable) });
}
/** Current exact request associations are another projection of the same
 * native evidence owner. Structural/FK review alone has no request binding. */
export function currentReadRequestBindings(input: {
  workloads: readonly ReadWorkloadView[]; candidateDigests: ReadonlySet<string>; mode: "reviewed" | "resumable";
}): ExactReadRequestBinding[] {
  return input.workloads.flatMap(workload => {
    const analysis = workload.analysis;
    if (analysis.status !== "ready" || !analysis.candidate_digest || !analysis.candidate
      || workload.state === "stale" || workload.state === "blocked") return [];
    const current = input.mode === "reviewed"
      ? workload.review?.analyzed_candidate_digest === analysis.candidate_digest && input.candidateDigests.has(workload.review.candidate_digest)
      : workload.review ? workload.review.analyzed_candidate_digest === analysis.candidate_digest && input.candidateDigests.has(workload.review.candidate_digest)
        : input.candidateDigests.has(workload.generated_boundary_digest);
    if (!current) return [];
    const resources = new Set(analysis.candidate.pack.resources.map(resource => resource.id));
    return analysis.allowed.flatMap(entry => {
      const roots = [...new Set(entry.authority_atoms.map(atom => atom.root_resource))].sort();
      return entry.status !== "supported" || !entry.plan_shape || !roots.length || roots.some(root => !resources.has(root))
        ? [] : [{ description: entry.description, resource_ids: roots }];
    });
  });
}

