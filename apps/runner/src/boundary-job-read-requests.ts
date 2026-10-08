import { currentReadRequestBindings } from "./read-current-evidence.js";
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
  return currentReadRequestBindings(input);
}
