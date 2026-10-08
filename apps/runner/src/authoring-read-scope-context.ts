import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { assertCurrentAuthoringEnvelope, parseStructuredAuthoringProtocol } from "./authoring-protocol.js";
import { activePolicySource, type PolicySourceSession } from "./authoring-policy-source.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { projectReadScopeHostContext, type ReadScopeHostContextInput } from "./read-current-evidence.js";
import { readWorkloadCatalog } from "./read-workload-model.js";

/** The public host supplies an acknowledged job and currently inspected Read
 * candidate. Source egress consent and native CAS remain its protected ports.
 * These identities describe applicability, never an interpretation or grant. */
export function projectAuthoringReadScopeContext(input: {
  resume: BoundaryAuthoringResumeState;
  boundary: ExplorationBoundaryDraft;
  sources?: PolicySourceSession;
  principalScopedRootResources?: readonly string[];
  records: NonNullable<ReadScopeHostContextInput["records"]>;
  answerQuestionIds?: readonly string[];
  native?: ReadScopeHostContextInput["native"];
}) {
  assertCurrentAuthoringEnvelope(input.resume);
  const protocol = parseStructuredAuthoringProtocol(input.resume.authoring_protocol);
  if (input.resume.binding.boundary_name !== input.boundary.pack.name)
    throw new Error("READ_SCOPE_CONTEXT_INVALID: The selected Read candidate belongs to a different saved setup.");
  const source = activePolicySource(input.sources);
  if (input.resume.policy_source_session !== (source ? input.sources!.id : undefined))
    throw new Error("READ_SCOPE_CONTEXT_INVALID: The saved setup's exact Source attachment is unavailable or changed.");
  const job = { created_at: input.resume.created_at, boundary_name: input.resume.binding.boundary_name };
  const request = { id: `job:${canonicalJsonDigest(job)}`, text: input.resume.job_intent };
  const catalog = readWorkloadCatalog(input.boundary, input.principalScopedRootResources);
  return projectReadScopeHostContext({ request,
    ...(source ? { source: { session_id: input.sources!.id, snapshot: source } } : {}),
    catalog: { digest: catalog.digest, resources: catalog.resources,
      relationships: catalog.resources.flatMap(resource => resource.relationships.map(relationship => ({
        id: relationship.id, from: resource.id, to: relationship.target_resource,
      }))) },
    binding: {
      meaning_digest: canonicalJsonDigest({ protocol, request, source: source ? { session_id: input.sources!.id, digest: source.digest } : null }),
      applicability_digest: canonicalJsonDigest({ job, purpose: "original_read_task" }),
      operation_digest: canonicalJsonDigest({ binding: input.resume.binding, candidate: explorationBoundaryCandidateDigest(input.boundary) }),
    }, records: input.records, answerQuestionIds: input.answerQuestionIds, native: input.native });
}
