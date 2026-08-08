import fs from "node:fs/promises";
import path from "node:path";
import {
  inspectDatabase,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  generationLockSharedFactsDigest,
  loadAutoBoundaryPolicyBaseline,
  loadStructuredProjectEvidence,
  persistGenerationLockSnapshot,
  pruneAutoBoundaryReviewOverrides,
  writeAutoBoundaryArtifacts,
  type AutoBoundaryBuild,
  type AutoBoundaryReviewOverrides,
  type BuildAutoBoundaryInput,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";
import {
  boundaryReviewDecisions,
  createBoundaryReviewProgress,
  readBoundaryReviewProgress,
  type BoundaryReviewProgress,
} from "./boundary-review-domain.js";
import {
  loadBoundaryLibraryForReconciliation,
  rebaseSavedBoundaryForRescan,
  saveBoundaryLibraryAfterReconciliation,
  type BoundaryLibraryReconciliationState,
} from "./boundary-library.js";
import {
  backupLegacyBoundaryReviewOverrides,
  boundaryReviewOverridesForCandidate,
} from "./boundary-review-policy.js";
import { detectProjectContext } from "./project-detection.js";
import { safeTerminalText } from "./terminal-syntax.js";

export const BOUNDARY_RESCAN_REPORT_VERSION = "synapsor.boundary-rescan-report.v1" as const;
const BOUNDARY_RESCAN_REPORT_FILE = "boundary-rescan-report.json";

type BoundaryResource = ExplorationBoundaryDraft["pack"]["resources"][number];

export type BoundaryRescanFieldChange = {
  resource_id: string;
  field: string;
};

export type BoundaryRescanRelationshipChange = {
  resource_id: string;
  relationship_id: string;
  target_resource: string;
};

export type BoundaryRescanEntry = {
  boundary_id: `bnd_${string}`;
  boundary_name: string;
  deployment_profile: ExplorationBoundaryDraft["deployment_profile"];
  previous_candidate_digest: `sha256:${string}`;
  candidate_digest: `sha256:${string}`;
  kept_confirmations: number;
  safely_carried_confirmations: string[];
  invalidated_decisions: Array<{
    id: string;
    reason: "reviewed_input_changed" | "decision_removed";
  }>;
  retained_resources: string[];
  removed_resources: string[];
  newly_available_resources: string[];
  newly_available_fields: BoundaryRescanFieldChange[];
  removed_fields: BoundaryRescanFieldChange[];
  changed_field_types: BoundaryRescanFieldChange[];
  newly_available_relationships: BoundaryRescanRelationshipChange[];
  removed_relationships: BoundaryRescanRelationshipChange[];
  pruned_review_inputs: string[];
};

export type BoundaryRescanReport = {
  schema_version: typeof BOUNDARY_RESCAN_REPORT_VERSION;
  generated_at: string;
  engine: SchemaInspection["engine"];
  source_env: string;
  previous_schema_fingerprint: `sha256:${string}`;
  schema_fingerprint: `sha256:${string}`;
  previous_role_posture_fingerprint: `sha256:${string}`;
  role_posture_fingerprint: `sha256:${string}`;
  schema_changed: boolean;
  role_posture_changed: boolean;
  changed: boolean;
  boundaries: BoundaryRescanEntry[];
  totals: {
    boundaries: number;
    kept_confirmations: number;
    safely_carried_confirmations: number;
    invalidated_decisions: number;
    newly_available_resources: number;
    newly_available_fields: number;
    newly_available_relationships: number;
    removed_resources: number;
    removed_fields: number;
    removed_relationships: number;
  };
  source_database_changed: false;
};

export type PreparedBoundaryRescan = {
  projectRoot: string;
  boundaryRoot: string;
  persistReviewState: boolean;
  selectedBuild: AutoBoundaryBuild;
  selectedProgress: BoundaryReviewProgress;
  library: BoundaryLibraryReconciliationState;
  generationLockSnapshots: Array<{
    fingerprint: `sha256:${string}`;
    lock: GenerationLock;
  }>;
  report: BoundaryRescanReport;
  previewDigest: `sha256:${string}`;
};

export async function prepareBoundaryRescan(input: {
  projectRoot: string;
  boundaryRoot?: string;
  schemaInspector?: typeof inspectDatabase;
  inspection?: SchemaInspection;
  now?: string;
}): Promise<PreparedBoundaryRescan> {
  const projectRoot = path.resolve(input.projectRoot);
  const boundaryRoot = path.resolve(projectRoot, input.boundaryRoot ?? "synapsor/generated");
  assertInsideProject(projectRoot, boundaryRoot);
  const [oldDraft, oldLock, hadSavedReviewState] = await Promise.all([
    readJson<ExplorationBoundaryDraft>(
      path.join(boundaryRoot, "exploration-boundary.draft.json"),
      "exploration boundary draft",
    ),
    readJson<GenerationLock>(
      path.join(projectRoot, ".synapsor/generation-lock.json"),
      "generation lock",
    ),
    anyFileExists([
      path.join(projectRoot, ".synapsor/boundary-library.json"),
      path.join(projectRoot, ".synapsor/boundary-review-progress.json"),
    ]),
  ]);
  const inspection = input.inspection ?? await (input.schemaInspector ?? inspectDatabase)({
    engine: oldLock.engine,
    databaseUrlEnv: oldLock.source_env,
    schema: oldLock.inspected_schema,
    env: process.env,
  });
  const project = await detectProjectContext(projectRoot);
  const evidence = await loadStructuredProjectEvidence(project);
  const currentProgress = await readBoundaryReviewProgress(projectRoot, oldDraft);
  const currentCandidate = currentProgress?.candidate ?? oldDraft;
  const previousLibrary = await loadBoundaryLibraryForReconciliation({
    projectRoot,
    draft: oldDraft,
    currentCandidate,
    ...(currentProgress ? { currentProgress } : {}),
  });
  const oldPolicyBaseline = await optionalOldPolicyBaseline(projectRoot, oldDraft);
  const nextBoundaries: Record<string, BoundaryReviewProgress> = {};
  const builds = new Map<string, AutoBoundaryBuild>();
  const entries: BoundaryRescanEntry[] = [];
  const now = input.now ?? new Date().toISOString();

  for (const [boundaryName, previous] of Object.entries(previousLibrary.boundaries)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const buildInput = buildInputForBoundary({
      inspection,
      project,
      evidence,
      lock: oldLock,
      candidate: previous.candidate,
    });
    const cleanBuild = buildAutoBoundary(buildInput);
    const previousOverrides = boundaryReviewOverridesForCandidate({
      progress: previous,
      baseline: oldPolicyBaseline,
      candidate: previous.candidate,
      actor: previous.confirmations.at(-1)?.actor ?? "boundary-rescan",
      now: previous.updated_at,
    });
    const pruned = pruneAutoBoundaryReviewOverrides(
      inspection,
      previousOverrides,
      {
        project,
        parsedEvidence: evidence.parsed,
        existingContracts: evidence.existingContracts,
      },
    );
    const sharedFactsUnchanged = generationLockSharedFactsDigest(oldLock)
      === generationLockSharedFactsDigest(cleanBuild.lock);
    if (sharedFactsUnchanged && pruned.removed.length === 0) {
      const progress = structuredClone(previous);
      builds.set(boundaryName, cleanBuild);
      nextBoundaries[boundaryName] = progress;
      entries.push(rescanEntry({
        previous,
        progress,
        generatedDraft: cleanBuild.exploration_boundary,
        safelyCarried: [],
        prunedReviewInputs: [],
      }));
      continue;
    }
    const build = buildAutoBoundary({ ...buildInput, overrides: pruned.overrides });
    builds.set(boundaryName, build);
    const candidate = previous.candidate.pack.resources.length === 0
      ? rebaseEmptyDisabledBoundary(
          build.exploration_boundary,
          previous.candidate,
          boundaryName,
        )
      : rebaseSavedBoundaryForRescan({
          generatedDraft: build.exploration_boundary,
          previousCandidate: previous.candidate,
          boundaryName,
        });
    const retained = retainedReviewDecisions(previous, candidate);
    const progress = createBoundaryReviewProgress({
      draft: build.exploration_boundary,
      candidate,
      confirmedDecisions: retained.decisions,
      previous,
      reviewOverrides: pruned.overrides,
      actor: "synapsor-rescan-reconciliation",
      reason: retained.safelyCarried.length
        ? "Preserved unchanged reviewed authority; newly inspected fields remain unavailable until separately reviewed."
        : "Preserved review decisions whose exact authority inputs are unchanged.",
      revision: previous.revision + 1,
      now,
    });
    if (retained.safelyCarried.length) {
      const safeIds = new Set(retained.safelyCarried);
      const previousInvalidations = new Set(previous.invalidated_decisions.map(invalidationKey));
      progress.invalidated_decisions = progress.invalidated_decisions.filter((item) =>
        previousInvalidations.has(invalidationKey(item)) || !safeIds.has(item.id));
    }
    nextBoundaries[boundaryName] = progress;
    entries.push(rescanEntry({
      previous,
      progress,
      generatedDraft: build.exploration_boundary,
      safelyCarried: retained.safelyCarried,
      prunedReviewInputs: pruned.removed,
    }));
  }

  const selectedProgress = nextBoundaries[previousLibrary.selected_name];
  const selectedBuild = builds.get(previousLibrary.selected_name);
  if (!selectedProgress || !selectedBuild) {
    throw new Error("Schema rescan could not preserve the selected boundary.");
  }
  const library: BoundaryLibraryReconciliationState = {
    selected_name: previousLibrary.selected_name,
    boundaries: nextBoundaries,
    updated_at: now,
  };
  const report = rescanReport({ oldLock, selectedBuild, inspection, entries, now });
  const { generated_at: _generatedAt, ...stableReport } = report;
  return {
    projectRoot,
    boundaryRoot,
    persistReviewState: hadSavedReviewState || Object.values(nextBoundaries).some(
      (progress) => progress.candidate.pack.resources.length > 0,
    ),
    selectedBuild,
    selectedProgress,
    library,
    generationLockSnapshots: [...builds.values()].map((build) => ({
      fingerprint: build.exploration_boundary.generation_lock_fingerprint,
      lock: build.lock,
    })),
    report,
    previewDigest: canonicalJsonDigest({
      schema_version: "synapsor.boundary-rescan-preview.v1",
      selected_boundary_id: selectedProgress.boundary_id,
      selected_candidate_digest: selectedProgress.candidate_digest,
      library: Object.fromEntries(Object.entries(nextBoundaries).map(([name, progress]) => [
        name,
        {
          boundary_id: progress.boundary_id,
          candidate_digest: progress.candidate_digest,
          confirmed_decisions: progress.confirmed_decisions,
        },
      ])),
      report: stableReport,
    }),
  };
}

export async function commitBoundaryRescan(prepared: PreparedBoundaryRescan): Promise<void> {
  if (!prepared.report.changed) return;
  if (Object.values(prepared.library.boundaries).some(
    (progress) => progress.policy_migration.status === "review_required",
  )) {
    await backupLegacyBoundaryReviewOverrides(prepared.projectRoot);
  }
  for (const snapshot of prepared.generationLockSnapshots) {
    await persistGenerationLockSnapshot(
      prepared.projectRoot,
      snapshot.fingerprint,
      snapshot.lock,
    );
  }
  await writeAutoBoundaryArtifacts({
    projectRoot: prepared.projectRoot,
    outputRoot: path.relative(prepared.projectRoot, prepared.boundaryRoot),
    build: prepared.selectedBuild,
    force: true,
    preserveActiveBoundary: true,
    preserveReviewProgress: prepared.persistReviewState,
    ...(prepared.persistReviewState ? { reviewProgress: prepared.selectedProgress } : {}),
  });
  if (prepared.persistReviewState) {
    await saveBoundaryLibraryAfterReconciliation({
      projectRoot: prepared.projectRoot,
      state: prepared.library,
    });
  }
  await writePrivateJsonAtomic(
    path.join(prepared.projectRoot, ".synapsor", BOUNDARY_RESCAN_REPORT_FILE),
    prepared.report,
  );
}

export async function readBoundaryRescanReport(
  projectRoot: string,
): Promise<BoundaryRescanReport | undefined> {
  try {
    const report = await readJson<BoundaryRescanReport>(
      path.join(path.resolve(projectRoot), ".synapsor", BOUNDARY_RESCAN_REPORT_FILE),
      "boundary rescan report",
    );
    return report.schema_version === BOUNDARY_RESCAN_REPORT_VERSION ? report : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function formatBoundaryRescanReport(report: BoundaryRescanReport): string {
  if (!report.changed) {
    return "Rescan complete: the reviewed schema and database-role posture are unchanged. No boundary revision was created.";
  }
  const lines = [
    "RESCAN RECONCILIATION",
    `Boundaries checked: ${report.totals.boundaries}`,
    `Decisions kept: ${report.totals.kept_confirmations}`,
    `Prior decisions invalidated: ${report.totals.invalidated_decisions}`,
    `Newly available: ${report.totals.newly_available_resources} tables, `
      + `${report.totals.newly_available_fields} columns, `
      + `${report.totals.newly_available_relationships} relationships`,
    `Removed: ${report.totals.removed_resources} tables, ${report.totals.removed_fields} columns, `
      + `${report.totals.removed_relationships} relationships`,
  ];
  for (const boundary of report.boundaries) {
    const details = [
      ...boundary.invalidated_decisions.map((decision) =>
        `${decision.id}: ${decision.reason === "decision_removed" ? "reviewed input no longer exists" : "reviewed input changed"}`),
      ...boundary.changed_field_types.map((field) =>
        `${field.resource_id}.${field.field}: reviewed column type changed`),
      ...boundary.removed_fields.map((field) =>
        `${field.resource_id}.${field.field}: reviewed column was removed`),
      ...boundary.removed_relationships.map((relationship) =>
        `${relationship.resource_id}.${relationship.relationship_id}: reviewed relationship was removed`),
      ...boundary.removed_resources.map((resource) => `${resource}: reviewed table was removed`),
      ...boundary.newly_available_resources.map((resource) =>
        `${resource}: new table is available to review`),
      ...boundary.pruned_review_inputs,
      ...boundary.newly_available_fields.map((field) =>
        `${field.resource_id}.${field.field}: new column is kept out until reviewed`),
      ...boundary.newly_available_relationships.map((relationship) =>
        `${relationship.resource_id}.${relationship.relationship_id}: new relationship is available to review`),
    ];
    lines.push(
      "",
      `Boundary ${boundary.boundary_name}: kept ${boundary.kept_confirmations}; `
        + `${boundary.invalidated_decisions.length} prior decisions invalidated.`,
      ...details.slice(0, 8).map((detail) => `  - ${detail}`),
      ...(details.length > 8 ? [`  - +${details.length - 8} more changes; open /access for the full review.`] : []),
    );
  }
  const hasReviewedResource = report.boundaries.some((boundary) =>
    boundary.retained_resources.length > 0);
  lines.push(
    "",
    ...(hasReviewedResource
      ? [
          "No reconciled revision was activated. Existing exact authority files were preserved.",
          "Review the disabled exact revision, then activate it separately even when no prior decision was invalidated.",
        ]
      : [
          "No authority was activated. This project still has no reviewed table.",
          "Resolve table access with synapsor-runner boundary review --access; activation remains unavailable until then.",
        ]),
  );
  return safeTerminalText(lines.join("\n"));
}

function buildInputForBoundary(input: {
  inspection: SchemaInspection;
  project: Awaited<ReturnType<typeof detectProjectContext>>;
  evidence: Awaited<ReturnType<typeof loadStructuredProjectEvidence>>;
  lock: GenerationLock;
  candidate: ExplorationBoundaryDraft;
}): BuildAutoBoundaryInput {
  return {
    inspection: input.inspection,
    project: input.project,
    parsedEvidence: input.evidence.parsed,
    existingContracts: input.evidence.existingContracts,
    sourceEnv: input.lock.source_env,
    sourceName: input.candidate.source,
    inspectedSchema: input.lock.inspected_schema,
    deploymentProfile: input.candidate.deployment_profile,
    ...(input.candidate.trusted_context.provider === "http_claims"
      ? {
          httpClaims: {
            tenantClaim: input.candidate.trusted_context.tenant_claim,
            principalClaim: input.candidate.trusted_context.principal_claim,
          },
        }
      : {}),
    ...(input.candidate.organization_scope
      ? {
          singleOrganization: {
            organizationId: input.candidate.organization_scope.organization_id,
          },
        }
      : {}),
  };
}

function retainedReviewDecisions(
  previous: BoundaryReviewProgress,
  candidate: ExplorationBoundaryDraft,
): { decisions: string[]; safelyCarried: string[] } {
  const next = boundaryReviewDecisions(candidate);
  const nextById = new Map(next.map((decision) => [decision.id, decision]));
  const previousResources = new Map(previous.candidate.pack.resources.map((resource) => [resource.id, resource]));
  const nextResources = new Map(candidate.pack.resources.map((resource) => [resource.id, resource]));
  const decisions: string[] = [];
  const safelyCarried: string[] = [];
  for (const confirmation of previous.confirmations) {
    const current = nextById.get(confirmation.id);
    if (!current) continue;
    if (current.input_digest === confirmation.input_digest) {
      if (!decisionDependsOnChangedReviewedType(current.id, previousResources, nextResources)) {
        decisions.push(current.decision);
      }
      continue;
    }
    if (current.kind === "field_visibility"
      && current.resource_id
      && isSafeUnavailableFieldChange(
        previousResources.get(current.resource_id),
        nextResources.get(current.resource_id),
      )) {
      decisions.push(current.decision);
      safelyCarried.push(current.id);
    }
  }
  return { decisions, safelyCarried };
}

function rebaseEmptyDisabledBoundary(
  generated: ExplorationBoundaryDraft,
  previous: ExplorationBoundaryDraft,
  boundaryName: string,
): ExplorationBoundaryDraft {
  const candidate = structuredClone(generated);
  candidate.pack.name = boundaryName;
  candidate.pack.resources = [];
  candidate.budgets = structuredClone(previous.budgets);
  const newlyEligible = generated.pack.resources.map((resource) => `${resource.id}:`);
  candidate.unresolved_decisions = generated.unresolved_decisions.filter((decision) =>
    !newlyEligible.some((prefix) => decision.startsWith(prefix)));
  return candidate;
}

function decisionDependsOnChangedReviewedType(
  decisionId: string,
  previous: Map<string, BoundaryResource>,
  next: Map<string, BoundaryResource>,
): boolean {
  const match = /^resource\.(.+)\.field_permissions$/.exec(decisionId);
  if (!match) return false;
  const before = previous.get(match[1]!);
  const after = next.get(match[1]!);
  if (!before || !after) return true;
  const reviewedFields = new Set([
    ...before.selectable_fields,
    ...(before.model_withheld_fields ?? []),
  ]);
  return [...reviewedFields].some((field) =>
    before.field_types[field] !== after.field_types[field]);
}

function isSafeUnavailableFieldChange(
  before: BoundaryResource | undefined,
  after: BoundaryResource | undefined,
): boolean {
  if (!before || !after) return false;
  if (!sameStrings(before.selectable_fields, after.selectable_fields)
    || !sameStrings(before.model_withheld_fields ?? [], after.model_withheld_fields ?? [])) {
    return false;
  }
  const beforeFields = new Set(Object.keys(before.field_types));
  const afterFields = new Set(Object.keys(after.field_types));
  const added = [...afterFields].filter((field) => !beforeFields.has(field));
  const removed = [...beforeFields].filter((field) => !afterFields.has(field));
  return added.every((field) => after.kept_out_fields.includes(field))
    && removed.every((field) => before.kept_out_fields.includes(field))
    && [...beforeFields].filter((field) => afterFields.has(field)).every((field) =>
      fieldAccess(before, field) === fieldAccess(after, field));
}

function fieldAccess(resource: BoundaryResource, field: string): "visible" | "withheld" | "kept_out" {
  if (!resource.selectable_fields.includes(field)) return "kept_out";
  return (resource.model_withheld_fields ?? []).includes(field) ? "withheld" : "visible";
}

function rescanEntry(input: {
  previous: BoundaryReviewProgress;
  progress: BoundaryReviewProgress;
  generatedDraft: ExplorationBoundaryDraft;
  safelyCarried: string[];
  prunedReviewInputs: string[];
}): BoundaryRescanEntry {
  const beforeResources = new Map(input.previous.candidate.pack.resources.map((resource) => [resource.id, resource]));
  const afterResources = new Map(input.progress.candidate.pack.resources.map((resource) => [resource.id, resource]));
  const generatedResources = new Map(input.generatedDraft.pack.resources.map((resource) => [resource.id, resource]));
  const newlyAvailableFields: BoundaryRescanFieldChange[] = [];
  const removedFields: BoundaryRescanFieldChange[] = [];
  const changedFieldTypes: BoundaryRescanFieldChange[] = [];
  const newlyAvailableRelationships: BoundaryRescanRelationshipChange[] = [];
  const removedRelationships: BoundaryRescanRelationshipChange[] = [];
  for (const [resourceId, before] of beforeResources) {
    const generated = generatedResources.get(resourceId);
    if (!generated) continue;
    const beforeFields = new Set(Object.keys(before.field_types));
    const generatedFields = new Set(Object.keys(generated.field_types));
    for (const field of generatedFields) {
      if (!beforeFields.has(field)) newlyAvailableFields.push({ resource_id: resourceId, field });
      else if (before.field_types[field] !== generated.field_types[field]) {
        changedFieldTypes.push({ resource_id: resourceId, field });
      }
    }
    for (const field of beforeFields) {
      if (!generatedFields.has(field)) removedFields.push({ resource_id: resourceId, field });
    }
    const beforeRelationships = new Map(before.relationships.map((relationship) => [relationship.id, relationship]));
    const generatedRelationships = new Map(generated.relationships.map((relationship) => [relationship.id, relationship]));
    for (const [relationshipId, relationship] of generatedRelationships) {
      if (!beforeRelationships.has(relationshipId)) {
        newlyAvailableRelationships.push({
          resource_id: resourceId,
          relationship_id: relationshipId,
          target_resource: relationship.target_resource,
        });
      }
    }
    for (const [relationshipId, relationship] of beforeRelationships) {
      if (!generatedRelationships.has(relationshipId)) {
        removedRelationships.push({
          resource_id: resourceId,
          relationship_id: relationshipId,
          target_resource: relationship.target_resource,
        });
      }
    }
  }
  const previousInvalidations = new Set(input.previous.invalidated_decisions.map(invalidationKey));
  const invalidated = input.progress.invalidated_decisions
    .filter((item) => !previousInvalidations.has(invalidationKey(item)))
    .map((item) => ({ id: item.id, reason: item.reason }));
  return {
    boundary_id: input.progress.boundary_id,
    boundary_name: input.progress.candidate.pack.name,
    deployment_profile: input.progress.candidate.deployment_profile,
    previous_candidate_digest: input.previous.candidate_digest,
    candidate_digest: input.progress.candidate_digest,
    kept_confirmations: input.progress.confirmations.length,
    safely_carried_confirmations: [...input.safelyCarried].sort(),
    invalidated_decisions: invalidated,
    retained_resources: [...afterResources.keys()].filter((id) => beforeResources.has(id)).sort(),
    removed_resources: [...beforeResources.keys()].filter((id) => !afterResources.has(id)).sort(),
    newly_available_resources: [...generatedResources.keys()].filter((id) => !beforeResources.has(id)).sort(),
    newly_available_fields: sortFieldChanges(newlyAvailableFields),
    removed_fields: sortFieldChanges(removedFields),
    changed_field_types: sortFieldChanges(changedFieldTypes),
    newly_available_relationships: sortRelationshipChanges(newlyAvailableRelationships),
    removed_relationships: sortRelationshipChanges(removedRelationships),
    pruned_review_inputs: [...input.prunedReviewInputs].sort(),
  };
}

function rescanReport(input: {
  oldLock: GenerationLock;
  selectedBuild: AutoBoundaryBuild;
  inspection: SchemaInspection;
  entries: BoundaryRescanEntry[];
  now: string;
}): BoundaryRescanReport {
  const schemaChanged = input.oldLock.schema_fingerprint !== input.selectedBuild.lock.schema_fingerprint;
  const roleChanged = input.oldLock.role_posture_fingerprint !== input.selectedBuild.lock.role_posture_fingerprint;
  const totals = {
    boundaries: input.entries.length,
    kept_confirmations: sum(input.entries, (entry) => entry.kept_confirmations),
    safely_carried_confirmations: sum(input.entries, (entry) => entry.safely_carried_confirmations.length),
    invalidated_decisions: sum(input.entries, (entry) => entry.invalidated_decisions.length),
    newly_available_resources: sum(input.entries, (entry) => entry.newly_available_resources.length),
    newly_available_fields: sum(input.entries, (entry) => entry.newly_available_fields.length),
    newly_available_relationships: sum(input.entries, (entry) => entry.newly_available_relationships.length),
    removed_resources: sum(input.entries, (entry) => entry.removed_resources.length),
    removed_fields: sum(input.entries, (entry) => entry.removed_fields.length),
    removed_relationships: sum(input.entries, (entry) => entry.removed_relationships.length),
  };
  const policyChanged = input.entries.some((entry) =>
    entry.previous_candidate_digest !== entry.candidate_digest
    || entry.pruned_review_inputs.length > 0);
  return {
    schema_version: BOUNDARY_RESCAN_REPORT_VERSION,
    generated_at: input.now,
    engine: input.inspection.engine,
    source_env: input.oldLock.source_env,
    previous_schema_fingerprint: input.oldLock.schema_fingerprint,
    schema_fingerprint: input.selectedBuild.lock.schema_fingerprint,
    previous_role_posture_fingerprint: input.oldLock.role_posture_fingerprint,
    role_posture_fingerprint: input.selectedBuild.lock.role_posture_fingerprint,
    schema_changed: schemaChanged,
    role_posture_changed: roleChanged,
    changed: schemaChanged || roleChanged || policyChanged,
    boundaries: input.entries,
    totals,
    source_database_changed: false,
  };
}

async function optionalOldPolicyBaseline(
  projectRoot: string,
  fallback: ExplorationBoundaryDraft,
): Promise<ExplorationBoundaryDraft> {
  try {
    return (await loadAutoBoundaryPolicyBaseline(projectRoot)).boundary;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

function sortFieldChanges(changes: BoundaryRescanFieldChange[]): BoundaryRescanFieldChange[] {
  return changes.sort((left, right) =>
    left.resource_id.localeCompare(right.resource_id) || left.field.localeCompare(right.field));
}

function sortRelationshipChanges(
  changes: BoundaryRescanRelationshipChange[],
): BoundaryRescanRelationshipChange[] {
  return changes.sort((left, right) =>
    left.resource_id.localeCompare(right.resource_id)
    || left.relationship_id.localeCompare(right.relationship_id));
}

function invalidationKey(input: { id: string; previous_input_digest: string }): string {
  return `${input.id}:${input.previous_input_digest}`;
}

function sum<T>(values: T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readJson<T>(filePath: string, label: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON at ${filePath}.`);
    throw error;
  }
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function anyFileExists(filePaths: string[]): Promise<boolean> {
  const results = await Promise.all(filePaths.map(async (filePath) => {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }));
  return results.some(Boolean);
}

function assertInsideProject(projectRoot: string, target: string): void {
  const relative = path.relative(projectRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Boundary rescan path escapes the selected project.");
  }
}
