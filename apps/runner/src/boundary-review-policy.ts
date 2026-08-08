import fs from "node:fs/promises";
import path from "node:path";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  emptyReviewOverrides,
  normalizeAutoBoundaryReviewOverrides,
  type AutoBoundaryReviewOverrides,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import type { BoundaryReviewProgress } from "./boundary-review-domain.js";

type BoundaryResource = ExplorationBoundaryDraft["pack"]["resources"][number];
type ResourceOverride = AutoBoundaryReviewOverrides["resources"][string];

export function boundaryReviewOverridesForCandidate(input: {
  progress: BoundaryReviewProgress | undefined;
  baseline: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  actor?: string;
  now?: string;
}): AutoBoundaryReviewOverrides {
  if (input.progress?.policy_migration.status === "complete") {
    return normalizeAutoBoundaryReviewOverrides(input.progress.review_overrides);
  }
  return reconstructBoundaryReviewOverrides({
    baseline: input.baseline,
    candidate: input.candidate,
    actor: input.actor
      ?? input.progress?.confirmations.at(-1)?.actor
      ?? "boundary-policy-migration",
    decidedAt: input.now ?? input.progress?.updated_at ?? new Date().toISOString(),
  });
}

/**
 * Reconstruct only choices represented by the old project-wide override file.
 * The exact saved candidate, rather than that ambiguous file, is authoritative.
 */
export function reconstructBoundaryReviewOverrides(input: {
  baseline: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  actor: string;
  decidedAt: string;
}): AutoBoundaryReviewOverrides {
  const overrides = emptyReviewOverrides();
  const baselineResources = new Map(
    input.baseline.pack.resources.map((resource) => [resource.id, resource]),
  );
  for (const candidate of input.candidate.pack.resources) {
    const baseline = baselineResources.get(candidate.id);
    if (!baseline) continue;
    const resource: ResourceOverride = {};
    const decision = <T>(value: T) => ({
      value,
      actor: boundedMigrationText(input.actor, "migration actor", 128),
      reason: `Reconstructed from exact saved boundary ${input.candidate.pack.name}; no project-wide policy was assigned.`,
      decided_at: input.decidedAt,
    });

    if (candidate.primary_key !== baseline.primary_key) {
      resource.row_identity = decision(candidate.primary_key);
    }
    if (candidate.tenant_scope?.path_id !== baseline.tenant_scope?.path_id) {
      if (candidate.tenant_scope) resource.tenant_scope_path = decision(candidate.tenant_scope.path_id);
      else if (candidate.tenant_key) resource.tenant_key = decision(candidate.tenant_key);
      else if (candidate.shared_reference_scope) {
        resource.shared_reference_scope = decision(
          candidate.shared_reference_scope.acknowledgement,
        );
      }
    } else if (candidate.tenant_key !== baseline.tenant_key && candidate.tenant_key) {
      resource.tenant_key = decision(candidate.tenant_key);
    } else if (candidate.shared_reference_scope
      && JSON.stringify(candidate.shared_reference_scope)
        !== JSON.stringify(baseline.shared_reference_scope)) {
      resource.shared_reference_scope = decision(
        candidate.shared_reference_scope.acknowledgement,
      );
    }
    if (candidate.principal_scope?.path_id !== baseline.principal_scope?.path_id) {
      if (candidate.principal_scope) {
        resource.principal_scope_path = decision(candidate.principal_scope.path_id);
      } else {
        resource.principal_key = decision(candidate.principal_key ?? null);
      }
    } else if (candidate.principal_key !== baseline.principal_key) {
      resource.principal_key = decision(candidate.principal_key ?? null);
    }
    if (candidate.minimum_cohort_size !== baseline.minimum_cohort_size
      || candidate.minimum_cohort_overridden === true) {
      resource.minimum_cohort = decision(candidate.minimum_cohort_size);
    }

    const fields = reconstructFieldExposureOverrides(baseline, candidate, input);
    if (Object.keys(fields).length) resource.fields = fields;
    const fieldEnums = reconstructFieldEnumOverrides(baseline, candidate, input);
    if (Object.keys(fieldEnums).length) resource.field_enums = fieldEnums;
    if (Object.keys(resource).length) overrides.resources[candidate.id] = resource;
  }
  return normalizeAutoBoundaryReviewOverrides({
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
    resources: overrides.resources,
  });
}

export async function backupLegacyBoundaryReviewOverrides(projectRoot: string): Promise<void> {
  const stateRoot = path.join(path.resolve(projectRoot), ".synapsor");
  const legacy = path.join(stateRoot, "review-overrides.json");
  const backup = path.join(stateRoot, "review-overrides.legacy-backup.json");
  try {
    await fs.access(backup);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const stat = await fs.lstat(legacy);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Legacy boundary review overrides must be a regular project-local file.");
    }
    await fs.copyFile(legacy, backup, fs.constants.COPYFILE_EXCL);
    await fs.chmod(backup, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function loadCompletedBoundaryReviewOverrides(input: {
  projectRoot: string;
  boundaryName: string;
}): Promise<AutoBoundaryReviewOverrides | undefined> {
  const stateRoot = path.join(path.resolve(input.projectRoot), ".synapsor");
  const current = await readOptionalJson(path.join(stateRoot, "boundary-review-progress.json"));
  const currentResult = completedOverridesFromStoredProgress(current, input.boundaryName);
  if (currentResult) return currentResult;
  const library = await readOptionalJson(path.join(stateRoot, "boundary-library.json"));
  if (isRecord(library) && isRecord(library.boundaries)) {
    const saved = completedOverridesFromStoredProgress(
      library.boundaries[input.boundaryName],
      input.boundaryName,
    );
    if (saved) return saved;
  }
  return loadUnambiguousLegacyOverrides(stateRoot, input.boundaryName, current, library);
}

function reconstructFieldExposureOverrides(
  baseline: BoundaryResource,
  candidate: BoundaryResource,
  input: { candidate: ExplorationBoundaryDraft; actor: string; decidedAt: string },
): NonNullable<ResourceOverride["fields"]> {
  const result: NonNullable<ResourceOverride["fields"]> = {};
  const fields = new Set([
    ...Object.keys(baseline.field_types),
    ...Object.keys(candidate.field_types),
  ]);
  for (const field of [...fields].sort()) {
    const before = fieldExposure(baseline, field);
    const after = fieldExposure(candidate, field);
    if (before === after) continue;
    result[field] = {
      exposure: after,
      actor: boundedMigrationText(input.actor, "migration actor", 128),
      reason: `Reconstructed from exact saved boundary ${input.candidate.pack.name}; no project-wide field policy was assigned.`,
      decided_at: input.decidedAt,
    };
  }
  return result;
}

function reconstructFieldEnumOverrides(
  baseline: BoundaryResource,
  candidate: BoundaryResource,
  input: { candidate: ExplorationBoundaryDraft; actor: string; decidedAt: string },
): NonNullable<ResourceOverride["field_enums"]> {
  const result: NonNullable<ResourceOverride["field_enums"]> = {};
  const fields = new Set([
    ...Object.keys(baseline.field_enums),
    ...Object.keys(candidate.field_enums),
  ]);
  for (const field of [...fields].sort()) {
    if (fieldExposure(candidate, field) !== "allow_reviewed_use") continue;
    const before = baseline.field_enums[field];
    if (!before) continue;
    const after = candidate.field_enums[field] ?? [];
    if (sameStrings(before, after)) continue;
    result[field] = {
      values: [...after],
      actor: boundedMigrationText(input.actor, "migration actor", 128),
      reason: `Reconstructed from exact saved boundary ${input.candidate.pack.name}; no project-wide enum policy was assigned.`,
      decided_at: input.decidedAt,
    };
  }
  return result;
}

function fieldExposure(
  resource: BoundaryResource,
  field: string,
): "keep_out" | "withhold_from_model" | "allow_reviewed_use" {
  if (resource.kept_out_fields.includes(field) || !resource.selectable_fields.includes(field)) {
    return "keep_out";
  }
  return (resource.model_withheld_fields ?? []).includes(field)
    ? "withhold_from_model"
    : "allow_reviewed_use";
}

function completedOverridesFromStoredProgress(
  value: unknown,
  expectedName: string,
): AutoBoundaryReviewOverrides | undefined {
  if (!isRecord(value)
    || !isRecord(value.candidate)
    || !isRecord(value.candidate.pack)
    || value.candidate.pack.name !== expectedName
    || !isRecord(value.policy_migration)
    || value.policy_migration.status !== "complete") {
    return undefined;
  }
  return normalizeAutoBoundaryReviewOverrides(value.review_overrides);
}

async function readOptionalJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadUnambiguousLegacyOverrides(
  stateRoot: string,
  expectedName: string,
  current: unknown,
  library: unknown,
): Promise<AutoBoundaryReviewOverrides | undefined> {
  const names = new Set<string>();
  collectStoredBoundaryName(current, names);
  if (isRecord(library) && isRecord(library.boundaries)) {
    Object.keys(library.boundaries).forEach((name) => names.add(name));
  }
  const activeSet = await readOptionalJson(path.join(stateRoot, "exploration-boundaries.active.json"));
  if (isRecord(activeSet) && Array.isArray(activeSet.boundaries)) {
    activeSet.boundaries.forEach((boundary) => collectStoredBoundaryName(boundary, names));
  } else {
    collectStoredBoundaryName(
      await readOptionalJson(path.join(stateRoot, "exploration-boundary.active.json")),
      names,
    );
  }
  if (names.size > 1 || (names.size === 1 && !names.has(expectedName))) return undefined;
  const legacy = await readOptionalJson(path.join(stateRoot, "review-overrides.json"));
  return legacy === undefined ? undefined : normalizeAutoBoundaryReviewOverrides(legacy);
}

function collectStoredBoundaryName(value: unknown, names: Set<string>): void {
  if (!isRecord(value)) return;
  const pack = isRecord(value.candidate) && isRecord(value.candidate.pack)
    ? value.candidate.pack
    : isRecord(value.pack)
      ? value.pack
      : undefined;
  if (pack && typeof pack.name === "string") names.add(pack.name);
}

function boundedMigrationText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be non-empty review text of at most ${maximum} characters.`);
  }
  return normalized;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
