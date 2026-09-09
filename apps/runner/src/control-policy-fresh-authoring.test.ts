import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary, explorationBoundaryCandidateDigest, loadGenerationLockSnapshot, persistGenerationLockSnapshot } from "./auto-boundary.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readAuthoringCatalog } from "./control-policy-read-authoring.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { readProjectReadAuthoring, saveProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { buildActionCatalogForSavedReadRevision } from "./action-rule-read-revision.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { readRuntimeConfig } from "./cli-project.js";
import { initializeFreshGovernedAuthoring } from "./control-policy-fresh-authoring.js";
import { openBoundProjectControlPolicies } from "./control-policy-store.js";
import { decodeOperatorAuthority, encodeOperatorAuthority } from "./control-policy-authority-codec.js";
import { initializeGuidedProject } from "./guided-project.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("fresh governed authoring bootstrap", () => {
  it("rebinds a minimized Action catalog from exact governed metadata history without legacy snapshot files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-governed-lock-history-")); roots.push(root);
    const build = fixture(root);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0", instantOnboarding: true });
    const config = await readRuntimeConfig(guided.config_path);
    const initial = await initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path, build, actor: "local_operator" });
    const catalog = buildActionRuleAuthoringCatalog({ boundary: build.exploration_boundary, inspection: fixtureInspection() }).catalog;
    const next = fixture(root);
    next.lock = { ...next.lock, reviewed_overrides_digest: canonicalJsonDigest("changed reviewed labels") };
    next.exploration_boundary.generation_lock_fingerprint = canonicalJsonDigest(next.lock);
    const authoring = structuredClone(initial.authoring.authoring);
    const previous = initial.authoring.selected!;
    const progress = createBoundaryReviewProgress({ draft: next.exploration_boundary, candidate: next.exploration_boundary,
      boundaryId: previous.progress.boundary_id, reviewOverrides: next.overrides, confirmedDecisions: [], actor: "local_operator",
      reason: "Minimize the disabled Read draft after mapping.", revision: 2 });
    authoring.entries = [{ draft: next.exploration_boundary, draft_lock: next.lock, candidate_lock: next.lock,
      progress, catalog: readAuthoringCatalog(next) }];
    await saveProjectReadAuthoring({ projectRoot: root, expected: initial.authoring.bindings, authoring, actor: "local_operator", operation: "prepare_read" });
    const before = await readProjectReadAuthoring(root);
    await expect(fs.stat(path.join(root, ".synapsor/exploration-locks"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(loadGenerationLockSnapshot(root, canonicalJsonDigest(build.lock))).resolves.toEqual(build.lock);
    await expect(loadGenerationLockSnapshot(root, canonicalJsonDigest(next.lock))).resolves.toEqual(next.lock);
    const rebound = await buildActionCatalogForSavedReadRevision({ projectRoot: root, catalog,
      nextBoundary: next.exploration_boundary, inspection: fixtureInspection() });
    expect(rebound.catalog.generation_lock_fingerprint).toBe(canonicalJsonDigest(next.lock));
    expect(await readProjectReadAuthoring(root)).toEqual(before);
    // A matching but unreviewed legacy export cannot fill a hole in governed history.
    const foreign = { ...next.lock, evidence_fingerprint: canonicalJsonDigest("not reviewed in this project") };
    await persistGenerationLockSnapshot(root, canonicalJsonDigest(foreign), foreign);
    await expect(loadGenerationLockSnapshot(root, canonicalJsonDigest(foreign))).rejects.toMatchObject({ code: "POLICY_GENERATION_SNAPSHOT_UNAVAILABLE" });
    expect(await readProjectReadAuthoring(root)).toEqual(before);
    const binding = await openBoundProjectControlPolicies(root);
    try {
      const current = await binding!.repository.scopeSnapshot({ deployment_id: binding!.deployment_id, scope: { level: "operator" }, kinds: ["read", "action", "execution"] });
      expect(current.active).toEqual([]);
    } finally { await binding?.close(); }
  });

  it.each(["partial_write", "before_publish"])("recovers from %s without publishing a partial checkpoint", async (stage) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-fresh-governed-interrupted-")); roots.push(root);
    const build = fixture(root);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0", instantOnboarding: true });
    const config = await readRuntimeConfig(guided.config_path);
    const checkpointPath = path.join(root, ".synapsor", "fresh-governed-authoring.json");
    const originalOpen = fs.open, originalRename = fs.rename;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (stage === "partial_write" && String(args[0]).startsWith(checkpointPath)) {
        vi.spyOn(handle, "writeFile").mockImplementation(async () => {
          await handle.write("{");
          throw new Error("Injected checkpoint interruption");
        });
      }
      return handle;
    });
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (stage === "before_publish" && to === checkpointPath) throw new Error("Injected checkpoint interruption");
      return originalRename(from, to);
    });
    try {
      await expect(initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
        build, actor: "local_operator" })).rejects.toThrow("Injected checkpoint interruption");
      await expect(fs.stat(checkpointPath)).rejects.toHaveProperty("code", "ENOENT");
      expect((await fs.readdir(path.dirname(checkpointPath))).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally { open.mockRestore(); rename.mockRestore(); }
    const recovered = await initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" });
    expect(recovered.status).toBe("initialized");
    expect(recovered.authoring.selected?.progress.candidate.activation).toBe("disabled_unreviewed");
    expect((await fs.stat(checkpointPath)).nlink).toBe(1);
  });

  it("creates and resumes a disabled governed Read review without file-backed authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-fresh-governed-authoring-")); roots.push(root);
    const build = fixture(root);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0", instantOnboarding: true });
    const config = await readRuntimeConfig(guided.config_path);

    const first = await initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" });
    expect(first.status).toBe("initialized");
    expect(first.authoring.selected?.progress.candidate.pack.resources).toHaveLength(1);
    await expect(fs.stat(path.join(root, "synapsor", "generated"))).rejects.toMatchObject({ code: "ENOENT" });

    const binding = await openBoundProjectControlPolicies(root);
    if (!binding) throw new Error("Expected fresh governed binding.");
    try {
      const state = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id,
        scope: { level: "operator" }, kinds: ["read", "action", "execution", "management"] });
      const active = state.active.map((revision) => decodeOperatorAuthority(revision, { runtimeConfig: config }));
      const drafts = state.drafts.map((revision) => decodeOperatorAuthority(revision, { runtimeConfig: config }));
      expect(active).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "read_selection", selected_name: null }),
        expect.objectContaining({ type: "read_authoring" }),
      ]));
      expect(active.some((policy) => policy.type === "read" || policy.type === "action" || policy.type === "execution")).toBe(false);
      expect(drafts).toEqual([expect.objectContaining({ type: "read", boundary: expect.objectContaining({ activation: "disabled_unreviewed" }) })]);
    } finally { await binding.close(); }

    const reinspection = fixture(root, "2026-09-08T00:01:00.000Z");
    await expect(initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build: reinspection, actor: "local_operator" })).resolves.toMatchObject({ status: "resumed" });
  });

  it("refuses a file-backed project instead of importing it as fresh authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-fresh-governed-refusal-")); roots.push(root);
    const build = fixture(root);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0" });
    await fs.mkdir(path.join(root, "synapsor", "generated"), { recursive: true });
    const config = await readRuntimeConfig(guided.config_path);
    await expect(initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" })).rejects.toMatchObject({ code: "POLICY_FRESH_AUTHORING_LEGACY_AUTHORITY" });
    await expect(fs.stat(path.join(root, ".synapsor", "control-policy", "migration.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a generically valid checkpoint tampered to add active Read authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-fresh-governed-tamper-")); roots.push(root);
    const build = fixture(root);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0" });
    const config = await readRuntimeConfig(guided.config_path);
    const initial = await initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" });
    const checkpointPath = path.join(root, ".synapsor", "fresh-governed-authoring.json");
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    const candidate = initial.authoring.selected!.progress.candidate;
    const lock = initial.authoring.selected!.candidate_lock;
    const activeRead = encodeOperatorAuthority({ type: "read", boundary: {
      ...candidate,
      activation: { state: "active", digest: explorationBoundaryCandidateDigest(candidate), actor: "forged_operator",
        activated_at: "2026-09-08T00:00:00.000Z", generation_lock_fingerprint: candidate.generation_lock_fingerprint,
        reviewed_decisions: [] },
    }, generation_lock: lock });
    const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: candidate.pack.name });
    checkpoint.snapshot.revisions = checkpoint.snapshot.revisions.filter((revision: { kind: string; name: string }) =>
      !(revision.kind === "management" && revision.name === "read_selection"));
    checkpoint.snapshot.revisions.push(activeRead, selection);
    checkpoint.snapshot.active = checkpoint.snapshot.active.filter((pointer: { kind: string; name: string }) =>
      !(pointer.kind === "management" && pointer.name === "read_selection"));
    checkpoint.snapshot.active.push(pointer(activeRead), pointer(selection));
    await fs.writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`, "utf8");
    await expect(initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" })).rejects.toMatchObject({ code: "POLICY_FRESH_AUTHORING_SNAPSHOT_INVALID" });
  });

  it("exports and submits a fresh disabled Read revision through the public structured service", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-fresh-governed-structured-")); roots.push(root);
    const build = fixture(root);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0" });
    const config = await readRuntimeConfig(guided.config_path);
    await initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" });

    await expect(structuredBoundaryAuthoringCommand([
      "--project-root", root, "--export-draft", "structured-draft.json",
    ], async () => fixtureInspection())).resolves.toBe(0);
    await expect(structuredBoundaryAuthoringCommand([
      "--project-root", root, "--draft", "structured-draft.json",
    ], async () => fixtureInspection())).resolves.toBe(0);

    const binding = await openBoundProjectControlPolicies(root);
    if (!binding) throw new Error("Expected fresh governed binding.");
    try {
      const state = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id,
        scope: { level: "operator" }, kinds: ["read", "action", "execution", "management"] });
      expect(state.active.some((revision) => revision.kind === "read" || revision.kind === "action" || revision.kind === "execution")).toBe(false);
      expect(state.drafts.some((revision) => revision.kind === "read")).toBe(true);
    } finally { await binding.close(); }
  });

  it("bootstraps a coded metadata-only review and submits explicit scope decisions as disabled Read authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-fresh-governed-coded-")); roots.push(root);
    const build = metadataOnlyFixture(root);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0" });
    const config = await readRuntimeConfig(guided.config_path);
    const initial = await initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" });
    expect(initial.authoring.selected?.stage).toBe("metadata_only");
    expect(initial.authoring.selected?.progress.candidate.pack.resources).toEqual([]);

    await expect(structuredBoundaryAuthoringCommand([
      "--project-root", root, "--export-draft", "coded-draft.json",
    ], async () => metadataOnlyInspection())).resolves.toBe(0);
    const draftPath = path.join(root, "coded-draft.json");
    const draft = JSON.parse(await fs.readFile(draftPath, "utf8"));
    draft.read.resources = [{ resource_id: "coded.x17", include: true, row_identity: "k01", tenant_key: "k02", principal_key: "k03",
      field_metadata: [{ field: "v01", label: "Reviewed value" }] }];
    await fs.writeFile(draftPath, `${JSON.stringify(draft)}\n`, "utf8");
    await expect(structuredBoundaryAuthoringCommand([
      "--project-root", root, "--draft", "coded-draft.json",
    ], async () => metadataOnlyInspection())).resolves.toBe(0);
    const saved = await initializeFreshGovernedAuthoring({ projectRoot: root, config, storePath: guided.store_path,
      build, actor: "local_operator" });
    expect(saved.authoring.selected?.stage).toBeUndefined();
    expect(saved.authoring.selected?.progress.candidate.pack.resources).toHaveLength(1);
  });
});

function fixture(root: string, inspectedAt = "2026-09-08T00:00:00.000Z") {
  const inspection = fixtureInspection(inspectedAt);
  return buildAutoBoundary({ inspection, inspectedSchema: "university", sourceEnv: "DATABASE_URL", deploymentProfile: "staging", overrides: {
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: { "university.students": { tenant_key: {
      value: "institution_id", actor: "fixture_operator", reason: "Fixture tenant binding.", decided_at: "2026-09-08T00:00:00.000Z",
    } } },
  }, project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}

function fixtureInspection(inspectedAt = "2026-09-08T00:00:00.000Z"): SchemaInspection {
  return {
    engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: inspectedAt,
    schemas: ["university"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: "university", name: "students", type: "table", writable: false,
      columns: ["id", "institution_id", "student_id", "credits", "version"].map((name, ordinal_position) => ({
        name, data_type: name === "credits" || name === "version" ? "integer" : "uuid", ordinal_position,
        nullable: false, generated: false, suggestions: { tenant: name === "institution_id", conflict: name === "version",
          sensitive: false, immutable: name.endsWith("id"), large_or_binary: false },
      })), primary_key: ["id"], unique_constraints: [{ name: "students_pkey", columns: ["id"] }], check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["institution_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["student_id", "credits"] },
    }],
  };
}

function metadataOnlyFixture(root: string) {
  return buildAutoBoundary({ inspection: metadataOnlyInspection(), inspectedSchema: "coded", sourceEnv: "DATABASE_URL",
    project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}

function metadataOnlyInspection(): SchemaInspection {
  const inspection = fixtureInspection();
  const table = inspection.tables[0]!;
  table.schema = "coded"; table.name = "x17";
  const names = ["k01", "k02", "k03", "v01", "v02"];
  table.columns = table.columns.map((column, index) => ({ ...column, name: names[index]!,
    suggestions: { tenant: false, conflict: false, sensitive: false, immutable: index < 3, large_or_binary: false } }));
  table.primary_key = [];
  table.unique_constraints = [{ name: "x17_k01", columns: ["k01"] }, { name: "x17_k03", columns: ["k03"] }];
  table.suggestions = { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["v01"] };
  inspection.schemas = ["coded"];
  return inspection;
}

function pointer(revision: { scope: unknown; kind: string; name: string; revision_id: string }) {
  return { scope: revision.scope, kind: revision.kind, name: revision.name, revision_id: revision.revision_id };
}
