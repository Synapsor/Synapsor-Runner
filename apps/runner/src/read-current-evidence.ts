import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import { activePolicySource, type PolicySourceSession } from "./authoring-policy-source.js";
import { parseOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { parseOwnerHandoffs, type AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import { findReadMeaningEvidence, readDefinitionPhrases, ReadMeaningConflictError, isUnknownReadMeaning,
  type ReadMeaningCatalog, type ReadMeaningEvidence, type ReadMeaningStatement, type ReadMeaningTarget } from "./read-meaning-evidence.js";
import type { ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";
import type { ReadWorkloadView } from "./read-workloads.js";
import type { ExactReadRequestBinding } from "./read-requested-scope.js";
import type { ModelAuthoringConversation } from "./model-authoring-conversation.js";

type Digest = `sha256:${string}`;
type Answer = ReadMeaningTarget & { question: string; answer: string };
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
};
export type CurrentReadEvidenceReference =
  | { kind: "statement"; evidence: ReadMeaningEvidence }
  | { kind: "operator_answer"; question_id: string; revision: number; answer_id: string; handoff_id: string }
  | { kind: "workload"; analysis_id: string; analysis_digest: Digest; candidate_digest: Digest };
export type CurrentReadEvidence = {
  status: "established" | "missing" | "stale" | "conflicting" | "unsupported";
  target: ReadMeaningTarget;
  references: CurrentReadEvidenceReference[];
  evidence?: ReadMeaningEvidence;
  progression?: "raw_captured" | "confirmed_awaiting_mapping" | "mapped";
  reason?: string;
  authority_granted: false;
};
export type CurrentReadEvidenceInput = {
  catalog: ReadMeaningCatalog;
  statements: readonly ReadMeaningStatement[];
  answers: readonly Answer[];
  context_digest: Digest;
  requested_use_digest: Digest;
  records?: CurrentReadEvidenceRecords;
};

/** A derived view over the existing native records. Nothing here is a stored
 * authority, an accepted model quote, or permission to expose/query a field. */
export function createCurrentReadEvidence(input: CurrentReadEvidenceInput) {
  const meaning = (target: ReadMeaningTarget): CurrentReadEvidence => {
    const result = (status: CurrentReadEvidence["status"], extra: Partial<CurrentReadEvidence> = {}): CurrentReadEvidence =>
      ({ status, target: structuredClone(target), references: [], authority_granted: false, ...extra });
    const resource = input.catalog.resources.find(resource => resource.id === target.resource);
    if (!resource || target.field !== undefined && !resource.fields.some(field => field.id === target.field))
      return result("unsupported", { reason: "The exact target is absent from the current model-visible Read catalog." });
    let retained: ReturnType<typeof retainedMeaning>;
    try { retained = retainedMeaning(target, input.records); }
    catch (error) { return result("unsupported", { reason: error instanceof Error ? error.message : String(error) }); }
    if (retained.status === "conflicting") return result("conflicting", { references: retained.references, reason: retained.reason });
    const currentAnswers = input.answers.filter(answer => sameTarget(answer, target));
    if (retained.pending && !currentAnswers.length) return result(retained.status ?? "missing", {
      references: retained.references, ...(retained.progression ? { progression: retained.progression } : {}), reason: retained.reason });
    const answers = currentAnswers.length ? input.answers : [...input.answers, ...(retained.answer ? [retained.answer] : [])];
    try {
      const statements = input.statements.filter(statement => !isConfirmedMeaningIndex(statement));
      // A retained decision does not silently overrule newly supplied explicit
      // meaning. Exact identical definitions may be repeated; different words
      // require the ordinary attributed conflict decision, not guessed synonymy.
      if (retained.answer && !currentAnswers.length) {
        const phrases = readDefinitionPhrases(retained.answer.answer, target, input.catalog);
        const meanings = phrases.length ? phrases : [retained.answer.answer.trim().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ").toLowerCase()];
        const conflict = statements.filter(statement => readDefinitionPhrases(statement.text, target, input.catalog)
          .some(phrase => !meanings.includes(phrase)));
        if (conflict.length) {
          const references: CurrentReadEvidenceReference[] = [...retained.references];
          for (const statement of conflict) {
            const evidence = findReadMeaningEvidence({ ...input, target, statements: [statement], answers: [] });
            if (evidence) references.push({ kind: "statement", evidence });
          }
          return result("conflicting", { references, reason: "An explicit current definition differs from the retained answer; no current reviewed precedence resolves both." });
        }
      }
      const evidence = findReadMeaningEvidence({ target, catalog: input.catalog, statements, answers,
        context_digest: input.context_digest, requested_use_digest: input.requested_use_digest });
      if (evidence) return result("established", { evidence,
        references: [{ kind: "statement", evidence }, ...(retained.answer && !currentAnswers.length ? retained.references : [])],
        ...(retained.answer && !currentAnswers.length ? { progression: "mapped" as const } : {}) });
    } catch (error) {
      if (!(error instanceof ReadMeaningConflictError)) throw error;
      return result("conflicting", { references: error.evidence.map(evidence => ({ kind: "statement", evidence })), reason: error.message });
    }
    return result(retained.status ?? "missing", { references: retained.references,
      ...(retained.progression ? { progression: retained.progression } : {}), ...(retained.reason ? { reason: retained.reason } : {}) });
  };
  const confirmedAnswers = (): Answer[] => {
    const answers = [...input.answers];
    for (const question of input.records?.questions ?? []) {
      if (!question.target.resource || answers.some(answer => sameTarget(answer, question.target as ReadMeaningTarget))) continue;
      const target = { resource: question.target.resource, ...(question.target.field ? { field: question.target.field } : {}) };
      const resolved = meaning(target);
      if (resolved.status !== "established" || resolved.progression !== "mapped" || !resolved.evidence) continue;
      const reference = resolved.references.find(reference => reference.kind === "operator_answer");
      if (reference?.kind !== "operator_answer") continue;
      const current = input.records!.questions.find(q => q.id === reference.question_id && q.revision === reference.revision);
      if (current?.presentation && current.raw_answer) answers.push({ ...target, question: current.presentation.text, answer: current.raw_answer.text });
    }
    return structuredClone(answers);
  };
  const statementMeaning = (target: ReadMeaningTarget) => createCurrentReadEvidence({ ...input, answers: [], records: undefined }).meaning(target);
  const view = () => input.catalog.resources.flatMap(resource => [meaning({ resource: resource.id }),
    ...resource.fields.map(field => meaning({ resource: resource.id, field: field.id }))]);
  return { meaning, confirmedAnswers, statementMeaning, view };
}

/** One projection of original operator context, attached Source and declared
 * conversation answers for all Read producers. Source indexes remain inert
 * unless the native-record resolver verifies their lineage. */
export function currentReadEvidenceStatements(input: {
  original: readonly string[];
  conversation?: ModelAuthoringConversation;
  retiredAnswers?: readonly Answer[];
}): ReadMeaningStatement[] {
  const source = activePolicySource(input.conversation?.policySources);
  return [
    ...input.original.map((text, index) => ({ text, origin: "operator_statement" as const,
      source_digest: canonicalJsonDigest(text), source_id: `operator_context:${index}` })),
    ...(input.conversation?.turns.filter(turn => turn.kind === "clarification").flatMap((turn, index) =>
      // Retire the exact answered question's conversation projection. The same
      // text in a different question, original request or Source is not erased.
      input.retiredAnswers?.some(answer => answer.question === turn.question && answer.answer === turn.answer) ? [] : [{ text: turn.answer,
        origin: "operator_statement" as const, source_digest: canonicalJsonDigest(turn.answer), source_id: `operator_answer:${index}` }]) ?? []),
    ...(source ? [{ text: source.text, origin: "policy_source" as const, source_digest: source.digest,
      source_id: input.conversation!.policySources!.id, source_version: source.version },
      ...(input.conversation?.policySources?.operator_messages ?? []).map((text, index) => ({ text,
        origin: "operator_statement" as const, source_digest: canonicalJsonDigest(text), source_id: `operator_message:${index}` }))] : []),
  ].filter(statement => !isConfirmedMeaningIndex(statement));
}

function sameTarget(left: ReadMeaningTarget, right: ReadMeaningTarget): boolean {
  return left.resource === right.resource && left.field === right.field;
}
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function retainedMeaning(target: ReadMeaningTarget, records: CurrentReadEvidenceRecords | undefined): {
  answer?: Answer; references: CurrentReadEvidenceReference[]; status?: CurrentReadEvidence["status"];
  progression?: CurrentReadEvidence["progression"]; reason?: string;
  pending?: boolean;
} {
  if (!records) return { references: [] };
  const questions = records.questions.map(parseOperatorQuestion).filter(question => question.kind === "attributed_meaning"
    && question.continuation === "read_mapping" && question.target.resource === target.resource && question.target.field === target.field);
  const handoffs = parseOwnerHandoffs([...records.handoffs]);
  const latest = questions.filter(question => !questions.some(other => other.handoff_id === question.handoff_id && other.revision > question.revision));
  const histories = [records.history, records.checkpoint].filter((history): history is ReadWorkloadAssistanceCheckpoint => !!history);
  const currentAnswers = histories.flatMap(history => {
    const answers = [...history.state.clarified_targets];
    const retired = new Set((history.state.reviewed_replacements ?? []).map(edge => edge.previous_index));
    const pending = history.pending_question;
    if (pending?.kind === "clarification" && pending.decision?.state === "answered") {
      if (pending.replacement?.confirmed) retired.add(pending.replacement.previous_index);
      answers.push({ ...pending.request, answer: pending.decision.answer });
    }
    return answers.filter((_answer, index) => !retired.has(index));
  });
  const source = activePolicySource(records.source);
  let stale = false, unsupported = false;
  const found: Array<{ answer: Answer; references: CurrentReadEvidenceReference[] }> = [];
  for (const text of records.source?.operator_messages ?? []) {
    let index: unknown;
    try { index = JSON.parse(text); } catch { continue; }
    if (!object(index) || index.kind !== "confirmed_read_meaning" || !Array.isArray(index.statements)) continue;
    for (const statement of index.statements) {
      if (!object(statement) || !sameTarget(statement as ReadMeaningTarget, target)) continue;
      const q = latest.find(question => question.digest === statement.question_digest);
      const h = q && handoffs.find(handoff => handoff.id === q.handoff_id);
      if (!q || !h || h.state !== "answered" || !q.raw_answer || !q.confirmation || q.disposition
        || q.scope_digest !== index.scope_digest || q.context_digest !== statement.question_context_digest
        || q.raw_answer.text !== statement.raw_answer || q.presentation?.text !== statement.question
        || canonicalJsonDigest(q.confirmation) !== canonicalJsonDigest(statement.confirmation)
        || h.answer !== q.raw_answer.text || h.answer_context_digest !== q.context_digest || h.scope_digest !== q.scope_digest
        || !currentAnswers.some(answer => sameTarget(answer, target) && answer.answer === q.raw_answer!.text && answer.question === q.presentation?.text)) {
        unsupported = true; continue;
      }
      const nativeReference: CurrentReadEvidenceReference = { kind: "operator_answer", question_id: q.id, revision: q.revision,
        answer_id: q.raw_answer.id, handoff_id: h.id };
      if (!source || source.digest !== index.source_digest) { stale = true; continue; }
      const workload = records.workloads.find(workload => workload.analysis.status === "ready" && workload.analysis.candidate
        && workload.analysis.candidate_digest && histories.some(history => workload.generated_boundary_digest === history.boundary_digest)
        && workload.source.meaning_evidence?.some(evidence => sameTarget(evidence, target)
          && evidence.reference.kind === "answered_clarification" && evidence.reference.text === q.raw_answer!.text
          && evidence.reference.source_digest === canonicalJsonDigest(q.raw_answer!.text)
          && evidence.reference.source_id === canonicalJsonDigest({ target, question: q.presentation!.text })));
      if (!workload?.analysis.candidate || !workload.analysis.candidate_digest) { unsupported = true; continue; }
      if (canonicalJsonDigest(targetDependencies(workload.analysis.candidate, target)) !== canonicalJsonDigest(targetDependencies(records.boundary, target))) {
        stale = true; continue;
      }
      if (isUnknownReadMeaning(q.raw_answer.text)) { unsupported = true; continue; }
      found.push({ answer: { ...target, question: q.presentation!.text, answer: q.raw_answer.text }, references: [nativeReference,
        { kind: "workload", analysis_id: workload.analysis_id, analysis_digest: workload.analysis_digest, candidate_digest: workload.analysis.candidate_digest }] });
    }
  }
  // Native questions are append-ordered; revisions replace only their own
  // handoff. A newer question for this exact target must not resurrect an old
  // indexed Yes, including when it belongs to a new handoff. Other targets do
  // not participate in this decision.
  const newest = latest.at(-1);
  if (newest && !found.some(item => item.references.some(ref => ref.kind === "operator_answer"
    && ref.question_id === newest.id && ref.revision === newest.revision))) {
    const h = handoffs.find(handoff => handoff.id === newest.handoff_id);
    if (h && h.scope_digest === newest.scope_digest && h.context_digest === newest.context_digest) return {
      pending: true, status: stale ? "stale" : "missing", references: newest.raw_answer ? [{ kind: "operator_answer", question_id: newest.id,
        revision: newest.revision, answer_id: newest.raw_answer.id, handoff_id: h.id }] : [],
      ...(newest.raw_answer && !newest.disposition ? { progression: newest.confirmation ? "confirmed_awaiting_mapping" as const : "raw_captured" as const } : {}),
      reason: "The latest native question for this target remains pending; an earlier mapping is not its answer." };
  }
  if (new Set(found.map(item => item.answer.answer)).size > 1) return { status: "conflicting", references: found.flatMap(item => item.references), reason: "Current native Read answers disagree; no reviewed replacement selects one." };
  if (found.length) return found[0]!;
  const unfinished = latest.find(question => question.raw_answer && !question.disposition);
  if (unfinished?.raw_answer) return { status: stale ? "stale" : "missing", references: [{ kind: "operator_answer", question_id: unfinished.id,
    revision: unfinished.revision, answer_id: unfinished.raw_answer.id, handoff_id: unfinished.handoff_id! }],
    progression: unfinished.confirmation ? "confirmed_awaiting_mapping" : "raw_captured",
    reason: "The exact saved answer is available to its ordinary continuation; no completed mapping is inferred." };
  return { references: [], ...(stale ? { status: "stale" as const, reason: "The supporting Source or target dependencies changed." }
    : unsupported ? { status: "unsupported" as const, reason: "The indexed statement has no complete current native Read lineage." } : {}) };
}

/** Business naming remains separate from authority. Presentation and unrelated
 * fields are excluded, while the exact field/type/scope/operation dependencies
 * are retained. Consumers still perform ordinary whole-project currentness. */
function targetDependencies(boundary: ExplorationBoundaryDraft, target: ReadMeaningTarget): unknown {
  const resource = boundary.pack.resources.find(resource => resource.id === target.resource);
  if (!resource) return null;
  if (target.field === undefined) return { source: boundary.source, role: boundary.role_posture_fingerprint,
    identity: { id: resource.id, schema: resource.schema, table: resource.table, primary_key: resource.primary_key,
      tenant_key: resource.tenant_key ?? null, principal_key: resource.principal_key ?? null, tenant_scope: resource.tenant_scope ?? null,
      principal_scope: resource.principal_scope ?? null } };
  const field = target.field;
  return { source: boundary.source, role: boundary.role_posture_fingerprint,
    identity: targetDependencies(boundary, { resource: target.resource }), field, type: resource.field_types[field] ?? null, enum: resource.field_enums[field] ?? null,
    selectable: resource.selectable_fields.includes(field), filterable: resource.filterable_fields[field] ?? null,
    sortable: resource.sortable_fields.includes(field), groupable: resource.groupable_fields.includes(field),
    aggregate: resource.aggregate_measures.includes(field), kept_out: resource.kept_out_fields.includes(field),
    model_withheld: resource.model_withheld_fields?.includes(field) ?? false,
    count_distinct: resource.count_distinct_fields.includes(field), time_bucket: resource.time_bucket_fields[field] ?? null,
    presence: resource.presence_measure_fields?.includes(field) ?? false,
    aggregate_functions: resource.aggregate_measure_functions?.[field] ?? null };
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

/** Structured saved indexes are never free-text testimony. A copied index with
 * an explicit identifier in raw_answer must not bypass native lineage checks. */
function isConfirmedMeaningIndex(statement: ReadMeaningStatement): boolean {
  if (statement.origin !== "operator_statement") return false;
  try { const value: unknown = JSON.parse(statement.text); return object(value) && value.kind === "confirmed_read_meaning"; }
  catch { return false; }
}
