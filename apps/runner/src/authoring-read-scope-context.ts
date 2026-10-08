import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import { assertCurrentAuthoringEnvelope, parseStructuredAuthoringProtocol } from "./authoring-protocol.js";
import { activePolicySource, type PolicySourceSession } from "./authoring-policy-source.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { projectReadScopeHostContext, type ReadScopeHostContextInput } from "./read-current-evidence.js";
import { projectReadSubjectContext, type ReadSubjectReviewContext } from "./authoring-read-subject-context.js";
import { explorationBoundaryCandidateDigest as candidateDigest } from "./auto-boundary.js";
import { readSubjectConfigurationDigest, type ReadSubjectBinding } from "./read-structured-scope.js";
import { projectBoundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { readWorkloadCatalog } from "./read-workload-model.js";

/** The public host supplies an acknowledged job and currently inspected Read
 * candidate. Source egress consent and native CAS remain its protected ports.
 * These identities describe applicability, never an interpretation or grant. */
export type AuthoringReadScopeContextInput = {
  resume: BoundaryAuthoringResumeState;
  boundary: ExplorationBoundaryDraft;
  sources?: PolicySourceSession;
  structuralReview?: ReadSubjectReviewContext;
  records: NonNullable<ReadScopeHostContextInput["records"]>;
  answerQuestionIds?: readonly string[];
  native?: ReadScopeHostContextInput["native"];
};
export function projectAuthoringReadScopeContext(input: AuthoringReadScopeContextInput) {
  if (input.structuralReview && candidateDigest(input.structuralReview.candidate) !== candidateDigest(input.boundary))
    throw new Error("READ_SUBJECT_CONTEXT_CHANGED: The native structural review does not match this Read candidate.");
  const source = activePolicySource(input.sources);
  const subjects = input.structuralReview ? projectReadSubjectContext({ context: input.structuralReview,
    sourceDigest: (source?.digest ?? canonicalJsonDigest(null)) as `sha256:${string}` }).subject_scopes : [];
  return project(input, subjects);
}

/** A prepared mutation is not a future acknowledged structural review. Reuse
 * only exact current subject configurations that survive the preview; every
 * changed/new configuration stays absent until its real review owner acts. */
export function projectAuthoringReadScopePreview(input: AuthoringReadScopeContextInput & {
  structuralReview: ReadSubjectReviewContext; preparedCandidate: ExplorationBoundaryDraft; preparedLock: GenerationLock;
}) {
  const current = projectAuthoringReadScopeContext(input);
  const preview = input.preparedCandidate;
  const lock = input.preparedLock, currentLock = input.structuralReview.lock;
  // A real prepared mutation changes contract/override lock members. Bind that
  // exact lock while preserving inspected identity; never invent a future review.
  const inspected = (value: GenerationLock) => ({ engine: value.engine, source_env: value.source_env,
    inspected_schema: value.inspected_schema, schema_fingerprint: value.schema_fingerprint,
    role_posture_fingerprint: value.role_posture_fingerprint, database_server_version: value.database_server_version,
    database_server_tier: value.database_server_tier, database_server_authority: value.database_server_authority });
  if (preview.source !== input.boundary.source || canonicalJsonDigest(lock) !== preview.generation_lock_fingerprint
    || preview.role_posture_fingerprint !== lock.role_posture_fingerprint
    || canonicalJsonDigest(inspected(lock)) !== canonicalJsonDigest(inspected(currentLock)))
    throw new Error("READ_SUBJECT_CONTEXT_CHANGED: The prepared revision changed its inspected Source, schema or role binding.");
  const subjects = (current.catalog.subject_scopes ?? []).filter(subject => {
    const resource = preview.pack.resources.find(resource => resource.id === subject.root_resource);
    return resource && readSubjectConfigurationDigest(resource, preview) === subject.configuration_digest;
  });
  // The consumed proposal must already bind the exact identity that the guarded
  // save will produce. This local projection never writes/revalidates a Resume.
  const resume = { ...input.resume, binding: projectBoundaryAuthoringResumeBinding(preview, lock) };
  return project({ ...input, resume, boundary: preview, native: undefined }, subjects);
}

function project(input: AuthoringReadScopeContextInput, subjects: readonly ReadSubjectBinding[]) {
  assertCurrentAuthoringEnvelope(input.resume);
  const protocol = parseStructuredAuthoringProtocol(input.resume.authoring_protocol);
  if (input.resume.binding.boundary_name !== input.boundary.pack.name)
    throw new Error("READ_SCOPE_CONTEXT_INVALID: The selected Read candidate belongs to a different saved setup.");
  const source = activePolicySource(input.sources);
  if (input.resume.policy_source_session !== (source ? input.sources!.id : undefined))
    throw new Error("READ_SCOPE_CONTEXT_INVALID: The saved setup's exact Source attachment is unavailable or changed.");
  const job = { created_at: input.resume.created_at, boundary_name: input.resume.binding.boundary_name };
  const request = { id: `job:${canonicalJsonDigest(job)}`, text: input.resume.job_intent };
  const catalog = readWorkloadCatalog(input.boundary);

  return projectReadScopeHostContext({ request,
    ...(source ? { source: { session_id: input.sources!.id, snapshot: source } } : {}),
    catalog: { digest: catalog.digest, resources: catalog.resources, subject_scopes: subjects,
      relationships: catalog.resources.flatMap(resource => resource.relationships.map(relationship => ({
        id: relationship.id, from: resource.id, to: relationship.target_resource,
      }))) },
    binding: {
      meaning_digest: canonicalJsonDigest({ protocol, request, source: source ? { session_id: input.sources!.id, digest: source.digest } : null }),
      applicability_digest: canonicalJsonDigest({ job, purpose: "original_read_task" }),
      operation_digest: canonicalJsonDigest({ binding: input.resume.binding, candidate: explorationBoundaryCandidateDigest(input.boundary) }),
    }, records: input.records, answerQuestionIds: input.answerQuestionIds, native: input.native });
}
