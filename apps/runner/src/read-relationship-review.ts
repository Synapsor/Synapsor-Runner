import { REVIEWED_READ_RELATIONSHIP_SCHEMA_VERSION, type ReviewedReadRelationship } from "./read-authoring-contract-types.js";
export type { ReviewedReadRelationship } from "./read-authoring-contract-types.js";
import { Buffer } from "node:buffer";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  explorationBoundaryCandidateDigest,
  reviewedAnalysisRelationshipHopLimit,
  type ExplorationBoundaryDraft,
  type ExplorationRelationship,
} from "./auto-boundary.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { ReviewSection } from "./read-boundary-review-types.js";
import { safeTerminalText } from "./terminal-syntax.js";

const MAX_REVIEWABLE_RELATIONSHIPS = 64;
const MAX_REVIEW_METADATA_BYTES = 64 * 1024;

/**
 * A host-created selection of one generated relationship. This is provenance,
 * not authority: callers must still make an exact disabled-candidate mutation.
 */

type ReviewableReadRelationship = {
  resource: string;
  relationship: ExplorationRelationship;
  relationship_fingerprint: `sha256:${string}`;
};

export class ReadRelationshipUnavailableError extends Error {
  readonly code = "READ_RELATIONSHIP_RESTORE_UNAVAILABLE";
  constructor(readonly details: string[]) {
    super(`READ_RELATIONSHIP_RESTORE_UNAVAILABLE: ${details.join(" ")}`);
  }
}

/** Only catalog identifiers are displayed, never the model's free-form question.
 * An unavailable path is not consent to invent a join or omit a required fact. */
function unavailableRelationship(input: Parameters<typeof reviewableRelationships>[0]): ReadRelationshipUnavailableError {
  const root = input.generatedBoundary.pack.resources.find(r => r.id === input.fromResource);
  const included = new Set(input.boundary.pack.resources.map(r => r.id));
  const maximum = reviewedAnalysisRelationshipHopLimit(input.boundary.budgets);
  const paths = root?.relationships.filter(r => !input.toResource || r.target_resource === input.toResource) ?? [];
  const current = input.boundary.pack.resources.find(r => r.id === input.fromResource);
  const reasons = new Set<string>();
  if (!root || !current) reasons.add("The requested root is not in both the generated catalog and the included Read selection.");
  else if (!paths.length) reasons.add("The inspected catalog supplies no generated outgoing path for this request; an operator answer cannot create a relationship.");
  for (const p of paths) {
    if (current?.relationships.some(r => r.id === p.id)) reasons.add("The generated path is already included; use the current catalog instead of requesting restoration.");
    const missing = requiredResources(p).filter(id => !included.has(id));
    if (missing.length) reasons.add(`Path to ${terminal(p.target_resource)} needs excluded resources: ${missing.map(terminal).join(", ")}. Review resource selection and its policy impact first.`);
    if ((p.proof?.links.length ?? p.path_depth ?? 1) > maximum) reasons.add(`Path to ${terminal(p.target_resource)} exceeds the current ${maximum}-hop analysis limit; a separate explicit budget review is required.`);
    if (p.unmatched_rows === "review_required") reasons.add(`Path to ${terminal(p.target_resource)} has nullable rows with no reviewed unmatched-row decision.`);
  }
  if (!reasons.size) reasons.add("The available metadata does not establish an exact many-to-one path with complete keys and uniqueness proof.");
  return new ReadRelationshipUnavailableError([
    `Read root: ${root ? terminal(root.id) : "not in the current catalog"}. Analysis limit: ${maximum} hops.`,
    ...[...reasons].slice(0, 3),
    "The disabled draft and saved requirements remain pending. Excluding a required resource also removes its private verification facts; it does not complete the job.",
    "Review resources and exact paths, or save and resolve the source prerequisite. No access or source data changed.",
  ]);
}

function terminal(value: string): string {
  return safeTerminalText(value);
}

function relationshipFingerprint(resource: string, relationship: ExplorationRelationship): `sha256:${string}` {
  return canonicalJsonDigest({ resource, relationship });
}

function requiredResources(relationship: ExplorationRelationship): string[] {
  return [...new Set([
    relationship.target_resource,
    ...(relationship.proof?.links ?? []).flatMap((link) => [
      link.source_resource,
      link.target_resource,
    ]),
  ])].sort();
}

function isExactGeneratedRelationship(
  resource: string,
  relationship: ExplorationRelationship,
  included: ReadonlySet<string>,
  maximumHops: number,
): boolean {
  const links = relationship.proof?.links;
  if (relationship.cardinality !== "many_to_one" || relationship.max_fan_out !== 1
    || relationship.unmatched_rows === "review_required"
    || relationship.proof?.source !== "database_catalog"
    || !links?.length || links.length > maximumHops
    || relationship.path_depth !== undefined && relationship.path_depth !== links.length
    || canonicalJsonDigest(links) !== relationship.proof.digest
    || !requiredResources(relationship).every((id) => included.has(id))) return false;
  for (const [index, link] of links.entries()) {
    if (link.cardinality !== "many_to_one" || link.max_fan_out !== 1
      || !link.constraint_name || !link.source_columns.length
      || link.source_columns.length !== link.target_columns.length
      || link.source_resource !== (index === 0 ? resource : links[index - 1]!.target_resource)
      || !link.target_uniqueness.name || !link.target_uniqueness.columns.length) return false;
  }
  return links.at(-1)!.target_resource === relationship.target_resource;
}

function reviewableRelationships(input: {
  boundary: ExplorationBoundaryDraft;
  generatedBoundary: ExplorationBoundaryDraft;
  fromResource: string;
  toResource?: string;
}): ReviewableReadRelationship[] {
  const currentFrom = input.boundary.pack.resources.find((resource) => resource.id === input.fromResource);
  const generatedFrom = input.generatedBoundary.pack.resources.find((resource) => resource.id === input.fromResource);
  const included = new Set(input.boundary.pack.resources.map((resource) => resource.id));
  if (!currentFrom || !generatedFrom || (input.toResource && !included.has(input.toResource))) return [];
  const currentIds = new Set(currentFrom.relationships.map((relationship) => relationship.id));
  const maximumHops = reviewedAnalysisRelationshipHopLimit(input.boundary.budgets);
  return generatedFrom.relationships
    .filter((relationship) => !input.toResource || relationship.target_resource === input.toResource)
    .filter((relationship) => !currentIds.has(relationship.id))
    .filter((relationship) => isExactGeneratedRelationship(
      input.fromResource,
      relationship,
      included,
      maximumHops,
    ))
    .map((relationship) => ({
      resource: input.fromResource,
      relationship: structuredClone(relationship),
      relationship_fingerprint: relationshipFingerprint(input.fromResource, relationship),
    }))
    .sort((left, right) => left.relationship.id.localeCompare(right.relationship.id)
      || left.relationship_fingerprint.localeCompare(right.relationship_fingerprint));
}

function keyPairLines(relationship: ExplorationRelationship): string[] {
  return relationship.proof!.links.flatMap((link, index) => [
    `Link ${index + 1}: ${terminal(link.source_resource)} -> ${terminal(link.target_resource)} via ${terminal(link.constraint_name)}.`,
    `  target uniqueness: ${terminal(link.target_uniqueness.kind)} ${terminal(link.target_uniqueness.name)} (${link.target_uniqueness.columns.map(terminal).join(", ")}).`,
    ...link.source_columns.map((column, columnIndex) =>
      `  ${terminal(column)} = ${terminal(link.target_columns[columnIndex]!)}`),
  ]);
}

export function readRelationshipEvidenceReviewSections(
  candidates: readonly ReviewableReadRelationship[],
): ReviewSection[] {
  return candidates.map(({ resource, relationship }, index) => ({
    id: `read_relationship_${index + 1}`,
    title: `Catalog path ${index + 1}: ${terminal(resource)} -> ${terminal(relationship.target_resource)}`,
    lines: [
      `Exact relationship ID: ${terminal(relationship.id)}.`,
      `Path depth: ${relationship.proof!.links.length}. Catalog-proven many-to-one path only.`,
      ...keyPairLines(relationship),
      `Unmatched rows: ${relationship.unmatched_rows ?? "not applicable"}.`,
      "Every path endpoint and intermediate is already included in this disabled Read boundary.",
      "Structural metadata only. No source rows, trusted identity values, new resources, writes, or activation.",
    ],
  }));
}

/**
 * Reviews one restorable generated path after the caller has already received a
 * bounded root and optional target request. The host, never the model, selects the exact
 * generated path and returns provenance for an exact disabled mutation.
 */
export async function reviewReadRelationship(input: {
  projectRoot: string;
  boundary: ExplorationBoundaryDraft;
  generatedBoundary: ExplorationBoundaryDraft;
  fromResource: string;
  toResource?: string;
  session: BoundaryReviewInteractiveSession;
  modelLabel: string;
  assertCurrent: () => Promise<void>;
}): Promise<ReviewedReadRelationship | undefined> {
  if (!input.projectRoot.trim() || input.projectRoot.length > 4_096) {
    throw new Error("READ_RELATIONSHIP_REVIEW_PROJECT_INVALID: resume from the saved project before reviewing a generated path.");
  }
  await input.assertCurrent();
  const candidates = reviewableRelationships(input);
  if (!candidates.length) {
    throw unavailableRelationship(input);
  }
  if (candidates.length > MAX_REVIEWABLE_RELATIONSHIPS
    || Buffer.byteLength(JSON.stringify(candidates)) > MAX_REVIEW_METADATA_BYTES) {
    throw new Error(
      "READ_RELATIONSHIP_METADATA_TOO_LARGE: The complete generated relationship metadata exceeds this review's limit. Narrow the requested root/target pair and resume. Nothing was truncated, transferred, or changed.",
    );
  }
  if (!input.session.chooseOption) {
    throw new Error("READ_RELATIONSHIP_CONSENT_REQUIRED: Resume guided review to permit structural relationship review. No generated metadata was transferred or changed.");
  }
  const metadataDigest = canonicalJsonDigest(candidates.map(({ resource, relationship, relationship_fingerprint }) => ({
    resource,
    relationship,
    relationship_fingerprint,
  })));
  const selected = await input.session.chooseOption("REVIEW AND STAGE READ RELATIONSHIP", [
    ...candidates.map((candidate, index) => ({
      value: String(index),
      label: `Review and add path ${index + 1} to the disabled draft`,
      detail: `${terminal(candidate.resource)} -> ${terminal(candidate.relationship.target_resource)}; exact path ID ${terminal(candidate.relationship.id)}; ${candidate.relationship.proof!.links.length} proven ${candidate.relationship.proof!.links.length === 1 ? "hop" : "hops"}.`,
    })),
    {
      value: "pending",
      label: "Keep this relationship pending",
      detail: "Retain the current disabled Read draft without staging a path or changing access.",
    },
  ], {
    initialValue: "pending",
    requireExplicitSelection: true,
    explainOnRequest: true,
    context: [
      `The selected provider is ${terminal(input.modelLabel)}. The exact selected structural path may be included in the continuing edit; no source rows, values, or trusted identity values are sent.`,
      "The path can only reconnect two resources already in the disabled boundary. It cannot add independent access, a table, a scope rule, a prerequisite, or activation.",
    ],
    explanationContext: [
      "Review exact generated structural relationship metadata for the requested root only. Runner stages one selected path for the continuing disabled-authority edit; normal human review remains required.",
    ],
    exactDetails: {
      title: "RESTORABLE READ RELATIONSHIP METADATA",
      summaryTitle: "RESTORABLE READ RELATIONSHIP SUMMARY",
      lines: [
        `Requested root: ${terminal(input.fromResource)}. Requested target: ${input.toResource ? terminal(input.toResource) : "choose one exact path to an already included resource"}.`,
        `Destination: ${terminal(input.modelLabel)}. The selected path's structural metadata may be sent in the continuing edit; source rows, values, and trusted identity values are not sent.`,
        `Exact metadata fingerprint: ${metadataDigest}.`,
        `Complete eligible paths: ${candidates.length}. No candidate was omitted or truncated.`,
        "No source rows, trusted identity values, resource additions, scope changes, writes, or activation are permitted.",
      ],
      sections: readRelationshipEvidenceReviewSections(candidates),
    },
  });
  if (selected === undefined || selected === "pending") return undefined;
  const selectedIndex = Number(selected);
  if (!Number.isSafeInteger(selectedIndex) || String(selectedIndex) !== selected
    || selectedIndex < 0 || selectedIndex >= candidates.length) {
    throw new Error("READ_RELATIONSHIP_SELECTION_INVALID: Reopen the relationship review and select one displayed catalog path.");
  }
  await input.assertCurrent();
  const choice = candidates[selectedIndex]!;
  return {
    schema_version: REVIEWED_READ_RELATIONSHIP_SCHEMA_VERSION,
    candidate_digest: explorationBoundaryCandidateDigest(input.boundary),
    resource: choice.resource,
    relationship_id: choice.relationship.id,
    relationship_fingerprint: choice.relationship_fingerprint,
  };
}

/**
 * Revalidates a host-staged selection before the caller appends its returned
 * relationship to an exact disabled candidate mutation.
 */
export function validateReviewedReadRelationship(
  reviewed: ReviewedReadRelationship,
  currentBoundary: ExplorationBoundaryDraft,
  generatedBoundary: ExplorationBoundaryDraft,
): ExplorationRelationship {
  if (!isReviewedReadRelationship(reviewed)) {
    throw new Error("READ_RELATIONSHIP_PROVENANCE_INVALID: Relationship restoration requires a complete Runner-reviewed selection.");
  }
  if (reviewed.candidate_digest !== explorationBoundaryCandidateDigest(currentBoundary)) {
    throw new Error("READ_RELATIONSHIP_CANDIDATE_STALE: The disabled Read candidate changed after relationship review. Reopen the exact relationship review.");
  }
  const currentResource = currentBoundary.pack.resources.find((resource) => resource.id === reviewed.resource);
  if (!currentResource || currentResource.relationships.some((relationship) => relationship.id === reviewed.relationship_id)) {
    throw new Error("READ_RELATIONSHIP_RESTORE_STALE: The selected relationship is no longer absent from the current disabled Read candidate.");
  }
  const generatedResource = generatedBoundary.pack.resources.find((resource) => resource.id === reviewed.resource);
  const relationship = generatedResource?.relationships.find((item) => item.id === reviewed.relationship_id);
  if (!relationship || relationshipFingerprint(reviewed.resource, relationship) !== reviewed.relationship_fingerprint) {
    throw new Error("READ_RELATIONSHIP_PROOF_STALE: The generated relationship or its catalog proof changed. Reopen relationship review.");
  }
  const targetResource = relationship.target_resource;
  const reviewable = reviewableRelationships({
    boundary: currentBoundary,
    generatedBoundary,
    fromResource: reviewed.resource,
    toResource: targetResource,
  }).find((candidate) => candidate.relationship.id === reviewed.relationship_id
    && candidate.relationship_fingerprint === reviewed.relationship_fingerprint);
  if (!reviewable) {
    throw new Error("READ_RELATIONSHIP_RESTORE_UNAVAILABLE: The selected path no longer fits the included resources, reviewed hop limit, or nullable-row requirements.");
  }
  return structuredClone(reviewable.relationship);
}

/**
 * Checks the prepared disabled candidate still contains the exact host-staged
 * generated proof. Call this after composing ordinary policy changes and again
 * on the exact mutation preview before committing it.
 */
export function assertReviewedReadRelationshipRetained(
  reviewed: ReviewedReadRelationship,
  resultingCandidate: ExplorationBoundaryDraft,
): void {
  if (!isReviewedReadRelationship(reviewed)) {
    throw new Error("READ_RELATIONSHIP_PROVENANCE_INVALID: Relationship restoration requires a complete Runner-reviewed selection.");
  }
  const relationship = resultingCandidate.pack.resources.find((resource) => resource.id === reviewed.resource)
    ?.relationships.find((item) => item.id === reviewed.relationship_id);
  if (!relationship || relationshipFingerprint(reviewed.resource, relationship) !== reviewed.relationship_fingerprint) {
    throw new Error("READ_RELATIONSHIP_RESTORE_NOT_RETAINED: The exact selected generated relationship is missing or changed in the disabled candidate preview.");
  }
}

function isReviewedReadRelationship(value: unknown): value is ReviewedReadRelationship {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 5
    && record.schema_version === REVIEWED_READ_RELATIONSHIP_SCHEMA_VERSION
    && typeof record.resource === "string" && record.resource.length > 0 && record.resource.length <= 256
    && typeof record.relationship_id === "string" && record.relationship_id.length > 0 && record.relationship_id.length <= 256
    && typeof record.candidate_digest === "string" && /^sha256:[0-9a-f]{64}$/u.test(record.candidate_digest)
    && typeof record.relationship_fingerprint === "string" && /^sha256:[0-9a-f]{64}$/u.test(record.relationship_fingerprint);
}
