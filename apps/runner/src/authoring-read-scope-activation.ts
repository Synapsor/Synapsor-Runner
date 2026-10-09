import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, schemaFingerprintForInspection, type SchemaInspection } from "@synapsor-runner/schema-inspector";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { assertBoundaryAuthoringResumeCurrent, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { boundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { authoringDestination, loadPolicySources, policySourceSavedDigest, type AuthoringDestination } from "./authoring-policy-source.js";
import { ownerQuestionContextDigest, ownerQuestionScopeDigest } from "./authoring-owner-question-binding.js";
import { createNativeReadScope, type NativeReadScopeAssessment } from "./authoring-read-scope-native.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

export type ReadScopeActivationAssessmentInput = {
  projectRoot: string;
  candidate: ExplorationBoundaryDraft;
  /** Actual reader inspection captured by activation after its human wait. */
  readerInspection: SchemaInspection;
  permit: ProjectAuthorityMutationPermit;
  /** Only a resolved current endpoint identity; no provider client or credentials. */
  currentDestination?: AuthoringDestination;
};

function unavailable(detail: string): Error {
  return Object.assign(new Error(`READ_SCOPE_ACTIVATION_CONTEXT_UNAVAILABLE: ${detail} Reopen the saved Read review; no authority was changed.`),
    { code: "READ_SCOPE_ACTIVATION_CONTEXT_UNAVAILABLE" });
}

/** Read-only hydration of the existing native owner. This neither confirms the
 * scope nor activates authority; the caller retains its protected activation save. */
export async function assessReadScopeForActivation(input: ReadScopeActivationAssessmentInput): Promise<NativeReadScopeAssessment> {
  // An omitted permit must never silently acquire a new independent writer lease.
  if (!input.permit) throw unavailable("The current activation permit is required.");
  const expected = structuredClone({ candidate: input.candidate, reader: input.readerInspection,
    destination: input.currentDestination });
  return withProjectAuthorityMutation(input.projectRoot, async permit => {
    const context = await loadBoundaryReviewContext(input.projectRoot, permit);
    const candidateDigest = explorationBoundaryCandidateDigest(expected.candidate);
    const readerSchema = schemaFingerprintForInspection(expected.reader), readerRole = rolePostureFingerprint(expected.reader);
    if (explorationBoundaryCandidateDigest(context.candidate) !== candidateDigest
      || expected.reader.engine !== context.lock.engine || readerSchema !== context.lock.schema_fingerprint
      || readerRole !== context.lock.role_posture_fingerprint)
      throw unavailable("The selected candidate or reader inspection changed.");
    const loaded = await readBoundaryAuthoringResumeState(input.projectRoot, boundaryAuthoringResumeBinding(context.bundle));
    if (loaded.status === "none") return { kind: "missing", status: "pending", candidate_digest: candidateDigest };
    if (loaded.status !== "ready") throw unavailable(`The saved setup is ${loaded.status}: ${loaded.reason}.`);
    const resume = structuredClone(loaded.value);
    const sources = resume.policy_source_session ? await loadPolicySources(input.projectRoot, resume.policy_source_session) : undefined;
    const sourceDigest = sources ? canonicalJsonDigest(sources) : undefined;
    const assertCurrent = async (held?: ProjectAuthorityMutationPermit) => {
      if (!held) throw unavailable("The current activation permit is required.");
      await assertBoundaryAuthoringResumeCurrent(input.projectRoot, resume, undefined, { permit: held });
      if (sources && await policySourceSavedDigest(input.projectRoot, sources.id) !== sourceDigest)
        throw unavailable("The exact saved Source changed.");
      const current = await loadBoundaryReviewContext(input.projectRoot, held);
      if (explorationBoundaryCandidateDigest(current.candidate) !== candidateDigest
        || canonicalJsonDigest(current.bundle.mutation_bindings) !== canonicalJsonDigest(context.bundle.mutation_bindings))
        throw unavailable("The current Read selection or protected binding changed.");
    };
    const model = () => {
      const destination = expected.destination ?? (resume.model.provider === "openai_compatible" ? undefined
        : { provider: resume.model.provider, model: resume.model.name });
      if (!destination || destination.provider !== resume.model.provider || destination.model !== resume.model.name)
        throw unavailable("The exact saved model destination is unavailable.");
      const resolved = authoringDestination(destination);
      if ((resume.model.provider === "openai_compatible" && !resume.metadata_destination_digest)
        || (resume.metadata_destination_digest && canonicalJsonDigest(resolved) !== resume.metadata_destination_digest))
        throw unavailable("The current destination does not match the saved metadata permission.");
      return { provider: resume.model.provider, model: resume.model.name, destination: resolved };
    };
    const scope = () => ownerQuestionScopeDigest({ job: resume.job_intent,
      pendingJobRevision: resume.pending_job_revision, pendingReadRevision: resume.pending_read_revision,
      readRevision: resume.pending_read_revision_state, model: model() });
    const readonly = (): never => { throw unavailable("Activation assessment cannot mutate or interact with the authoring job."); };
    const owner = createNativeReadScope({ projectRoot: input.projectRoot, ports: {
      snapshot: () => ({ resume, revision: resume.revision_digest, blocked: false,
        questions: resume.operator_questions ?? [], handoffs: resume.owner_handoffs ?? [],
        generation: resume.generation_recovery, read: resume.read, sources }),
      assertCurrent, questionScope: scope,
      questionContext: async held => {
        await assertCurrent(held);
        return ownerQuestionContextDigest({ scope: scope(), binding: boundaryAuthoringResumeBinding(context.bundle),
          candidate: context.candidate, sources, readerSchema, readerRole });
      },
      mutate: async () => readonly(), save: async () => readonly(), failure: unavailable,
    }, interact: async () => readonly() });
    const result = await owner.assess(expected.candidate, permit);
    await assertCurrent(permit);
    return result;
  }, { permit: input.permit });
}
