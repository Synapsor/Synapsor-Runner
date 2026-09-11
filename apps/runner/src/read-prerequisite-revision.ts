import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { explorationBoundaryCandidateDigest, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { prepareExactBoundaryCandidateMutation, type BoundaryReviewMutationBindings } from "./boundary-review-mutation.js";
import { assertReviewedReadCurrentStatePrerequisite, type ReviewedReadCurrentStatePrerequisite } from "./read-prerequisite.js";
import { assertReadPrerequisiteRetained } from "./read-prerequisite-preservation.js";

export async function prepareReadPrerequisiteRevision(input: {
  projectRoot: string;
  previous: ExplorationBoundaryDraft;
  prerequisite: ReviewedReadCurrentStatePrerequisite;
  bindings: BoundaryReviewMutationBindings;
  actor: string;
  schemaInspector?: typeof inspectDatabase;
}) {
  const candidate = { ...structuredClone(input.previous), read_prerequisite: structuredClone(input.prerequisite) };
  assertReadPrerequisiteRetained(input.previous, candidate);
  const inspector: typeof inspectDatabase = async (request) => {
    const inspection = await (input.schemaInspector ?? inspectDatabase)(request);
    assertReviewedReadCurrentStatePrerequisite(input.prerequisite, inspection);
    return inspection;
  };
  return prepareExactBoundaryCandidateMutation(input.projectRoot, {
    candidate,
    expected_generated_boundary_digest: explorationBoundaryCandidateDigest(input.previous),
    expected_candidate_digest: explorationBoundaryCandidateDigest(candidate),
    expected_bindings: input.bindings,
    actor: input.actor,
    reason: "Require a reviewed private current-state check before every customer data query; keep fields, relationships and business actions unchanged.",
  }, inspector);
}

export function readPrerequisiteRevisionLines(previous: ExplorationBoundaryDraft, next: ExplorationBoundaryDraft): string[] {
  if (canonicalJsonDigest(previous.read_prerequisite ?? null) === canonicalJsonDigest(next.read_prerequisite ?? null)) return [];
  const prerequisite = next.read_prerequisite;
  if (!prerequisite) return ["Private access condition removed. This requires a separate authority review."];
  return [
    "Customer access: require the reviewed current status before every data query, including counts and analysis.",
    "Missing, not-yet-effective, expired or non-qualifying evidence denies access. Identity still comes only from the trusted session.",
    "Status and dates stay private. This does not add a customer-readable table, approve a change or enable execution.",
    `Exact details: ${prerequisite.source.schema}.${prerequisite.source.table}; reviewed status ${JSON.stringify(prerequisite.current_state.positive_state)}; inclusive start, exclusive end, database UTC time.`,
    "Saved as a disabled revision for separate review; existing active access stays unchanged until activation.",
  ];
}
