import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, hasReviewedPrincipalScope } from "./auto-boundary.js";
import { applicableBoundaryReviewConfirmations, boundaryReviewDecisions } from "./boundary-review-domain.js";
import type { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { readSubjectConfigurationDigest, readSubjectScopeKind, type ReadSubjectBinding } from "./read-structured-scope.js";

type Digest = `sha256:${string}`;
export type ReadSubjectReviewContext = Awaited<ReturnType<typeof loadBoundaryReviewContext>>;
/** Pure projection of an already-loaded coherent native review. This neither
 * records a confirmation nor treats configured columns as acknowledgment. */
export function projectReadSubjectContext(input: { context: ReadSubjectReviewContext; sourceDigest: Digest }): {
  subject_scopes: ReadSubjectBinding[];
  descriptions: Array<{ root_resource: string; kind: ReadSubjectBinding["kind"]; text: string }>;
} {
  const { candidate, draft, progress, bundle, lock } = input.context;
  const changed = (): never => { throw new Error("READ_SUBJECT_CONTEXT_CHANGED: Reopen the current acknowledged structural review. No subject scope was established."); };
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.sourceDigest)) changed();
  const candidateDigest = explorationBoundaryCandidateDigest(candidate);
  const { bundle_digest, mutation_bindings, ...bundleBody } = bundle;
  if (bundle_digest !== d(bundleBody) || bundle.candidate_digest !== candidateDigest
    || explorationBoundaryCandidateDigest(bundle.candidate) !== candidateDigest
    || mutation_bindings.candidate_digest !== candidateDigest
    || mutation_bindings.draft_digest !== explorationBoundaryCandidateDigest(draft)
    || mutation_bindings.schema_fingerprint !== lock.schema_fingerprint
    || mutation_bindings.role_posture_fingerprint !== lock.role_posture_fingerprint
    || bundle.authority.schema_fingerprint !== lock.schema_fingerprint
    || bundle.authority.role_posture_fingerprint !== candidate.role_posture_fingerprint
    || candidate.role_posture_fingerprint !== lock.role_posture_fingerprint
    || mutation_bindings.generation_lock_fingerprint !== draft.generation_lock_fingerprint
    || candidate.generation_lock_fingerprint !== draft.generation_lock_fingerprint) changed();
  if (!progress) return { subject_scopes: [], descriptions: [] };
  if (progress.draft_digest !== explorationBoundaryCandidateDigest(draft)
    || progress.candidate_digest !== candidateDigest
    || explorationBoundaryCandidateDigest(progress.candidate) !== candidateDigest
    || mutation_bindings.review_revision !== progress.revision
    || progress.policy_migration.status !== "complete") changed();
  const decisions = boundaryReviewDecisions(candidate);
  if (new Set(decisions.map(decision => decision.id)).size !== decisions.length
    || new Set(progress.confirmations.map(confirmation => confirmation.id)).size !== progress.confirmations.length) changed();
  const applicable = applicableBoundaryReviewConfirmations(candidate, progress.confirmations, input.context.resolvedOrigins);
  type SubjectDecisionBinding =
    | { kind: "trusted_context" | "database_role" | "organization_scope" }
    | { kind: "tenant_scope" | "principal_scope"; resource_id: string };
  const acknowledged = (binding: SubjectDecisionBinding) => {
    const matches = decisions.filter(decision => decision.kind === binding.kind
      && ("resource_id" in binding
        ? "resource_id" in decision && decision.resource_id === binding.resource_id
        : !("resource_id" in decision)));
    if (matches.length !== 1) return undefined;
    const { decision: _display, ...reference } = matches[0]!;
    const confirmed = applicable.find(item => d(item.current) === d(reference));
    const confirmation = confirmed?.confirmation;
    const advertised = bundle.decisions.some(({ decision: _display, confirmed: _cached, ...item }) => d(item) === d(reference));
    if (!confirmation || confirmation.status !== "confirmed" || !confirmation.actor.trim()
      || !confirmation.confirmed_at || !advertised) return undefined;
    // Applicability belongs to the existing review owner. Cached display text
    // and its display flag cannot create or remove a typed acknowledgment.
    return { id: reference.id, kind: reference.kind,
      resource_id: "resource_id" in reference ? reference.resource_id : null,
      input_digest: reference.input_digest, acknowledgement: d({ actor: confirmation.actor, confirmed_at: confirmation.confirmed_at }) };
  };
  // Verified role posture can have no outstanding role decision. Require its
  // acknowledgment only when the existing native review actually defines one;
  // the coherent schema/role fingerprints above remain mandatory in either case.
  const globals = [acknowledged({ kind: "trusted_context" }),
    ...(decisions.some(decision => decision.kind === "database_role" && !("resource_id" in decision)) ? [acknowledged({ kind: "database_role" })] : []),
    ...(candidate.organization_scope ? [acknowledged({ kind: "organization_scope" })] : [])];
  if (globals.some(value => !value)) return { subject_scopes: [], descriptions: [] };
  const subject_scopes: ReadSubjectBinding[] = [], descriptions: Array<{ root_resource: string; kind: ReadSubjectBinding["kind"]; text: string }> = [];
  for (const resource of candidate.pack.resources) {
    if (resource.relationship_only) continue;
    const relevant = [...globals, acknowledged({ kind: "tenant_scope", resource_id: resource.id }),
      ...(hasReviewedPrincipalScope(resource) ? [acknowledged({ kind: "principal_scope", resource_id: resource.id })] : [])];
    if (relevant.some(value => !value)) continue;
    const configuration_digest = readSubjectConfigurationDigest(resource, candidate);
    const review_digest = d({ boundary_id: progress.boundary_id, root_resource: resource.id,
      source_digest: input.sourceDigest, schema_fingerprint: lock.schema_fingerprint,
      role_posture_fingerprint: lock.role_posture_fingerprint, configuration_digest, acknowledgements: relevant });
    const kind = readSubjectScopeKind(resource);
    subject_scopes.push({ root_resource: resource.id, reference: `subject-scope:${review_digest.slice(7)}`,
      source_digest: input.sourceDigest, review_digest, configuration_digest, kind });
    descriptions.push({ root_resource: resource.id, kind, text: kind === "principal"
      ? "Only records belonging to the signed-in person under the currently reviewed structural scope."
      : kind === "tenant" ? "Records within the currently reviewed organization scope; not restricted to one person."
      : resource.shared_reference_scope ? "Reviewed shared-reference records with no tenant or per-person predicate."
      : "Reviewed whole-organization records with no per-person predicate." });
  }
  return { subject_scopes, descriptions };
}
