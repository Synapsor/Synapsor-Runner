import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readActionRuleReviewSubjects } from "./action-rule-authority.js";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import type { ActionParameterInteractionPorts } from "./authoring-action-parameter-interaction.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { createTypedParameterHost } from "./authoring-typed-parameter-host.js";
import { resolveTypedParameterSourceRecords, type TypedParameterCompilerContext } from "./authoring-typed-parameter-source.js";
import type { TypedParameterBinding } from "./authoring-typed-parameter-binding.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

type Digest = `sha256:${string}`;
/** Detached projection of ONE current native read. The native owner resolves
 * current inspection/Read and selected checkpoint slots; no whole session port. */
export type NativeTypedParameterSnapshot = {
  resume_revision: Digest;
  questions: readonly OperatorQuestion[];
  handoffs: readonly AuthoringOwnerHandoff[];
  generation?: AuthoringTransportState;
  checkpoints: readonly ActionRuleAuthoringCheckpoint[];
  compiler_context: TypedParameterCompilerContext;
};
export type NativeTypedParameterPorts = {
  loadCurrent(permit?: ProjectAuthorityMutationPermit): Promise<NativeTypedParameterSnapshot>;
  /** Native owner verifies revision, selected question applicability/current
   * Source/Read/schema/role and trusted local operator scope. */
  assertCurrent(expected: { resume_revision: Digest; binding: TypedParameterBinding }, permit?: ProjectAuthorityMutationPermit): Promise<void>;
  mutate<T>(operation: (permit: ProjectAuthorityMutationPermit) => Promise<T>): Promise<T>;
  /** Native owner alone writes protected Resume/CAS and updates its memory.
   * Return only after durable save; never acknowledge a staged memory write. */
  saveQuestions(input: { expected_resume_revision: Digest; expected_questions_digest: Digest; questions: OperatorQuestion[] },
    permit: ProjectAuthorityMutationPermit): Promise<{ resume_revision: Digest; questions_digest: Digest }>;
};
function acknowledgementChanged(): never {
  throw new Error("TYPED_PARAMETER_NATIVE_ACK_CHANGED: The native save did not acknowledge the exact question history. Inspect retained state; no completion or retry was inferred.");
}
const digest = (value: unknown): value is Digest => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);

/** Compose existing host/domain/source owners for an already-created native
 * question. Every operation has a new detached snapshot. No snapshot, candidate
 * or mutation permit survives a call or a later human wait. */
export function createNativeTypedParameterAdapter(input: {
  projectRoot: string;
  question_id: string;
  ports: NativeTypedParameterPorts;
  /** Runner-owned canonical business projector, never model narration. */
  businessLines(compiled: CompiledActionRuleModelDraftV1): readonly string[];
}): ActionParameterInteractionPorts {
  const withHost = async <T>(operation: (host: ActionParameterInteractionPorts) => Promise<T>, permit?: ProjectAuthorityMutationPermit): Promise<T> => {
    const snapshot = structuredClone(await input.ports.loadCurrent(permit));
    if (!digest(snapshot.resume_revision)) acknowledgementChanged();
    const originalQuestionsDigest = canonicalJsonDigest(snapshot.questions);
    let questions = [...snapshot.questions];
    const assertCurrent = (binding: TypedParameterBinding) => input.ports.assertCurrent({ resume_revision: snapshot.resume_revision, binding }, permit);
    const host = createTypedParameterHost({ question_id: input.question_id, access: {
      readQuestions: () => questions,
      readHandoffs: () => snapshot.handoffs,
      readRecovery: () => snapshot.generation,
      assertFresh: binding => assertCurrent(binding),
      resolve: async binding => {
        await assertCurrent(binding);
        const subjects = [binding.baseline, binding.origin].some(ref => ref.kind === "saved_authority")
          ? await readActionRuleReviewSubjects(input.projectRoot) : [];
        const resolved = resolveTypedParameterSourceRecords({ binding,
          records: { subjects, checkpoints: snapshot.checkpoints, generation: snapshot.generation },
          context: snapshot.compiler_context, businessLines: input.businessLines });
        await assertCurrent(binding);
        return resolved;
      },
      // Mutations enter through the outer native owner exactly once. The host's
      // existing callback reuses that permit, without a second lease/queue.
      mutate: async operation => {
        if (!permit) throw new Error("TYPED_PARAMETER_NATIVE_PERMIT_REQUIRED: Reopen the protected field operation; no question was saved.");
        return operation(permit);
      },
      installQuestions: next => { questions = structuredClone(next); },
      save: async held => {
        if (!permit || held !== permit) acknowledgementChanged();
        const expected = canonicalJsonDigest(questions);
        const ack = await input.ports.saveQuestions({ expected_resume_revision: snapshot.resume_revision,
          expected_questions_digest: originalQuestionsDigest, questions: structuredClone(questions) }, held);
        if (!ack || Object.keys(ack).some(key => key !== "resume_revision" && key !== "questions_digest")
          || !digest(ack.resume_revision) || ack.questions_digest !== expected
          || expected !== originalQuestionsDigest && ack.resume_revision === snapshot.resume_revision) acknowledgementChanged();
        // No post-save latest read: a concurrent future revision cannot replace
        // this exact durable ACK or conceal an already committed operation.
      },
    } });
    return operation(host);
  };
  return {
    loadCurrent: () => withHost(host => host.loadCurrent()),
    assertCurrent: expected => withHost(host => host.assertCurrent(expected)),
    submitField: request => input.ports.mutate(permit => withHost(host => host.submitField(request), permit)),
    recordDecision: request => input.ports.mutate(permit => withHost(host => host.recordDecision(request), permit)),
  };
}
