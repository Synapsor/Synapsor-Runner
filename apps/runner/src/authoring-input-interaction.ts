import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { PolicySourceChangedError } from "./authoring-policy-source.js";

type Digest = `sha256:${string}`;
/** A derived expectation, never a stored cursor or a permission. Budget changes
 * remain subject to the existing exact-save/monotonic checks, independently of
 * the semantic identity of the question being answered. */
export type InputInteractionBinding = {
  root_id: string;
  root_semantic_digest: Digest;
  question_id: string;
  question_revision: number;
  question_semantic_digest: Digest;
  context_digest: Digest;
  scope_digest: Digest;
  proposal_digest?: Digest;
};

export type InputInteraction =
  | { kind: "question"; binding: InputInteractionBinding; text: string; material: readonly string[];
      preserveWhitespace: true; recordPolicyAnswer: false }
  | { kind: "readback"; binding: InputInteractionBinding; lines: readonly string[]; defaultValue: false }
  | { kind: "pending"; binding: InputInteractionBinding; material: readonly string[];
      sourceInterpretation: boolean; canAnswer: boolean; defaultValue: "keep" };

export type InputInteractionResponse =
  | { kind: "answer"; binding: InputInteractionBinding; raw: string | null }
  | { kind: "decision"; binding: InputInteractionBinding; accepted: boolean | null }
  | { kind: "pending"; binding: InputInteractionBinding; choice: "keep" | "answer" };

export function inputInteractionBinding(root: OperatorQuestion, question: OperatorQuestion): InputInteractionBinding {
  const semantic = (q: OperatorQuestion): Digest => {
    const { digest: _digest, budget: _budget, ...body } = q;
    return canonicalJsonDigest(body);
  };
  return { root_id: root.id, root_semantic_digest: semantic(root), question_id: question.id,
    question_revision: question.revision, question_semantic_digest: semantic(question),
    context_digest: question.context_digest, scope_digest: question.scope_digest,
    ...(question.proposal ? { proposal_digest: canonicalJsonDigest(question.proposal) } : {}) };
}

/** Both the CLI and a headless operator answer this same view. They supply only
 * words or a decision; they cannot supply a review, actor, handoff or completion. */
export function assertInputInteractionResponse(view: InputInteraction, response: InputInteractionResponse): void {
  if (canonicalJsonDigest(view.binding) !== canonicalJsonDigest(response.binding)
    || view.kind === "question" && (response.kind !== "answer" || response.raw !== null && typeof response.raw !== "string")
    || view.kind === "readback" && (response.kind !== "decision" || response.accepted !== null && typeof response.accepted !== "boolean")
    || view.kind === "pending" && (response.kind !== "pending" || !["keep", "answer"].includes(response.choice)
      || !view.canAnswer && response.choice !== "keep")) throw new PolicySourceChangedError();
}
