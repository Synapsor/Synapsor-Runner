import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import type { ControlPolicyPointer, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { listActionRuleAuthorityDrafts, parseStoredActionRuleAuthority, readActionRuleAuthorityActivation } from "./action-rule-authority.js";
import { parseExplorationBoundaryDraftArtifact, type GenerationLock, loadActivatedExplorationBoundaries, loadGenerationLockForActivatedBoundary, loadGenerationLockSnapshot,
  type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { readBoundaryReviewProgress } from "./boundary-review-persistence.js";
import { loadBoundaryLibraryForReconciliation, resolveSavedBoundaryReviewAuthority } from "./boundary-library.js";
import { encodeOperatorAuthority, encodeOperatorExecutionPolicy, validateOperatorPolicySnapshot,
  type StoredOperatorAuthority } from "./control-policy-authority-codec.js";
import { executionBindingDigest } from "./control-policy-execution.js";
import { migrateProjectControlPolicies, openProjectControlPolicies, type BoundProjectPolicyStore, type ControlPolicyMigrationSnapshot,
  type ProjectPolicyStoreSelection } from "./control-policy-store.js";

const MAX_LEGACY_RECORDS = 64;
const MAX_LEGACY_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const GENERATED_DRAFT = "synapsor/generated/exploration-boundary.draft.json";
const REVIEW_PROGRESS = ".synapsor/boundary-review-progress.json";

export type ProjectControlPolicyMigrationPreview = {
  status: "ready";
  epoch: 0;
  migration_digest: `sha256:${string}`;
  snapshot: ControlPolicyMigrationSnapshot;
} | {
  status: "already_migrated";
  epoch: number;
} | {
  status: "migration_pending";
  epoch: 0;
};

/** Inspects the exact local authority exports. This performs no source access,
 * grants, activation, parent-policy creation, or legacy-file mutation. */
export async function previewProjectControlPolicyMigration(input: {
  projectRoot: string; config: RuntimeConfig; env?: NodeJS.ProcessEnv; storePath?: string;
}):
Promise<ProjectControlPolicyMigrationPreview> {
  const root = path.resolve(input.projectRoot);
  const storePath = input.storePath ?? path.resolve(root, input.config.storage?.sqlite_path ?? ".synapsor/local.db");
  try {
    const binding = await openProjectControlPolicies({ projectRoot: root, config: input.config, storePath, env: input.env });
    if (binding) {
      try { return { status: "already_migrated", epoch: (await binding.repository.deployment(binding.deployment_id))!.epoch }; }
      finally { await binding.close(); }
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code === "POLICY_MIGRATION_PENDING") return { status: "migration_pending", epoch: 0 };
    throw error;
  }
  const provenance: ControlPolicyMigrationSnapshot["provenance"] = [];
  const addProvenance = async (relative: string) => {
    const raw = await readOptionalJson(path.join(root, relative));
    if (raw !== undefined) provenance.push({ path: relative, digest: canonicalJsonDigest(raw) });
    return raw;
  };

  try {
    const activeReads = await loadActivatedExplorationBoundaries(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    let activeSet: unknown;
    if (activeReads.length) {
      activeSet = await addProvenance(".synapsor/exploration-boundaries.active.json");
      await addProvenance(".synapsor/exploration-boundary.active.json");
    }
    const authorities: Array<{ state: "active" | "draft"; policy: StoredOperatorAuthority }> = [];
    for (const boundary of activeReads) {
      const lockPath = `.synapsor/exploration-locks/${boundary.generation_lock_fingerprint.slice(7)}.json`;
      // The general active-boundary loader may recreate a missing snapshot
      // from mutable current state. Migration is strictly observational.
      if (await addProvenance(lockPath) === undefined) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
      const lock = await loadGenerationLockForActivatedBoundary(root, boundary);
      authorities.push({ state: "active", policy: { type: "read", boundary, generation_lock: lock } });
    }
    const selectedActiveName = selectedActiveReadName(activeReads, activeSet);
    authorities.push({ state: "active", policy: { type: "read_selection", selected_name: selectedActiveName } });

    const draftArtifact = await addProvenance(GENERATED_DRAFT);
    const draft = draftArtifact === undefined ? undefined : parseExplorationBoundaryDraftArtifact(draftArtifact,
      await addProvenance(".synapsor/generation-lock.json") as GenerationLock);
    const progressArtifact = await addProvenance(REVIEW_PROGRESS);
    if ((draft === undefined) !== (progressArtifact === undefined)) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
    if (draft) {
      const currentProgress = await readBoundaryReviewProgress(root, draft);
      if (!currentProgress) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
      const libraryArtifact = await addProvenance(".synapsor/boundary-library.json");
      const reconciled = libraryArtifact === undefined
        ? { selected_name: currentProgress.candidate.pack.name, boundaries: { [currentProgress.candidate.pack.name]: currentProgress } }
        : await loadBoundaryLibraryForReconciliation({ projectRoot: root, draft, currentCandidate: currentProgress.candidate, currentProgress });
      const selectedLibraryName = libraryArtifact === undefined
        ? reconciled.selected_name : exactLibrarySelection(libraryArtifact, reconciled.boundaries);
      const library = { ...reconciled, selected_name: selectedLibraryName };
      const entries = [];
      for (const [name, progress] of Object.entries(library.boundaries).sort(([left], [right]) => left.localeCompare(right))) {
        if (name !== progress.candidate.pack.name || progress.candidate.pack.resources.length === 0) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
        const resolved = await resolveSavedBoundaryReviewAuthority({ projectRoot: root, draft, candidate: progress.candidate, progress });
        const draftLock = await loadGenerationLockSnapshot(root, resolved.reviewDraft.generation_lock_fingerprint);
        entries.push({ draft: resolved.reviewDraft, draft_lock: draftLock, candidate_lock: resolved.generationLock, progress });
        authorities.push({ state: "draft" as const, policy: { type: "read", boundary: progress.candidate, generation_lock: resolved.generationLock } });
        await addProvenance(`.synapsor/exploration-locks/${resolved.reviewDraft.generation_lock_fingerprint.slice(7)}.json`);
        await addProvenance(`.synapsor/exploration-locks/${progress.candidate.generation_lock_fingerprint.slice(7)}.json`);
      }
      const selected = library.boundaries[library.selected_name];
      if (!selected) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
      authorities.push({ state: "active", policy: { type: "read_authoring", selected_boundary_id: selected.boundary_id, entries } });
    }

    const drafts = await listActionRuleAuthorityDrafts(root);
    assertUniqueActionDraftNames(drafts);
    for (const authority of drafts) authorities.push({ state: "draft", policy: { type: "action", authority } });
    const activeAction = await readActionRuleAuthorityActivation(root);
    if (activeAction) authorities.push({ state: "active", policy: { type: "action", authority: activeAction } });
    const actionHistory = await addActionProvenance(root, provenance, input.config);
    const execution = encodeOperatorExecutionPolicy(input.config);
    if (execution) authorities.push({ state: "active", policy: { type: "execution", runtime_binding_digest: executionBindingDigest(input.config),
      policy: input.config.supervised_worker! } });
    if (authorities.length + actionHistory.length > MAX_LEGACY_RECORDS) refuse("POLICY_MIGRATION_SNAPSHOT_TOO_LARGE");

    const pointedRevisions = authorities.map(({ policy }) => encodeOperatorAuthority(policy, { runtimeConfig: input.config }));
    const revisions = deduplicateRevisions([...pointedRevisions, ...actionHistory]);
    const pointer = (revision: ControlPolicyRevision): ControlPolicyPointer => ({ scope: revision.scope, kind: revision.kind,
      name: revision.name, revision_id: revision.revision_id });
    const snapshot: ControlPolicyMigrationSnapshot = {
      revisions,
      active: pointedRevisions.filter((_revision, index) => authorities[index]!.state === "active").map(pointer),
      drafts: pointedRevisions.filter((_revision, index) => authorities[index]!.state === "draft").map(pointer),
      provenance: provenance.sort((left, right) => left.path.localeCompare(right.path)),
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) refuse("POLICY_MIGRATION_SNAPSHOT_TOO_LARGE");
    validateOperatorPolicySnapshot(snapshot, { runtimeConfig: input.config });
    return { status: "ready", epoch: 0, migration_digest: canonicalJsonDigest(snapshot), snapshot: structuredClone(snapshot) };
  } catch (error) {
    if ((error as { code?: unknown })?.code?.toString().startsWith("POLICY_")) throw error;
    refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE", error);
  }
}

/** Rechecks the supplied preview under the actual cutover lock. A changed file
 * cannot be imported under a previously reviewed digest. */
export async function migrateProjectControlPoliciesFromProject(input: ProjectPolicyStoreSelection & {
  actor: string;
  preview: ProjectControlPolicyMigrationPreview;
}): Promise<{ binding: BoundProjectPolicyStore; status: "imported" | "already_imported" }> {
  const expected = structuredClone(input.preview);
  return migrateProjectControlPolicies({ ...input,
    readLegacySnapshot: async (lockedProjectRoot) => {
      if (expected.status !== "ready") refuse("POLICY_MIGRATION_PREVIEW_REQUIRED");
      const current = await previewProjectControlPolicyMigration({ projectRoot: lockedProjectRoot, config: input.config,
        storePath: input.storePath, env: input.env });
      if (current.status !== "ready" || current.migration_digest !== expected.migration_digest
        || canonicalJsonDigest(current.snapshot) !== canonicalJsonDigest(expected.snapshot)) {
        refuse("POLICY_MIGRATION_PREVIEW_STALE");
      }
      return current.snapshot;
    },
    validateSnapshot: async (snapshot) => validateOperatorPolicySnapshot(snapshot, { runtimeConfig: input.config }),
  });
}

function selectedActiveReadName(active: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>, activeSet: unknown): string | null {
  if (active.length === 0) return null;
  if (active.length === 1 && (!activeSet || typeof activeSet !== "object" || Array.isArray(activeSet))) return active[0]!.pack.name;
  const selected = (activeSet as { selected_name?: unknown } | undefined)?.selected_name;
  if (typeof selected !== "string" || !active.some((boundary) => boundary.pack.name === selected)) {
    refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
  }
  return selected;
}

function exactLibrarySelection(value: unknown, boundaries: Record<string, unknown>): string {
  const selected = (value as { selected_name?: unknown } | null)?.selected_name;
  if (typeof selected !== "string" || !boundaries[selected]) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
  return selected;
}

async function addActionProvenance(
  root: string,
  provenance: ControlPolicyMigrationSnapshot["provenance"],
  config: RuntimeConfig,
): Promise<ControlPolicyRevision[]> {
  const state = path.join(root, ".synapsor", "action-rules");
  try { await fs.readdir(state, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  for (const name of ["active.json"]) {
    const value = await readOptionalJson(path.join(state, name));
    if (value !== undefined) provenance.push({ path: `.synapsor/action-rules/${name}`, digest: canonicalJsonDigest(value) });
  }
  const drafts = path.join(state, "drafts");
  let names: import("node:fs").Dirent[];
  try { names = await fs.readdir(drafts, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }
  for (const entry of names.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const value = await readOptionalJson(path.join(drafts, entry.name, "authority.json"));
    if (value === undefined) {
      const contents = await fs.readdir(path.join(drafts, entry.name));
      // Activating a draft removes its file but intentionally leaves the
      // containing directory behind. Other incomplete contents are unsafe.
      if (contents.length === 0) continue;
      refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
    }
    const authority = parseStoredActionRuleAuthority(value);
    // Legacy writer paths are keyed by the one current bundle name. A second
    // directory claiming that name has no selected draft to migrate safely.
    if (entry.name !== authority.authority.name) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
    provenance.push({ path: `.synapsor/action-rules/drafts/${entry.name}/authority.json`, digest: canonicalJsonDigest(value) });
  }
  const history = path.join(state, "revisions");
  let revisions: import("node:fs").Dirent[];
  try { revisions = await fs.readdir(history, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const imported: ControlPolicyRevision[] = [];
  for (const entry of revisions.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `.synapsor/action-rules/revisions/${entry.name}/authority.json`;
    const value = await readOptionalJson(path.join(history, entry.name, "authority.json"));
    if (value === undefined) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
    const authority = parseStoredActionRuleAuthority(value);
    if (authority.state !== "active" || entry.name !== authority.digest.slice("sha256:".length)) {
      refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
    }
    provenance.push({ path: relative, digest: canonicalJsonDigest(value) });
    imported.push(encodeOperatorAuthority({ type: "action", authority }, { runtimeConfig: config }));
  }
  return imported;
}

function assertUniqueActionDraftNames(drafts: Awaited<ReturnType<typeof listActionRuleAuthorityDrafts>>): void {
  const names = new Set<string>();
  for (const draft of drafts) {
    if (names.has(draft.authority.name)) refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
    names.add(draft.authority.name);
  }
}

function deduplicateRevisions(revisions: ControlPolicyRevision[]): ControlPolicyRevision[] {
  const unique = new Map<string, ControlPolicyRevision>();
  for (const revision of revisions) {
    const existing = unique.get(revision.revision_id);
    if (existing && canonicalJsonDigest(existing) !== canonicalJsonDigest(revision)) {
      refuse("POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE");
    }
    unique.set(revision.revision_id, revision);
  }
  return [...unique.values()];
}

async function readOptionalJson(file: string): Promise<unknown | undefined> {
  let stat;
  try { stat = await fs.stat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.size > MAX_LEGACY_ARTIFACT_BYTES) refuse("POLICY_MIGRATION_SNAPSHOT_TOO_LARGE");
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

function refuse(code: string, cause?: unknown): never {
  throw Object.assign(new Error(`${code}: legacy project authority was not migrated; no source data or authority changed.`, cause === undefined ? undefined : { cause }), { code });
}
