import { describe, expect, it } from "vitest";
import { currentBoundaryJobReadRequests } from "./boundary-job-read-requests.js";
import type { ReadWorkloadView } from "./read-workloads.js";

// Unit projection only; public CLI proof uses native persisted workload records.
function projection(): ReadWorkloadView {
  return { state: "reviewed", generated_boundary_digest: "sha256:current",
    review: { analyzed_candidate_digest: "sha256:analysis", candidate_digest: "sha256:current" },
    analysis: { status: "ready", candidate_digest: "sha256:analysis",
      candidate: { pack: { resources: [{ id: "club.members" }] } },
      allowed: [{ description: "Read member expiry dates.", status: "supported", plan_shape: { resource: "club.members" },
        authority_atoms: [{ root_resource: "club.members" }] }],
    },
  } as unknown as ReadWorkloadView;
}
const candidateDigests = new Set(["sha256:current"]);
describe("current native Read request projection", () => {
  it("carries an exact supported current reviewed mapping", () => {
    const workload = projection(), before = structuredClone(workload);
    expect(currentBoundaryJobReadRequests({ workloads: [workload], candidateDigests, mode: "reviewed" }))
      .toEqual([{ description: "Read member expiry dates.", resource_ids: ["club.members"] }]);
    expect(workload).toEqual(before);
  });
  it.each(["stale", "blocked", "analysis_changed", "candidate_changed", "unsupported", "missing_plan", "unknown_root", "inventory_only"])("does not carry %s evidence", control => {
    const workload = projection();
    if (control === "stale" || control === "blocked") workload.state = control;
    if (control === "analysis_changed") workload.review!.analyzed_candidate_digest = "sha256:changed";
    if (control === "candidate_changed") workload.review!.candidate_digest = "sha256:changed";
    if (control === "unsupported") workload.analysis.allowed[0]!.status = "blocked";
    if (control === "missing_plan") delete workload.analysis.allowed[0]!.plan_shape;
    if (control === "unknown_root") workload.analysis.allowed[0]!.authority_atoms[0]!.root_resource = "archive.members";
    if (control === "inventory_only") workload.analysis.allowed = [];
    expect(currentBoundaryJobReadRequests({ workloads: [workload], candidateDigests, mode: "reviewed" })).toEqual([]);
  });
  it("keeps a current unreviewed resumable mapping separate from reviewed reuse", () => {
    const workload = projection(); delete workload.review; workload.state = "ready";
    expect(currentBoundaryJobReadRequests({ workloads: [workload], candidateDigests, mode: "reviewed" })).toEqual([]);
    expect(currentBoundaryJobReadRequests({ workloads: [workload], candidateDigests, mode: "resumable" }))
      .toEqual([{ description: "Read member expiry dates.", resource_ids: ["club.members"] }]);
    workload.generated_boundary_digest = "sha256:changed";
    expect(currentBoundaryJobReadRequests({ workloads: [workload], candidateDigests, mode: "resumable" })).toEqual([]);
  });
});
