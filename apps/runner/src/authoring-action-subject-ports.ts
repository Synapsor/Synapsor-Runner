import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ModelActionRuleDraftInput, ActionRuleModelPreparedContext } from "./action-rule-model.js";
import type { ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringQuestionCompletion } from "./authoring-generation-recovery.js";
import type { AskAuthoringEpisodeBudget } from "./model-ask.js";
import { parseActionSubjectMaterial, parseActionSubjectEntries, type ActionSubjectTarget, type ActionSubjectHostMaterial, type ActionSubjectEntry } from "./authoring-action-subject-binding.js";
export type ActionSubjectStaged = { material: ActionSubjectHostMaterial; entries: ActionSubjectEntry[] };
export type ActionSubjectInventory = { context: ActionRuleModelPreparedContext; checkpoint: ActionRuleAuthoringCheckpoint;
  components: ActionRuleAuthoringCheckpoint["components"]; targets: ActionSubjectTarget[] };
/** These ports expose immutable current projections and existing protected save
 * ownership. They never expose arbitrary mutable authoring-session access. */
export type ActionSubjectPorts = {
  /** Synchronous preparation only. No I/O, waiting, consent, saving or adoption. */
  stage(input: ActionSubjectInventory): ActionSubjectStaged | undefined;
  /** Called only after actual whole-batch consumption or a saved exact question. */
  review(input: { context: ActionRuleModelPreparedContext; staged?: ActionSubjectStaged; completion?: AuthoringQuestionCompletion;
    checkpoint(): ActionRuleAuthoringCheckpoint; episodeBudget: AskAuthoringEpisodeBudget;
    saveQuestion(question: OperatorQuestion, completion?: AuthoringQuestionCompletion): Promise<void>;
  }): Promise<OperatorQuestion | undefined>;
  /** Final current-evidence resolution for every surviving target, never English. */
  assertCurrent(input: ActionSubjectInventory): void;
};
/** Exact typed producer inventory. This assigns no business scope or permission. */
export function actionSubjectTargets(components: ActionRuleAuthoringCheckpoint["components"]): ActionSubjectTarget[] {
  const verification = components.verification as { resources?: { resource: string; binding: string; source: { kind: string } }[] } | undefined;
  const effect = components.effect as { target_resource?: string; target_binding?: string;
    atomic_updates?: { target_resource: string; target_binding: string }[] } | undefined;
  const targets: ActionSubjectTarget[] = (verification?.resources ?? []).filter(r => r.source.kind === "subject_ref")
    .map(r => ({ kind: "verification_subject", resource: r.resource, binding: r.binding }));
  if (effect?.target_resource) targets.push({ kind: "primary_effect", resource: effect.target_resource,
    ...(effect.target_binding ? { binding: effect.target_binding } : {}) });
  for (const [index, update] of (effect?.atomic_updates ?? []).entries())
    targets.push({ kind: "atomic_effect", index, resource: update.target_resource, binding: update.target_binding });
  return targets;
}
export function assertActionSubjectStage(stage: ActionSubjectStaged, inventory: ActionSubjectInventory): ActionSubjectStaged {
  const material = parseActionSubjectMaterial(stage.material), entries = parseActionSubjectEntries(stage.entries, material);
  const tail = inventory.checkpoint.logical_turns?.at(-1);
  if (!tail || tail.completed || material.logical_turn_id !== tail.id
    || material.request_digest !== inventory.checkpoint.intent_digest || material.candidate_digest !== canonicalJsonDigest(inventory.components)
    || canonicalJsonDigest(material.targets.map(t => t.target)) !== canonicalJsonDigest(inventory.targets)
    || inventory.targets.some(t => !inventory.context.builtCatalog.catalog.resources.some(r => r.name === t.resource))) {
    throw new Error("ACTION_SUBJECT_STALE: The staged subject does not bind this actual component projection and open owning turn.");
  }
  return { material, entries };
}
// Keep the producer input's type-only linkage visible for callers, without a
// second callback registry or additional persisted owner.
export type ActionSubjectProducerInput = Pick<ModelActionRuleDraftInput, "subjectReview">;
