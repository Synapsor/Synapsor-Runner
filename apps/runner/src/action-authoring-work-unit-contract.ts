import type { ActionWorkUnitCorrection, ActionWorkUnitBindingPermutation } from "./action-rule-authoring-checkpoint.js";
export type { ActionWorkUnitCorrection, ActionWorkUnitBindingPermutation } from "./action-rule-authoring-checkpoint.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseActionWorkUnitCoverageProvenance, type ActionWorkUnitCoverageProvenance } from "./action-rule-authoring-checkpoint.js";
import { Buffer } from "node:buffer";
import { assertSourceInputReviews } from "./authoring-input-policy-records.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import { activePolicySource, type PolicyCoverage, type PolicyPassage, type PolicySourceSession } from "./authoring-policy-source.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";

type Digest = `sha256:${string}`;
export const ACTION_WORK_UNIT_BINDING_LOADER_FIELDS = ["source", "max_rows", "overflow", "collection_consistency"] as const;
type DraftComponents = {
  verification?: ActionRuleModelDraftV1["verification"];
  effect?: ActionRuleModelDraftV1["effect"];
};

/** A current, already interpreted Source report supplied by the existing host
 * reviewPolicyCoverage/parsePolicyCoverage path against exact policyCoverageDraft
 * evidence and attributed operator history. Raw provider claims are not this
 * contract. Its host owns field/evidence checks and semantic interpretation;
 * this wrapper adds no durable meaning, grant or review engine. */
export type ActionWorkUnitSourceReview = {
  draft: { read: ExplorationBoundaryDraft; actions: ActionRuleModelDraftV1[] };
  report: PolicyCoverage;
  passage_indexes: number[];
  source_answer_history_digest: Digest;
  /** Exact original coverage episode identity; only its host can authenticate it. */
  coverage_provenance?: ActionWorkUnitCoverageProvenance;
};
export type ActionWorkUnitContext = {
  readBoundary: ExplorationBoundaryDraft;
  readBoundaryDigest: Digest;
  builtCatalog: BuiltActionRuleAuthoringCatalogV1;
  policySources?: PolicySourceSession;
};
export type ActionWorkUnitSourceReviewStatus = {
  state: "not_assessed" | "source_interpretation_pending" | "current_registered_requirements_satisfied";
  assurance: "current_nominated_source_requirements_only" | "structural_only";
  whole_source_review_pending: true;
  source_digest?: string;
  interpretation_digest?: Digest;
};
export type ActionWorkUnitFidelityAssessment =
  | { state: "source_interpretation_pending" }
  | { state: "owner_meaning_pending"; source_review?: ActionWorkUnitSourceReview }
  | { state: "currentness_pending" }
  | { state: "current_registered_requirements_satisfied"; source_review: ActionWorkUnitSourceReview }
  | { state: "representation_mismatch"; source_review: ActionWorkUnitSourceReview;
      component: "subject" | "predicate" | "private_role"; editable_paths: string[];
      binding_permutation?: ActionWorkUnitBindingPermutation };

const MAX_CONTRACT_BYTES = 32 * 1024;
const MAX_EDITABLE_PATHS = 32;
const escape = (part: string) => part.replace(/~/gu, "~0").replace(/\//gu, "~1");
const parts = (pointer: string) => pointer.slice(1).split("/").map(p => p.replace(/~1/gu, "/").replace(/~0/gu, "~"));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class ActionWorkUnitSourcePendingError extends Error {
  readonly code: string;
  constructor(readonly reason: "owner_meaning" | "currentness" | "assessment_incomplete") {
    const code = { owner_meaning: "ACTION_WORK_UNIT_SOURCE_MEANING_PENDING", currentness: "ACTION_WORK_UNIT_SOURCE_CONTEXT_CHANGED",
      assessment_incomplete: "ACTION_WORK_UNIT_SOURCE_ASSESSMENT_INCOMPLETE" }[reason];
    super(`${code}: ${reason === "owner_meaning" ? "Use the attributed owner question route for the missing Source meaning."
      : reason === "currentness" ? "Reopen the current Source, Read and Action review; prior interpretation is history."
        : "The current Source assessment did not finish. Preserve the draft and inspect its review; no model repair or acceptance was inferred."}`);
    this.code = code;
  }
}

function checkedSourceReview(context: ActionWorkUnitContext, draft: ActionRuleModelDraftV1, review: ActionWorkUnitSourceReview): PolicyPassage[] {
  if (review?.coverage_provenance !== undefined) try { parseActionWorkUnitCoverageProvenance(review.coverage_provenance); }
  catch { throw new ActionWorkUnitSourcePendingError("assessment_incomplete"); }
  if (!review || !object(review.draft) || !Array.isArray(review.draft.actions) || !object(review.report)
    || !Array.isArray(review.report.passages) || !Array.isArray(review.passage_indexes))
    throw new ActionWorkUnitSourcePendingError("assessment_incomplete");
  const source = activePolicySource(context.policySources);
  const matching = review.draft.actions.filter(a => a && a.outcome === draft.outcome);
  if (!source || review.report.source_digest !== source.digest || review.report.draft_digest !== canonicalJsonDigest(review.draft)
    || review.source_answer_history_digest !== canonicalJsonDigest(context.policySources?.operator_messages ?? [])
    || canonicalJsonDigest(review.draft.read) !== canonicalJsonDigest(context.readBoundary)
    || matching.length !== 1 || canonicalJsonDigest(matching[0]) !== canonicalJsonDigest(draft)
    || !review.passage_indexes.length || review.passage_indexes.length > 120
    || new Set(review.passage_indexes).size !== review.passage_indexes.length) throw new ActionWorkUnitSourcePendingError("currentness");
  return review.passage_indexes.map(index => {
    const passage = Number.isSafeInteger(index) && index >= 0 ? review.report.passages[index] : undefined;
    if (!passage || !Number.isSafeInteger(passage.start) || !Number.isSafeInteger(passage.end)
      || passage.start < 1 || passage.end < passage.start || passage.end > source.lines
      || !Array.isArray(passage.draft_paths) || passage.draft_paths.length > 32 || passage.draft_paths.some(p => typeof p !== "string" || !p.startsWith("/")))
      throw new ActionWorkUnitSourcePendingError("currentness");
    return passage;
  });
}

/** The catalog and components describe the proposal. Only current existing
 * interpretation records describe an established Source association. */
export function buildActionAuthoringWorkUnitContract(input: ActionWorkUnitContext & {
  intent: string;
  expectedOutcome?: string;
  components: DraftComponents;
  sourceReview?: ActionWorkUnitSourceReview;
  correction?: ActionWorkUnitCorrection;
  draft?: ActionRuleModelDraftV1;
}) {
  const source = activePolicySource(input.policySources);
  if (input.correction && (input.correction.source_digest !== source?.digest || input.correction.read_digest !== input.readBoundaryDigest
    || input.correction.source_answer_history_digest !== canonicalJsonDigest(input.policySources?.operator_messages ?? [])
    || input.correction.catalog_digest !== canonicalJsonDigest(input.builtCatalog.catalog))) throw new ActionWorkUnitSourcePendingError("currentness");
  const readCatalog = readBoundaryRevisionCatalog(input.readBoundary);
  const verification = input.components.verification?.resources ?? [];
  const effects = input.components.effect ? [input.components.effect, ...input.components.effect.atomic_updates ?? []] : [];
  const sourceFields = new Map<string, { record_digest: string; exposure: "model_and_runner" | "runner_only" | "kept_out" }>();
  let staleInterpretations = 0;
  for (const record of input.policySources?.read_interpretations ?? []) {
    const { record_digest, ...body } = record;
    if (!source || record.source_digest !== source.digest || record.read_digest !== input.readBoundaryDigest
      || record.catalog_digest !== readCatalog.digest || record.authority_changed !== false
      || canonicalJsonDigest(body) !== record_digest) { staleInterpretations += 1; continue; }
    for (const field of record.fields) {
      const actual = readCatalog.resources.find(r => r.id === field.resource)?.fields.find(f => f.id === field.field);
      if (!actual || actual.current_exposure !== field.exposure) { staleInterpretations += 1; continue; }
      sourceFields.set(`${field.resource}\0${field.field}`, { record_digest, exposure: field.exposure });
    }
  }
  const fieldRoles = verification.flatMap(binding => binding.fields.map(field => {
    const catalog = input.builtCatalog.authoring.resources.find(r => r.name === binding.resource)?.fields.find(f => f.name === field);
    const read = readCatalog.resources.find(r => r.id === binding.resource)?.fields.find(f => f.id === field);
    return { binding: binding.binding, resource: binding.resource, field,
      schema_role: catalog?.role ?? "not_in_current_catalog", proposed_read: { raw_return: read?.raw_return === true,
        model_analysis: read?.model_operations ?? [], runner_row_selection: read?.row_selection === true },
      ...(sourceFields.has(`${binding.resource}\0${field}`) ? { current_source_interpretation: sourceFields.get(`${binding.resource}\0${field}`) } : {}) };
  }));
  const outcome = input.expectedOutcome ?? input.draft?.outcome;
  assertSourceInputReviews(input.policySources?.input_policy_reviews ?? []);
  const inputRequirements = (input.policySources?.input_policy_reviews ?? []).filter(r => source && r.source_digest === source.digest
    && r.source_session === input.policySources?.id && outcome && r.outcomes.includes(outcome)).map(record => ({
      interpretation_digest: record.digest, source_digest: record.source_digest, store_digest: record.store_digest,
      agenda_digest: record.agenda_digest, decision: record.decision, assurance: "finite_length_implication_only",
      store_currentness: "requires_existing_input_assessor", requirements: record.requirements.filter(q => outcome && q.outcomes.includes(outcome))
        .map(q => ({ input: q.input, source_range: { start: q.start, end: q.end }, min_length: q.min_length, max_length: q.max_length })),
    }));
  const passages = input.sourceReview && input.draft ? checkedSourceReview(input, input.draft, input.sourceReview) : [];
  const core = {
    schema_version: "synapsor.action-authoring-work-unit-contract.v1" as const,
    identity: { intended_outcome: outcome ?? null, intent_digest: canonicalJsonDigest(input.intent),
      source_session: source ? input.policySources!.id : null, source_digest: source?.digest ?? null,
      source_answer_history_digest: canonicalJsonDigest(input.policySources?.operator_messages ?? []),
      read_digest: input.readBoundaryDigest, read_catalog_digest: readCatalog.digest,
      action_catalog_digest: canonicalJsonDigest(input.builtCatalog.catalog), draft_digest: input.draft ? canonicalJsonDigest(input.draft) : null },
    attached_source: source ? { name: source.name, version: source.version, digest: source.digest, lines: source.lines,
      meaning: "Complete attached literal policy and attributed answers are in the consented Source history; a mentioned path is not another attachment." } : null,
    proposal: {
      caller_subjects: verification.filter(r => r.source.kind === "subject_ref").map(r => ({ binding: r.binding, resource: r.resource,
        reference_route: input.builtCatalog.authoring.resources.find(c => c.name === r.resource)?.subject_reference ?? { obtainable: "not_assessed" },
        assurance: "proposed_caller_contract_not_source_acceptance" })),
      evidence_bindings: verification.filter(r => r.source.kind === "relationship").map(r => ({ binding: r.binding, resource: r.resource,
        source: r.source, assurance: "compiler_scoped_relation_not_caller_selection" })),
      effect_targets: effects.map(e => ({ operation: e.operation, resource: e.target_resource, binding: e.target_binding ?? null,
        assurance: "proposed_effect_not_caller_contract_or_execution" })), field_roles: fieldRoles,
    },
    current_interpretation: { read_field_records: [...new Set([...sourceFields.values()].map(r => r.record_digest))],
      discarded_stale_record_count: staleInterpretations, input_requirements: inputRequirements,
      correction_nomination: input.correction ?? null,
      source_review: input.sourceReview && input.draft ? { interpretation_digest: canonicalJsonDigest(input.sourceReview.report),
        passages: passages.map(p => ({ source_range: { start: p.start, end: p.end }, disposition: p.disposition,
          interpretation: p.interpretation, draft_paths: p.draft_paths, field_checks: p.field_checks ?? [], evidence_checks: p.evidence_checks ?? [] })) } : null },
    status: { validation_scope: "structural_proposal", source_semantic_coverage: passages.length ? "current_nominated_interpretation_only" : "pending",
      whole_program_review: "pending", active_read_return_roles: "not_assessed_by_this_contract", publication: "not_performed", execution: "not_authorized" },
    routing: "Correct only a current nominated representation. Interpret unregistered requirements from the attached literal Source and accepted answers; ask the owner only for genuinely missing meaning. Revalidate stale evidence. A correct effect, stricter predicate or private-looking name does not establish fidelity.",
  };
  if (Buffer.byteLength(JSON.stringify(core)) > MAX_CONTRACT_BYTES) throw new Error(
    `ACTION_WORK_UNIT_CONTEXT_LIMIT: The current metadata contract exceeds ${MAX_CONTRACT_BYTES} bytes. Preserve the draft and prepare a smaller nominated review; no Source or record was truncated.`);
  return core;
}

export class ActionWorkUnitFidelityError extends Error {
  readonly code: string = "ACTION_WORK_UNIT_REPRESENTATION_MISMATCH";
  constructor(readonly correction: ActionWorkUnitCorrection) {
    super("ACTION_WORK_UNIT_REPRESENTATION_MISMATCH: Correct only the current Source-nominated components; preserve every other predicate, effect, guard and approval setting.");
  }
}
export class ActionWorkUnitCorrectionScopeError extends ActionWorkUnitFidelityError {
  override readonly code = "ACTION_WORK_UNIT_CORRECTION_OUTSIDE_SCOPE";
  constructor(correction: ActionWorkUnitCorrection) {
    super(correction);
    this.message = "ACTION_WORK_UNIT_CORRECTION_OUTSIDE_SCOPE: Preserve every component outside the current Source nomination, including the order and identity of untouched predicates and bindings.";
  }
}

function pathExists(draft: unknown, pointer: string): boolean {
  let at: unknown = draft;
  for (const part of parts(pointer)) { if (!at || typeof at !== "object" || !Object.hasOwn(at, part)) return false; at = (at as Record<string, unknown>)[part]; }
  return true;
}
function nominatedByPassage(draft: ActionRuleModelDraftV1, review: ActionWorkUnitSourceReview, passage: PolicyPassage, pointer: string): boolean {
  const index = review.draft.actions.findIndex(a => a.outcome === draft.outcome);
  return passage.draft_paths.some(reference => {
    const p = parts(reference);
    if (p[0] === "actions" && p[1] === String(index) && p.length > 2) {
      const local = `/${p.slice(2).map(escape).join("/")}`;
      return pointer === local || pointer.startsWith(`${local}/`);
    }
    if (p[0] !== "runner_evidence" || p[1] !== "actions" || p[2] !== draft.outcome) return false;
    if (p[3] === "effect") return pointer === "/effect" || pointer.startsWith("/effect/");
    if (p[3] === "scoped_bindings" && p[4]) {
      const i = draft.verification.resources.findIndex(r => r.binding === p[4]);
      return i >= 0 && (pointer === `/verification/resources/${i}` || pointer.startsWith(`/verification/resources/${i}/`));
    }
    return false;
  });
}

export function pendingActionWorkUnitSourceReview(context: ActionWorkUnitContext): ActionWorkUnitSourceReviewStatus {
  const source = activePolicySource(context.policySources);
  return { state: source ? "source_interpretation_pending" : "not_assessed",
    assurance: "structural_only", whole_source_review_pending: true, ...(source ? { source_digest: source.digest } : {}) };
}

export function validateActionWorkUnitAssessment(context: ActionWorkUnitContext, draft: ActionRuleModelDraftV1,
  assessment: ActionWorkUnitFidelityAssessment | undefined): { status: ActionWorkUnitSourceReviewStatus; correction?: ActionWorkUnitCorrection } {
  const source = activePolicySource(context.policySources);
  const status = pendingActionWorkUnitSourceReview(context);
  if (!assessment || assessment.state === "source_interpretation_pending") return { status };
  if (!["owner_meaning_pending", "currentness_pending", "current_registered_requirements_satisfied", "representation_mismatch"].includes(assessment.state))
    throw new ActionWorkUnitSourcePendingError("assessment_incomplete");
  if (assessment.state === "owner_meaning_pending") throw new ActionWorkUnitSourcePendingError("owner_meaning");
  if (assessment.state === "currentness_pending") throw new ActionWorkUnitSourcePendingError("currentness");
  const passages = checkedSourceReview(context, draft, assessment.source_review);
  if (assessment.state === "current_registered_requirements_satisfied") {
    const index = assessment.source_review.draft.actions.findIndex(a => a.outcome === draft.outcome);
    const nominated = passages.some(p => p.draft_paths.some(reference => {
      const path = parts(reference);
      return path[0] === "actions" && path[1] === String(index)
        || path[0] === "runner_evidence" && path[1] === "actions" && path[2] === draft.outcome;
    }));
    if (!nominated || passages.some(p => ["conflict", "unsupported", "needs_decision"].includes(p.disposition))) throw new ActionWorkUnitSourcePendingError("assessment_incomplete");
    return { status: { state: assessment.state, assurance: "current_nominated_source_requirements_only", whole_source_review_pending: true,
      source_digest: source!.digest, interpretation_digest: canonicalJsonDigest(assessment.source_review.report) } };
  }
  if (assessment.state !== "representation_mismatch" || !["subject", "predicate", "private_role"].includes(assessment.component)
    || !Array.isArray(assessment.editable_paths) || !assessment.editable_paths.length || assessment.editable_paths.length > MAX_EDITABLE_PATHS
    || new Set(assessment.editable_paths).size !== assessment.editable_paths.length || !passages.some(p => p.disposition === "conflict"))
    throw new ActionWorkUnitSourcePendingError("assessment_incomplete");
  for (const pointer of assessment.editable_paths) {
    const path = typeof pointer === "string" ? parts(pointer) : [];
    const loader = path.length === 4 && path[0] === "verification" && path[1] === "resources"
      && /^(?:0|[1-9]\d*)$/u.test(path[2] ?? "") && ACTION_WORK_UNIT_BINDING_LOADER_FIELDS.includes(path[3] as typeof ACTION_WORK_UNIT_BINDING_LOADER_FIELDS[number]);
    const region = loader && passages.some(p => p.disposition === "conflict" && p.responsibility === "runner" && p.issue_kind === "contradiction"
      && p.draft_paths.includes(`/actions/${assessment.source_review.draft.actions.findIndex(a => a.outcome === draft.outcome)}/verification/resources/${path[2]}`));
    const bindingRegion = path[0] === "verification" && path[1] === "resources" && passages.some(p => p.disposition === "conflict"
      && p.draft_paths.includes(`/actions/${assessment.source_review.draft.actions.findIndex(a => a.outcome === draft.outcome)}/verification/resources/${path[2]}`));
    if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer.includes("~") && /~(?![01])/u.test(pointer)
      || path.some(p => ["__proto__", "constructor", "prototype", ""].includes(p))
      || !["verification", "require", "inputs", "effect", "derive", "approval", "ttl_seconds", "review", "discovery"].includes(path[0]!)
      || bindingRegion && !loader || !pathExists(draft, pointer) && !region || !passages.some(p => p.disposition === "conflict" && nominatedByPassage(draft, assessment.source_review, p, pointer)))
      throw new ActionWorkUnitSourcePendingError("assessment_incomplete");
  }
  if (assessment.binding_permutation) {
    const permutation = assessment.binding_permutation;
    const index = assessment.source_review.draft.actions.findIndex(a => a.outcome === draft.outcome);
    if (!object(permutation) || Object.keys(permutation).some(k => !["slots", "original_bindings"].includes(k))
      || !Array.isArray(permutation.slots) || permutation.slots.length < 2 || permutation.slots.length > MAX_EDITABLE_PATHS
      || !Array.isArray(permutation.original_bindings) || permutation.original_bindings.length !== permutation.slots.length
      || new Set(permutation.original_bindings).size !== permutation.original_bindings.length
      || permutation.slots.some((slot, i) => !Number.isSafeInteger(slot) || slot < 0 || i > 0 && slot <= permutation.slots[i - 1]!
        || draft.verification.resources[slot]?.binding !== permutation.original_bindings[i]
        || !passages.some(p => p.disposition === "conflict" && p.responsibility === "runner" && p.issue_kind === "contradiction"
          && p.draft_paths.includes(`/actions/${index}/verification/resources/${slot}`))))
      throw new ActionWorkUnitSourcePendingError("assessment_incomplete");
  }
  return { status, correction: { source_digest: source!.digest, read_digest: context.readBoundaryDigest,
    source_answer_history_digest: canonicalJsonDigest(context.policySources?.operator_messages ?? []),
    catalog_digest: canonicalJsonDigest(context.builtCatalog.catalog), parent_digest: canonicalJsonDigest(draft), outcome: draft.outcome,
    interpretation_digest: canonicalJsonDigest(assessment.source_review.report), component: assessment.component,
    editable_paths: [...assessment.editable_paths], source_ranges: passages.filter(p => p.disposition === "conflict").map(p => ({ start: p.start, end: p.end })),
    ...(assessment.binding_permutation ? { binding_permutation: structuredClone(assessment.binding_permutation) } : {}) } };
}

/** Exact JSON-pointer scope, including deletion of nominated array members.
 * Every untouched member remains in order. No predicate equivalence is inferred. */
export function assertActionWorkUnitCorrection(context: ActionWorkUnitContext, parent: ActionRuleModelDraftV1,
  next: ActionRuleModelDraftV1, correction: ActionWorkUnitCorrection): void {
  if (correction.source_digest !== activePolicySource(context.policySources)?.digest || correction.read_digest !== context.readBoundaryDigest
    || correction.source_answer_history_digest !== canonicalJsonDigest(context.policySources?.operator_messages ?? [])
    || correction.catalog_digest !== canonicalJsonDigest(context.builtCatalog.catalog) || correction.parent_digest !== canonicalJsonDigest(parent)
    || correction.outcome !== parent.outcome) throw new ActionWorkUnitSourcePendingError("currentness");
  const editable = new Set(correction.editable_paths);
  const equal = (before: unknown, after: unknown, pointer: string): boolean => {
    if (editable.has(pointer)) return true;
    if (before === undefined || after === undefined) return before === after;
    if (canonicalJsonDigest(before) === canonicalJsonDigest(after)) return true;
    if (Array.isArray(before) && Array.isArray(after)) {
      if (pointer === "/verification/resources" && correction.binding_permutation) {
        const selected = new Set(correction.binding_permutation.slots);
        if (before.length !== after.length || new Set(after.map(b => object(b) ? b.binding : undefined)).size !== after.length
          || correction.binding_permutation.slots.some((slot,i) => !object(before[slot]) || before[slot].binding !== correction.binding_permutation!.original_bindings[i])) return false;
        return before.every((binding, i) => {
          if (!selected.has(i)) return equal(binding, after[i], `${pointer}/${i}`);
          const slot = correction.binding_permutation!.slots.find(j => object(after[j]) && after[j].binding === (binding as Record<string, unknown>).binding);
          return slot !== undefined && equal(binding, after[slot], `${pointer}/${i}`);
        });
      }
      const memo = new Map<string, boolean>();
      const visit = (i: number, j: number): boolean => {
        if (i === before.length) return j === after.length;
        const key = `${i}:${j}`;
        if (memo.has(key)) return memo.get(key)!;
        const child = `${pointer}/${i}`;
        const permitted = editable.has(child)
          ? visit(i + 1, j) || j < after.length && visit(i + 1, j + 1)
          : j < after.length && equal(before[i], after[j], child) && visit(i + 1, j + 1);
        memo.set(key, permitted); return permitted;
      };
      return visit(0, 0);
    }
    if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .every(key => equal(before[key], after[key], `${pointer}/${escape(key)}`));
    return false;
  };
  if (!equal(parent, next, "")) throw new ActionWorkUnitCorrectionScopeError(correction);
}

export function actionWorkUnitFidelityDiagnostics(error: ActionWorkUnitFidelityError) {
  const top = parts(error.correction.editable_paths[0]!)[0];
  const path = top === "verification" ? "verification_boundary" : top === "effect" ? "rule.effect" : top === "approval" ? "approval" : "rule";
  return [{ code: error.code, path, repair: "model" as const,
    message: `The current Source interpretation identifies a representation mismatch. Correct only this exact nomination: ${JSON.stringify(error.correction)}. Unknown meaning requires its owner route.` }];
}
