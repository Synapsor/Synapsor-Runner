import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { parseActionRequirementsQuestionBinding, type ActionRequirementsQuestionBinding } from "./authoring-action-requirements-binding.js";
import { actionRequirementsPending, actionRequirementTargetsDigest } from "./authoring-action-requirements.js";
export function prepareActionRequirementsOperatorQuestion(input: { binding: ActionRequirementsQuestionBinding; id?: string; revision?: number }): OperatorQuestion {
  const binding = parseActionRequirementsQuestionBinding(input.binding);
  const body = { version: 4 as const, id: input.id ?? randomUUID(), revision: input.revision ?? 1, kind: "action_requirements" as const,
    action_requirements: binding, scope_digest: actionRequirementTargetsDigest(binding.proposals), context_digest: binding.dependencies.context_digest,
    target: { phase: "action_requirements", outcomes: binding.dependencies.participating_outcomes }, material: [], evidence: [], continuation: "action_rule_review" as const };
  return parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) });
}
/** Host-inspected projection comparison; not a live custody/lease check. */
export function assertActionRequirementsQuestionDependencies(q: OperatorQuestion, current: ActionRequirementsQuestionBinding["dependencies"]): void {
  const parsed = parseOperatorQuestion(q);
  if (!parsed.action_requirements || canonicalJsonDigest(parsed.action_requirements.dependencies) !== canonicalJsonDigest(current))
    throw new Error("AUTHORING_ACTION_REQUIREMENTS_CHANGED: Reinspect the exact Root, Source, store/session, Read, catalog, AST and target under the same Held save boundary.");
}
/** Detached DATA for the existing compiler/domain consumer. This is neither
 * execution authority nor proof of protected operator identity/currentness. */
export function projectConfirmedActionRequirements(q: OperatorQuestion) {
  const parsed = parseOperatorQuestion(q), binding = parsed.action_requirements;
  if (!binding || !parsed.confirmation || parsed.disposition || parsed.proposal?.value?.kind !== "action_requirements" || actionRequirementsPending(binding.proposals).length)
    throw new Error("AUTHORING_ACTION_REQUIREMENTS_UNCONFIRMED: Exact supported meaning remains pending.");
  return { version: 1 as const, proposals: structuredClone(binding.proposals), binding_digest: canonicalJsonDigest(binding),
    confirmation: { ...parsed.confirmation, question: { id: parsed.id, revision: parsed.revision, digest: parsed.digest } } };
}
