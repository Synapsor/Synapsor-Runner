import { readScopeProposalCodec, type ReadScopeProposal } from "./read-structured-scope.js";
import type { ReadWorkloadAnalysis } from "./read-workload-assist.js";

/** Only offers exact typed targets for the existing structural review. This
 * establishes no policy applicability, shared-access permission or activation. */
export function requestedSharedCatalogResources<T extends { resource_id: string }>(
  resources: readonly T[], proposal: ReadScopeProposal | undefined,
): T[] {
  if (!proposal) return [];
  const parsed = readScopeProposalCodec.parse(proposal);
  const requested = new Set(parsed.requirements.filter(item => item.disposition === "include")
    .flatMap(item => [...item.targets.flatMap(target => [target.resource, target.root_resource]),
      ...item.subjects.map(subject => subject.root_resource)]));
  return resources.filter(resource => requested.has(resource.resource_id));
}

/** Every analyzed plan counts, including host-produced support. Names and
 * descriptions neither erase a plan nor establish support. */
export function analyzedReadCoverage(analysis: Pick<ReadWorkloadAnalysis, "allowed">) {
  return { supported: analysis.allowed.filter(plan => plan.status === "supported").length,
    total: analysis.allowed.length };
}
