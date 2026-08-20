import fs from "node:fs/promises";
import path from "node:path";
import {
  inspectDatabase,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
  assertReviewedDerivedMeasureForBoundary,
  assertReviewedAutoBandForBoundary,
  assertReviewedNumericBandForBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  generationLockSharedFactsDigest,
  loadAutoBoundaryPolicyBaseline,
  loadStructuredProjectEvidence,
  persistAutoBoundaryPolicyBaseline,
  persistGenerationLockSnapshot,
  pruneAutoBoundaryReviewOverrides,
  seedConfiguredPrincipalBindingReview,
  writeAutoBoundaryArtifacts,
  type AutoBoundaryBuild,
  type AutoBoundaryReviewOverrides,
  type BuildAutoBoundaryInput,
  type ConfiguredTrustedContextAuthority,
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
  serializeBoundaryLibraryAfterReconciliation,
  type BoundaryLibraryReconciliationState,
} from "./boundary-library.js";
import {
  backupLegacyBoundaryReviewOverrides,
  boundaryReviewOverridesForCandidate,
} from "./boundary-review-policy.js";
import { detectProjectContext } from "./project-detection.js";
import { safeTerminalText } from "./terminal-syntax.js";
import {
  configuredTrustedContextFromBoundary,
  resolveConfiguredTrustedContextAuthority,
} from "./configured-trusted-context.js";
import {
  formatRelationshipJoinColumns,
  formatRelationshipPath,
} from "./derived-scope-display.js";

export { resolveConfiguredTrustedContextAuthority } from "./configured-trusted-context.js";

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
  path_depth?: number;
  path_links?: Array<{
    source_resource: string;
    target_resource: string;
    source_columns: string[];
  }>;
};

export type BoundaryRescanPreservedAuthority = {
  resources: number;
  reviewed_paths: number;
  field_policies: number;
};

export type BoundaryRescanValueAllowlistChange = {
  resource_id: string;
  field: string;
  value_count: number;
};

export type BoundaryRescanEntry = {
  boundary_id: `bnd_${string}`;
  boundary_name: string;
  deployment_profile: ExplorationBoundaryDraft["deployment_profile"];
  previous_candidate_digest: `sha256:${string}`;
  candidate_digest: `sha256:${string}`;
  /** Exact confirmation records retained. Legacy active revisions may have none. */
  kept_confirmations: number;
  /** Concrete reviewed policy carried forward, independent of confirmation storage format. */
  preserved_authority?: BoundaryRescanPreservedAuthority;
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
  newly_proven_value_allowlists?: BoundaryRescanValueAllowlistChange[];
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
  previous_trusted_context_fingerprint?: `sha256:${string}`;
  trusted_context_fingerprint?: `sha256:${string}`;
  previous_database_server_version?: string;
  database_server_version?: string;
  previous_database_server_tier?: "full" | "compatible_limited";
  database_server_tier?: "full" | "compatible_limited";
  database_server_authority_changed?: boolean;
  database_server_authority_changes?: string[];
  schema_changed: boolean;
  role_posture_changed: boolean;
  trusted_context_changed?: boolean;
  trusted_context_changes?: string[];
  authoring_baseline_refreshed?: boolean;
  changed: boolean;
  boundaries: BoundaryRescanEntry[];
  totals: {
    boundaries: number;
    preserved_authority?: BoundaryRescanPreservedAuthority;
    kept_confirmations: number;
    safely_carried_confirmations: number;
    invalidated_decisions: number;
    newly_available_resources: number;
    newly_available_fields: number;
    newly_available_relationships: number;
    newly_proven_value_allowlists?: number;
    removed_resources: number;
    removed_fields: number;
    removed_relationships: number;
  };
  source_database_changed: false;
};

export type PreparedBoundaryRescan = {
  projectRoot: string;
  boundaryRoot: string;
  baseStateDigest: `sha256:${string}`;
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
  const baseStateDigest = await boundaryRescanBaseStateDigest(projectRoot, boundaryRoot);
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
  const now = input.now ?? new Date().toISOString();
  const savedPolicyBaseline = await optionalOldPolicyBaseline(projectRoot);
  const oldPolicyBaseline = savedPolicyBaseline?.boundary ?? oldDraft;
  const selectedPrevious = previousLibrary.boundaries[previousLibrary.selected_name];
  if (!selectedPrevious) throw new Error("Schema rescan could not load the selected boundary.");
  const selectedPreviousOverrides = boundaryReviewOverridesForCandidate({
    progress: selectedPrevious,
    baseline: oldPolicyBaseline,
    candidate: selectedPrevious.candidate,
    actor: selectedPrevious.confirmations.at(-1)?.actor ?? "boundary-rescan",
    now: selectedPrevious.updated_at,
  });
  const configuredTrustedContext = await resolveConfiguredTrustedContextAuthority({
    projectRoot,
    sourceEnv: oldLock.source_env,
    candidate: selectedPrevious.candidate,
    fallbackAuthority: oldLock.trusted_context_authority,
  });
  const previousTrustedContext = oldLock.trusted_context_authority
    ?? inferLegacyTrustedContextAuthority({
      candidate: selectedPrevious.candidate,
      inspection,
      current: configuredTrustedContext,
      overrides: selectedPreviousOverrides,
    });
  const comparableOldLock: GenerationLock = oldLock.trusted_context_fingerprint
    ? oldLock
    : {
        ...oldLock,
        trusted_context_authority: previousTrustedContext,
        trusted_context_fingerprint: canonicalJsonDigest(previousTrustedContext),
      };
  const nextBoundaries: Record<string, BoundaryReviewProgress> = {};
  const builds = new Map<string, AutoBoundaryBuild>();
  const entries: BoundaryRescanEntry[] = [];

  for (const [boundaryName, previous] of Object.entries(previousLibrary.boundaries)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const buildInput = buildInputForBoundary({
      inspection,
      project,
      evidence,
      lock: oldLock,
      candidate: previous.candidate,
      configuredTrustedContext,
    });
    const cleanBuild = buildAutoBoundary(buildInput);
    let previousOverrides = boundaryReviewOverridesForCandidate({
      progress: previous,
      baseline: oldPolicyBaseline,
      candidate: previous.candidate,
      actor: previous.confirmations.at(-1)?.actor ?? "boundary-rescan",
      now: previous.updated_at,
    });
    previousOverrides = reconcileConfiguredScopeOverrides({
      inspection,
      cleanBuild,
      previous: previousTrustedContext,
      current: configuredTrustedContext,
      overrides: previousOverrides,
      now,
    });
    const pruned = pruneAutoBoundaryReviewOverrides(
      inspection,
      previousOverrides,
      {
        project,
        parsedEvidence: evidence.parsed,
        existingContracts: evidence.existingContracts,
        configuredTrustedContext,
        previousBoundary: previous.candidate,
      },
    );
    const sharedFactsUnchanged = generationLockSharedFactsDigest(comparableOldLock)
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
    const foundationBuild = buildAutoBoundary({
      ...buildInput,
      overrides: withoutAdvancedAggregateOverrides(pruned.overrides),
    });
    const previousFoundation = withoutAdvancedAggregates(previous.candidate);
    const foundationCandidate = previousFoundation.pack.resources.length === 0
      ? rebaseEmptyDisabledBoundary(
          foundationBuild.exploration_boundary,
          previousFoundation,
          boundaryName,
        )
      : rebaseSavedBoundaryForRescan({
          generatedDraft: foundationBuild.exploration_boundary,
          previousCandidate: previousFoundation,
          boundaryName,
        });
    const reviewedAggregates = pruneInvalidAdvancedAggregateOverrides(
      foundationCandidate,
      pruned.overrides,
    );
    pruned.removed.push(...reviewedAggregates.removed);
    const build = buildAutoBoundary({ ...buildInput, overrides: reviewedAggregates.overrides });
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
      reviewOverrides: reviewedAggregates.overrides,
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
  const report = rescanReport({
    oldLock,
    selectedBuild,
    inspection,
    entries,
    now,
    previousTrustedContext,
    configuredTrustedContext,
  });
  report.authoring_baseline_refreshed = savedPolicyBaseline === undefined
    || canonicalJsonDigest(savedPolicyBaseline)
      !== canonicalJsonDigest(selectedBuild.policy_baseline);
  const { generated_at: _generatedAt, ...stableReport } = report;
  if (await boundaryRescanBaseStateDigest(projectRoot, boundaryRoot) !== baseStateDigest) {
    throw new Error(
      "Boundary review changed while the rescan preview was being prepared. Retry --rescan so no newer review is overwritten.",
    );
  }
  return {
    projectRoot,
    boundaryRoot,
    baseStateDigest,
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
  if (!prepared.report.changed && !prepared.report.authoring_baseline_refreshed) return;
  if (await boundaryRescanBaseStateDigest(prepared.projectRoot, prepared.boundaryRoot)
    !== prepared.baseStateDigest) {
    throw new Error(
      "Boundary review changed after this rescan preview was prepared. Nothing was written; retry --rescan.",
    );
  }
  if (!prepared.report.changed) {
    await persistAutoBoundaryPolicyBaseline(
      prepared.projectRoot,
      prepared.selectedBuild.policy_baseline,
    );
    await writeBoundaryRescanReport(prepared.projectRoot, prepared.report);
    return;
  }
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
    additionalPrivateStateFiles: {
      ...(prepared.persistReviewState
        ? { "boundary-library.json": serializeBoundaryLibraryAfterReconciliation(prepared.library) }
        : {}),
      [BOUNDARY_RESCAN_REPORT_FILE]: `${JSON.stringify(prepared.report, null, 2)}\n`,
    },
  });
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
    if (report.authoring_baseline_refreshed) {
      return "Rescan complete: the reviewed schema, database-server capabilities, database-role posture, and trusted-context authority are unchanged. Runner repaired the private boundary-authoring baseline so new CLI and Workbench boundaries can use the configured trusted bindings. No active boundary or reviewed revision changed.";
    }
    return "Rescan complete: the reviewed schema, database-server capabilities, database-role posture, and trusted-context authority are unchanged. No boundary revision was created.";
  }
  const preserved = preservedAuthorityForReport(report);
  const lines = [
    "RESCAN RECONCILIATION",
    `Boundaries checked: ${report.totals.boundaries}`,
    `Reviewed authority preserved: ${formatPreservedAuthority(preserved)}`,
    `Prior decisions invalidated: ${report.totals.invalidated_decisions}`,
    `Newly available: ${report.totals.newly_available_resources} tables, `
      + `${report.totals.newly_available_fields} columns, `
      + `${report.totals.newly_available_relationships} relationships`,
    ...((report.totals.newly_proven_value_allowlists ?? 0) > 0
      ? [`Newly proven value allowlists: ${report.totals.newly_proven_value_allowlists}`]
      : []),
    `Removed: ${report.totals.removed_resources} tables, ${report.totals.removed_fields} columns, `
      + `${report.totals.removed_relationships} relationships`,
    ...(report.trusted_context_changed
      ? [
          "Trusted context changed:",
          ...(report.trusted_context_changes ?? []).map((change) => `  - ${change}`),
        ]
      : []),
    ...(report.database_server_authority_changed
      ? [
          "Database server capability authority changed:",
          ...(report.database_server_authority_changes ?? []).map((change) => `  - ${change}`),
        ]
      : []),
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
        formatBoundaryRescanRelationshipChange(relationship, "removed")),
      ...boundary.removed_resources.map((resource) => `${resource}: reviewed table was removed`),
      ...boundary.newly_available_resources.map((resource) =>
        `${resource}: new table is available to review`),
      ...(boundary.newly_proven_value_allowlists ?? []).map((item) =>
        `${item.resource_id}.${item.field}: an enforced schema vocabulary now narrows existing filter/group authority to ${item.value_count} reviewed values; confirm field permissions, then activate`),
      ...boundary.pruned_review_inputs,
      ...boundary.newly_available_fields.map((field) =>
        `${field.resource_id}.${field.field}: new column is kept out until reviewed`),
      ...boundary.newly_available_relationships.map((relationship) =>
        formatBoundaryRescanRelationshipChange(relationship, "new")),
    ];
    const boundaryPreserved = preservedAuthorityForEntry(boundary);
    lines.push(
      "",
      `Boundary ${boundary.boundary_name}: preserved ${formatPreservedAuthority(boundaryPreserved)}; `
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

export function preservedAuthorityForEntry(
  entry: BoundaryRescanEntry,
): BoundaryRescanPreservedAuthority {
  return entry.preserved_authority ?? {
    resources: entry.retained_resources.length,
    reviewed_paths: 0,
    field_policies: 0,
  };
}

export function formatPreservedAuthority(
  preserved: BoundaryRescanPreservedAuthority,
): string {
  return `${preserved.resources} ${plural(preserved.resources, "table", "tables")}, `
    + `${preserved.reviewed_paths} reviewed ${plural(preserved.reviewed_paths, "path", "paths")}, `
    + `${preserved.field_policies} field ${plural(preserved.field_policies, "policy", "policies")}`;
}

export function formatBoundaryRescanRelationshipChange(
  relationship: BoundaryRescanRelationshipChange,
  state: "new" | "removed",
): string {
  const action = state === "new"
    ? "new relationship is available to review"
    : "reviewed relationship was removed";
  const links = relationship.path_links ?? [];
  if (!links.length) {
    return `${relationship.resource_id}.${relationship.relationship_id}: ${action}`;
  }
  const depth = relationship.path_depth ?? links.length;
  const display = {
    source_resource: relationship.resource_id,
    target_resource: relationship.target_resource,
    links,
  };
  const joinColumns = formatRelationshipJoinColumns(display);
  return [
    `${relationship.resource_id}: ${action} (${depth} ${plural(depth, "hop", "hops")})`,
    `    ${formatRelationshipPath(display)}`,
    ...(joinColumns ? [`    via columns: ${joinColumns}`] : []),
    `    path ID: ${relationship.relationship_id}`,
  ].join("\n");
}

function preservedAuthorityForReport(
  report: BoundaryRescanReport,
): BoundaryRescanPreservedAuthority {
  return report.totals.preserved_authority ?? report.boundaries.reduce(
    (total, entry) => addPreservedAuthority(total, preservedAuthorityForEntry(entry)),
    emptyPreservedAuthority(),
  );
}

function runnerConfigDecision(value: {
  actor: string;
  reason: string;
} | undefined): boolean {
  return value?.actor === "runner-config"
    || /^Runner config (?:principal|tenant)_binding explicitly names /i.test(value?.reason ?? "");
}

function reflectedDirectBinding(input: {
  candidate: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
  binding: string | undefined;
  kind: "tenant" | "principal";
}): boolean {
  if (!input.binding) return false;
  const tables = new Map(input.inspection.tables.map((table) => [
    `${table.schema}.${table.name}`,
    table,
  ]));
  const applicable = input.candidate.pack.resources.filter((resource) =>
    tables.get(resource.id)?.columns.some((column) =>
      column.name === input.binding && column.nullable === false));
  if (!applicable.length) return false;
  return applicable.every((resource) =>
    (input.kind === "tenant" ? resource.tenant_key : resource.principal_key) === input.binding);
}

function inferredRunnerConfigBinding(
  overrides: AutoBoundaryReviewOverrides,
  kind: "tenant" | "principal",
): string | undefined {
  const values = new Set(Object.values(overrides.resources).flatMap((resource) => {
    const decision = kind === "tenant" ? resource.tenant_key : resource.principal_key;
    return decision && decision.value && runnerConfigDecision(decision) ? [decision.value] : [];
  }));
  return values.size === 1 ? [...values][0] : undefined;
}

function inferLegacyTrustedContextAuthority(input: {
  candidate: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
  current: ConfiguredTrustedContextAuthority;
  overrides: AutoBoundaryReviewOverrides;
}): ConfiguredTrustedContextAuthority {
  const legacy = configuredTrustedContextFromBoundary(input.candidate);
  const tenantBinding = inferredRunnerConfigBinding(input.overrides, "tenant")
    ?? (reflectedDirectBinding({
      candidate: input.candidate,
      inspection: input.inspection,
      binding: input.current.tenant_binding,
      kind: "tenant",
    }) ? input.current.tenant_binding : undefined);
  const principalBinding = inferredRunnerConfigBinding(input.overrides, "principal")
    ?? (reflectedDirectBinding({
      candidate: input.candidate,
      inspection: input.inspection,
      binding: input.current.principal_binding,
      kind: "principal",
    }) ? input.current.principal_binding : undefined);
  return {
    ...legacy,
    ...(tenantBinding ? { tenant_binding: tenantBinding } : {}),
    ...(principalBinding ? { principal_binding: principalBinding } : {}),
  };
}

function removeChangedConfigBindingOverrides(input: {
  overrides: AutoBoundaryReviewOverrides;
  previous: ConfiguredTrustedContextAuthority;
  current: ConfiguredTrustedContextAuthority;
}): void {
  if (input.previous.principal_binding !== input.current.principal_binding) {
    for (const resource of Object.values(input.overrides.resources)) {
      if (runnerConfigDecision(resource.principal_key)
        && resource.principal_key?.value === input.previous.principal_binding) {
        delete resource.principal_key;
      }
    }
  }
  if (input.previous.tenant_binding !== input.current.tenant_binding) {
    for (const resource of Object.values(input.overrides.resources)) {
      if (runnerConfigDecision(resource.tenant_key)
        && resource.tenant_key?.value === input.previous.tenant_binding) {
        delete resource.tenant_key;
      }
    }
  }
}

function seedConfiguredTenantBindingReview(input: {
  inspection: SchemaInspection;
  cleanBuild: AutoBoundaryBuild;
  binding: string;
  overrides: AutoBoundaryReviewOverrides;
  now: string;
}): void {
  const generated = new Map(input.cleanBuild.exploration_boundary.pack.resources.map(
    (resource) => [resource.id, resource],
  ));
  for (const table of input.inspection.tables) {
    const column = table.columns.find((candidate) =>
      candidate.name === input.binding
      && candidate.nullable === false
      && candidate.suggestions.large_or_binary !== true);
    if (!column) continue;
    const resourceId = `${table.schema}.${table.name}`;
    if (generated.get(resourceId)?.tenant_key === column.name) continue;
    const review = input.overrides.resources[resourceId] ?? {};
    if (review.tenant_key || review.tenant_scope_path || review.shared_reference_scope) continue;
    review.tenant_key = {
      value: column.name,
      actor: "runner-config",
      reason: `Runner config tenant_binding explicitly names inspected non-null column ${column.name}; exact boundary activation is still required.`,
      decided_at: input.now,
    };
    input.overrides.resources[resourceId] = review;
  }
}

function reconcileConfiguredScopeOverrides(input: {
  inspection: SchemaInspection;
  cleanBuild: AutoBoundaryBuild;
  previous: ConfiguredTrustedContextAuthority;
  current: ConfiguredTrustedContextAuthority;
  overrides: AutoBoundaryReviewOverrides;
  now: string;
}): AutoBoundaryReviewOverrides {
  let overrides = structuredClone(input.overrides);
  removeChangedConfigBindingOverrides({
    overrides,
    previous: input.previous,
    current: input.current,
  });
  if (input.current.principal_binding) {
    overrides = seedConfiguredPrincipalBindingReview({
      inspection: input.inspection,
      principalBinding: input.current.principal_binding,
      overrides,
      actor: "runner-config",
      decidedAt: input.now,
    });
  }
  if (input.current.tenant_binding) {
    seedConfiguredTenantBindingReview({
      inspection: input.inspection,
      cleanBuild: input.cleanBuild,
      binding: input.current.tenant_binding,
      overrides,
      now: input.now,
    });
  }
  return overrides;
}

function describeTrustedContextChanges(
  previous: ConfiguredTrustedContextAuthority,
  current: ConfiguredTrustedContextAuthority,
): string[] {
  const labels: Record<Exclude<keyof ConfiguredTrustedContextAuthority, "schema_version">, string> = {
    provider: "provider",
    tenant_binding: "tenant binding",
    principal_binding: "principal binding",
    tenant_env: "tenant environment variable",
    principal_env: "principal environment variable",
    tenant_claim: "tenant JWT claim",
    principal_claim: "principal JWT claim",
  };
  const changes: string[] = [];
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    if (previous[key] === current[key]) continue;
    const before = previous[key];
    const after = current[key];
    changes.push(before === undefined
      ? `${labels[key]} ${after} added`
      : after === undefined
        ? `${labels[key]} ${before} removed`
        : `${labels[key]} changed from ${before} to ${after}`);
  }
  return changes;
}

function buildInputForBoundary(input: {
  inspection: SchemaInspection;
  project: Awaited<ReturnType<typeof detectProjectContext>>;
  evidence: Awaited<ReturnType<typeof loadStructuredProjectEvidence>>;
  lock: GenerationLock;
  candidate: ExplorationBoundaryDraft;
  configuredTrustedContext: ConfiguredTrustedContextAuthority;
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
    configuredTrustedContext: input.configuredTrustedContext,
    ...(input.configuredTrustedContext.provider === "http_claims"
      ? {
          httpClaims: {
            tenantClaim: input.configuredTrustedContext.tenant_claim,
            principalClaim: input.configuredTrustedContext.principal_claim!,
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

function preservedAuthorityCounts(
  beforeResources: Map<string, BoundaryResource>,
  afterResources: Map<string, BoundaryResource>,
): BoundaryRescanPreservedAuthority {
  const preserved = emptyPreservedAuthority();
  for (const [resourceId, before] of beforeResources) {
    const after = afterResources.get(resourceId);
    if (!after) continue;
    preserved.resources += 1;

    const beforePaths = reviewedPathSnapshots(before);
    const afterPaths = reviewedPathSnapshots(after);
    for (const [pathId, digest] of beforePaths) {
      if (afterPaths.get(pathId) === digest) preserved.reviewed_paths += 1;
    }

    for (const field of Object.keys(before.field_types)) {
      if (!Object.hasOwn(after.field_types, field)) continue;
      if (canonicalJsonDigest(reviewedFieldPolicy(before, field))
        === canonicalJsonDigest(reviewedFieldPolicy(after, field))) {
        preserved.field_policies += 1;
      }
    }
  }
  return preserved;
}

function reviewedPathSnapshots(resource: BoundaryResource): Map<string, `sha256:${string}`> {
  const roles = new Map<string, Array<{ role: string; authority: unknown }>>();
  const add = (pathId: string, role: string, authority: unknown): void => {
    const current = roles.get(pathId) ?? [];
    current.push({ role, authority });
    roles.set(pathId, current);
  };
  if (resource.tenant_scope) add(resource.tenant_scope.path_id, "tenant_scope", resource.tenant_scope);
  if (resource.principal_scope) {
    add(resource.principal_scope.path_id, "principal_scope", resource.principal_scope);
  }
  for (const relationship of resource.relationships) {
    add(relationship.id, "analysis_relationship", relationship);
  }
  return new Map([...roles].map(([pathId, entries]) => [
    pathId,
    canonicalJsonDigest(entries.sort((left, right) => left.role.localeCompare(right.role))),
  ]));
}

function reviewedFieldPolicy(resource: BoundaryResource, field: string): unknown {
  return {
    data_type: resource.field_types[field],
    exposure: fieldAccess(resource, field),
    filter_operators: resource.filterable_fields[field] ?? null,
    sortable: resource.sortable_fields.includes(field),
    groupable: resource.groupable_fields.includes(field),
    aggregate_measure: resource.aggregate_measures.includes(field),
    aggregate_functions: resource.aggregate_measure_functions?.[field] ?? null,
    presence_measure: resource.presence_measure_fields?.includes(field) ?? false,
    count_distinct: resource.count_distinct_fields.includes(field),
    time_bucket: resource.time_bucket_fields[field] ?? null,
    enum_values: resource.field_enums[field] ?? null,
    metadata: resource.field_metadata?.[field] ?? null,
    row_identity: resource.primary_key === field,
    tenant_key: resource.tenant_key === field,
    principal_key: resource.principal_key === field,
  };
}

function relationshipChange(
  resourceId: string,
  relationship: BoundaryResource["relationships"][number],
): BoundaryRescanRelationshipChange {
  const links = relationship.proof?.links.map((link) => ({
    source_resource: link.source_resource,
    target_resource: link.target_resource,
    source_columns: [...link.source_columns],
  }));
  return {
    resource_id: resourceId,
    relationship_id: relationship.id,
    target_resource: relationship.target_resource,
    path_depth: relationship.path_depth ?? links?.length ?? 1,
    ...(links?.length ? { path_links: links } : {}),
  };
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
  const newlyProvenValueAllowlists: BoundaryRescanValueAllowlistChange[] = [];
  for (const [resourceId, before] of beforeResources) {
    const generated = generatedResources.get(resourceId);
    if (!generated) continue;
    const after = afterResources.get(resourceId);
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
    for (const [field, values] of Object.entries(after?.field_enums ?? {})) {
      if (!before.field_enums[field]?.length && values.length) {
        newlyProvenValueAllowlists.push({
          resource_id: resourceId,
          field,
          value_count: values.length,
        });
      }
    }
    const beforeRelationships = new Map(before.relationships.map((relationship) => [relationship.id, relationship]));
    const generatedRelationships = new Map(generated.relationships.map((relationship) => [relationship.id, relationship]));
    for (const [relationshipId, relationship] of generatedRelationships) {
      if (!beforeRelationships.has(relationshipId)) {
        newlyAvailableRelationships.push(relationshipChange(resourceId, relationship));
      }
    }
    for (const [relationshipId, relationship] of beforeRelationships) {
      if (!generatedRelationships.has(relationshipId)) {
        removedRelationships.push(relationshipChange(resourceId, relationship));
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
    preserved_authority: preservedAuthorityCounts(beforeResources, afterResources),
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
    newly_proven_value_allowlists: sortValueAllowlistChanges(newlyProvenValueAllowlists),
    pruned_review_inputs: [...input.prunedReviewInputs].sort(),
  };
}

function rescanReport(input: {
  oldLock: GenerationLock;
  selectedBuild: AutoBoundaryBuild;
  inspection: SchemaInspection;
  entries: BoundaryRescanEntry[];
  now: string;
  previousTrustedContext: ConfiguredTrustedContextAuthority;
  configuredTrustedContext: ConfiguredTrustedContextAuthority;
}): BoundaryRescanReport {
  const schemaChanged = input.oldLock.schema_fingerprint !== input.selectedBuild.lock.schema_fingerprint;
  const roleChanged = input.oldLock.role_posture_fingerprint !== input.selectedBuild.lock.role_posture_fingerprint;
  const previousTrustedContextFingerprint = canonicalJsonDigest(input.previousTrustedContext);
  const trustedContextFingerprint = canonicalJsonDigest(input.configuredTrustedContext);
  const trustedContextChanged = previousTrustedContextFingerprint !== trustedContextFingerprint;
  const trustedContextChanges = describeTrustedContextChanges(
    input.previousTrustedContext,
    input.configuredTrustedContext,
  );
  const previousServerAuthority = input.oldLock.database_server_authority;
  const currentServerAuthority = input.selectedBuild.lock.database_server_authority;
  const serverAuthorityMetadataMissing = !input.oldLock.database_server_version
    || !input.oldLock.database_server_tier
    || !previousServerAuthority;
  const serverAuthorityChanged = serverAuthorityMetadataMissing
    || canonicalJsonDigest({
      authority: previousServerAuthority ?? null,
      tier: input.oldLock.database_server_tier ?? null,
    }) !== canonicalJsonDigest({
      authority: currentServerAuthority ?? null,
      tier: input.selectedBuild.lock.database_server_tier ?? null,
    });
  const serverAuthorityChanges = serverAuthorityChanged
    ? [
        serverAuthorityMetadataMissing
          ? `recorded detected server ${input.selectedBuild.lock.database_server_version ?? input.inspection.server_version} as the ${input.selectedBuild.lock.database_server_tier ?? "supported"} capability tier`
          : previousServerAuthority && currentServerAuthority
          ? `release line changed from ${previousServerAuthority.engine} ${previousServerAuthority.version_line} to ${currentServerAuthority.engine} ${currentServerAuthority.version_line}`
          : previousServerAuthority
            ? `the reviewed ${previousServerAuthority.engine} ${previousServerAuthority.version_line} capability profile is no longer available`
            : `recorded the ${currentServerAuthority?.engine ?? input.inspection.engine} ${currentServerAuthority?.version_line ?? input.inspection.server_version} capability profile for this boundary`,
        ...(currentServerAuthority?.features.automatic_numeric_bands === false
          ? ["automatic numeric bands are unavailable on this release line and were removed from review authority"]
          : []),
        ...(currentServerAuthority?.features.schema_check_constraints === false
          ? ["CHECK constraints cannot provide reviewed value vocabularies on this release line"]
          : []),
      ]
    : [];
  const totals = {
    boundaries: input.entries.length,
    preserved_authority: input.entries.reduce(
      (total, entry) => addPreservedAuthority(total, preservedAuthorityForEntry(entry)),
      emptyPreservedAuthority(),
    ),
    kept_confirmations: sum(input.entries, (entry) => entry.kept_confirmations),
    safely_carried_confirmations: sum(input.entries, (entry) => entry.safely_carried_confirmations.length),
    invalidated_decisions: sum(input.entries, (entry) => entry.invalidated_decisions.length),
    newly_available_resources: sum(input.entries, (entry) => entry.newly_available_resources.length),
    newly_available_fields: sum(input.entries, (entry) => entry.newly_available_fields.length),
    newly_available_relationships: sum(input.entries, (entry) => entry.newly_available_relationships.length),
    newly_proven_value_allowlists: sum(
      input.entries,
      (entry) => entry.newly_proven_value_allowlists?.length ?? 0,
    ),
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
    previous_trusted_context_fingerprint: previousTrustedContextFingerprint,
    trusted_context_fingerprint: trustedContextFingerprint,
    ...(input.oldLock.database_server_version
      ? { previous_database_server_version: input.oldLock.database_server_version }
      : {}),
    ...(input.selectedBuild.lock.database_server_version
      ? { database_server_version: input.selectedBuild.lock.database_server_version }
      : {}),
    ...(input.oldLock.database_server_tier
      ? { previous_database_server_tier: input.oldLock.database_server_tier }
      : {}),
    ...(input.selectedBuild.lock.database_server_tier
      ? { database_server_tier: input.selectedBuild.lock.database_server_tier }
      : {}),
    database_server_authority_changed: serverAuthorityChanged,
    database_server_authority_changes: serverAuthorityChanges,
    schema_changed: schemaChanged,
    role_posture_changed: roleChanged,
    trusted_context_changed: trustedContextChanged,
    trusted_context_changes: trustedContextChanges,
    changed: schemaChanged || roleChanged || trustedContextChanged || serverAuthorityChanged || policyChanged,
    boundaries: input.entries,
    totals,
    source_database_changed: false,
  };
}

function withoutAdvancedAggregateOverrides(
  input: AutoBoundaryReviewOverrides,
): AutoBoundaryReviewOverrides {
  const result = structuredClone(input);
  for (const [resourceId, resource] of Object.entries(result.resources)) {
    delete resource.derived_measures;
    delete resource.numeric_bands;
    delete resource.auto_bands;
    if (Object.keys(resource).length === 0) delete result.resources[resourceId];
  }
  return result;
}

function withoutAdvancedAggregates(input: ExplorationBoundaryDraft): ExplorationBoundaryDraft {
  const result = structuredClone(input);
  result.pack.resources.forEach((resource) => {
    delete resource.derived_measures;
    delete resource.numeric_bands;
    delete resource.auto_bands;
  });
  return result;
}

function pruneInvalidAdvancedAggregateOverrides(
  boundary: ExplorationBoundaryDraft,
  input: AutoBoundaryReviewOverrides,
): { overrides: AutoBoundaryReviewOverrides; removed: string[] } {
  const overrides = structuredClone(input);
  const removed: string[] = [];
  for (const [resourceId, resource] of Object.entries(overrides.resources)) {
    for (const [name, decision] of Object.entries(resource.derived_measures ?? {})) {
      try {
        assertReviewedDerivedMeasureForBoundary(boundary, resourceId, decision.definition);
      } catch (error) {
        delete resource.derived_measures![name];
        removed.push(
          `${resourceId}.${name}: reviewed derived measure no longer validates against current authority (${safeTerminalText(error instanceof Error ? error.message : String(error))})`,
        );
      }
    }
    if (resource.derived_measures && Object.keys(resource.derived_measures).length === 0) {
      delete resource.derived_measures;
    }
    for (const [name, decision] of Object.entries(resource.numeric_bands ?? {})) {
      try {
        assertReviewedNumericBandForBoundary(boundary, resourceId, decision.definition);
      } catch (error) {
        delete resource.numeric_bands![name];
        removed.push(
          `${resourceId}.${name}: reviewed numeric band no longer validates against current authority (${safeTerminalText(error instanceof Error ? error.message : String(error))})`,
        );
      }
    }
    if (resource.numeric_bands && Object.keys(resource.numeric_bands).length === 0) {
      delete resource.numeric_bands;
    }
    for (const [field, decision] of Object.entries(resource.auto_bands ?? {})) {
      try {
        assertReviewedAutoBandForBoundary(boundary, resourceId, decision.definition);
      } catch (error) {
        delete resource.auto_bands![field];
        removed.push(
          `${resourceId}.${field}: reviewed auto band no longer validates against current authority (${safeTerminalText(error instanceof Error ? error.message : String(error))})`,
        );
      }
    }
    if (resource.auto_bands && Object.keys(resource.auto_bands).length === 0) {
      delete resource.auto_bands;
    }
    if (Object.keys(resource).length === 0) delete overrides.resources[resourceId];
  }
  return { overrides, removed: removed.sort() };
}

async function optionalOldPolicyBaseline(
  projectRoot: string,
): Promise<AutoBoundaryBuild["policy_baseline"] | undefined> {
  try {
    return await loadAutoBoundaryPolicyBaseline(projectRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeBoundaryRescanReport(
  projectRoot: string,
  report: BoundaryRescanReport,
): Promise<void> {
  const stateRoot = path.join(projectRoot, ".synapsor");
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const temporaryRoot = await fs.mkdtemp(path.join(stateRoot, ".boundary-rescan-report-"));
  const temporary = path.join(temporaryRoot, BOUNDARY_RESCAN_REPORT_FILE);
  const destination = path.join(stateRoot, BOUNDARY_RESCAN_REPORT_FILE);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
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

function sortValueAllowlistChanges(
  changes: BoundaryRescanValueAllowlistChange[],
): BoundaryRescanValueAllowlistChange[] {
  return changes.sort((left, right) =>
    left.resource_id.localeCompare(right.resource_id) || left.field.localeCompare(right.field));
}

function invalidationKey(input: { id: string; previous_input_digest: string }): string {
  return `${input.id}:${input.previous_input_digest}`;
}

function sum<T>(values: T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function emptyPreservedAuthority(): BoundaryRescanPreservedAuthority {
  return { resources: 0, reviewed_paths: 0, field_policies: 0 };
}

function addPreservedAuthority(
  left: BoundaryRescanPreservedAuthority,
  right: BoundaryRescanPreservedAuthority,
): BoundaryRescanPreservedAuthority {
  return {
    resources: left.resources + right.resources,
    reviewed_paths: left.reviewed_paths + right.reviewed_paths,
    field_policies: left.field_policies + right.field_policies,
  };
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
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

async function boundaryRescanBaseStateDigest(
  projectRoot: string,
  boundaryRoot: string,
): Promise<`sha256:${string}`> {
  const files = [
    path.join(boundaryRoot, "exploration-boundary.draft.json"),
    path.join(boundaryRoot, "review-overrides.json"),
    path.join(projectRoot, ".synapsor/generation-lock.json"),
    path.join(projectRoot, ".synapsor/auto-boundary-policy-baseline.json"),
    path.join(projectRoot, ".synapsor/review-overrides.json"),
    path.join(projectRoot, ".synapsor/boundary-review-progress.json"),
    path.join(projectRoot, ".synapsor/boundary-library.json"),
    path.join(projectRoot, ".synapsor/exploration-boundary.active.json"),
    path.join(projectRoot, ".synapsor/exploration-boundaries.active.json"),
  ];
  const snapshots = await Promise.all(files.map(async (filePath) => {
    try {
      const contents = await fs.readFile(filePath, "utf8");
      return {
        path: path.relative(projectRoot, filePath),
        exists: true,
        digest: canonicalJsonDigest(contents),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: path.relative(projectRoot, filePath), exists: false };
      }
      throw error;
    }
  }));
  return canonicalJsonDigest({
    schema_version: "synapsor.boundary-rescan-base-state.v1",
    files: snapshots,
  });
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
