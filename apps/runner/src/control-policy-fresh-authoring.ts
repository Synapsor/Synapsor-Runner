import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AutoBoundaryBuild } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { createBoundaryReviewProgress, newBoundaryReviewId } from "./boundary-review-domain.js";
import { decodeOperatorAuthority, encodeOperatorAuthority, validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { readProjectReadAuthoring, type ProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { readAuthoringCatalog, type StoredReadAuthoring } from "./control-policy-read-authoring.js";
import { migrateProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import type { ControlPolicyPointer, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

const FRESH_GUIDED_STATE = ".synapsor/guided-onboarding.json";
const FRESH_BOOTSTRAP_CHECKPOINT = ".synapsor/fresh-governed-authoring.json";
const MAX_FRESH_BOOTSTRAP_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const LEGACY_AUTHORITY_ARTIFACTS = [
  "synapsor/generated",
  ".synapsor/exploration-boundary.active.json",
  ".synapsor/exploration-boundaries.active.json",
  ".synapsor/boundary-review-progress.json",
  ".synapsor/boundary-library.json",
  ".synapsor/action-rules",
] as const;

export type FreshGovernedAuthoringResult = {
  status: "initialized" | "resumed";
  authoring: ProjectReadAuthoring;
};

/**
 * Installs the first local governed Read review for a project created by the
 * guided initializer. It deliberately has no file-authority fallback: any
 * established legacy authority must take its explicit migration path.
 */
export async function initializeFreshGovernedAuthoring(input: {
  projectRoot: string;
  config: RuntimeConfig;
  storePath: string;
  build: AutoBoundaryBuild;
  actor: string;
  env?: NodeJS.ProcessEnv;
}): Promise<FreshGovernedAuthoringResult> {
  const root = path.resolve(input.projectRoot);
  assertLocalFreshStore(input.config, input.storePath);
  await assertFreshGuidedCheckpoint(root);
  const snapshot = await prepareFreshCheckpoint(root, input.config, input.build, input.actor);
  const migrated = await migrateProjectControlPolicies({
    projectRoot: root,
    config: input.config,
    storePath: input.storePath,
    env: input.env,
    actor: input.actor,
    readLegacySnapshot: async (lockedRoot) => {
      await assertFreshGuidedCheckpoint(lockedRoot);
      return structuredClone(snapshot);
    },
    validateSnapshot: async (candidate) => validateFreshAuthoringSnapshot(candidate, input.config),
  });
  await migrated.binding.close();
  const authoring = await readProjectReadAuthoring(root);
  if (!authoring?.selected) {
    throw failure("POLICY_FRESH_AUTHORING_MISSING", "The fresh governed Read review was not available after repository initialization. Resume the same project; do not create file-backed authority.");
  }
  return { status: migrated.status === "imported" ? "initialized" : "resumed", authoring };
}

/** Replays only a previously frozen, still-disabled fresh bootstrap. */
export async function resumeFreshGovernedAuthoring(input: {
  projectRoot: string; config: RuntimeConfig; storePath: string; actor: string; env?: NodeJS.ProcessEnv;
}): Promise<FreshGovernedAuthoringResult | undefined> {
  const root = path.resolve(input.projectRoot);
  assertLocalFreshStore(input.config, input.storePath);
  const snapshot = await readFrozenCheckpoint(root, input.config);
  if (!snapshot || !await isDisabledGuidedReviewCheckpoint(root)) return undefined;
  await assertFreshGuidedCheckpoint(root);
  const migrated = await migrateProjectControlPolicies({ projectRoot: root, config: input.config, storePath: input.storePath,
    env: input.env, actor: input.actor,
    readLegacySnapshot: async (lockedRoot) => { await assertFreshGuidedCheckpoint(lockedRoot); return structuredClone(snapshot); },
    validateSnapshot: async (candidate) => validateFreshAuthoringSnapshot(candidate, input.config),
  });
  await migrated.binding.close();
  const authoring = await readProjectReadAuthoring(root);
  if (!authoring?.selected) throw failure("POLICY_FRESH_AUTHORING_MISSING", "The frozen fresh Read review was not available after recovery.");
  return { status: "resumed", authoring };
}

function initialSnapshot(build: AutoBoundaryBuild, actor: string): ControlPolicyMigrationSnapshot {
  const candidate = recommendedBoundaryReviewCandidate(build.exploration_boundary);
  const progress = createBoundaryReviewProgress({
    draft: build.exploration_boundary,
    candidate,
    boundaryId: newBoundaryReviewId(),
    reviewOverrides: build.overrides,
    confirmedDecisions: [],
    actor,
    reason: "Fresh local governed authoring; pending human review.",
    revision: 1,
  });
  const authoring: StoredReadAuthoring = {
    type: "read_authoring",
    selected_boundary_id: progress.boundary_id,
    entries: [{
      draft: build.exploration_boundary,
      draft_lock: build.lock,
      candidate_lock: build.lock,
      progress,
      catalog: readAuthoringCatalog(build),
      ...(candidate.pack.resources.length === 0 ? { stage: "metadata_only" as const } : {}),
    }],
  };
  const activePolicies = [
    { type: "read_selection" as const, selected_name: null },
    authoring,
  ];
  const activeRevisions = activePolicies.map((policy) => encodeOperatorAuthority(policy));
  const draftRevisions = candidate.pack.resources.length === 0 ? [] : [encodeOperatorAuthority({
    type: "read" as const,
    boundary: candidate,
    generation_lock: build.lock,
  })];
  const revisions = [...activeRevisions, ...draftRevisions];
  return {
    revisions,
    active: activeRevisions.map(pointer),
    drafts: draftRevisions.map(pointer),
    provenance: [],
  };
}

function pointer(revision: ControlPolicyRevision): ControlPolicyPointer {
  return { scope: revision.scope, kind: revision.kind, name: revision.name, revision_id: revision.revision_id };
}

function assertLocalFreshStore(config: RuntimeConfig, storePath: string): void {
  if (config.storage?.shared_postgres) {
    throw failure("POLICY_FRESH_AUTHORING_LOCAL_ONLY", "Fresh guided governed authoring requires the new project's local control store. Configure a shared policy store through its explicit reviewed provisioning path.");
  }
  if (storePath === ":memory:") {
    throw failure("POLICY_FRESH_AUTHORING_STORE_INVALID", "Fresh guided governed authoring requires a persistent local control store.");
  }
}

async function assertFreshGuidedCheckpoint(projectRoot: string): Promise<void> {
  const statePath = path.join(projectRoot, FRESH_GUIDED_STATE);
  const state = await fs.readFile(statePath, "utf8").then((text) => JSON.parse(text) as {
    schema_version?: unknown; authority_active?: unknown; status?: unknown;
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw failure("POLICY_FRESH_AUTHORING_CHECKPOINT_REQUIRED", "Create the fresh guided project before initializing governed authoring. Existing projects are never converted automatically.");
    throw error;
  });
  if (state.schema_version !== "synapsor.guided-onboarding.v1"
    || state.authority_active !== false || state.status !== "review_boundary") {
    throw failure("POLICY_FRESH_AUTHORING_CHECKPOINT_INVALID", "This project is not an untouched disabled guided-authoring checkpoint. Resume its existing review or use the explicit migration path.");
  }
  for (const relative of LEGACY_AUTHORITY_ARTIFACTS) {
    const entry = await fs.lstat(path.join(projectRoot, relative)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry) {
      throw failure("POLICY_FRESH_AUTHORING_LEGACY_AUTHORITY", "Existing file-backed Read or Action authority was found. Runner will not silently migrate or replace it; use the explicit migration/review path.");
    }
  }
}

async function prepareFreshCheckpoint(projectRoot: string, config: RuntimeConfig, build: AutoBoundaryBuild,
  actor: string): Promise<ControlPolicyMigrationSnapshot> {
  return withProjectAuthorityMutation(projectRoot, () => prepareFreshCheckpointUnlocked(projectRoot, config, build, actor));
}

async function prepareFreshCheckpointUnlocked(projectRoot: string, config: RuntimeConfig, build: AutoBoundaryBuild,
  actor: string): Promise<ControlPolicyMigrationSnapshot> {
  const checkpointPath = path.join(projectRoot, FRESH_BOOTSTRAP_CHECKPOINT);
  const snapshot = initialSnapshot(build, actor);
  const expected = {
    schema_version: "synapsor.fresh-governed-authoring.v1",
    config_digest: canonicalJsonDigest(config),
    snapshot,
  };
  const existing = await fs.lstat(checkpointPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) return (await readFrozenCheckpoint(projectRoot, config))!;
  const contents = `${JSON.stringify(expected)}\n`;
  if (Buffer.byteLength(contents) > MAX_FRESH_BOOTSTRAP_CHECKPOINT_BYTES) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_TOO_LARGE", "The exact fresh metadata checkpoint exceeds its bounded storage limit. No checkpoint or authority was published.");
  }
  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    // The project writer lock preserves exclusive creation; rename publishes
    // a complete, single-link file even if the process dies immediately after.
    await fs.rename(temporary, checkpointPath);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(checkpointPath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return snapshot;
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}

async function readFrozenCheckpoint(projectRoot: string, config: RuntimeConfig): Promise<ControlPolicyMigrationSnapshot | undefined> {
  const checkpointPath = path.join(projectRoot, FRESH_BOOTSTRAP_CHECKPOINT);
  const stat = await fs.lstat(checkpointPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FRESH_BOOTSTRAP_CHECKPOINT_BYTES) {
    throw failure("POLICY_FRESH_AUTHORING_CHECKPOINT_INVALID", "The fresh governed-authoring checkpoint is not a private regular file. Do not replace it; resume from a verified local project copy.");
  }
  let actual: unknown;
  try { actual = JSON.parse(await fs.readFile(checkpointPath, "utf8")); }
  catch { throw failure("POLICY_FRESH_AUTHORING_CHECKPOINT_INVALID", "The fresh governed-authoring checkpoint is invalid. Do not infer a new authority from this project."); }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    throw failure("POLICY_FRESH_AUTHORING_CHECKPOINT_INVALID", "The fresh governed-authoring checkpoint is invalid. Do not infer a new authority from this project.");
  }
  const record = actual as { schema_version?: unknown; config_digest?: unknown; snapshot?: unknown };
  if (record.schema_version !== "synapsor.fresh-governed-authoring.v1" || record.config_digest !== canonicalJsonDigest(config)) {
    throw failure("POLICY_FRESH_AUTHORING_CHECKPOINT_CHANGED", "The generated config changed after fresh governed bootstrap began. Resume the exact checkpoint or start a new fresh project; Runner will not rebind it.");
  }
  try {
    validateFreshAuthoringSnapshot(record.snapshot as ControlPolicyMigrationSnapshot, config);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID") throw error;
    throw failure("POLICY_FRESH_AUTHORING_CHECKPOINT_INVALID", "The frozen fresh governed-authoring snapshot is invalid. Do not infer replacement authority from this project.");
  }
  return structuredClone(record.snapshot as ControlPolicyMigrationSnapshot);
}

async function isDisabledGuidedReviewCheckpoint(projectRoot: string): Promise<boolean> {
  try {
    const state = JSON.parse(await fs.readFile(path.join(projectRoot, FRESH_GUIDED_STATE), "utf8")) as {
      schema_version?: unknown; authority_active?: unknown; status?: unknown;
    };
    return state.schema_version === "synapsor.guided-onboarding.v1"
      && state.authority_active === false && state.status === "review_boundary";
  } catch { return false; }
}

function validateFreshAuthoringSnapshot(snapshot: ControlPolicyMigrationSnapshot, config: RuntimeConfig): void {
  validateOperatorPolicySnapshot(snapshot, { runtimeConfig: config });
  if (snapshot.provenance.length !== 0 || snapshot.active.length !== 2 || snapshot.revisions.length < 2 || snapshot.revisions.length > 3) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "The fresh governed-authoring checkpoint contains records outside the initial disabled Read review.");
  }
  const revisions = new Map(snapshot.revisions.map((revision) => [revision.revision_id, revision]));
  const active = snapshot.active.map((pointer) => {
    if (!pointer.revision_id || !revisions.has(pointer.revision_id)) {
      throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "The fresh governed-authoring checkpoint has an invalid active policy pointer.");
    }
    return decodeOperatorAuthority(revisions.get(pointer.revision_id)!, { runtimeConfig: config });
  });
  const selection = active.find((policy) => policy.type === "read_selection");
  const authoring = active.find((policy) => policy.type === "read_authoring");
  if (active.length !== 2 || !selection || selection.selected_name !== null || !authoring
    || authoring.entries.length !== 1 || authoring.selected_boundary_id !== authoring.entries[0]!.progress.boundary_id) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "The fresh governed-authoring checkpoint must contain only an unselected Read record and one disabled authoring entry.");
  }
  const entry = authoring.entries[0]!;
  if (entry.progress.confirmed_decisions.length !== 0 || entry.progress.confirmations.length !== 0
    || entry.progress.invalidated_decisions.length !== 0) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "The fresh governed-authoring checkpoint cannot restore caller or human review confirmations.");
  }
  const metadataOnly = entry.stage === "metadata_only";
  if (metadataOnly !== (entry.progress.candidate.pack.resources.length === 0)) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "The fresh governed-authoring checkpoint's metadata-only stage does not match its exact disabled Read candidate.");
  }
  if (metadataOnly) {
    if (snapshot.drafts.length !== 0 || snapshot.revisions.length !== 2) {
      throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "A metadata-only fresh checkpoint cannot contain disabled Read policy drafts.");
    }
    return;
  }
  if (snapshot.drafts.length !== 1 || snapshot.revisions.length !== 3) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "A fresh governed checkpoint must contain exactly one matching disabled Read draft.");
  }
  const pointer = snapshot.drafts[0]!;
  if (!pointer.revision_id || !revisions.has(pointer.revision_id)) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "The fresh governed checkpoint has an invalid disabled Read pointer.");
  }
  const draft = decodeOperatorAuthority(revisions.get(pointer.revision_id)!, { runtimeConfig: config });
  if (draft.type !== "read" || draft.boundary.activation !== "disabled_unreviewed"
    || canonicalJsonDigest(draft.boundary) !== canonicalJsonDigest(entry.progress.candidate)
    || canonicalJsonDigest(draft.generation_lock) !== canonicalJsonDigest(entry.candidate_lock)) {
    throw failure("POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID", "The fresh governed checkpoint's disabled Read draft is not the exact saved authoring candidate.");
  }
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
