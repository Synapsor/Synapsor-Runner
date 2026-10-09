import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseReviewedSharedSum, type ReviewedSharedSumV1 } from "@synapsor-runner/action-rules";
import { parseOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import { parseSharedSumQuestionBinding, type SharedSumQuestionBinding } from "./authoring-shared-sum-binding.js";

/** Prepare DATA for Main's existing protected save. This creates neither
 * native producer custody nor operator confirmation nor an authority grant. */
export function prepareSharedSumOperatorQuestion(input: { binding: SharedSumQuestionBinding; id?: string; revision?: number }): OperatorQuestion {
  const binding = parseSharedSumQuestionBinding(input.binding);
  const body = { version: 3 as const, id: input.id ?? randomUUID(), revision: input.revision ?? 1,
    kind: "shared_sum" as const, shared_sum: binding,
    scope_digest: canonicalJsonDigest(binding.designation), context_digest: binding.dependencies.context_digest,
    target: { phase: "shared_sum", outcomes: binding.dependencies.participating_outcomes },
    material: [], evidence: [], continuation: "action_rule_review" as const };
  return parseOperatorQuestion({ ...body, digest: canonicalJsonDigest(body) });
}

/** Compare only a host's inspected projection. The caller still resolves the
 * actual protected Question, native generation and complete writer registry. */
export function assertSharedSumQuestionDependencies(q: OperatorQuestion, current: SharedSumQuestionBinding["dependencies"]): void {
  const parsed = parseOperatorQuestion(q);
  if (!parsed.shared_sum || canonicalJsonDigest(parsed.shared_sum.dependencies) !== canonicalJsonDigest(current))
    throw new Error("AUTHORING_SHARED_SUM_CHANGED: Reinspect the current Source, catalog, generation, Read dependencies and complete participating Actions before consuming this review.");
}

/** A detached serializable projection, never a permit. Main consumes this
 * only after authentic native origin/currentness and explicit local operator
 * confirmation have been checked under the same Held publication boundary. */
export function projectReviewedSharedSumQuestion(q: OperatorQuestion): ReviewedSharedSumV1 {
  const parsed = parseOperatorQuestion(q), binding = parsed.shared_sum, confirmation = parsed.confirmation;
  if (!binding || !confirmation || parsed.disposition || parsed.proposal?.value?.kind !== "shared_sum")
    throw new Error("AUTHORING_SHARED_SUM_UNCONFIRMED: The exact typed meaning remains pending; no reviewed designation was projected.");
  return parseReviewedSharedSum({ schema_version: "synapsor.reviewed-shared-sum.v1", designation: binding.designation,
    confirmation: { ...confirmation, question: { id: parsed.id, revision: parsed.revision, digest: parsed.digest },
      context_digest: parsed.context_digest, source_digest: binding.dependencies.source_digest,
      catalog_digest: binding.dependencies.catalog_digest, generation_lock_fingerprint: binding.dependencies.generation_lock_fingerprint,
      read_dependencies: binding.dependencies.read_dependencies, designation_digest: canonicalJsonDigest(binding.designation) } });
}
