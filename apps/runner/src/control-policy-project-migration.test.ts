import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ControlPolicyRepository } from "@synapsor-runner/proposal-store";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { BOUNDARY_REVIEW_SUBMISSION_VERSION, boundaryReviewDecisionRefs,
  type BoundaryReviewSubmission, type ExplorationBoundaryDraft, ACTIVE_EXPLORATION_BOUNDARY_SET_FILE_VERSION,
  encodeExplorationBoundaryActiveArtifact, AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary, explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { saveBoundaryLibraryAfterReconciliation } from "./boundary-library.js";
import { decodeOperatorAuthority } from "./control-policy-authority-codec.js";
import { activateActionRuleAuthority, buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { migrateProjectControlPoliciesFromProject, previewProjectControlPolicyMigration } from "./control-policy-project-migration.js";

// Typed counterparts of explicit fixture reviews; these are codec/record inputs,
// not native Read meaning confirmation or activation evidence.
function fixtureReviewSubmission(candidate: ExplorationBoundaryDraft): BoundaryReviewSubmission {
  return { schema_version: BOUNDARY_REVIEW_SUBMISSION_VERSION,
    candidate_digest: explorationBoundaryCandidateDigest(candidate), decisions: boundaryReviewDecisionRefs(candidate) };
}

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function buildFixture(root: string) {
  const inspection: SchemaInspection = {
    engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-06T00:00:00.000Z",
    schemas: ["inventory"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: "inventory", name: "items", type: "table", writable: false,
      columns: ["id", "tenant_id", "principal_id", "quantity", "version"].map((name, ordinal_position) => ({
        name, data_type: ["version", "quantity"].includes(name) ? "integer" : "uuid", ordinal_position, nullable: false, generated: false,
        suggestions: { tenant: name === "tenant_id", conflict: name === "version", sensitive: false,
          immutable: name.endsWith("id"), large_or_binary: false },
      })), primary_key: ["id"], unique_constraints: [{ name: "items_pkey", columns: ["id"] }], check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["quantity"] },
    }],
  };
  const build = buildAutoBoundary({ inspection, inspectedSchema: "inventory", sourceEnv: "DATABASE_URL", deploymentProfile: "staging", overrides: {
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: { "inventory.items": { tenant_key: {
      value: "tenant_id", actor: "fixture_operator", reason: "Reviewed tenant binding.", decided_at: "2026-09-06T00:00:00.000Z",
    }, principal_key: {
      value: "principal_id", actor: "fixture_operator", reason: "Reviewed principal binding.", decided_at: "2026-09-06T00:00:00.000Z",
    } } },
  }, project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const candidate = recommendedBoundaryReviewCandidate(build.exploration_boundary);
  const active: ActivatedExplorationBoundary = { ...candidate, activation: { state: "active", digest: explorationBoundaryCandidateDigest(candidate),
    actor: "original_operator", activated_at: "2026-09-06T00:00:00.000Z", generation_lock_fingerprint: candidate.generation_lock_fingerprint, reviewed_decisions: [] } };
  const progress = createBoundaryReviewProgress({ draft: build.exploration_boundary, candidate,
    submission: fixtureReviewSubmission(candidate), actor: "original_operator", revision: 1 });
  return { build, active, progress };
}

async function legacyProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-migration-")); roots.push(root);
  await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, ".git"));
  const source = buildFixture(root);
  await writeAutoBoundaryArtifacts({ projectRoot: root, build: source.build, reviewProgress: source.progress });
  await fs.writeFile(path.join(root, ".synapsor", "exploration-boundary.active.json"), JSON.stringify(encodeExplorationBoundaryActiveArtifact(source.active)), { mode: 0o600 });
  const config = { storage: { sqlite_path: path.join(root, ".synapsor", "control.db") } } as RuntimeConfig;
  return { root, config, source };
}

describe("project control-policy migration adapter", () => {
  it("previews and imports exact active and disabled Read artifacts without altering them", async () => {
    const f = await legacyProject();
    const files = [".synapsor/exploration-boundary.active.json", ".synapsor/boundary-review-progress.json", "synapsor/generated/exploration-boundary.draft.json"];
    const before = await Promise.all(files.map((file) => fs.readFile(path.join(f.root, file), "utf8")));
    const preview = await previewProjectControlPolicyMigration({ projectRoot: f.root, config: f.config });
    expect(preview).toMatchObject({ status: "ready", epoch: 0 });
    if (preview.status !== "ready") throw new Error("Expected legacy preview.");
    expect(preview.migration_digest).toBe(canonicalJsonDigest(preview.snapshot));
    expect(preview.snapshot.provenance).toEqual(expect.arrayContaining([expect.objectContaining({
      path: `.synapsor/exploration-locks/${f.source.active.generation_lock_fingerprint.slice("sha256:".length)}.json`,
    })]));
    expect(preview.snapshot.active.map((pointer) => pointer.kind)).toEqual(expect.arrayContaining(["read", "management", "management"]));
    expect(preview.snapshot.drafts.map((pointer) => pointer.kind)).toEqual(["read"]);

    const migrated = await migrateProjectControlPoliciesFromProject({ projectRoot: f.root, config: f.config,
      storePath: f.config.storage!.sqlite_path!, actor: "local_operator", preview });
    try {
      expect(migrated.status).toBe("imported");
      const state = await migrated.binding.repository.scopeSnapshot({ deployment_id: migrated.binding.deployment_id,
        scope: { level: "operator" }, kinds: ["read", "management"] });
      const policies = [...state.active, ...state.drafts].map((revision) => decodeOperatorAuthority(revision, { runtimeConfig: f.config }));
      expect(policies.some((policy) => policy.type === "read" && policy.boundary.activation !== "disabled_unreviewed")).toBe(true);
      expect(policies.some((policy) => policy.type === "read" && policy.boundary.activation === "disabled_unreviewed")).toBe(true);
      expect(policies.some((policy) => policy.type === "read_authoring")).toBe(true);
    } finally { await migrated.binding.close(); }
    expect(await Promise.all(files.map((file) => fs.readFile(path.join(f.root, file), "utf8")))).toEqual(before);
  });

  it("rejects a preview made stale by an edited legacy artifact before importing", async () => {
    const f = await legacyProject();
    const preview = await previewProjectControlPolicyMigration({ projectRoot: f.root, config: f.config });
    const activePath = path.join(f.root, ".synapsor", "exploration-boundary.active.json");
    const active = JSON.parse(await fs.readFile(activePath, "utf8"));
    active.boundary.activation.actor = "changed_operator";
    await fs.writeFile(activePath, JSON.stringify(active), { mode: 0o600 });

    await expect(migrateProjectControlPoliciesFromProject({ projectRoot: f.root, config: f.config,
      storePath: f.config.storage!.sqlite_path!, actor: "local_operator", preview })).rejects.toMatchObject({ code: "POLICY_MIGRATION_PREVIEW_STALE" });
    await expect(fs.stat(path.join(f.root, ".synapsor", "control-policy", "migration.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves explicit active and saved-library selections across multiple boundaries", async () => {
    const f = await legacyProject();
    const savedCandidate = structuredClone(f.source.progress.candidate);
    savedCandidate.pack.name = "inventory_saved_review";
    const savedProgress = createBoundaryReviewProgress({ draft: f.source.build.exploration_boundary, candidate: savedCandidate,
       actor: "saved_operator", revision: 1 });
    await saveBoundaryLibraryAfterReconciliation({ projectRoot: f.root, state: {
      selected_name: savedCandidate.pack.name,
      boundaries: { [f.source.progress.candidate.pack.name]: f.source.progress, [savedCandidate.pack.name]: savedProgress },
      updated_at: "2026-09-06T02:00:00.000Z",
    } });
    const otherCandidate = structuredClone(f.source.progress.candidate);
    otherCandidate.pack.name = "inventory_other_active";
    const otherActive: ActivatedExplorationBoundary = { ...otherCandidate, activation: { state: "active",
      digest: explorationBoundaryCandidateDigest(otherCandidate), actor: "original_operator", activated_at: "2026-09-06T00:00:00.000Z",
      generation_lock_fingerprint: otherCandidate.generation_lock_fingerprint, reviewed_decisions: [] } };
    await fs.writeFile(path.join(f.root, ".synapsor", "exploration-boundaries.active.json"), JSON.stringify({
      schema_version: ACTIVE_EXPLORATION_BOUNDARY_SET_FILE_VERSION, selected_name: f.source.active.pack.name,
      boundaries: [otherActive, f.source.active], updated_at: "2026-09-06T02:00:00.000Z",
    }), { mode: 0o600 });

    const preview = await previewProjectControlPolicyMigration({ projectRoot: f.root, config: f.config });
    if (preview.status !== "ready") throw new Error("Expected legacy preview.");
    const activeSelection = preview.snapshot.revisions.map((revision) => decodeOperatorAuthority(revision, { runtimeConfig: f.config }))
      .find((policy) => policy.type === "read_selection");
    const authoring = preview.snapshot.revisions.map((revision) => decodeOperatorAuthority(revision, { runtimeConfig: f.config }))
      .find((policy) => policy.type === "read_authoring");
    expect(activeSelection).toMatchObject({ type: "read_selection", selected_name: f.source.active.pack.name });
    expect(authoring).toMatchObject({ type: "read_authoring", selected_boundary_id: savedProgress.boundary_id });
    expect(authoring?.type === "read_authoring" && authoring.entries).toHaveLength(3);
    expect(preview.snapshot.drafts.filter((pointer) => pointer.kind === "read")).toHaveLength(3);
  });

  it("preserves Action revision history while only pointing at each current Action state once", async () => {
    const f = await legacyProject();
    const initial = actionDraft(f.source.active.pack.name, f.source.active.activation.digest, f.source.active.generation_lock_fingerprint, "2026-09-06T01:00:00.000Z", 300);
    await writeActionRuleAuthorityDraft(f.root, initial);
    await activateActionRuleAuthority({ projectRoot: f.root, name: initial.authority.name, expected_digest: initial.digest,
      confirmation: `ACTIVATE ${initial.digest}`, actor: "original_operator" });
    const replacement = actionDraft(f.source.active.pack.name, f.source.active.activation.digest, f.source.active.generation_lock_fingerprint, "2026-09-06T02:00:00.000Z", 301);
    await writeActionRuleAuthorityDraft(f.root, replacement);
    const active = await activateActionRuleAuthority({ projectRoot: f.root, name: replacement.authority.name, expected_digest: replacement.digest,
      confirmation: `ACTIVATE ${replacement.digest}`, actor: "replacement_operator" });
    const currentDraft = actionDraft(f.source.active.pack.name, f.source.active.activation.digest, f.source.active.generation_lock_fingerprint,
      "2026-09-06T03:00:00.000Z", 302);
    await writeActionRuleAuthorityDraft(f.root, currentDraft);

    const preview = await previewProjectControlPolicyMigration({ projectRoot: f.root, config: f.config });
    if (preview.status !== "ready") throw new Error("Expected legacy preview.");
    const actions = preview.snapshot.revisions.map((revision) => decodeOperatorAuthority(revision, { runtimeConfig: f.config }))
      .filter((policy) => policy.type === "action");
    expect(actions).toHaveLength(3);
    expect(actions.filter((policy) => policy.authority.state === "active").map((policy) => policy.authority.digest))
      .toEqual(expect.arrayContaining([initial.digest, active.digest]));
    expect(preview.snapshot.active.filter((pointer) => pointer.kind === "action")).toHaveLength(1);
    expect(preview.snapshot.drafts.filter((pointer) => pointer.kind === "action")).toHaveLength(1);
  });

  it("resumes an interrupted frozen import and never reimports stale files once migrated", async () => {
    const f = await legacyProject();
    const preview = await previewProjectControlPolicyMigration({ projectRoot: f.root, config: f.config });
    const original = ControlPolicyRepository.prototype.importDeployment;
    const interrupted = vi.spyOn(ControlPolicyRepository.prototype, "importDeployment").mockRejectedValueOnce(new Error("interrupted before import"));
    await expect(migrateProjectControlPoliciesFromProject({ projectRoot: f.root, config: f.config,
      storePath: f.config.storage!.sqlite_path!, actor: "local_operator", preview })).rejects.toThrow("interrupted before import");
    interrupted.mockImplementation(original);

    const pending = await previewProjectControlPolicyMigration({ projectRoot: f.root, config: f.config,
      storePath: f.config.storage!.sqlite_path! });
    expect(pending).toEqual({ status: "migration_pending", epoch: 0 });

    const resumed = await migrateProjectControlPoliciesFromProject({ projectRoot: f.root, config: f.config,
      storePath: f.config.storage!.sqlite_path!, actor: "local_operator", preview: pending });
    await resumed.binding.close();
    await fs.writeFile(path.join(f.root, ".synapsor", "exploration-boundary.active.json"), "{\"untrusted\":true}", { mode: 0o600 });
    const repeated = await migrateProjectControlPoliciesFromProject({ projectRoot: f.root, config: f.config,
      storePath: f.config.storage!.sqlite_path!, actor: "local_operator", preview });
    try { expect(repeated.status).toBe("already_imported"); }
    finally { await repeated.binding.close(); }
  });

  it("refuses partial legacy review state instead of dropping it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-migration-invalid-")); roots.push(root);
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    await fs.writeFile(path.join(root, ".synapsor", "boundary-review-progress.json"), "{}", { mode: 0o600 });

    await expect(previewProjectControlPolicyMigration({ projectRoot: root, config: {} as RuntimeConfig }))
      .rejects.toMatchObject({ code: "POLICY_MIGRATION_UNSUPPORTED_LEGACY_STATE" });
  });

  it("refuses an oversized legacy artifact before creating migration state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-migration-large-")); roots.push(root);
    const draft = path.join(root, "synapsor", "generated", "exploration-boundary.draft.json");
    await fs.mkdir(path.dirname(draft), { recursive: true });
    await fs.writeFile(draft, "", { mode: 0o600 });
    await fs.truncate(draft, (16 * 1024 * 1024) + 1);

    await expect(previewProjectControlPolicyMigration({ projectRoot: root, config: {} as RuntimeConfig }))
      .rejects.toMatchObject({ code: "POLICY_MIGRATION_SNAPSHOT_TOO_LARGE" });
    await expect(fs.stat(path.join(root, ".synapsor", "control-policy", "migration.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function actionDraft(readBoundaryName: string, readBoundaryDigest: `sha256:${string}`, lock: `sha256:${string}`, now: string, ttlSeconds: number) {
  const id = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const integer = { kind: "integer" } as const;
  const catalog: ActionRuleCatalogV1 = { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: lock,
    relationships: [], resources: [{ name: "inventory.items", source: "local_postgres", engine: "postgres", schema: "inventory",
      table: "items", primary_key: "id", tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version",
      fields: [...["id", "tenant_id", "principal_id"].map((name) => ({ name, type: id, nullable: false })),
        ...["quantity", "version"].map((name) => ({ name, type: integer, nullable: false }))] }] };
  const verification: RuleVerificationBoundarySpecV1 = { schema_version: "synapsor.verification-boundary.v1", name: "inventory.verify",
    source: "local_postgres", context: "trusted_context", generation_lock_fingerprint: lock, resources: [{ binding: "item",
      resource: "inventory.items", source: { kind: "subject_ref" }, primary_key: "id", version_field: "version", fields: catalog.resources[0]!.fields,
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" }, cardinality: "one", max_rows: 1,
      overflow: "unsupported", lock: "for_update" }], lock_order: ["item"], transaction: { isolation: "repeatable_read", timezone: "UTC" } };
  const envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: "synapsor.derived-effect-envelope.v1", name: "inventory.effect",
    source: "local_postgres", operation: "update", target_resource: "inventory.items", target_binding: "item", primary_key: "id",
    tenant_key: "tenant_id", principal_scope_key: "principal_id", conflict_key: "version", max_rows: 1,
    allowed_fields: [{ name: "quantity", type: integer, minimum: 0, maximum: 10 }], version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["inventory.review"], writeback: { mode: "direct_sql", supervised_worker: "allowed" } };
  const rule: ActionRuleSpecV1 = { schema_version: "synapsor.action-rule.v1", name: "inventory.replenish", outcome: "inventory.replenish",
    context: "trusted_context", source: "local_postgres", verification_boundary_ref: verification.name, effect_envelope_ref: envelope.name,
    subjects: [{ binding: "item", resource: "inventory.items", input: "opaque_subject_ref" }], require: { kind: "compare", operator: "lt",
      left: { kind: "field", binding: "item", field: "quantity" }, right: { kind: "literal", value: 5, value_type: integer } }, derive: {},
    effect: { operation: "update", target_resource: "inventory.items", target_binding: "item", set: { quantity: { kind: "literal", value: 5, value_type: integer } } },
    approval_class: "inventory.review", ttl_seconds: ttlSeconds };
  return buildActionRuleAuthorityDraft({ name: "inventory_actions", action_boundary_name: "inventory_changes", catalog,
    rules: [{ read_boundary_name: readBoundaryName, read_boundary_digest: readBoundaryDigest, verification_boundary: verification,
      effect_envelope: envelope, rule }], reviews: [{ outcome: rule.outcome, when: "Stock is below five.", then: "Set stock to five.",
      refused: ["Stock is already sufficient."], human_review: "One inventory reviewer.",
      examples: [{ kind: "eligible", scenario: "One item remaining", result: "Create proposal" }] }], now });
}
