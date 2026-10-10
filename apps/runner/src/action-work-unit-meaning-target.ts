import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { assessActionWorkUnitSource } from "./action-work-unit-source-assessment.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";

type Digest = `sha256:${string}`;
type AssessmentInput = Parameters<typeof assessActionWorkUnitSource>[0];
export type ActionWorkUnitMeaningTarget = {
  target: OperatorQuestion["target"];
  unresolved_delta_digest: Digest;
  passage_index: number;
  draft_path: string;
};

/** Transient candidates from an already interpreted report. The existing host
 * must authenticate its original native episode and current request/baseline
 * under Held access. This function creates no Question, proof or meaning. */
export function projectActionWorkUnitMeaningTargets(input: AssessmentInput & {
  requestedEdit: string; baseline?: ActionRuleModelDraftV1;
}): ActionWorkUnitMeaningTarget[] {
  if (!input.requestedEdit.trim() || input.requestedEdit.length > 4000) return [];
  const { assessment } = assessActionWorkUnitSource(input);
  if (assessment.state !== "owner_meaning_pending" || !assessment.source_review) return [];
  const { source_review: review } = assessment;
  const action = input.currentAction;
  const index = input.preparedDraft.actions.findIndex(a => a.outcome === action.outcome);
  const resource = input.context.builtCatalog.authoring.resources.find(r => r.name === action.effect.target_resource);
  if (!resource) return [];
  const dependencies = {
    requested_edit: input.requestedEdit, baseline: input.baseline ?? null,
    action, read: input.context.readBoundary, read_digest: input.context.readBoundaryDigest,
    catalog: input.context.builtCatalog, source_session: input.context.policySources,
    source_review: review,
  };
  const targets: ActionWorkUnitMeaningTarget[] = [];
  for (const passage_index of review.passage_indexes) {
    const passage = review.report.passages[passage_index]!;
    // An exact existing assignment is an association, not a claim that its
    // current value has the intended meaning. Component/root names do not
    // establish a missing delta. No expression or field-name heuristic runs.
    if (passage.draft_paths.length !== 1) return [];
    const draft_path = passage.draft_paths[0]!;
    const parts = draft_path.slice(1).split("/").map(p => p.replace(/~1/gu, "/").replace(/~0/gu, "~"));
    const field = parts[4];
    if (parts.length !== 5 || parts[0] !== "actions" || parts[1] !== String(index)
      || parts[2] !== "effect" || parts[3] !== "set" || !field
      || !Object.hasOwn(action.effect.set, field) || !resource.fields.some(f => f.name === field)) return [];
    const target = { phase: "effect", resource: resource.name, field, outcomes: [action.outcome] };
    // Two separate clauses with the same existing Question target cannot be
    // disambiguated by model prose or a field/phase match. Keep both pending.
    if (targets.some(t => canonicalJsonDigest(t.target) === canonicalJsonDigest(target))) return [];
    targets.push({ target, passage_index, draft_path,
      unresolved_delta_digest: canonicalJsonDigest({ dependencies, passage_index, draft_path, target }) });
  }
  return structuredClone(targets);
}

/** Selection only: the digest must have been advertised by this current host
 * projection. It does not interpret provider wording or grant a retry. */
export function selectActionWorkUnitMeaningTarget(current: readonly ActionWorkUnitMeaningTarget[],
  selected: Digest): ActionWorkUnitMeaningTarget | undefined {
  const matches = current.filter(t => t.unresolved_delta_digest === selected);
  return matches.length === 1 ? structuredClone(matches[0]) : undefined;
}

/** The same association comparison is usable live and after a native reload.
 * The caller still authenticates the actual Question/handoff/consumed producer
 * records and recomputes current candidates under Held access after every wait.
 * An absent pre-Question association cannot be reconstructed from wording. */
export function actionWorkUnitMeaningQuestionMatches(input: {
  current: readonly ActionWorkUnitMeaningTarget[]; question: OperatorQuestion;
  handoff: AuthoringOwnerHandoff; producerQuestionDigest: Digest;
}): boolean {
  const { question: q, handoff: h } = input;
  const exactly = (id: string, digest: Digest) => q.evidence.filter(e => e.id === id).length === 1
    && q.evidence.some(e => e.id === id && e.digest === digest);
  const association = q.evidence.filter(e => e.id === "action-unresolved-target");
  const target = association.length === 1
    ? selectActionWorkUnitMeaningTarget(input.current, association[0]!.digest) : undefined;
  return !!target && h.state === "waiting" && q.kind === "attributed_meaning" && q.continuation === "action_rule_review"
    && q.handoff_id === h.id && q.scope_digest === h.scope_digest && q.context_digest === h.context_digest
    && canonicalJsonDigest(q.target) === canonicalJsonDigest(target.target)
    && exactly("current-owner-question", h.digest) && exactly("action-producer-question", input.producerQuestionDigest);
}
