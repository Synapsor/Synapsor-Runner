import type { ExactReadRequestBinding } from "./read-requested-scope.js";
import type { ReadWorkloadView } from "./read-workloads.js";

/** Carry only current native workload associations into planning. The caller
 * supplies the exact candidate digests already admitted by its current review
 * inspection. Existing-capability inventory and model narration have no request
 * association and cannot manufacture one here. This grants no new authority. */
export function currentBoundaryJobReadRequests(input: {
  workloads: readonly ReadWorkloadView[];
  candidateDigests: ReadonlySet<string>;
  mode: "reviewed" | "resumable";
}): ExactReadRequestBinding[] {
  return input.workloads.flatMap(workload => {
    const analysis = workload.analysis;
    if (analysis.status !== "ready" || !analysis.candidate_digest || !analysis.candidate
      || workload.state === "stale" || workload.state === "blocked") return [];
    const current = input.mode === "reviewed"
      ? workload.review?.analyzed_candidate_digest === analysis.candidate_digest
        && input.candidateDigests.has(workload.review.candidate_digest)
      : workload.review
        ? workload.review.analyzed_candidate_digest === analysis.candidate_digest
          && input.candidateDigests.has(workload.review.candidate_digest)
        : input.candidateDigests.has(workload.generated_boundary_digest);
    if (!current) return [];
    const resources = new Set(analysis.candidate.pack.resources.map(resource => resource.id));
    return analysis.allowed.flatMap(entry => {
      const roots = [...new Set(entry.authority_atoms.map(atom => atom.root_resource))].sort();
      if (entry.status !== "supported" || !entry.plan_shape || !roots.length
        || roots.some(root => !resources.has(root))) return [];
      return [{ description: entry.description, resource_ids: roots }];
    });
  });
}
