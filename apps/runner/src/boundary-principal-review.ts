import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryReviewDecision } from "./boundary-review-progress-types.js";

type Resource = ExplorationBoundaryDraft["pack"]["resources"][number];
type Context = Pick<ExplorationBoundaryDraft, "trusted_context" | "source" | "role_posture_fingerprint">;

/** One native owner for the principal review identity and its presentation.
 * Inputs are actual structural configuration, never operator/model prose. */
export function principalScopeReviewDecision(resource: Resource, context: Context): BoundaryReviewDecision {
  const trusted = context.trusted_context.provider === "http_claims"
    ? { trusted_principal_http_claim: context.trusted_context.principal_claim }
    : { trusted_principal_env: context.trusted_context.principal_env };
  const derived = !resource.principal_key && resource.principal_scope;
  const rls = !resource.principal_key && !derived && resource.rls_session?.principal_setting;
  const detail = resource.principal_key ? `confirm principal scope ${resource.principal_key}`
    : derived ? `confirm mandatory derived principal scope via ${derived.path_id} to ${derived.ancestor_resource}.${derived.ancestor_column}`
    : rls ? `confirm database-enforced principal scope through PostgreSQL RLS setting ${rls}`
    : "confirm principal scope not configured";
  // Keep existing direct/derived/no-scope bindings byte-for-byte compatible.
  // RLS gains a real typed review binding, including its effective role/source.
  const reviewedInput = derived
    ? { principal_scope: derived, ...trusted, rls_session: resource.rls_session ?? null }
    : rls ? { principal_scope_kind: "postgres_rls", ...trusted, rls_session: resource.rls_session,
      source: context.source, role_posture_fingerprint: context.role_posture_fingerprint }
    : { principal_key: resource.principal_key ?? null, ...trusted, rls_session: resource.rls_session ?? null };
  return { id: `resource.${resource.id}.principal_scope`, kind: "principal_scope", resource_id: resource.id,
    decision: `${resource.id}: ${detail}`,
    input_digest: canonicalJsonDigest({ schema_version: "synapsor.boundary-review-input.v1",
      decision_kind: "principal_scope", reviewed_input: reviewedInput }) };
}
