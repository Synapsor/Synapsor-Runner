import { canonicalJsonDigest as digest } from "@synapsor-runner/protocol";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BoundaryAuthoringResumeRead } from "./boundary-authoring-resume.js";
import { analyzeReadWorkloadSet, normalizeReadWorkloadSet, READ_WORKLOAD_SET_VERSION,
  type ReadWorkloadAnalysis, type ReadWorkloadSet } from "./read-workload-assist.js";
import { storeReadWorkloadAnalysis, type ReadWorkloadView } from "./read-workloads.js";

type Digest = `sha256:${string}`;
type Selection = Pick<BoundaryAuthoringResumeRead, "analysis_id" | "analysis_digest">;
export type ReadRevisionAnalysis = {
  selected: Selection;
  preview_digest: Digest;
  workload?: ReadWorkloadSet;
  analysis?: ReadWorkloadAnalysis;
} & ({ state: "analyzed"; workload: ReadWorkloadSet; analysis: ReadWorkloadAnalysis }
  | { state: "pending_mapping"; reason: "no_saved_workload" | "exact_plan_unavailable" | "retained_workload_blocked" });
const changed = (): never => { throw new Error("READ_REVISION_WORKLOAD_CHANGED: Reopen the exact selected Read workload; its revision was not inferred or replaced."); };

/** Recompile actual retained work, never representative authority cards or
 * placeholder filter values. The protected host owns current scope projection,
 * real preview creation, generation consumption and the later native decision. */
export function prepareReadRevisionAnalysis(input: {
  selected?: ReadWorkloadView;
  expected: Selection;
  currentBoundary: ExplorationBoundaryDraft;
  preparedCandidate: ExplorationBoundaryDraft;
  /** Optional still-live original input. Its digest must match the saved analysis. */
  originalWorkload?: ReadWorkloadSet;
  now?: number;
}): ReadRevisionAnalysis {
  const base = { selected: structuredClone(input.expected), preview_digest: explorationBoundaryCandidateDigest(input.preparedCandidate) };
  if (!input.selected) return { ...base, state: "pending_mapping", reason: "no_saved_workload" };
  const saved = input.selected;
  if (saved.analysis_id !== input.expected.analysis_id || saved.analysis_digest !== input.expected.analysis_digest
    || saved.state === "stale" || saved.state === "blocked" || saved.analysis.status !== "ready"
    || (saved.review?.candidate_digest ?? saved.generated_boundary_digest) !== explorationBoundaryCandidateDigest(input.currentBoundary)) changed();
  let workload: ReadWorkloadSet;
  if (input.originalWorkload) {
    workload = normalizeReadWorkloadSet(input.originalWorkload);
    // Existing compiler computes the owning workload digest; do not duplicate
    // its canonicalization or confuse normalized/redacted plan shapes with input.
    const original = analyzeReadWorkloadSet({ workload, generatedBoundary: input.currentBoundary, now: input.now });
    if (original.workload_digest !== saved.analysis.workload_digest) changed();
  } else {
    const entries = [...saved.analysis.allowed, ...saved.analysis.forbidden];
    if (!saved.analysis.allowed.length || entries.some(entry => !entry.plan_shape || !entry.normalized_plan_digest
      || digest(entry.plan_shape) !== entry.normalized_plan_digest))
      return { ...base, state: "pending_mapping", reason: "exact_plan_unavailable" };
    const copy = (values: typeof saved.analysis.allowed) => values.map(entry => ({ id: entry.id,
      description: entry.description, plan: structuredClone(entry.plan_shape!) }));
    workload = normalizeReadWorkloadSet({ schema_version: READ_WORKLOAD_SET_VERSION, name: saved.analysis.workload_name,
      source: structuredClone(saved.source), allowed: copy(saved.analysis.allowed), forbidden: copy(saved.analysis.forbidden) });
  }
  const analysis = analyzeReadWorkloadSet({ workload, generatedBoundary: input.preparedCandidate, now: input.now });
  return analysis.status === "ready" ? { ...base, state: "analyzed", workload, analysis }
    : { ...base, state: "pending_mapping", reason: "retained_workload_blocked", workload, analysis };
}

/** Called only after the existing guarded disabled save. This stores actual
 * compiler output, with no review marker, confirmation, activation or Resume
 * write. The host must save its exact native question/pointer through Resume CAS
 * and obtain the separate grouped decision before reusing this workload. */
export async function storeCommittedReadRevisionAnalysis(input: {
  projectRoot: string;
  prepared: ReadRevisionAnalysis;
  expected: Selection;
  committedCandidate: ExplorationBoundaryDraft;
}): Promise<ReadWorkloadView> {
  if (input.prepared.state !== "analyzed")
    throw new Error("READ_REVISION_MAPPING_PENDING: Retain the consumed revision and use ordinary mapping; no analysis was invented.");
  if (digest(input.prepared.selected) !== digest(input.expected)
    || input.prepared.preview_digest !== explorationBoundaryCandidateDigest(input.committedCandidate)) changed();
  return storeReadWorkloadAnalysis({ projectRoot: input.projectRoot, generatedBoundary: input.committedCandidate,
    source: input.prepared.workload.source, analysis: input.prepared.analysis });
}
