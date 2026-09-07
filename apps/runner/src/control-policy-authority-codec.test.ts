import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import * as schemaInspector from "@synapsor-runner/schema-inspector";
import { createDefaultRuntimeStore, resolveRuntimeConfig, subjectReferenceScopeFingerprints,
  REQUEST_CHANGE_TOOL, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ControlPolicyRepository, migrateSharedPostgresRuntimeStore, ProposalStore } from "@synapsor-runner/proposal-store";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { RuleVerificationBoundarySpecV1, DerivedEffectEnvelopeSpecV1, ActionRuleSpecV1 } from "@synapsor/spec";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, activateExplorationBoundary, buildAutoBoundary, deactivateExplorationBoundary,
  explorationBoundaryCandidateDigest, generationReviewEvidenceDigest, loadActivatedExplorationBoundary, loadActivatedExplorationBoundaries,
  loadGenerationLockForActivatedBoundary, writeAutoBoundaryArtifacts, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { decodeOperatorAuthority, encodeOperatorAuthority, encodeOperatorExecutionPolicy, OPERATOR_READ_SELECTION, OPERATOR_READ_AUTHORING, OPERATOR_EXECUTION_POLICY,
  validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { migrateProjectControlPolicies, openProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import * as policyStoreAccess from "./control-policy-store.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { createOptionalActionRuleRuntimeServices, createOptionalReadActionRuleRuntimeServices } from "./semantic-action-runtime.js";
import { createScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";
import { readOperatorExecutionConfig } from "./control-policy-execution.js";
import { readAuthoringCatalog, type StoredReadAuthoring } from "./control-policy-read-authoring.js";
import { commitBoundaryRescan, prepareBoundaryRescan, readBoundaryRescanReport } from "./boundary-rescan.js";
import { commitBoundaryResourceReviewMutation, inspectBoundaryResourceReview, prepareBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { applyManagedBoundaryReviewDecision, createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { readBoundaryReviewProgress, saveBoundaryReviewProgress, saveInstantBoundaryReviewBaseline,
  saveInstantBoundaryEditBaseline } from "./boundary-review-persistence.js";
import { activateInstantCliBoundary } from "./instant-cli-boundary.js";
import { boundaryCommand, start } from "./guided-start.js";
import { saveInitialGovernedBoundaryReview } from "./boundary-initial-review.js";
import { readProjectReadAuthoring, saveProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { boundaryActivateCommand, boundaryAuthoringResumeBinding, boundaryReviewCommand, loadBoundaryReviewContext } from "./boundary-commands.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { startLocalUiServer } from "./local-ui.js";
import { analyzeReadWorkloadSet, type ReadWorkloadSet } from "./read-workload-assist.js";
import * as readWorkloads from "./read-workloads.js";
import * as autoBoundary from "./auto-boundary.js";
import * as mappingCatalog from "./job-mapping-catalog.js";
import * as boundaryMutations from "./boundary-review-mutation.js";
import * as guidedActions from "./guided-action.js";
import * as delegationSetup from "./delegation-setup.js";
import { createSavedBoundary, deleteSavedBoundary, discardOnlySavedBoundaryReview, renameSavedBoundary, switchSavedBoundary,
  resolveSavedBoundaryReviewAuthority, synchronizeBoundaryLibrary } from "./boundary-library.js";
import { readRuntimeConfig } from "./cli-project.js";
import * as cliProject from "./cli-project.js";
import { workerCommand } from "./worker-runtime.js";
import { applyProposal } from "./guarded-apply.js";
import { verifyJwtOperatorProof, verifySignedOperatorProof } from "./operator-identity.js";
import { argsWithRuntimeStoreBridge, assertGovernedLocalRuntimeStore, withSharedPostgresRuntimeStoreReadBridge } from "./store-shared.js";
import { createWorkbenchAskMcpGateway } from "./ask-mcp-gateway.js";
import { disableSemanticSupervisedExecution, enableSemanticSupervisedExecution,
  previewSemanticSupervisedExecution, readSemanticSupervisedExecutionState, semanticExecutionConfirmation } from "./semantic-action-deployment.js";
import { activateActionRuleAuthority, buildActionRuleAuthorityDraft, createActiveActionRuleAuthorityLoader,
  deactivateActionRuleAuthority, listActionRuleAuthorityDrafts, loadActiveActionRuleAuthority, readActionRuleAuthorityActivation,
  readActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, type ActionRuleAuthorityActivationV1 } from "./action-rule-authority.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function fixture(domain = "inventory", deploymentProfile: "staging" | "development" = "staging") {
  const inspection: SchemaInspection = {
    engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-06T00:00:00.000Z",
    schemas: [domain], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: domain, name: "items", type: "table", writable: false,
      columns: ["id", "tenant_id", "principal_id", "quantity", "version"].map((name, ordinal_position) => ({
        name, data_type: ["version", "quantity"].includes(name) ? "integer" : "uuid", ordinal_position, nullable: false, generated: false,
        suggestions: { tenant: name === "tenant_id", conflict: name === "version", sensitive: false,
          immutable: name.endsWith("id"), large_or_binary: false },
      })), primary_key: ["id"], unique_constraints: [{ name: "items_pkey", columns: ["id"] }],
      check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["quantity"] },
    }],
  };
  const build = buildAutoBoundary({ inspection, inspectedSchema: domain, sourceEnv: "DATABASE_URL", deploymentProfile, overrides: {
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: { [`${domain}.items`]: { tenant_key: {
      value: "tenant_id", actor: "fixture_operator", reason: "Reviewed fixture authenticated tenant binding.", decided_at: "2026-09-06T00:00:00.000Z",
    }, principal_key: {
      value: "principal_id", actor: "fixture_operator", reason: "Reviewed fixture authenticated principal binding.", decided_at: "2026-09-06T00:00:00.000Z",
    } } },
  }, project: {
    root: "/test", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"],
  } });
  const candidate = recommendedBoundaryReviewCandidate(build.exploration_boundary);
  expect(candidate.pack.resources, JSON.stringify(build.graph.resources)).toHaveLength(1);
  const boundary: ActivatedExplorationBoundary = { ...candidate, activation: {
    state: "active", digest: explorationBoundaryCandidateDigest(candidate), actor: "original_operator",
    activated_at: "2026-09-06T00:00:00.000Z", generation_lock_fingerprint: candidate.generation_lock_fingerprint,
    reviewed_decisions: [],
  } };
  return { candidate, boundary, generation_lock: build.lock, inspection, build };
}

function snapshot(profile: "staging" | "development" = "staging"): ControlPolicyMigrationSnapshot {
  const input = fixture("inventory", profile);
  const active = encodeOperatorAuthority({ type: "read", boundary: input.boundary, generation_lock: input.generation_lock });
  const draft = encodeOperatorAuthority({ type: "read", boundary: input.candidate, generation_lock: input.generation_lock });
  const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: active.name });
  const pointer = ({ scope, kind, name, revision_id }: typeof active) => ({ scope, kind, name, revision_id });
  return { revisions: [active, draft, selection], active: [pointer(active), pointer(selection)], drafts: [pointer(draft)],
    provenance: [{ path: ".synapsor/exploration-boundary.active.json", digest: canonicalJsonDigest(input.boundary) }] };
}

function readAuthoringFixture(profile: "staging" | "development" = "staging"): StoredReadAuthoring {
  const entries = ["inventory", "university"].map((domain) => {
    const source = fixture(domain, profile);
    source.candidate.pack.name = `${domain}_draft`;
    return { draft: source.candidate, draft_lock: source.generation_lock, candidate_lock: source.generation_lock,
      progress: createBoundaryReviewProgress({ draft: source.candidate, candidate: source.candidate,
        confirmedDecisions: source.candidate.unresolved_decisions, actor: "reviewer", revision: 1 }) };
  });
  return { type: "read_authoring", selected_boundary_id: entries[0]!.progress.boundary_id, entries };
}

function metadataAuthoringFixture(projectRoot = "/test") {
  const inspection = structuredClone(fixture("coded").inspection);
  const table = inspection.tables[0]!; table.name = "x17";
  const names = ["k01", "k02", "k03", "v01", "v02"];
  table.columns = table.columns.map((column, index) => ({ ...column, name: names[index]!,
    suggestions: { tenant: false, conflict: false, sensitive: false, immutable: index < 3, large_or_binary: false } }));
  table.primary_key = [];
  table.unique_constraints = [{ name: "x17_k01", columns: ["k01"] }, { name: "x17_k03", columns: ["k03"] }];
  table.suggestions = { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["v01"] };
  const build = buildAutoBoundary({ inspection, inspectedSchema: "coded", sourceEnv: "DATABASE_URL",
    project: { root: projectRoot, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const draft = build.exploration_boundary; draft.pack.name = "coded_draft";
  const candidate = recommendedBoundaryReviewCandidate(draft);
  expect(candidate.pack.resources).toHaveLength(0);
  const progress = createBoundaryReviewProgress({ draft, candidate, confirmedDecisions: [], reviewOverrides: build.overrides,
    actor: "operator", revision: 1 });
  const authoring: StoredReadAuthoring = { type: "read_authoring", selected_boundary_id: progress.boundary_id,
    entries: [{ stage: "metadata_only", draft, draft_lock: build.lock, candidate_lock: build.lock,
      catalog: readAuthoringCatalog(build), progress }] };
  return { inspection, build, authoring };
}

describe("exact stored operator authority", () => {
  it("stores an ambiguous metadata scaffold without making it a valid Read policy", () => {
    const { authoring } = metadataAuthoringFixture(); const entry = authoring.entries[0]!;
    expect(decodeOperatorAuthority(encodeOperatorAuthority(authoring))).toEqual(authoring);
    expect(() => encodeOperatorAuthority({ type: "read", boundary: entry.progress.candidate,
      generation_lock: entry.candidate_lock })).toThrow("at least one reviewed resource");
  });

  it.each(["missing_stage", "missing_catalog", "nonempty", "enabled", "lock", "budget", "catalog", "self_attested_catalog"])(
    "refuses malformed metadata-only authoring: %s", (change) => {
      const { authoring } = metadataAuthoringFixture(); const entry = authoring.entries[0]!;
      if (change === "missing_stage") delete entry.stage;
      if (change === "missing_catalog") delete entry.catalog;
      if (change === "nonempty") entry.progress.candidate = fixture().candidate;
      if (change === "enabled") entry.progress.candidate.activation = fixture().boundary.activation as never;
      if (change === "lock") entry.candidate_lock = fixture().generation_lock;
      if (change === "budget") entry.progress.candidate.budgets.max_top_n = -1;
      if (change === "catalog") entry.catalog!.review.resources[0]!.fields[0]!.name = "forged_field";
      if (change === "self_attested_catalog") {
        const catalog = entry.catalog!;
        catalog.review.resources[0]!.fields[0]!.name = "forged_field";
        catalog.lock.evidence_fingerprint = generationReviewEvidenceDigest(catalog.review, catalog.evidence_project);
      }
      const original = structuredClone(authoring);
      expect(() => encodeOperatorAuthority(authoring)).toThrow();
      expect(authoring).toEqual(original);
    });

  it("binds private authoring catalogs to exact inspected evidence without granting their fields", () => {
    const authoring = readAuthoringFixture(); const source = fixture();
    authoring.entries[0]!.catalog = readAuthoringCatalog(source.build);
    expect(decodeOperatorAuthority(encodeOperatorAuthority(authoring))).toEqual(authoring);
    authoring.entries[0]!.catalog!.review.resources[0]!.fields[0]!.name = "forged_field";
    expect(() => encodeOperatorAuthority(authoring)).toThrow("POLICY_AUTHORING_CATALOG_MISMATCH");
    authoring.entries[0]!.catalog = readAuthoringCatalog(fixture("wrong_domain").build);
    expect(() => encodeOperatorAuthority(authoring)).toThrow("POLICY_AUTHORING_CATALOG_MISMATCH");
  });
  it("preserves exact authoring candidates, confirmations, stable identities and independent schema snapshots", () => {
    const authoring = readAuthoringFixture(); const before = structuredClone(authoring);
    const record = encodeOperatorAuthority(authoring);
    expect(record).toMatchObject(OPERATOR_READ_AUTHORING);
    expect(decodeOperatorAuthority(record)).toEqual(before);
    expect(authoring).toEqual(before);
  });

  it.each(["baseline_digest", "candidate_digest", "confirmation", "duplicate_identity", "duplicate_name", "selection", "active_candidate", "lock", "legacy"])(
    "refuses malformed authoring %s without repairing its reviewed state", (change) => {
      const authoring = readAuthoringFixture();
      const entry = authoring.entries[0]!;
      if (change === "baseline_digest") entry.progress.draft_digest = canonicalJsonDigest("changed");
      if (change === "candidate_digest") entry.progress.candidate_digest = canonicalJsonDigest("changed");
      if (change === "confirmation") entry.progress.confirmations[0]!.input_digest = canonicalJsonDigest("changed");
      if (change === "duplicate_identity") authoring.entries[1]!.progress.boundary_id = entry.progress.boundary_id;
      if (change === "duplicate_name") {
        const secondId = authoring.entries[1]!.progress.boundary_id;
        authoring.entries[1] = structuredClone(entry);
        authoring.entries[1]!.progress.boundary_id = secondId;
      }
      if (change === "selection") authoring.selected_boundary_id = `bnd_${"a".repeat(32)}`;
      if (change === "active_candidate") entry.progress.candidate = fixture().boundary as never;
      if (change === "lock") entry.candidate_lock = fixture("other_schema").generation_lock;
      if (change === "legacy") (entry.progress as { schema_version: string }).schema_version = "synapsor.boundary-review-progress.v2";
      const before = structuredClone(authoring);
      expect(() => encodeOperatorAuthority(authoring)).toThrow();
      expect(authoring).toEqual(before);
    });

  it.each(["inventory", "university"])("roundtrips %s Read authority, draft and generation provenance without a new review", (domain) => {
    const source = fixture(domain); const before = structuredClone(source);
    for (const boundary of [source.boundary, source.candidate]) {
      const input = { type: "read" as const, boundary, generation_lock: source.generation_lock };
      expect(decodeOperatorAuthority(encodeOperatorAuthority(input))).toEqual(input);
    }
    expect(source).toEqual(before);
  });

  it("retains distinct activation receipts even when the authority digest is unchanged", () => {
    const source = fixture();
    const first = encodeOperatorAuthority({ type: "read", boundary: source.boundary, generation_lock: source.generation_lock });
    source.boundary.activation.actor = "second_operator";
    source.boundary.activation.activated_at = "2026-09-06T01:00:00.000Z";
    const second = encodeOperatorAuthority({ type: "read", boundary: source.boundary, generation_lock: source.generation_lock });
    expect(first.authority_digest).toBe(second.authority_digest);
    expect(first.revision_id).not.toBe(second.revision_id);
    expect(first.content_digest).not.toBe(second.content_digest);
  });

  it("preserves independent active/draft pointers and the selected Read on restart", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-policy-codec-")); roots.push(projectRoot);
    const selection = { projectRoot, storePath: path.join(projectRoot, "control.db"), config: {} as RuntimeConfig, env: {} };
    const original = snapshot();
    validateOperatorPolicySnapshot(original);
    const imported = await migrateProjectControlPolicies({ ...selection, actor: "migration_operator",
      readLegacySnapshot: async () => original, validateSnapshot: async (value) => validateOperatorPolicySnapshot(value) });
    await imported.binding.close();
    const reopened = (await openProjectControlPolicies(selection))!;
    try {
      const current = await reopened.repository.snapshot(reopened.deployment_id, [original.active[0]!, OPERATOR_READ_SELECTION]);
      expect(current.policies[0]).toEqual({ active: original.revisions[0], draft: original.revisions[1] });
      expect(decodeOperatorAuthority(current.policies[1]!.active!)).toEqual({ type: "read_selection", selected_name: original.revisions[0]!.name });
    } finally { await reopened.close(); }
  });

  it.each(["content", "authority", "scope", "name", "identity", "lock"])("refuses a changed %s rather than normalizing it into authority", (change) => {
    const record = snapshot().revisions[0]!;
    if (change === "content") (record.content as { type: string }).type = "forged";
    if (change === "authority") record.authority_digest = canonicalJsonDigest("forged");
    if (change === "scope") record.scope = { level: "tenant", tenant_id: "another_owner" };
    if (change === "name") record.name = "another_read";
    if (change === "identity") record.revision_id = "another_revision";
    if (change === "lock") {
      const source = fixture(); source.generation_lock.compiler_version = "changed";
      expect(() => encodeOperatorAuthority({ type: "read", boundary: source.boundary, generation_lock: source.generation_lock })).toThrow();
    } else expect(() => decodeOperatorAuthority(record)).toThrow();
  });

  it.each(["draft_as_active", "active_as_draft", "missing_revision", "cross_name", "duplicate", "missing_selection"])("refuses invalid migration pointers: %s", (change) => {
    const state = snapshot();
    if (change === "draft_as_active") state.active[0]!.revision_id = state.drafts[0]!.revision_id;
    if (change === "active_as_draft") state.drafts[0]!.revision_id = state.active[0]!.revision_id;
    if (change === "missing_revision") state.revisions.shift();
    if (change === "cross_name") state.active[0]!.name = "other";
    if (change === "duplicate") state.active.push(state.active[0]!);
    if (change === "missing_selection") state.active.pop();
    expect(() => validateOperatorPolicySnapshot(state)).toThrow();
  });

  it("can preserve a fully revoked Read set without reactivating its history", () => {
    const state = snapshot();
    const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: null });
    state.revisions.push(selection);
    state.active = [{ ...OPERATOR_READ_SELECTION, revision_id: selection.revision_id }, { ...state.active[0]!, revision_id: null }];
    expect(() => validateOperatorPolicySnapshot(state)).not.toThrow();
    expect(state.drafts).toHaveLength(1);
  });

  it("keeps worker authority separate from its export and from credential values", () => {
    const config = executionConfig();
    const record = encodeOperatorExecutionPolicy(config)!;
    const exported = structuredClone(config);
    exported.supervised_worker!.enabled = false;
    const decoded = decodeOperatorAuthority(record, { runtimeConfig: exported });
    expect(decoded).toMatchObject({ type: "execution", policy: { enabled: true, profile: "staging" } });
    expect(record.content).not.toHaveProperty("sources");
    expect(record.content).not.toHaveProperty("runtimeConfig");
    expect(() => decodeOperatorAuthority(record)).toThrow("POLICY_EXECUTION_CONTEXT_REQUIRED");
    exported.sources!.local_postgres!.write_url_env = "DIFFERENT_WRITER";
    expect(() => decodeOperatorAuthority(record, { runtimeConfig: exported })).toThrow("POLICY_EXECUTION_BINDING_CHANGED");
  });

  it("does not turn disabled or missing execution configuration into enabled authority", () => {
    expect(encodeOperatorExecutionPolicy({} as RuntimeConfig)).toBeUndefined();
    const config = executionConfig(); config.supervised_worker!.enabled = false;
    const decoded = decodeOperatorAuthority(encodeOperatorExecutionPolicy(config)!, { runtimeConfig: config });
    expect(decoded).toMatchObject({ type: "execution", policy: { enabled: false } });
    const invalid = executionConfig(); invalid.supervised_worker!.outcomes![0]!.concurrency = 0;
    expect(() => encodeOperatorExecutionPolicy(invalid)).toThrow();
    const noReceipts = executionConfig(); delete noReceipts.sources!.local_postgres!.receipts;
    expect(() => encodeOperatorExecutionPolicy(noReceipts)).toThrow();
  });

  it("preserves legacy file-based execution enable and disable without implicitly migrating the project", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-legacy-execution-")); roots.push(projectRoot);
    const config = executionConfig(); config.action_rules!.project_root = projectRoot;
    const file = path.join(projectRoot, "synapsor.actions.runner.json");
    for (const enabled of [true, false]) {
      config.supervised_worker!.enabled = enabled;
      await fs.writeFile(file, JSON.stringify(config));
      expect((await readRuntimeConfig(file)).supervised_worker!.enabled).toBe(enabled);
    }
    await fs.writeFile(file, JSON.stringify({ ...config, supervised_worker: { enabled: "invalid" } }));
    await expect(readRuntimeConfig(file)).rejects.toThrow("Invalid Runner config");
    await expect(fs.stat(path.join(projectRoot, ".synapsor/control-policy/migration.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function executionConfig(): RuntimeConfig {
  return { version: 1, mode: "review", capabilities: [], trusted_context: { provider: "environment" },
    storage: { sqlite_path: "./.synapsor/local.db" },
    action_rules: { project_root: "/reviewed-project" },
    sources: { local_postgres: { engine: "postgres", read_only: false, read_url_env: "READER_URL",
      write_url_env: "WRITER_URL", receipts: { authority: "runner_ledger" } } },
    supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [{
      outcome: "inventory.replenish", action_boundary_digest: canonicalJsonDigest("reviewed action"),
      mode: "supervised_worker", concurrency: 1, queue_limit: 20, lease_seconds: 60,
      max_attempts: 3, proposal_ttl_seconds: 300, rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "WRITER_URL",
    }] },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const suite = backend === "postgres" && !process.env.SYNAPSOR_TEST_POSTGRES_URL ? describe.skip : describe;
  suite(`${backend} validated operator policy transactions`, () => {
    async function useRepository(run: (input: {
      policies: OperatorAuthorityRepository;
      projectRoot: string;
      binding: Awaited<ReturnType<typeof migrateProjectControlPolicies>>["binding"];
      original: ControlPolicyMigrationSnapshot;
      config: RuntimeConfig;
    }) => Promise<void>, profile: "staging" | "development" = "staging") {
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-operator-policy-")); roots.push(projectRoot);
      const schema = `operator_policy_${randomUUID().replaceAll("-", "")}`;
      const config = backend === "sqlite" ? {} as RuntimeConfig : { storage: { shared_postgres: {
        mode: "runtime_store", url_env: "TEST_POLICY_URL", schema,
      } } } as RuntimeConfig;
      const original = snapshot(profile);
      const result = await migrateProjectControlPolicies({ projectRoot, storePath: path.join(projectRoot, "control.db"), config,
        env: { TEST_POLICY_URL: process.env.SYNAPSOR_TEST_POSTGRES_URL }, actor: "operator",
        readLegacySnapshot: async () => original, validateSnapshot: async (value) => validateOperatorPolicySnapshot(value) });
      const previousUrl = process.env.TEST_POLICY_URL;
      if (backend === "postgres") process.env.TEST_POLICY_URL = process.env.SYNAPSOR_TEST_POSTGRES_URL;
      try { await run({ policies: new OperatorAuthorityRepository(result.binding, config), binding: result.binding, original, projectRoot, config }); }
      finally {
        if (previousUrl === undefined) delete process.env.TEST_POLICY_URL;
        else process.env.TEST_POLICY_URL = previousUrl;
        await result.binding.close();
        if (backend === "postgres") {
          const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL });
          try { await pool.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await pool.end(); }
        }
      }
    }

    it("retains partial coded metadata decisions and promotes only a fully valid disabled Read candidate", async () => {
      await useRepository(async ({ policies, projectRoot }) => {
        const { authoring, inspection } = metadataAuthoringFixture(projectRoot);
        const other = readAuthoringFixture().entries[1]!; other.catalog = readAuthoringCatalog(fixture("university").build);
        authoring.entries.push(other);
        const initial = await policies.current();
        await policies.commitReadAuthoring({ expected_epoch: initial.epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "inspect_coded_metadata" });
        const prepared = await policies.current();
        expect(prepared.drafts.map(({ revision }) => revision.name)).toEqual(["university_draft"]);
        const context = await loadBoundaryReviewContext(projectRoot);
        expect(context.candidate.pack.resources).toHaveLength(0);
        await expect(activateExplorationBoundary({ projectRoot, candidate: context.candidate,
          reviewDraft: context.draft, generationLock: context.lock,
          expectedDigest: explorationBoundaryCandidateDigest(context.candidate), actor: "operator",
          confirmation: `ACTIVATE ${explorationBoundaryCandidateDigest(context.candidate)}`,
          confirmedDecisions: context.candidate.unresolved_decisions, currentInspection: inspection,
          expectedAuthoring: (await readProjectReadAuthoring(projectRoot))!.bindings })).rejects.toThrow("at least one reviewed resource");
        expect(await policies.current()).toEqual(prepared);
        const id = context.progress!.boundary_id;
        const view = await inspectBoundaryResourceReview(projectRoot, "coded.x17");
        expect(view.fields.map((field) => field.name)).toContain("k01");
        const preview = await prepareBoundaryResourceReviewMutation(projectRoot, { resource_id: "coded.x17",
          include: true, row_identity: "k01", actor: "operator", reason: "k01 identifies one business record." }, async () => inspection);
        expect(preview.partial_scope_resolution).toBe(true);
        expect(preview.candidate.pack.resources).toHaveLength(0);
        const committed = await commitBoundaryResourceReviewMutation(projectRoot, preview);
        expect(committed).toMatchObject({ review_revision: 2, source_database_changed: false });
        const resumed = (await readProjectReadAuthoring(projectRoot))!;
        expect(resumed.selected!.stage).toBe("metadata_only");
        expect(resumed.selected!.progress.boundary_id).toBe(id);
        expect(resumed.selected!.progress.review_overrides.resources["coded.x17"]!.row_identity?.value).toBe("k01");
        expect((await policies.current()).drafts.map(({ revision }) => revision.name)).toEqual(["university_draft"]);
        await expect(commitBoundaryResourceReviewMutation(projectRoot, preview)).rejects.toThrow();
        const scoped = await prepareBoundaryResourceReviewMutation(projectRoot, { resource_id: "coded.x17", include: true,
          tenant_key: "k02", principal_key: "k03", actor: "operator", reason: "k02 is the account; k03 is the authenticated owner." }, async () => inspection);
        expect(scoped.candidate.pack.resources).toHaveLength(1);
        const saved = await commitBoundaryResourceReviewMutation(projectRoot, scoped);
        const complete = (await readProjectReadAuthoring(projectRoot))!;
        expect(complete.selected!.stage).toBeUndefined();
        expect(complete.selected!.progress.boundary_id).toBe(id);
        expect(complete.selected!.progress.revision).toBe(3);
        expect(saved.candidate_digest).toBe(complete.selected!.progress.candidate_digest);
        expect(complete.selected!.progress.candidate.pack.resources[0]).toMatchObject({ primary_key: "k01", tenant_key: "k02", principal_key: "k03" });
        const final = await policies.current();
        expect(final.drafts.map(({ revision }) => revision.name).sort()).toEqual(["coded_draft", "university_draft"]);
        expect(final.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(initial.active);
        expect(complete.authoring.entries[1]).toEqual(other);
        await expect(fs.stat(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json")))
          .rejects.toMatchObject({ code: "ENOENT" });
      });
    });

    it("rescans and renames incomplete metadata without publishing Read authority or losing reviewed answers", async () => {
      await useRepository(async ({ policies, projectRoot }) => {
        const { authoring, inspection } = metadataAuthoringFixture(projectRoot);
        const other = readAuthoringFixture().entries[1]!;
        authoring.entries.push(other);
        const initial = await policies.current();
        await policies.commitReadAuthoring({ expected_epoch: initial.epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "inspect_coded_metadata" });
        const preview = await prepareBoundaryResourceReviewMutation(projectRoot, { resource_id: "coded.x17",
          include: true, row_identity: "k01", actor: "operator", reason: "k01 identifies one business record." }, async () => inspection);
        await commitBoundaryResourceReviewMutation(projectRoot, preview);
        const before = await policies.current();
        const noOp = await prepareBoundaryRescan({ projectRoot, inspection });
        expect(noOp.report.changed).toBe(false);
        await commitBoundaryRescan(noOp);
        expect(await policies.current()).toEqual(before);
        const changed = structuredClone(inspection);
        changed.tables[0]!.columns.push({ ...structuredClone(changed.tables[0]!.columns[3]!), name: "v03", ordinal_position: 6 });
        const rescan = await prepareBoundaryRescan({ projectRoot, inspection: changed });
        const competing = await prepareBoundaryRescan({ projectRoot, inspection: changed });
        expect(rescan.report.changed).toBe(true);
        await commitBoundaryRescan(rescan);
        const resumed = (await readProjectReadAuthoring(projectRoot))!;
        expect(resumed.selected!.stage).toBe("metadata_only");
        expect(resumed.selected!.progress.candidate.pack.resources).toHaveLength(0);
        expect(resumed.selected!.progress.boundary_id).toBe(authoring.selected_boundary_id);
        expect(resumed.selected!.progress.review_overrides.resources["coded.x17"]!.row_identity?.value).toBe("k01");
        expect(resumed.authoring.entries[1]).toEqual(other);
        expect((await inspectBoundaryResourceReview(projectRoot, "coded.x17")).fields.map((field) => field.name)).toContain("v03");
        await expect(commitBoundaryRescan(competing)).rejects.toThrow("Boundary review changed");
        await renameSavedBoundary({ projectRoot, draft: resumed.selected!.draft,
          currentCandidate: resumed.selected!.progress.candidate, currentProgress: resumed.selected!.progress,
          expectedAuthoring: resumed.bindings, name: "coded_draft", newName: "customer_records",
          actor: "operator", reason: "Name the metadata scaffold after the clarified business records." });
        const renamed = (await readProjectReadAuthoring(projectRoot))!;
        expect(renamed.selected!.stage).toBe("metadata_only");
        expect(renamed.selected!.progress.boundary_id).toBe(authoring.selected_boundary_id);
        expect(renamed.selected!.progress.candidate.pack.name).toBe("customer_records");
        const final = await policies.current();
        expect(final.drafts.map(({ revision }) => revision.name)).toEqual(["university_draft"]);
        expect(final.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(initial.active);
      });
    });

    it.each(["disabled", "unrelated_active", "selected_active", "selected_changed", "guided_active", "metadata", "stale_export", "no_authoring",
      "workbench", "wrong_store", "no_config", "no_config_cli", "bare", "deferred"])("resumes governed startup without generated exports: %s", async (mode) => {
      await useRepository(async ({ policies, projectRoot, config }) => {
        const authoring = mode === "metadata" ? metadataAuthoringFixture(projectRoot).authoring : readAuthoringFixture();
        if (["selected_active", "selected_changed", "guided_active"].includes(mode)) {
          const source = fixture();
          if (mode === "selected_changed") source.candidate.budgets.max_top_n = 11;
          authoring.entries[0] = { draft: source.candidate, draft_lock: source.generation_lock,
            candidate_lock: source.generation_lock, progress: createBoundaryReviewProgress({ draft: source.candidate,
              candidate: source.candidate, confirmedDecisions: [], actor: "operator", revision: 1 }) };
          authoring.selected_boundary_id = authoring.entries[0]!.progress.boundary_id;
        }
        if (mode !== "no_authoring") {
          const current = await policies.current();
          await policies.commitReadAuthoring({ expected_epoch: current.epoch, expected_revision_id: null,
            authoring, actor: "operator", operation: "prepare_startup_review" });
        }
        if (mode === "disabled" || mode === "stale_export") await deactivateExplorationBoundary(projectRoot);
        const configPath = path.join(projectRoot, "synapsor.runner.json");
        if (!["no_config", "no_config_cli"].includes(mode)) await fs.writeFile(configPath, JSON.stringify({
          ...config, version: 1, mode: "read_only", capabilities: [], trusted_context: { provider: "environment" },
          sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true } },
          generated_authority: { generation_lock_path: "./.synapsor/generation-lock.json", enforcement: "required" },
          storage: {
          ...config.storage, sqlite_path: mode === "wrong_store" ? "./shadow.db" : "./control.db",
          ...(mode === "wrong_store" ? { shared_postgres: undefined } : {}),
        } }));
        if (mode === "guided_active") {
          const context = await loadBoundaryReviewContext(projectRoot);
          await writeBoundaryAuthoringResumeState(projectRoot, buildBoundaryAuthoringResumeState({
            binding: boundaryAuthoringResumeBinding(context.bundle), stage: "authority_review",
            jobIntent: "Review inventory and propose a bounded replenishment.", provider: "openai", model: "gpt-5.6-terra",
          }));
        }
        if (mode === "stale_export") {
          await fs.mkdir(path.join(projectRoot, "synapsor/generated"), { recursive: true });
          await fs.writeFile(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json"), "obsolete export");
          await fs.writeFile(path.join(projectRoot, ".synapsor/exploration-boundary.active.json"), "obsolete active export");
        }
        const before = await policies.current();
        const configBefore = ["no_config", "no_config_cli"].includes(mode) ? undefined : await fs.readFile(configPath, "utf8");
        const cwd = process.cwd(); const previousUrl = process.env.DATABASE_URL;
        const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        const inspect = vi.fn(async () => { throw new Error("Resume must not inspect or regenerate the saved metadata."); });
        const review = vi.fn(async () => 0), handoff = vi.fn(async () => 0), workbench = vi.fn(async () => 0);
        process.chdir(projectRoot); process.env.DATABASE_URL = "postgresql://unused-test-host/never-connect";
        try {
          const args = mode === "bare" ? [] : ["--from-env", "DATABASE_URL",
            ...(["workbench", "wrong_store", "no_config"].includes(mode) ? [] : [mode === "deferred" ? "--no-open" : "--cli"])];
          const running = start(args, { interactive: true, schemaInspector: inspect,
            runBoundaryReview: review, runPostActivationHandoff: handoff, openWorkbench: workbench });
          if (mode === "no_authoring") await expect(running).rejects.toMatchObject({ code: "POLICY_READ_AUTHORING_MISSING" });
          else if (mode === "wrong_store") await expect(running).rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
          else if (mode === "no_config") await expect(running).rejects.toThrow("Workbench needs the reviewed runtime configuration");
          else await expect(running).resolves.toBe(0);
          expect(inspect).not.toHaveBeenCalled();
          expect(handoff).toHaveBeenCalledTimes(mode === "selected_active" ? 1 : 0);
          expect(review).toHaveBeenCalledTimes(["disabled", "unrelated_active", "selected_changed", "guided_active", "metadata", "stale_export", "no_config_cli"].includes(mode) ? 1 : 0);
          if (mode === "guided_active") expect(review).toHaveBeenCalledWith(
            ["--project-root", projectRoot, "--access", "--job-first"], inspect, expect.any(Function));
          expect(workbench).toHaveBeenCalledTimes(["workbench", "bare"].includes(mode) ? 1 : 0);
          if (["workbench", "bare"].includes(mode)) expect(workbench).toHaveBeenCalledWith(expect.arrayContaining([
            "--store", path.join(projectRoot, "control.db"),
          ]));
          if (mode === "disabled" || mode === "stale_export") expect(output.mock.calls.flat().join("")).toContain("Agent authority active: no");
          expect(await policies.current()).toEqual(before);
          if (configBefore !== undefined) expect(await fs.readFile(configPath, "utf8")).toBe(configBefore);
          else await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.stat(path.join(projectRoot, "shadow.db"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          process.chdir(cwd); output.mockRestore();
          if (previousUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = previousUrl;
        }
      });
    });

    it.each(["cli", "draft", "coded_cli", "coded_draft", "configured_scope", "configured_scope_draft", "unconfigured_cli", "unconfigured_draft",
      "inspection_race", "unsafe_role", "inspection_failure", "review_failure"])(
      "publishes initial governed metadata only into an empty saved review: %s", async (mode) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const before = await policies.current();
        await policies.commitReadAuthoring({ expected_epoch: before.epoch, expected_revision_id: null,
          authoring: { type: "read_authoring", selected_boundary_id: null, entries: [] },
          actor: "operator", operation: "empty_review" });
        const initial = (await readProjectReadAuthoring(projectRoot))!;
        const source = mode.startsWith("coded") ? metadataAuthoringFixture(projectRoot) : fixture("inventory");
        const inspection = structuredClone(source.inspection);
        const competing = readAuthoringFixture();
        let configBefore: string | undefined;
        if (mode.startsWith("configured_scope") || mode.startsWith("unconfigured")) {
          inspection.tables[0]!.columns.find((field) => field.name === "principal_id")!.name = "actor_uuid";
          configBefore = JSON.stringify({ version: 1, mode: "read_only", capabilities: [],
            trusted_context: { provider: "environment", tenant_binding: "tenant_id", principal_binding: "actor_uuid",
              values: { tenant_id_env: "SYNAPSOR_TENANT_ID", principal_env: "CUSTOM_PRINCIPAL" } },
            sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true } },
            generated_authority: { generation_lock_path: "./.synapsor/generation-lock.json", enforcement: "required" },
          });
          await fs.writeFile(path.join(projectRoot, "synapsor.runner.json"), configBefore);
        }
        if (mode === "unsafe_role") inspection.role_posture!.superuser = true;
        const inspect = vi.fn(async () => {
          if (mode === "inspection_race") await saveProjectReadAuthoring({ projectRoot, expected: initial.bindings,
            authoring: competing, actor: "another_operator", operation: "other_initial_review" });
          if (mode === "inspection_failure") throw new Error("test metadata connection unavailable");
          return inspection;
        });
        const review = vi.fn(async () => { if (mode === "review_failure") throw new Error("test review UI unavailable"); return 0; });
        const cwd = process.cwd(); const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        await fs.mkdir(path.join(projectRoot, "synapsor/generated"), { recursive: true });
        const legacyFile = path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json");
        await fs.writeFile(legacyFile, "obsolete export must not be a generated draft");
        process.chdir(projectRoot);
        try {
          const isDraft = mode.endsWith("draft");
          const sourceEnv = mode.startsWith("unconfigured") ? "OTHER_DATABASE_URL" : "DATABASE_URL";
          const running = isDraft
            ? boundaryCommand(["draft", "--from-env", sourceEnv, "--schema", mode.startsWith("coded") ? "coded" : "inventory",
              "--project-root", projectRoot, "--force", "--json"], inspect)
            : start(["--from-env", sourceEnv, "--schema", mode.startsWith("coded") ? "coded" : "inventory", "--cli"], {
              interactive: true, schemaInspector: inspect, runBoundaryReview: review,
              reviewUnresolvedOrganizationScope: async () => ({ mode: "tenant" }),
            });
          if (mode.startsWith("unconfigured")) await expect(running).rejects.toThrow("does not configure the requested source OTHER_DATABASE_URL");
          else if (mode === "inspection_race") await expect(running).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
          else if (mode === "unsafe_role") await expect(running).rejects.toMatchObject({ code: "DATABASE_ROLE_UNSAFE" });
          else if (mode === "inspection_failure") await expect(running).rejects.toThrow("metadata connection unavailable");
          else if (mode === "review_failure") await expect(running).rejects.toThrow("test review UI unavailable");
          else await expect(running).resolves.toBe(0);
          if (mode.startsWith("unconfigured")) expect(inspect).not.toHaveBeenCalled();
          else expect(inspect).toHaveBeenCalledOnce();
          const saved = (await readProjectReadAuthoring(projectRoot))!;
          if (mode === "inspection_race") expect(saved.authoring).toEqual(competing);
          else if (["unsafe_role", "inspection_failure"].includes(mode) || mode.startsWith("unconfigured")) expect(saved).toEqual(initial);
          else {
            expect(saved.authoring.entries).toHaveLength(1);
            expect(saved.selected!.progress.revision).toBe(1);
            expect(saved.selected!.progress.confirmed_decisions).toEqual([]);
            expect(saved.selected!.catalog!.review.resources[0]!.id).toBe(mode.startsWith("coded") ? "coded.x17" : "inventory.items");
            expect(saved.selected!.stage).toBe(mode.startsWith("coded") ? "metadata_only" : undefined);
            if (mode.startsWith("configured_scope")) {
              expect(saved.selected!.candidate_lock.trusted_context_authority?.principal_binding).toBe("actor_uuid");
              expect(saved.selected!.progress.candidate.trusted_context.principal_env).toBe("CUSTOM_PRINCIPAL");
            }
            await expect(saveInitialGovernedBoundaryReview({ projectRoot, build: source.build,
              expectedAuthoring: initial.bindings, actor: "operator" })).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
            await expect(saveInitialGovernedBoundaryReview({ projectRoot, build: source.build,
              expectedAuthoring: saved.bindings, actor: "operator" })).rejects.toThrow("saved Read review already exists");
            expect(await readProjectReadAuthoring(projectRoot)).toEqual(saved);
            if (isDraft) expect(output.mock.calls.flat().join("")).toContain('"storage": "control_repository"');
            else expect(review).toHaveBeenCalledWith(["--project-root", projectRoot, "--access", "--job-first"], inspect, expect.any(Function));
          }
          const after = await policies.current();
          expect(after.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
          if (mode.startsWith("coded")) expect(after.drafts).toEqual([]);
          expect(await fs.readFile(legacyFile, "utf8")).toBe("obsolete export must not be a generated draft");
          await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
          if (configBefore) expect(await fs.readFile(path.join(projectRoot, "synapsor.runner.json"), "utf8")).toBe(configBefore);
          else await expect(fs.stat(path.join(projectRoot, "synapsor.runner.json"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally { process.chdir(cwd); output.mockRestore(); }
      });
    });

    it.each([{ surface: "cli", selectedActive: false }, { surface: "cli", selectedActive: true },
      { surface: "draft", selectedActive: false }, { surface: "draft", selectedActive: true }])(
      "resumes a stored rescan only when its exact selected Read is active: $surface $selectedActive", async ({ surface, selectedActive }) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const source = fixture(); const authoring = readAuthoringFixture();
        const first = authoring.entries[0]!;
        if (selectedActive) {
          first.draft = source.candidate;
          first.progress = createBoundaryReviewProgress({ draft: source.candidate, candidate: source.candidate,
            confirmedDecisions: [], actor: "operator", revision: 1 });
          authoring.selected_boundary_id = first.progress.boundary_id;
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare_rescan_resume" });
        const before = await policies.current();
        const cwd = process.cwd(); const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        const inspect = vi.fn(async () => source.inspection);
        const review = vi.fn(async () => 0), handoff = vi.fn(async () => 0);
        process.chdir(projectRoot);
        try {
          const running = surface === "cli" ? start(["--from-env", "DATABASE_URL", "--cli", "--rescan"], {
            interactive: true, schemaInspector: inspect, runBoundaryReview: review, runPostActivationHandoff: handoff,
          }) : boundaryCommand(["draft", "--from-env", "DATABASE_URL", "--project-root", projectRoot, "--force"], inspect);
          await expect(running).resolves.toBe(0);
          expect(inspect).toHaveBeenCalledOnce();
          expect(handoff).toHaveBeenCalledTimes(surface === "cli" && selectedActive ? 1 : 0);
          expect(review).toHaveBeenCalledTimes(surface === "cli" && !selectedActive ? 1 : 0);
          const after = await policies.current();
          expect(after.active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(before.active.filter(({ policy }) => policy.type !== "read_authoring"));
          expect((await readProjectReadAuthoring(projectRoot))!.authoring.entries.map((entry) => entry.progress))
            .toEqual(authoring.entries.map((entry) => entry.progress));
          await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally { process.chdir(cwd); output.mockRestore(); }
      });
    });

    it("binds Quick Start saves to the original review and returns the exact activation successor", async () => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture(); const first = authoring.entries[0]!;
        first.progress.review_overrides = fixture().build.overrides;
        const before = await policies.current();
        await policies.commitReadAuthoring({ expected_epoch: before.epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare_quick_start" });
        const shown = (await readProjectReadAuthoring(projectRoot))!;
        const input = { projectRoot, draft: first.draft, candidate: structuredClone(first.progress.candidate), actor: "operator" };
        input.candidate.budgets.max_top_n = 12;
        await expect(saveInstantBoundaryReviewBaseline(input)).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        const editing = await saveInstantBoundaryEditBaseline({ ...input, expectedAuthoring: shown.bindings });
        expect(editing.progress.boundary_id).toBe(first.progress.boundary_id);
        expect(editing.progress.revision).toBe(2);
        expect(editing.progress.review_overrides).toEqual(first.progress.review_overrides);
        expect(editing.progress.confirmations.length).toBeGreaterThan(0);
        expect(editing.progress.confirmations.length).toBeLessThan(first.progress.confirmations.length);
        for (const confirmation of editing.progress.confirmations) {
          expect(first.progress.confirmations).toContainEqual(confirmation);
        }
        const edited = (await readProjectReadAuthoring(projectRoot))!;
        expect(editing.authoring).toEqual(edited.bindings);
        expect(edited.authoring.entries[1]).toEqual(authoring.entries[1]);
        await expect(saveInstantBoundaryReviewBaseline({ ...input, expectedAuthoring: shown.bindings }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        await expect(saveInstantBoundaryReviewBaseline({ ...input, expectedAuthoring: editing.authoring,
          candidate: { ...input.candidate, pack: { ...input.candidate.pack,
            resources: [...input.candidate.pack.resources, fixture("unreviewed").candidate.pack.resources[0]!] } } }))
          .rejects.toThrow();
        expect((await readProjectReadAuthoring(projectRoot))!.bindings).toEqual(editing.authoring);
        const saved = await saveInstantBoundaryReviewBaseline({ ...input, expectedAuthoring: editing.authoring });
        expect(saved.progress.boundary_id).toBe(first.progress.boundary_id);
        expect(saved.progress.revision).toBe(3);
        expect(saved.progress.confirmed_decisions.length).toBeGreaterThan(0);
        const confirmed = (await readProjectReadAuthoring(projectRoot))!;
        expect(saved.authoring).toEqual(confirmed.bindings);
        const changed = structuredClone(confirmed.authoring);
        changed.entries[0]!.progress = createBoundaryReviewProgress({ draft: first.draft,
          candidate: { ...saved.progress.candidate, budgets: { ...saved.progress.candidate.budgets, max_top_n: 10 } },
          previous: saved.progress, confirmedDecisions: [], actor: "other_operator", revision: 4 });
        await saveProjectReadAuthoring({ projectRoot, expected: confirmed.bindings, authoring: changed,
          actor: "other_operator", operation: "newer_read_review" });
        const digest = saved.progress.candidate_digest;
        await expect(activateExplorationBoundary({ projectRoot, candidate: saved.progress.candidate,
          reviewDraft: first.draft, generationLock: first.candidate_lock, expectedDigest: digest,
          actor: "operator", confirmation: `ACTIVATE ${digest}`, confirmedDecisions: saved.progress.confirmed_decisions,
          currentInspection: fixture().inspection, expectedAuthoring: saved.authoring }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
      });
    });

    it.each(["accept", "edit", "prompt_race", "inspection_race", "staging"])("uses stored Quick Start candidates without export fallback: %s", async (mode) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture(mode === "staging" ? "staging" : "development"); const first = authoring.entries[0]!;
        const candidate = structuredClone(first.progress.candidate); candidate.budgets.max_top_n = 11;
        first.progress = createBoundaryReviewProgress({ draft: first.draft, candidate,
          previous: first.progress, reviewOverrides: fixture().build.overrides, confirmedDecisions: [], actor: "operator", revision: 4 });
        const before = await policies.current();
        await policies.commitReadAuthoring({ expected_epoch: before.epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare_quick_start" });
        const inspect = vi.fn(async () => {
          if (mode === "inspection_race" && inspect.mock.calls.length === 2) await compete();
          return fixture().inspection;
        });
        const compete = async () => {
          const current = (await readProjectReadAuthoring(projectRoot))!;
          const changed = structuredClone(current.authoring);
          changed.entries[0]!.progress = createBoundaryReviewProgress({ draft: first.draft,
            candidate: { ...first.progress.candidate, budgets: { ...first.progress.candidate.budgets, max_top_n: 7 } },
            previous: first.progress, confirmedDecisions: [], actor: "other_operator", revision: 5 });
          await saveProjectReadAuthoring({ projectRoot, expected: current.bindings, authoring: changed,
            actor: "other_operator", operation: "newer_read_review" });
        };
        let output = "";
        const run = activateInstantCliBoundary({ projectRoot, draft: fixture("wrong_export").candidate,
          lock: fixture("wrong_export").generation_lock, schemaInspector: inspect,
          env: { SYNAPSOR_TENANT_ID: "test-tenant", SYNAPSOR_PRINCIPAL: "test-principal" },
          stdout: { write: (chunk) => { output += String(chunk); return true; }, isTTY: false },
          chooseAskSelection: async () => ({ route: "later" }),
          session: { promptText: async () => { if (mode === "prompt_race") await compete(); return mode === "edit" ? "e" : ""; } } });
        if (mode.endsWith("race")) await expect(run).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        else expect(await run).toMatchObject({ accepted: mode === "accept" });
        const current = (await readProjectReadAuthoring(projectRoot))!;
        expect(current.selected!.progress.boundary_id).toBe(first.progress.boundary_id);
        expect(current.selected!.progress.revision).toBe(mode === "staging" ? 4 : 5);
        expect(current.selected!.progress.candidate.budgets.max_top_n).toBe(mode.endsWith("race") ? 7 : 11);
        expect(current.selected!.progress.review_overrides).toEqual(first.progress.review_overrides);
        expect(current.authoring.entries[1]).toEqual(authoring.entries[1]);
        expect(output).not.toContain("wrong_export");
        if (mode === "staging") expect(inspect).not.toHaveBeenCalled();
        const final = await policies.current();
        if (mode === "accept") {
          const active = await loadActivatedExplorationBoundary(projectRoot, { name: "inventory_draft" });
          expect(active.pack.resources[0]!.id).toBe("inventory.items");
          expect(active.budgets.max_top_n).toBe(11);
          expect(final.active).toEqual(expect.arrayContaining(before.active.filter(({ policy }) => policy.type === "read")));
        } else expect(final.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        await expect(fs.stat(path.join(projectRoot, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
      }, "development");
    });

    it("persists exact disabled edits independently, avoids duplicate history, and resumes current state", async () => {
      await useRepository(async ({ policies, binding, original }) => {
        const source = fixture(); source.candidate.budgets.max_top_n = 12;
        const policy = { type: "read" as const, boundary: source.candidate, generation_lock: source.generation_lock };
        const key = original.drafts[0]!;
        const saved = await policies.commit({ expected_epoch: 1, drafts: [{ key, policy }], actor: "reviewer", operation: "save_disabled_read" });
        expect(saved.epoch).toBe(2);
        expect(saved.changes).toMatchObject([{ state: "draft", before: original.drafts[0]!.revision_id }]);
        const next = await policies.current();
        expect(next.active.map((entry) => entry.revision)).toEqual(expect.arrayContaining(original.revisions.filter((entry) => entry !== original.revisions[1])));
        expect(next.drafts[0]!.policy).toEqual(policy);
        expect(await policies.commit({ expected_epoch: 2, drafts: [{ key, policy }], actor: "reviewer", operation: "same_draft" }))
          .toEqual({ epoch: 2, changes: [] });
        // Returning to an older, exact disabled revision moves the pointer but
        // never mutates or reinserts its immutable history.
        await policies.commit({ expected_epoch: 2, drafts: [{ key, policy: decodeOperatorAuthority(original.revisions[1]!) }],
          actor: "reviewer", operation: "restore_exact_draft" });
        expect((await new OperatorAuthorityRepository(binding).current()).drafts[0]!.revision).toEqual(original.revisions[1]);
        expect(await binding.repository.history({ deployment_id: binding.deployment_id, key })).toHaveLength(3);
      });
    });

    it("commits complete Read authoring and selection atomically without changing active authority", async () => {
      await useRepository(async ({ binding, projectRoot, config: storageConfig }) => {
        const action = actionFixture(fixture());
        await writeActionRuleAuthorityDraft(projectRoot, action);
        await activateActionRuleAuthority({ projectRoot, name: action.authority.name, expected_digest: action.digest,
          confirmation: `ACTIVATE ${action.digest}`, actor: "operator" });
        const config = executionConfig(); config.action_rules!.project_root = projectRoot;
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        config.supervised_worker!.outcomes![0]!.action_boundary_digest = action.authority.action_boundary.digest;
        const policies = new OperatorAuthorityRepository(binding, config);
        await policies.commit({ expected_epoch: (await policies.current()).epoch,
          active: [{ key: OPERATOR_EXECUTION_POLICY, policy: decodeOperatorAuthority(encodeOperatorExecutionPolicy(config)!, { runtimeConfig: config }) }],
          actor: "operator", operation: "reviewed_execution" });
        const before = await policies.current(); const authoring = readAuthoringFixture();
        await policies.commitReadAuthoring({ expected_epoch: before.epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "save_read_authoring" });
        const stored = await new OperatorAuthorityRepository(binding, config).current();
        expect(stored.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        expect(stored.drafts.filter(({ policy }) => policy.type === "action")).toEqual(before.drafts.filter(({ policy }) => policy.type === "action"));
        expect(stored.drafts.filter(({ policy }) => policy.type === "read")).toHaveLength(2);
        const record = stored.active.find(({ policy }) => policy.type === "read_authoring")!;
        expect(record.policy).toEqual(authoring);
        // A fresh epoch is insufficient when the original authoring revision
        // changed; callers must retain the identity from their original read.
        await expect(policies.commitReadAuthoring({ expected_epoch: stored.epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "stale_edit" })).rejects.toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
        const selected = structuredClone(authoring); selected.selected_boundary_id = selected.entries[1]!.progress.boundary_id;
        const input = { expected_epoch: stored.epoch, expected_revision_id: record.revision.revision_id,
          authoring: selected, actor: "operator", operation: "select_saved_draft" };
        const raced = await Promise.allSettled([policies.commitReadAuthoring(input), policies.commitReadAuthoring(input)]);
        expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const changed = await policies.current();
        expect(changed.active.find(({ policy }) => policy.type === "read_authoring")!.policy).toEqual(selected);
        expect(changed.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        expect(changed.drafts).toEqual(stored.drafts);
        // Generic writes must not desynchronize a candidate from its saved
        // review decisions, even though both are disabled.
        const drift = structuredClone(selected.entries[0]!.progress.candidate); drift.budgets.max_top_n = 7;
        await expect(policies.commit({ expected_epoch: changed.epoch, actor: "operator", operation: "partial_draft_edit",
          drafts: [{ key: { scope: { level: "operator" }, kind: "read", name: drift.pack.name },
            policy: { type: "read", boundary: drift, generation_lock: selected.entries[0]!.candidate_lock } }] }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_DRAFT_MISMATCH" });
        expect(await policies.current()).toEqual(changed);
        const edited = structuredClone(selected);
        const first = edited.entries[0]!;
        first.progress = createBoundaryReviewProgress({ draft: first.draft, candidate: drift,
          previous: first.progress, confirmedDecisions: [], revision: first.progress.revision + 1, actor: "operator" });
        await policies.commitReadAuthoring({ expected_epoch: changed.epoch,
          expected_revision_id: changed.active.find(({ policy }) => policy.type === "read_authoring")!.revision.revision_id,
          authoring: edited, actor: "operator", operation: "narrow_saved_draft" });
        const updated = await policies.current();
        expect(updated.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        expect(updated.drafts.find(({ revision }) => revision.name === drift.pack.name)!.policy)
          .toMatchObject({ boundary: { budgets: { max_top_n: 7 } } });
        expect(updated.drafts.find(({ revision }) => revision.name === selected.entries[1]!.progress.candidate.pack.name))
          .toEqual(changed.drafts.find(({ revision }) => revision.name === selected.entries[1]!.progress.candidate.pack.name));
        const removed = { ...edited, selected_boundary_id: first.progress.boundary_id, entries: [first] };
        await policies.commitReadAuthoring({ expected_epoch: updated.epoch,
          expected_revision_id: updated.active.find(({ policy }) => policy.type === "read_authoring")!.revision.revision_id,
          authoring: removed, actor: "operator", operation: "remove_saved_draft" });
        const final = await policies.current();
        expect(final.drafts.filter(({ policy }) => policy.type === "read")).toHaveLength(1);
        expect(final.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        await fs.writeFile(path.join(projectRoot, ".synapsor/boundary-review-progress.json"), "not authoritative");
        await fs.writeFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "not authoritative");
        expect(await new OperatorAuthorityRepository(binding, config).current()).toEqual(final);
        const review = await loadBoundaryReviewContext(projectRoot);
        expect(review.progress).toEqual(first.progress);
        expect(review.lock).toEqual(first.draft_lock);
        // Disabled review remains usable even if execution has independent
        // prerequisites and its exported files are unavailable.
        expect(review.bundle.mutation_bindings.authoring!.epoch).toBe(final.epoch);
        expect((await loadActivatedExplorationBoundary(projectRoot)).pack.name).toBe(fixture().boundary.pack.name);
        await deactivateExplorationBoundary(projectRoot);
        const revoked = await policies.current();
        expect(revoked.active.find(({ policy }) => policy.type === "read_authoring"))
          .toEqual(final.active.find(({ policy }) => policy.type === "read_authoring"));
        expect(revoked.drafts).toEqual(final.drafts);
        expect(revoked.active.filter(({ policy }) => policy.type === "action" || policy.type === "execution"))
          .toEqual(final.active.filter(({ policy }) => policy.type === "action" || policy.type === "execution"));
      });
    });

    it("reopens, edits and switches stored Read reviews without file repair or stale overwrites", async () => {
      await useRepository(async ({ binding, projectRoot }) => {
        const repository = new OperatorAuthorityRepository(binding);
        const original = await repository.current();
        const authoring = readAuthoringFixture();
        await repository.commitReadAuthoring({ expected_epoch: original.epoch, expected_revision_id: null,
          authoring, actor: "reviewer", operation: "prepare" });
        for (const name of ["boundary-library.json", "boundary-review-progress.json", "generation-lock.json"]) {
          await fs.writeFile(path.join(projectRoot, ".synapsor", name), "invalid legacy export");
        }
        const loaded = await loadBoundaryReviewContext(projectRoot);
        const context = { projectRoot, draft: loaded.draft, currentCandidate: loaded.candidate,
          currentProgress: loaded.progress, expectedAuthoring: loaded.bundle.mutation_bindings.authoring };
        const before = await repository.current();
        const list = await synchronizeBoundaryLibrary(context);
        expect(list.entries).toHaveLength(2);
        await expect(writeAutoBoundaryArtifacts({ projectRoot, build: fixture().build, force: true, preserveActiveBoundary: true }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REPOSITORY_REQUIRED" });
        expect(await repository.current()).toEqual(before);
        expect(await readBoundaryReviewProgress(projectRoot, loaded.draft)).toEqual(loaded.progress);
        const candidate = structuredClone(loaded.candidate); candidate.budgets.max_top_n = 8;
        const progress = createBoundaryReviewProgress({ draft: loaded.draft, candidate, previous: loaded.progress,
          confirmedDecisions: [], revision: loaded.progress!.revision + 1 });
        await expect(saveBoundaryReviewProgress(projectRoot, progress)).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        await saveBoundaryReviewProgress(projectRoot, progress, loaded.bundle.mutation_bindings.authoring);
        expect((await loadBoundaryReviewContext(projectRoot)).progress).toEqual(progress);
        await expect(switchSavedBoundary({ ...context, name: "university_draft" }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        const freshContext = async () => {
          const state = await loadBoundaryReviewContext(projectRoot);
          return { projectRoot, draft: state.draft, currentCandidate: state.candidate, currentProgress: state.progress,
            expectedAuthoring: state.bundle.mutation_bindings.authoring };
        };
        const switched = await switchSavedBoundary({ ...await freshContext(), name: "university_draft" });
        expect(switched).toEqual(authoring.entries[1]!.progress);
        const university = await loadBoundaryReviewContext(projectRoot);
        expect(university.draft).toEqual(authoring.entries[1]!.draft);
        expect(university.lock).toEqual(authoring.entries[1]!.draft_lock);
        await expect(readBoundaryReviewProgress(projectRoot, loaded.draft))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_BASELINE_MISMATCH" });
        await renameSavedBoundary({ ...await freshContext(), name: "university_draft", newName: "enrollment",
          actor: "reviewer", reason: "Use a business label" });
        expect((await loadBoundaryReviewContext(projectRoot)).progress!.boundary_id).toBe(switched.boundary_id);
        await deleteSavedBoundary({ ...await freshContext(), name: "enrollment" });
        expect((await loadBoundaryReviewContext(projectRoot)).progress).toEqual(progress);
        await createSavedBoundary({ ...await freshContext(), name: "stock_review", resourceId: "inventory.items", actor: "reviewer" });
        const created = await loadBoundaryReviewContext(projectRoot);
        expect(created.candidate.pack.name).toBe("stock_review");
        expect(created.progress!.boundary_id).not.toBe(progress.boundary_id);
        const current = await repository.current();
        expect(current.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(original.active);
        expect(await fs.readFile(path.join(projectRoot, ".synapsor/boundary-library.json"), "utf8")).toBe("invalid legacy export");
        await deleteSavedBoundary({ ...await freshContext(), name: "inventory_draft" });
        await discardOnlySavedBoundaryReview({ ...await freshContext(), name: "stock_review",
          boundaryRoot: path.join(projectRoot, "synapsor/generated") });
        const empty = await repository.currentReadState();
        expect(empty.drafts).toHaveLength(0);
        expect(empty.active.find(({ policy }) => policy.type === "read_authoring")!.policy)
          .toEqual({ type: "read_authoring", selected_boundary_id: null, entries: [] });
        await expect(loadBoundaryReviewContext(projectRoot)).rejects.toThrow("No saved Read boundary");
        expect((await repository.current()).active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(original.active);
      });
    });

    it("rescans stored reviews atomically, retains exact catalogs, and rejects stale publication", async () => {
      await useRepository(async ({ binding, projectRoot, config: storageConfig }) => {
        const source = fixture(); const action = actionFixture(source);
        await writeActionRuleAuthorityDraft(projectRoot, action);
        await activateActionRuleAuthority({ projectRoot, name: action.authority.name, expected_digest: action.digest,
          confirmation: `ACTIVATE ${action.digest}`, actor: "operator" });
        const config = executionConfig(); config.action_rules!.project_root = projectRoot;
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        config.supervised_worker!.outcomes![0]!.action_boundary_digest = action.authority.action_boundary.digest;
        const policies = new OperatorAuthorityRepository(binding, config);
        await policies.commit({ expected_epoch: (await policies.current()).epoch,
          active: [{ key: OPERATOR_EXECUTION_POLICY, policy: decodeOperatorAuthority(encodeOperatorExecutionPolicy(config)!, { runtimeConfig: config }) }],
          actor: "operator", operation: "reviewed_execution" });
        const before = await policies.current();
        const first = readAuthoringFixture().entries[0]!;
        const second = structuredClone(first); second.progress = createBoundaryReviewProgress({ draft: second.draft,
          candidate: { ...second.progress.candidate, pack: { ...second.progress.candidate.pack, name: "stock_audit" } },
          confirmedDecisions: [], actor: "reviewer", revision: 1 });
        const authoring: StoredReadAuthoring = { type: "read_authoring", selected_boundary_id: first.progress.boundary_id,
          entries: [first, second, readAuthoringFixture().entries[1]!] };
        await policies.commitReadAuthoring({ expected_epoch: before.epoch, expected_revision_id: null,
          authoring, actor: "reviewer", operation: "prepare" });
        for (const name of ["boundary-library.json", "boundary-review-progress.json", "generation-lock.json", "review-report.json", "boundary-rescan-report.json"]) {
          await fs.writeFile(path.join(projectRoot, ".synapsor", name), "invalid legacy export");
        }
        await expect(inspectBoundaryResourceReview(projectRoot, "inventory.items"))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_CATALOG_MISSING" });
        // Refreshing missing metadata does not create a new reviewed candidate.
        const unchanged = await prepareBoundaryRescan({ projectRoot, inspection: source.inspection });
        expect(unchanged.report.changed).toBe(false);
        expect(unchanged.report.authoring_baseline_refreshed).toBe(true);
        await commitBoundaryRescan(unchanged);
        const refreshed = await policies.current();
        const refreshedAuthoring = refreshed.active.find(({ policy }) => policy.type === "read_authoring")!.policy as StoredReadAuthoring;
        expect(refreshedAuthoring.entries.map((entry) => entry.progress)).toEqual(authoring.entries.map((entry) => entry.progress));
        expect(refreshedAuthoring.entries.map((entry) => entry.draft_lock)).toEqual(authoring.entries.map((entry) => entry.draft_lock));
        expect((await inspectBoundaryResourceReview(projectRoot, "inventory.items")).fields.map((field) => field.name)).toContain("quantity");
        const noOp = await prepareBoundaryRescan({ projectRoot, inspection: source.inspection });
        expect(noOp.report).toMatchObject({ changed: false, authoring_baseline_refreshed: false });
        await commitBoundaryRescan(noOp);
        expect(await policies.current()).toEqual(refreshed);
        const changed = structuredClone(source.inspection);
        changed.tables[0]!.columns.push({ ...structuredClone(changed.tables[0]!.columns[3]!), name: "m014", ordinal_position: 9 });
        const preview = await prepareBoundaryRescan({ projectRoot, inspection: changed });
        const competing = await prepareBoundaryRescan({ projectRoot, inspection: changed });
        expect(preview.report.boundaries).toHaveLength(2);
        expect(preview.report.changed).toBe(true);
        const unbound = structuredClone(preview); delete unbound.stored;
        await expect(commitBoundaryRescan(unbound)).rejects.toThrow("missing its original saved-review binding");
        expect(await policies.current()).toEqual(refreshed);
        await commitBoundaryRescan(preview);
        const saved = await policies.current();
        expect((saved.active.find(({ policy }) => policy.type === "read_authoring")!.policy as StoredReadAuthoring)
          .entries.find((entry) => entry.progress.candidate.pack.name === "university_draft"))
          .toEqual(authoring.entries[2]);
        expect(saved.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        expect(saved.drafts.filter(({ policy }) => policy.type === "action")).toEqual(before.drafts.filter(({ policy }) => policy.type === "action"));
        const read = await inspectBoundaryResourceReview(projectRoot, "inventory.items");
        expect(read.fields.map((field) => field.name)).toContain("m014");
        expect(read.candidate!.selectable_fields).not.toContain("m014");
        expect(await readBoundaryRescanReport(projectRoot)).toEqual(preview.report);
        expect(await fs.readFile(path.join(projectRoot, ".synapsor/review-report.json"), "utf8")).toBe("invalid legacy export");
        await expect(commitBoundaryRescan(competing)).rejects.toThrow("Boundary review changed");
        expect(await policies.current()).toEqual(saved);
        const edit = await prepareBoundaryResourceReviewMutation(projectRoot, { resource_id: "inventory.items",
          withhold_from_model_fields: ["quantity"], actor: "reviewer", reason: "Keep the internal stock quantity private" }, async () => changed);
        await commitBoundaryResourceReviewMutation(projectRoot, edit);
        const edited = await inspectBoundaryResourceReview(projectRoot, "inventory.items");
        expect(edited.candidate!.model_withheld_fields).toContain("quantity");
        expect(edited.fields.map((field) => field.name)).toContain("m014");
        expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        const final = await policies.current();
        const unsafe = structuredClone(changed); unsafe.role_posture!.superuser = true;
        await expect(prepareBoundaryRescan({ projectRoot, inspection: unsafe })).rejects.toMatchObject({ code: "DATABASE_ROLE_UNSAFE" });
        expect(await policies.current()).toEqual(final);
      });
    });

    it("uses exact saved revisions for manual Workbench reads, progress and library switches", async () => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        for (const [index, domain] of ["inventory", "university"].entries()) {
          authoring.entries[index]!.catalog = readAuthoringCatalog(fixture(domain).build);
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const original = await policies.current();
        const boundaryRoot = path.join(projectRoot, "synapsor/generated");
        const server = await startLocalUiServer({ projectRoot, boundaryRoot,
          configPath: path.join(projectRoot, "synapsor.runner.json"), storePath: path.join(projectRoot, "control.db"),
          token: "manual-review-token", csrfToken: "manual-review-csrf", instantOnboarding: true, deploymentProfile: "development" });
        try {
          const base = `http://${server.host}:${server.port}`;
          const bootstrap = await fetch(server.url, { redirect: "manual" });
          expect(bootstrap.status).toBe(303);
          const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!,
            "content-type": "application/json", "x-synapsor-csrf": "manual-review-csrf" };
          const get = async () => {
            const response = await fetch(`${base}/api/boundary`, { headers });
            const payload = await response.json(); expect(response.status, JSON.stringify(payload)).toBe(200); return payload;
          };
          const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
          for (const route of ["/api/instant/activate", "/api/instant/activate-and-read"]) {
            const refusal = await post(route, { next_surface: "no_model" });
            expect(refusal.status).toBe(409);
            expect(await refusal.json()).toMatchObject({ source_database_changed: false,
              error: expect.stringContaining("Resume the saved review") });
          }
          const shown = await get();
          expect(shown.candidate).toEqual(authoring.entries[0]!.progress.candidate);
          expect(shown.review.resources[0].id).toBe("inventory.items");
          expect(await policies.current()).toEqual(original);
          const candidate = structuredClone(shown.candidate); candidate.budgets.max_top_n = 8;
          const body = { candidate, confirmed_decisions: [], expected_revision: shown.review_progress.revision };
          const missing = await post("/api/boundary/progress", body);
          expect(missing.status).toBe(409);
          const saved = await post("/api/boundary/progress", { ...body, authoring_binding: shown.authoring_binding });
          const savedBody = await saved.json(); expect(saved.status, JSON.stringify(savedBody)).toBe(200);
          const readBack = await get();
          expect(readBack.candidate.budgets.max_top_n).toBe(8);
          expect(savedBody.authoring_binding).toEqual(readBack.authoring_binding);
          expect(savedBody.authoring_binding.revision_id).not.toBe(shown.authoring_binding.revision_id);
          const stale = await post("/api/boundary/library/switch", { name: "university_draft", authoring_binding: shown.authoring_binding });
          expect(stale.status).toBe(409);
          const switched = await post("/api/boundary/library/switch", { name: "university_draft", authoring_binding: savedBody.authoring_binding });
          const switchedBody = await switched.json(); expect(switched.status, JSON.stringify(switchedBody)).toBe(200);
          expect(switchedBody.candidate).toEqual(authoring.entries[1]!.progress.candidate);
          const university = await get();
          expect(university.draft).toEqual(authoring.entries[1]!.draft);
          expect(university.review.resources[0].id).toBe("university.items");
          const oldSave = await post("/api/boundary/progress", { ...body, authoring_binding: savedBody.authoring_binding });
          expect(oldSave.status).toBe(409);
          const changed = await policies.current();
          expect(changed.active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(original.active.filter(({ policy }) => policy.type !== "read_authoring"));
        } finally { await server.close(); }
      });
    });

    it.each(["field_metadata", "minimum_cohort_all"])("binds Workbench %s to its original saved review and returns the exact committed successor", async (kind) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        for (const [index, domain] of ["inventory", "university"].entries()) {
          authoring.entries[index]!.catalog = readAuthoringCatalog(fixture(domain).build);
          authoring.entries[index]!.progress.review_overrides = fixture(domain).build.overrides;
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const initial = await policies.current();
        let changeDuringInspection: (() => Promise<void>) | undefined;
        const inspect = vi.fn(async () => {
          const change = changeDuringInspection; changeDuringInspection = undefined;
          await change?.(); return fixture().inspection;
        });
        const server = await startLocalUiServer({ projectRoot, boundaryRoot: path.join(projectRoot, "synapsor/generated"),
          configPath: path.join(projectRoot, "synapsor.runner.json"), storePath: path.join(projectRoot, "control.db"),
          token: "metadata-review-token", csrfToken: "metadata-csrf", schemaInspector: inspect });
        try {
          const base = `http://${server.host}:${server.port}`;
          const bootstrap = await fetch(server.url, { redirect: "manual" });
          expect(bootstrap.status).toBe(303);
          const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!,
            "content-type": "application/json", "x-synapsor-csrf": "metadata-csrf" };
          const get = async () => {
            const response = await fetch(`${base}/api/boundary`, { headers });
            const payload = await response.json(); expect(response.status, JSON.stringify(payload)).toBe(200); return payload;
          };
          const post = (body: unknown) => fetch(`${base}/api/boundary/regenerate`, { method: "POST", headers, body: JSON.stringify(body) });
          const shown = await get();
          const body = { kind, actor: "reviewer", reason: "Review stock information for this workspace.",
            ...(kind === "field_metadata" ? { resource_id: "inventory.items", field: "quantity", label: "Available stock",
              description: "Number of stocked units." } : { value: 3 }), authoring_binding: shown.authoring_binding };
          const missing = await post({ ...body, authoring_binding: undefined });
          expect(missing.status).toBe(409); expect(inspect).not.toHaveBeenCalled();
          const forged = await post({ ...body, authoring_binding: { ...shown.authoring_binding, repository_id: "another-repository" } });
          expect(forged.status).toBe(409); expect(inspect).not.toHaveBeenCalled();
          expect(await policies.current()).toEqual(initial);
          changeDuringInspection = async () => {
            const current = (await readProjectReadAuthoring(projectRoot))!;
            const selected = current.selected!;
            const candidate = structuredClone(selected.progress.candidate); candidate.budgets.max_top_n = 8;
            await saveBoundaryReviewProgress(projectRoot, createBoundaryReviewProgress({ draft: selected.draft, candidate,
              previous: selected.progress, confirmedDecisions: candidate.unresolved_decisions, revision: selected.progress.revision + 1 }), current.bindings);
          };
          const stale = await post(body);
          expect(stale.status, JSON.stringify(await stale.json())).toBe(409);
          const current = await get();
          expect(current.candidate.budgets.max_top_n).toBe(8);
          expect(current.candidate.pack.resources[0].field_metadata?.quantity?.label).not.toBe("Available stock");
          expect(current.candidate.pack.resources[0].minimum_cohort_size).not.toBe(3);
          const saved = await post({ ...body, authoring_binding: current.authoring_binding });
          const result = await saved.json(); expect(saved.status, JSON.stringify(result)).toBe(200);
          const after = await get();
          expect(result.candidate).toEqual(after.candidate);
          expect(result.candidate_digest).toBe(after.candidate_digest);
          expect(result.authoring_binding).toEqual(after.authoring_binding);
          expect(result.review_progress.revision).toBe(after.review_progress.revision);
          expect(result.source_database_changed).toBe(false);
          expect(result.candidate.budgets.max_top_n).toBe(8);
          if (kind === "field_metadata") expect(result.candidate.pack.resources[0].field_metadata.quantity.label).toBe("Available stock");
          else expect(result.candidate.pack.resources[0].minimum_cohort_size).toBe(3);
          const replay = await post({ ...body, authoring_binding: current.authoring_binding });
          expect(replay.status).toBe(409);
          changeDuringInspection = async () => {
            const current = (await readProjectReadAuthoring(projectRoot))!;
            await switchSavedBoundary({ projectRoot, draft: current.selected!.draft,
              currentCandidate: current.selected!.progress.candidate, currentProgress: current.selected!.progress,
              expectedAuthoring: current.bindings, name: "university_draft" });
          };
          const switched = await post({ ...body, label: "Stock availability", value: 2, authoring_binding: result.authoring_binding });
          const switchedBody = await switched.json();
          expect(switched.status, JSON.stringify(switchedBody)).toBe(409);
          expect(switchedBody.candidate).toBeUndefined();
          const final = await policies.current();
          expect(final.active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(initial.active.filter(({ policy }) => policy.type !== "read_authoring"));
          const retained = (await readProjectReadAuthoring(projectRoot))!;
          expect(retained.selected).toEqual(authoring.entries[1]);
          expect(retained.authoring.entries[0]!.progress.candidate).toEqual(result.candidate);
          await expect(fs.stat(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json")))
            .rejects.toMatchObject({ code: "ENOENT" });
        } finally { await server.close(); }
      });
    });

    it.each(["analyze", "model", "apply", "receipt"])("retains the selected saved Read revision through Workbench workload %s and recovery", async (phase) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        for (const [index, domain] of ["inventory", "university"].entries()) {
          authoring.entries[index]!.catalog = readAuthoringCatalog(fixture(domain).build);
          authoring.entries[index]!.progress.review_overrides = fixture(domain).build.overrides;
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const initial = await policies.current();
        let changeDuringInspection: (() => Promise<void>) | undefined;
        let changeDuringModel: (() => Promise<void>) | undefined;
        let modelCalls = 0;
        const inspect = vi.fn(async () => {
          const change = changeDuringInspection; changeDuringInspection = undefined;
          await change?.(); return fixture().inspection;
        });
        const server = await startLocalUiServer({ projectRoot, boundaryRoot: path.join(projectRoot, "synapsor/generated"),
          configPath: path.join(projectRoot, "synapsor.runner.json"), storePath: path.join(projectRoot, "control.db"),
          token: "workload-review-token", csrfToken: "workload-csrf", schemaInspector: inspect,
          readWorkloadSuggestion: async (input) => {
            modelCalls += 1;
            const change = changeDuringModel; changeDuringModel = undefined; await change?.();
            const workload: ReadWorkloadSet = { schema_version: "synapsor.read-workload-set.v1", name: input.name,
              allowed: [{ id: "count_items", description: "How many stock items are there?", plan: {
                kind: "aggregate", resource: "inventory.items", measures: [{ function: "count" }] } }], forbidden: [],
              source: { kind: "model", provider: input.provider, model: input.model } };
            return { workload, analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: input.generatedBoundary }),
              provider: input.provider, model: input.model, authority_granted: false, source_query_executed: false,
              explore_budget_consumed: false, source_database_changed: false };
          } });
        try {
          const base = `http://${server.host}:${server.port}`;
          const bootstrap = await fetch(server.url, { redirect: "manual" }); expect(bootstrap.status).toBe(303);
          const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!,
            "content-type": "application/json", "x-synapsor-csrf": "workload-csrf" };
          const get = async (route = "") => {
            const response = await fetch(`${base}/api/boundary${route}`, { headers });
            const payload = await response.json(); expect(response.status, JSON.stringify(payload)).toBe(200); return payload;
          };
          const post = (route: string, body: unknown) => fetch(`${base}/api/boundary/workloads/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
          const shown = await get(); const catalog = await get("/workloads");
          expect(catalog.authoring_binding).toEqual(shown.authoring_binding);
          expect(catalog.plan_cards.length).toBeGreaterThan(0);
          const decision = { actor: "reviewer", reason: "Prepare reviewed stock counts." };
          const body = { ...decision, ...(phase === "model" ? { mode: "model", provider: "openai", model: "gpt-5.6-terra",
            egress_acknowledged: true, intent: { name: "stock_counts", allowed_questions: ["How many stock items are there?"], forbidden_questions: [] } }
            : { mode: "cards", selected_card_ids: [catalog.plan_cards[0].id] }) };
          for (const authoring_binding of [undefined, { ...shown.authoring_binding, epoch: 0 }]) {
            const refused = await post("analyze", { ...body, authoring_binding }); expect(refused.status).toBe(409);
          }
          expect(inspect).not.toHaveBeenCalled(); expect(modelCalls).toBe(0);
          const analyze = async (authoring_binding: unknown) => {
            const response = await post("analyze", { ...body, authoring_binding });
            const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200); return result;
          };
          const mapped = await analyze(shown.authoring_binding);
          expect(mapped.authoring_binding).toEqual(shown.authoring_binding);
          expect(await policies.current()).toEqual(initial);
          const applyBody = (mapping: typeof mapped) => ({ ...decision, analysis_id: mapping.workload.analysis_id,
            decision_digest: mapping.preview.decision_digest, confirmation: `APPLY WORKLOAD ${mapping.preview.decision_digest}`,
            authoring_binding: mapping.authoring_binding });
          const change = async () => {
            const current = (await readProjectReadAuthoring(projectRoot))!; const selected = current.selected!;
            const candidate = structuredClone(selected.progress.candidate); candidate.budgets.max_top_n = 8;
            await saveBoundaryReviewProgress(projectRoot, createBoundaryReviewProgress({ draft: selected.draft, candidate,
              previous: selected.progress, confirmedDecisions: candidate.unresolved_decisions, revision: selected.progress.revision + 1 }), current.bindings);
          };
          if (phase === "model") changeDuringModel = change; else changeDuringInspection = change;
          const stale = await post(phase === "apply" ? "apply" : "analyze",
            phase === "apply" ? applyBody(mapped) : { ...body, authoring_binding: shown.authoring_binding });
          const staleBody = await stale.json(); expect(stale.status, JSON.stringify(staleBody)).toBe(409);
          expect(staleBody.preview).toBeUndefined();
          const current = await get(); expect(current.candidate.budgets.max_top_n).toBe(8);
          const renewed = await analyze(current.authoring_binding);
          const invalid = await post("apply", { ...applyBody(renewed), confirmation: "not confirmed" }); expect(invalid.status).toBe(409);
          const receiptFault = phase === "receipt" ? vi.spyOn(readWorkloads, "recordReadWorkloadReview")
            .mockRejectedValueOnce(new Error("write failed: private test diagnostic")) : undefined;
          let result;
          try {
            const applied = await post("apply", applyBody(renewed));
            result = await applied.json(); expect(applied.status, JSON.stringify(result)).toBe(phase === "receipt" ? 503 : 200);
          } finally { receiptFault?.mockRestore(); }
          if (phase === "receipt") {
            expect(result).toMatchObject({ ok: false, draft_saved: true, code: "READ_WORKLOAD_REVIEW_RECORD_UNAVAILABLE" });
            expect(result.error).toContain("disabled Read draft was saved");
            expect(JSON.stringify(result)).not.toContain("private test diagnostic");
          }
          const after = await get();
          expect(result.authoring_binding).toEqual(after.authoring_binding);
          expect(result.candidate_digest).toBe(after.candidate_digest);
          expect(result.review_revision).toBe(after.review_progress.revision);
          expect(result.authority_activated).toBe(false); expect(result.source_database_changed).toBe(false);
          const replay = await post("apply", applyBody(renewed)); expect(replay.status).toBe(409);
          expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(initial.active.filter(({ policy }) => policy.type !== "read_authoring"));
          expect((await readProjectReadAuthoring(projectRoot))!.authoring.entries[1]).toEqual(authoring.entries[1]);
        } finally { await server.close(); }
      });
    });

    it.each(["no-op", "expand", "preparation", "inspection", "refresh"] as const)("keeps the original saved job-mapping review through %s and recovery", async (phase) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const source = fixture(); const inspection = structuredClone(source.inspection);
        const overrides = structuredClone(source.build.overrides);
        if (phase !== "no-op") {
          const bins = structuredClone(inspection.tables[0]!); bins.name = "bins"; inspection.tables.push(bins);
          overrides.resources["inventory.bins"] = structuredClone(overrides.resources["inventory.items"]!);
        }
        const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "inventory", overrides,
          project: { root: projectRoot, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
        const draft = build.exploration_boundary; draft.pack.name = "inventory_draft";
        const candidate = recommendedBoundaryReviewCandidate(draft);
        candidate.pack.resources = candidate.pack.resources.filter((resource) => resource.id === "inventory.items");
        const reviewed = autoBoundary.reviewExplorationBoundaryCandidate(draft, candidate).candidate;
        const authoring = readAuthoringFixture();
        authoring.entries[0] = { draft, draft_lock: build.lock, candidate_lock: build.lock, catalog: readAuthoringCatalog(build),
          progress: createBoundaryReviewProgress({ draft, candidate: reviewed, confirmedDecisions: reviewed.unresolved_decisions,
            actor: "reviewer", revision: 1, reviewOverrides: build.overrides }) };
        authoring.entries[1]!.catalog = readAuthoringCatalog(fixture("university").build);
        authoring.selected_boundary_id = authoring.entries[0]!.progress.boundary_id;
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const initial = await policies.current();
        const edit = async (limit: number) => {
          const current = (await readProjectReadAuthoring(projectRoot))!; const entry = current.selected!;
          const next = structuredClone(entry.progress.candidate); next.budgets.max_top_n = limit;
          await saveBoundaryReviewProgress(projectRoot, createBoundaryReviewProgress({ draft: entry.draft, candidate: next,
            previous: entry.progress, confirmedDecisions: next.unresolved_decisions, revision: entry.progress.revision + 1 }), current.bindings);
        };
        let duringInspection = false; let inspections = 0; let duringRefresh = false;
        let duringPreparation = false;
        const originalRead = boundaryMutations.loadBoundaryResourceReviewCatalog;
        const readSnapshot = vi.spyOn(boundaryMutations, "loadBoundaryResourceReviewCatalog").mockImplementation(async (root) => {
          const snapshot = await originalRead(root);
          if (duringPreparation) { duringPreparation = false; await edit(7); }
          return snapshot;
        });
        const originalLoad = mappingCatalog.loadJobMappingCatalog;
        const refresh = vi.spyOn(mappingCatalog, "loadJobMappingCatalog").mockImplementation(async (root) => {
          if (duringRefresh) { duringRefresh = false; await edit(6); }
          return originalLoad(root);
        });
        const server = await startLocalUiServer({ projectRoot, boundaryRoot: path.join(projectRoot, "synapsor/generated"),
          configPath: path.join(projectRoot, "synapsor.runner.json"), storePath: path.join(projectRoot, "control.db"),
          token: "mapping-token", csrfToken: "mapping-csrf", schemaInspector: async () => {
            inspections++; if (duringInspection) { duringInspection = false; await edit(7); } return inspection;
          } });
        try {
          const base = `http://${server.host}:${server.port}`;
          const bootstrap = await fetch(server.url, { redirect: "manual" }); expect(bootstrap.status).toBe(303);
          const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!,
            "content-type": "application/json", "x-synapsor-csrf": "mapping-csrf" };
          const get = async () => {
            const response = await fetch(`${base}/api/boundary/delegations`, { headers }); const payload = await response.json();
            expect(response.status, JSON.stringify(payload)).toBe(200); return payload;
          };
          const post = (shown: Awaited<ReturnType<typeof get>>, token: unknown = shown.authoring_binding) => fetch(`${base}/api/boundary/delegations/catalog`, {
            method: "POST", headers, body: JSON.stringify({ expected_plan_digest: shown.mapping_catalog.plan_digest,
              accepted_shared_resources: [], actor: "reviewer", authoring_binding: token }) });
          const shown = await get(); expect(shown.mapping_catalog.authoring_binding).toEqual(shown.authoring_binding);
          expect((await post(shown, null)).status).toBe(409);
          await expect(mappingCatalog.applyJobMappingCatalog({ projectRoot, expectedPlanDigest: shown.mapping_catalog.plan_digest,
            actor: "reviewer", reason: "Prepare the job." })).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
          expect(await policies.current()).toEqual(initial);
          await edit(9);
          const changed = await get(); expect(changed.mapping_catalog.plan_digest).toBe(shown.mapping_catalog.plan_digest);
          expect((await post(shown)).status).toBe(409); expect(inspections).toBe(0);
          if (phase === "inspection" || phase === "preparation") {
            duringInspection = phase === "inspection";
            duringPreparation = phase === "preparation";
            const raced = await post(changed); const result = await raced.json(); expect(raced.status, JSON.stringify(result)).toBe(409);
            expect((await readProjectReadAuthoring(projectRoot))!.selected!.progress.candidate.budgets.max_top_n).toBe(7);
            if (phase === "preparation") expect(inspections).toBe(0);
          }
          const reloaded = await get();
          if (phase === "refresh") duringRefresh = true;
          const saved = await post(reloaded); const result = await saved.json();
          expect(saved.status, JSON.stringify(result)).toBe(phase === "refresh" ? 503 : 200);
          const after = (await readProjectReadAuthoring(projectRoot))!;
          if (phase === "refresh") {
            expect(result).toMatchObject({ draft_saved: true, code: "JOB_MAPPING_REVIEW_REFRESH_REQUIRED" });
            expect(result.authoring_binding).not.toEqual(after.bindings);
            expect(after.selected!.progress.candidate.budgets.max_top_n).toBe(6);
          } else expect(result.authoring_binding).toEqual(after.bindings);
          expect(result.applied.changed).toBe(phase !== "no-op");
          expect(result.applied.candidate.pack.resources).toHaveLength(phase === "no-op" ? 1 : 2);
          expect(result.applied.candidate.budgets.max_top_n).toBe(phase === "inspection" || phase === "preparation" ? 7 : 9);
          expect(result.applied.authority_activated).toBe(false); expect(result.applied.source_database_changed).toBe(false);
          const fresh = await get(); const retry = await post(fresh); expect(retry.status).toBe(200);
          expect((await retry.json()).applied.changed).toBe(false);
          expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(initial.active.filter(({ policy }) => policy.type !== "read_authoring"));
          expect(after.authoring.entries[1]).toEqual(authoring.entries[1]);
          await expect(fs.stat(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json")))
            .rejects.toMatchObject({ code: "ENOENT" });
        } finally { await server.close(); refresh.mockRestore(); readSnapshot.mockRestore(); }
      });
    });

    it.each(["current", "stale", "before_save", "after_save", "selection", "unrelated", "action_mismatch", "analysis_mismatch"] as const)(
      "binds the saved Workbench job artifact to its exact Read dependency during %s", async (phase) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        for (const [index, domain] of ["inventory", "university"].entries()) {
          authoring.entries[index]!.catalog = readAuthoringCatalog(fixture(domain).build);
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const initial = await policies.current();
        const selected = (await readProjectReadAuthoring(projectRoot))!.selected!;
        const candidate = selected.progress.candidate;
        const workload: ReadWorkloadSet = { schema_version: "synapsor.read-workload-set.v1", name: "stock_counts",
          allowed: [{ id: "count_items", description: "How many stock items are there?", plan: {
            kind: "aggregate", resource: "inventory.items", measures: [{ function: "count" }] } }], forbidden: [],
          source: { kind: "operator_exact_plan" } };
        const mapped = await readWorkloads.storeReadWorkloadAnalysis({ projectRoot, generatedBoundary: candidate,
          source: workload.source, analysis: analyzeReadWorkloadSet({ workload, generatedBoundary: candidate }) });
        const review = await readWorkloads.recordReadWorkloadReview({ projectRoot, workload: mapped,
          candidateDigest: selected.progress.candidate_digest, reviewRevision: selected.progress.revision });
        if (phase === "analysis_mismatch") {
          await fs.writeFile(path.join(projectRoot, ".synapsor/read-workloads", `${mapped.analysis_id}.review.json`),
            JSON.stringify({ ...review, analyzed_candidate_digest: canonicalJsonDigest("different analyzed candidate") }));
        }
        const change = async (other = false) => {
          const current = (await readProjectReadAuthoring(projectRoot))!;
          const entry = other ? current.authoring.entries[1]! : current.selected!;
          const next = structuredClone(entry.progress.candidate); next.budgets.max_top_n = 8;
          entry.progress = createBoundaryReviewProgress({ draft: entry.draft, candidate: next, previous: entry.progress,
            confirmedDecisions: next.unresolved_decisions, revision: entry.progress.revision + 1 });
          await saveProjectReadAuthoring({ projectRoot, expected: current.bindings, authoring: current.authoring,
            actor: "operator", operation: "edit_disabled_review" });
        };
        if (phase === "stale") await change();
        const originalStatus = guidedActions.guidedActionStatus;
        const status = vi.spyOn(guidedActions, "guidedActionStatus").mockImplementationOnce(async (root) => {
          const result = await originalStatus(root);
          if (phase === "before_save" || phase === "unrelated") await change(phase === "unrelated");
          if (phase === "selection") {
            const current = (await readProjectReadAuthoring(projectRoot))!;
            await switchSavedBoundary({ projectRoot, draft: current.selected!.draft,
              currentCandidate: current.selected!.progress.candidate, currentProgress: current.selected!.progress,
              expectedAuthoring: current.bindings, name: "university_draft" });
          }
          if (phase === "action_mismatch") result.drafts = [{ capability: "inventory.adjust", boundary_name: candidate.pack.name,
            boundary_digest: canonicalJsonDigest("a previous Read revision"), contract_digest: canonicalJsonDigest("reviewed action") } as never];
          return result;
        });
        const originalSave = delegationSetup.writeDelegationDraft;
        const save = vi.spyOn(delegationSetup, "writeDelegationDraft").mockImplementationOnce(async (root, draft) => {
          const result = await originalSave(root, draft);
          if (phase === "after_save") await change();
          return result;
        });
        const server = await startLocalUiServer({ projectRoot, boundaryRoot: path.join(projectRoot, "synapsor/generated"),
          configPath: path.join(projectRoot, "synapsor.runner.json"), storePath: path.join(projectRoot, "control.db"),
          token: "job-artifact-token", csrfToken: "job-artifact-csrf" });
        try {
          const bootstrap = await fetch(server.url, { redirect: "manual" }); expect(bootstrap.status).toBe(303);
          const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!,
            "content-type": "application/json", "x-synapsor-csrf": "job-artifact-csrf" };
          const response = await fetch(`http://${server.host}:${server.port}/api/boundary/delegations/record`, {
            method: "POST", headers, body: JSON.stringify({ job_intent: "Count my stock items.", analysis_id: mapped.analysis_id,
              action_intents: phase === "action_mismatch" ? ["Adjust stock."] : [],
              actions: phase === "action_mismatch" ? [{ intent: "Adjust stock.", capability: "inventory.adjust",
                contract_digest: canonicalJsonDigest("reviewed action") }] : [] }) });
          const result = await response.json();
          const success = phase === "current" || phase === "unrelated";
          expect(response.status, JSON.stringify(result)).toBe(success ? 200 : phase === "after_save" ? 503 : 409);
          expect(result.source_database_changed).toBe(false);
          const saved = success || phase === "after_save";
          expect(save.mock.calls.length).toBe(saved ? 1 : 0);
          const records = await delegationSetup.listDelegationDrafts(projectRoot);
          expect(records).toHaveLength(saved ? 1 : 0);
          if (saved) {
            expect(result.delegation.read.candidate_digest).toBe(selected.progress.candidate_digest);
            expect(result.review_current).toBe(success);
            expect(result.delegation.state).toBe("disabled");
            expect(result.authority_granted).toBe(false);
          }
          if (phase === "after_save") expect(result).toMatchObject({ draft_saved: true, code: "DELEGATION_REVIEW_REFRESH_REQUIRED" });
          if (phase === "unrelated") expect((await policies.current()).epoch).toBeGreaterThan(initial.epoch);
          expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(initial.active.filter(({ policy }) => policy.type !== "read_authoring"));
          await expect(fs.stat(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json")))
            .rejects.toMatchObject({ code: "ENOENT" });
        } finally { await server.close(); status.mockRestore(); save.mockRestore(); }
      });
    });

    it.each(["same", "separate"] as const)("stages a proven relationship only on the original saved active review with %s policy locks without overwriting pending work", async (locks) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const source = fixture(); const inspection = structuredClone(source.inspection);
        const items = inspection.tables[0]!; const bins = structuredClone(items); bins.name = "bins";
        bins.unique_constraints = [{ name: "bins_pkey", columns: ["id"] }];
        items.columns.push({ ...structuredClone(items.columns[0]!), name: "bin_id", ordinal_position: items.columns.length });
        items.foreign_keys = [{ name: "items_bin_id_fkey", columns: ["bin_id"], referenced_schema: "inventory",
          referenced_table: "bins", referenced_columns: ["id"], delete_rule: "RESTRICT" }];
        inspection.tables.push(bins);
        const overrides = structuredClone(source.build.overrides);
        overrides.resources["inventory.bins"] = structuredClone(overrides.resources["inventory.items"]!);
        const buildInput = { inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "inventory", overrides,
          project: { root: projectRoot, package_manager: "npm" as const, frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } };
        const build = buildAutoBoundary(buildInput);
        const draft = build.exploration_boundary; draft.pack.name = "inventory_draft";
        const candidateBuild = locks === "same" ? build : buildAutoBoundary({ ...buildInput,
          overrides: applyManagedBoundaryReviewDecision(overrides, { kind: "field_metadata", resource_id: "inventory.items", field: "quantity",
            label: "Available quantity", actor: "reviewer", reason: "Clarify the saved stock policy.", decided_at: "2026-09-06T00:00:00.000Z" }) });
        const candidateDraft = candidateBuild.exploration_boundary; candidateDraft.pack.name = draft.pack.name;
        if (locks === "separate") expect(candidateDraft.generation_lock_fingerprint).not.toBe(draft.generation_lock_fingerprint);
        const proposed = recommendedBoundaryReviewCandidate(candidateDraft);
        const relation = proposed.pack.resources.find((resource) => resource.id === "inventory.items")!.relationships[0]!;
        expect(relation.id).toBe("items_bin_id_fkey");
        proposed.pack.resources.find((resource) => resource.id === "inventory.items")!.relationships = [];
        const candidate = autoBoundary.reviewExplorationBoundaryCandidate(candidateDraft, proposed).candidate;
        const authoring = readAuthoringFixture();
        authoring.entries[0] = { draft, draft_lock: build.lock, candidate_lock: candidateBuild.lock, catalog: readAuthoringCatalog(build),
          progress: createBoundaryReviewProgress({ draft, candidate, confirmedDecisions: candidate.unresolved_decisions,
            actor: "reviewer", revision: 1, reviewOverrides: candidateBuild.overrides }) };
        authoring.entries[1]!.catalog = readAuthoringCatalog(fixture("university").build);
        authoring.selected_boundary_id = authoring.entries[0]!.progress.boundary_id;
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const digest = explorationBoundaryCandidateDigest(candidate);
        const active = await activateExplorationBoundary({ projectRoot, candidate, reviewDraft: candidateDraft, generationLock: candidateBuild.lock,
          currentInspection: inspection, expectedDigest: digest, confirmation: `ACTIVATE ${digest}`, actor: "operator",
          confirmedDecisions: candidate.unresolved_decisions, expectedAuthoring: (await readProjectReadAuthoring(projectRoot))!.bindings });
        const initial = await policies.current();
        let changeDuringLoad: (() => Promise<unknown>) | undefined;
        const loadActive = autoBoundary.loadActivatedExplorationBoundary;
        const activeLoad = vi.spyOn(autoBoundary, "loadActivatedExplorationBoundary").mockImplementation(async (...args) => {
          const result = await loadActive(...args);
          const change = changeDuringLoad; changeDuringLoad = undefined; await change?.(); return result;
        });
        const server = await startLocalUiServer({ projectRoot, boundaryRoot: path.join(projectRoot, "synapsor/generated"),
          configPath: path.join(projectRoot, "synapsor.runner.json"), storePath: path.join(projectRoot, "control.db"),
          token: "relationship-token", csrfToken: "relationship-csrf", schemaInspector: async () => inspection });
        try {
          const base = `http://${server.host}:${server.port}`;
          const bootstrap = await fetch(server.url, { redirect: "manual" }); expect(bootstrap.status).toBe(303);
          const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!,
            "content-type": "application/json", "x-synapsor-csrf": "relationship-csrf" };
          const get = async () => {
            const response = await fetch(`${base}/api/boundary`, { headers }); const payload = await response.json();
            expect(response.status, JSON.stringify(payload)).toBe(200); return payload;
          };
          const body = { resource: "inventory.items", relationship: relation.id, active_boundary_digest: active.activation.digest,
            actor: "reviewer", confirmation: `REVIEW RELATIONSHIP ${relation.proof!.digest}` };
          const post = (authoring_binding: unknown, extra = {}) => fetch(`${base}/api/boundary/review-relationship`, {
            method: "POST", headers, body: JSON.stringify({ ...body, authoring_binding, ...extra }) });
          const shown = await get();
          expect((await post(undefined)).status).toBe(409);
          expect((await post(shown.authoring_binding, { confirmation: "not confirmed" })).status).toBe(409);
          expect(await policies.current()).toEqual(initial);
          const saveCandidate = async (replacement: typeof candidate) => {
            const current = (await readProjectReadAuthoring(projectRoot))!; const selected = current.selected!;
            return saveBoundaryReviewProgress(projectRoot, createBoundaryReviewProgress({ draft: selected.draft, candidate: replacement,
              previous: selected.progress, confirmedDecisions: replacement.unresolved_decisions, revision: selected.progress.revision + 1 }), current.bindings);
          };
          const edited = structuredClone(candidate); edited.budgets.max_top_n = 8;
          changeDuringLoad = () => saveCandidate(edited);
          expect((await post(shown.authoring_binding)).status).toBe(409);
          const pending = await get(); expect(pending.candidate.budgets.max_top_n).toBe(8);
          const refusedPending = await post(pending.authoring_binding);
          const refusal = await refusedPending.json(); expect(refusedPending.status, JSON.stringify(refusal)).toBe(409);
          expect(refusal.error).toContain("pending edits");
          expect((await get()).candidate).toEqual(pending.candidate);
          await saveCandidate(candidate);
          const switchTo = async (name: string) => {
            const current = (await readProjectReadAuthoring(projectRoot))!; const selected = current.selected!;
            return switchSavedBoundary({ projectRoot, draft: selected.draft, currentCandidate: selected.progress.candidate,
              currentProgress: selected.progress, expectedAuthoring: current.bindings, name });
          };
          const beforeSwitch = await get();
          changeDuringLoad = () => switchTo("university_draft");
          const switched = await post(beforeSwitch.authoring_binding); const switchResult = await switched.json();
          expect(switched.status, JSON.stringify(switchResult)).toBe(409);
          expect((await get()).candidate.pack.name).toBe("university_draft");
          await switchTo("inventory_draft");
          const reloaded = await get();
          const saved = await post(reloaded.authoring_binding); const result = await saved.json();
          expect(saved.status, JSON.stringify(result)).toBe(200);
          const after = await get(); expect(result.authoring_binding).toEqual(after.authoring_binding);
          expect(result.candidate_digest).toBe(after.candidate_digest);
          expect(result.candidate.pack.resources.find((resource: { id: string }) => resource.id === "inventory.items").relationships).toEqual([relation]);
          expect(result.source_database_changed).toBe(false);
          expect((await post(reloaded.authoring_binding)).status).toBe(409);
          expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(initial.active.filter(({ policy }) => policy.type !== "read_authoring"));
          expect((await readProjectReadAuthoring(projectRoot))!.authoring.entries[1]).toEqual(authoring.entries[1]);
          await expect(fs.stat(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json")))
            .rejects.toMatchObject({ code: "ENOENT" });
        } finally { await server.close(); activeLoad.mockRestore(); }
      });
    });

    it("binds saved Read activation to the exact original selection, candidate and repository epoch", async () => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const shown = (await readProjectReadAuthoring(projectRoot))!;
        const entry = shown.selected!;
        const activation = (candidate = entry.progress.candidate) => ({ projectRoot, candidate,
          reviewDraft: entry.draft, generationLock: entry.candidate_lock,
          expectedDigest: explorationBoundaryCandidateDigest(candidate), actor: "reviewer",
          confirmation: `ACTIVATE ${explorationBoundaryCandidateDigest(candidate)}`,
          confirmedDecisions: candidate.unresolved_decisions, currentInspection: fixture().inspection });
        const before = await policies.current();
        await expect(activateExplorationBoundary(activation())).rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        const forged = structuredClone(entry.progress.candidate); forged.budgets.max_top_n = 7;
        await expect(activateExplorationBoundary({ ...activation(forged), expectedAuthoring: shown.bindings }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        expect(await policies.current()).toEqual(before);
        const progress = createBoundaryReviewProgress({ draft: entry.draft, candidate: forged,
          previous: entry.progress, confirmedDecisions: forged.unresolved_decisions, revision: entry.progress.revision + 1 });
        const next = await saveBoundaryReviewProgress(projectRoot, progress, shown.bindings);
        await expect(activateExplorationBoundary({ ...activation(), expectedAuthoring: shown.bindings }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        const active = await activateExplorationBoundary({ ...activation(forged), expectedAuthoring: next });
        expect(active.activation.digest).toBe(explorationBoundaryCandidateDigest(forged));
        await expect(activateExplorationBoundary({ ...activation(forged), expectedAuthoring: next }))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        expect((await readProjectReadAuthoring(projectRoot))!.selected!.progress).toEqual(progress);
      });
    });

    it("refuses stale CLI consent and keeps the revised draft available for a new confirmation", async () => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        for (const [index, domain] of ["inventory", "university"].entries()) {
          authoring.entries[index]!.catalog = readAuthoringCatalog(fixture(domain).build);
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const original = await policies.current();
        const args = ["--project-root", projectRoot, "--actor", "reviewer"];
        const session = { presentationMode: "conversation" as const, chooseResource: async () => undefined,
          editFieldTiers: async () => undefined, promptText: async () => "reviewer", present: () => undefined,
          confirm: async () => {
            const shown = (await readProjectReadAuthoring(projectRoot))!; const entry = shown.selected!;
            const candidate = structuredClone(entry.progress.candidate); candidate.budgets.max_top_n = 11;
            await saveBoundaryReviewProgress(projectRoot, createBoundaryReviewProgress({ draft: entry.draft, candidate,
              previous: entry.progress, confirmedDecisions: candidate.unresolved_decisions, revision: entry.progress.revision + 1 }), shown.bindings);
            return true;
          } };
        await expect(boundaryActivateCommand(args, async () => fixture().inspection, session))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring"))
          .toEqual(original.active.filter(({ policy }) => policy.type !== "read_authoring"));
        await expect(boundaryActivateCommand(args, async () => fixture().inspection, { ...session, confirm: async () => true })).resolves.toBe(0);
        expect((await loadActivatedExplorationBoundary(projectRoot)).budgets.max_top_n).toBe(11);
      });
    });

    it.each(["complete", "commit_failure", "lost_response", "unknown_commit", "wrong_store", "explicit_wrong_store", "nested_wrong_store", "concurrent", "expired_after_review"])(
      "commits governed headless Read consent in the actual policy store: %s", async (mode) => {
      await useRepository(async ({ policies, projectRoot, binding, config: storageConfig }) => {
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring: readAuthoringFixture(), actor: "operator", operation: "prepare" });
        const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const privatePath = path.join(projectRoot, "operator.private.pem");
        await fs.writeFile(path.join(projectRoot, "operator.pub.pem"), publicKey.export({ type: "spki", format: "pem" }).toString());
        await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
        const configPath = path.join(projectRoot, "synapsor.runner.json");
        const config = { version: 1, mode: "read_only", capabilities: [], trusted_context: { provider: "environment" },
          sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true } },
          generated_authority: { generation_lock_path: "./.synapsor/generation-lock.json", enforcement: "required" },
          operator_identity: { provider: "signed_key", operators: { alice: { public_key_path: "./operator.pub.pem", roles: ["boundary_reviewer"] } } },
          storage: mode === "wrong_store" ? { sqlite_path: "./shadow.db" } : storageConfig.storage ?? { sqlite_path: "./control.db" },
        };
        await fs.writeFile(configPath, JSON.stringify(config));
        const selectedConfigPath = mode === "nested_wrong_store" ? path.join(projectRoot, "configs/alternate.json")
          : mode === "explicit_wrong_store" ? path.join(projectRoot, "alternate.json") : configPath;
        if (mode === "explicit_wrong_store") await fs.writeFile(selectedConfigPath, JSON.stringify({ ...config, storage: { sqlite_path: "./shadow.db" } }));
        if (mode === "nested_wrong_store") {
          await fs.mkdir(path.dirname(selectedConfigPath));
          await fs.writeFile(selectedConfigPath, JSON.stringify({ ...config, storage: { sqlite_path: "../shadow.db" },
            operator_identity: { provider: "signed_key", operators: { alice: { public_key_path: "../operator.pub.pem", roles: ["boundary_reviewer"] } } },
          }));
        }
        const bundlePath = path.join(projectRoot, "review.json");
        const refreshBundle = async () => {
          const context = await loadBoundaryReviewContext(projectRoot);
          await fs.writeFile(bundlePath, JSON.stringify(context.bundle));
          return context;
        };
        const shown = await refreshBundle();
        const args = ["--project-root", projectRoot, "--config", selectedConfigPath, "--review-bundle", bundlePath,
          "--headless", "--confirm", `ACTIVATE ${shown.bundle.candidate_digest}`, "--identity", "alice",
          "--identity-key", privatePath, "--required-role", "boundary_reviewer", "--reason", "Reviewed exact inventory Read scope",
          "--nonce", "shared-headless-read-nonce-0001", "--expires-at", new Date(Date.now() + 300_000).toISOString(), "--json"];
        const before = await policies.current();
        let activationEvent: Parameters<ControlPolicyRepository["commit"]>[0]["event"] | undefined;
        const commit = ControlPolicyRepository.prototype.commit;
        const fault = vi.spyOn(ControlPolicyRepository.prototype, "commit").mockImplementation(async function (this: ControlPolicyRepository, input) {
          if ((input.event.receipt as { operation?: string }).operation !== "activate_read") return commit.call(this, input);
          activationEvent = structuredClone(input.event);
          if (mode === "commit_failure") throw new Error("test publication refused before commit");
          const result = await commit.call(this, input);
          if (mode === "lost_response" || mode === "unknown_commit") throw new Error("test connection lost after commit");
          return result;
        });
        const readEvent = ControlPolicyRepository.prototype.event;
        const eventFault = vi.spyOn(ControlPolicyRepository.prototype, "event").mockImplementation(async function (this: ControlPolicyRepository, ...args) {
          if (mode === "unknown_commit" && activationEvent) throw new Error("test receipt lookup unavailable");
          return readEvent.apply(this, args);
        });
        const activate = autoBoundary.activateExplorationBoundary;
        const expired = vi.spyOn(autoBoundary, "activateExplorationBoundary").mockImplementation(async (input) => activate({ ...input,
          ...(mode === "expired_after_review" && input.verifiedDecision ? { verifiedDecision: { ...input.verifiedDecision,
            expires_at: new Date(Date.now() - 1000).toISOString() } } : {}),
        }));
        const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
        try {
          const run = () => boundaryActivateCommand(args, async () => fixture().inspection);
          const running = mode === "concurrent" ? Promise.allSettled([run(), run()]) : run();
          if (mode.endsWith("wrong_store")) {
            await expect(running).rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
            expect(await policies.current()).toEqual(before);
          } else if (mode === "commit_failure" || mode === "expired_after_review") {
            if (mode === "commit_failure") await expect(running).rejects.toThrow("test publication refused before commit");
            else await expect(running).rejects.toMatchObject({ code: "POLICY_ACTIVATION_DECISION_INVALID" });
            if (activationEvent) expect(await binding.repository.event(binding.deployment_id, activationEvent.event_id)).toBeUndefined();
            expect((await policies.current()).active.filter(({ policy }) => policy.type !== "read_authoring"))
              .toEqual(before.active.filter(({ policy }) => policy.type !== "read_authoring"));
          } else {
            if (mode === "unknown_commit") await expect(running).rejects.toMatchObject({ code: "POLICY_ACTIVATION_COMMIT_UNCONFIRMED" });
            else if (mode === "concurrent") {
              const results = await running as PromiseSettledResult<number>[];
              expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
              expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
            } else await expect(running).resolves.toBe(0);
            eventFault.mockRestore();
            const recorded = await binding.repository.event(binding.deployment_id, activationEvent!.event_id);
            expect(recorded).toMatchObject(activationEvent!);
            expect(recorded!.receipt).toMatchObject({ operation: "activate_read", verified_decision: {
              subject: "alice", provider: "signed_key", purpose: "activate_read", boundary_digest: shown.bundle.candidate_digest,
              repository_id: binding.repository_id, deployment_id: binding.deployment_id, project_id: binding.project_id,
            } });
            expect((await loadActivatedExplorationBoundary(projectRoot)).activation.digest).toBe(shown.bundle.candidate_digest);
          }
          fault.mockRestore(); eventFault.mockRestore(); expired.mockRestore();
          if (!mode.endsWith("wrong_store")) {
            await refreshBundle();
            const after = await policies.current();
            // The next proof has a new issuance time and bundle, but its nonce
            // still cannot authorize a second activation after success.
            if (mode === "commit_failure" || mode === "expired_after_review") await expect(boundaryActivateCommand(args, async () => fixture().inspection)).resolves.toBe(0);
            else {
              await expect(boundaryActivateCommand(args, async () => fixture().inspection))
                .rejects.toMatchObject({ code: "POLICY_EVENT_ALREADY_RECORDED" });
              expect(await policies.current()).toEqual(after);
            }
          }
          await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.stat(path.join(projectRoot, "shadow.db"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally { fault.mockRestore(); eventFault.mockRestore(); expired.mockRestore(); output.mockRestore(); }
      });
    });

    it.each(["single", "batch", "coded"].flatMap((method) => (method === "coded" ? ["complete", "commit_failure"] : ["complete", "commit_failure", "lost_response", "unknown_commit",
      "wrong_store", "nested_wrong_store", "concurrent", "expired_after_review", "tampered_candidate", "tampered_contract"])
      .flatMap((mode) => (method !== "coded" && ["complete", "commit_failure", "lost_response", "unknown_commit"].includes(mode)
        ? ["signed_key", "jwt_oidc"] : ["signed_key"]).map((provider) => ({ method, mode, provider })))))
      ("atomically records signed Read edits in the configured repository: $method $mode $provider", async ({ method, mode, provider }) => {
      await useRepository(async ({ policies, projectRoot, binding, config: storageConfig }) => {
        const coded = method === "coded" ? metadataAuthoringFixture(projectRoot) : undefined;
        const authoring = coded?.authoring ?? readAuthoringFixture();
        const inspection = coded?.inspection ?? fixture().inspection;
        if (coded) authoring.entries.push(readAuthoringFixture().entries[1]!);
        for (const [index, domain] of (coded ? [] : ["inventory", "university"]).entries()) {
          const entry = authoring.entries[index]!;
          const build = fixture(domain).build;
          entry.catalog = readAuthoringCatalog(build);
          entry.progress = createBoundaryReviewProgress({ draft: entry.draft, candidate: entry.progress.candidate,
            previous: entry.progress, reviewOverrides: build.overrides,
            confirmedDecisions: entry.progress.candidate.unresolved_decisions, actor: "operator", revision: 1 });
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
        const privatePath = path.join(projectRoot, "operator.private.pem");
        const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
        await fs.writeFile(path.join(projectRoot, "operator.pub.pem"), publicPem);
        await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
        const configPath = path.join(projectRoot, "synapsor.runner.json");
        const tokenEnv = `TEST_READ_EDIT_TOKEN_${randomUUID().replaceAll("-", "").toUpperCase()}`;
        const secretEnv = `TEST_READ_EDIT_ATTESTATION_${randomUUID().replaceAll("-", "").toUpperCase()}`;
        const attestation = "test-only-read-edit-attestation-secret-at-least-32-bytes";
        const token = provider === "jwt_oidc" ? await new SignJWT({ roles: ["boundary_reviewer"] })
          .setProtectedHeader({ alg: "RS256", kid: "read-edit-test-key" }).setSubject("alice")
          .setIssuer("https://operator.test").setAudience("synapsor-test").setExpirationTime("5m").sign(privateKey) : undefined;
        if (token) { process.env[tokenEnv] = token; process.env[secretEnv] = attestation; }
        const config = { version: 1, mode: "read_only", capabilities: [],
          trusted_context: { provider: "environment", tenant_binding: "tenant_id" },
          sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true } },
          generated_authority: { generation_lock_path: "./.synapsor/generation-lock.json", enforcement: "required" },
          operator_identity: provider === "jwt_oidc" ? { provider, token_env: tokenEnv, attestation_secret_env: secretEnv,
            algorithms: ["RS256"], public_key_path: "./operator.pub.pem", issuer: "https://operator.test", audience: "synapsor-test" }
            : { provider: "signed_key", operators: { alice: { public_key_path: "./operator.pub.pem", roles: ["boundary_reviewer"] } } },
          storage: storageConfig.storage ?? { sqlite_path: "./control.db" },
        };
        await fs.writeFile(configPath, JSON.stringify(config));
        const selectedConfigPath = mode === "nested_wrong_store" ? path.join(projectRoot, "configs/alternate.json")
          : mode === "wrong_store" ? path.join(projectRoot, "alternate.json") : configPath;
        if (mode.endsWith("wrong_store")) {
          await fs.mkdir(path.dirname(selectedConfigPath), { recursive: true });
          await fs.writeFile(selectedConfigPath, JSON.stringify({ ...config,
            storage: { sqlite_path: mode === "nested_wrong_store" ? "../shadow.db" : "./shadow.db" },
            operator_identity: { provider: "signed_key", operators: { alice: {
              public_key_path: mode === "nested_wrong_store" ? "../operator.pub.pem" : "./operator.pub.pem", roles: ["boundary_reviewer"] } } },
          }));
        }
        const reason = coded ? "k01 identifies one record; customer isolation is still unresolved."
          : "Keep the inventory quantity private without changing the active service.";
        let output = "";
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
        const before = await policies.current();
        let publication: Parameters<ControlPolicyRepository["commit"]>[0] | undefined;
        const commit = ControlPolicyRepository.prototype.commit;
        const recording = vi.spyOn(ControlPolicyRepository.prototype, "commit").mockImplementation(async function (this: ControlPolicyRepository, input) {
          if ((input.event.receipt as { operation?: string }).operation !== "edit_prepared_read") return commit.call(this, input);
          publication = structuredClone(input);
          if (mode === "commit_failure") throw new Error("test edit commit refused");
          const result = await commit.call(this, input);
          if (mode === "lost_response" || mode === "unknown_commit") throw new Error("test edit response lost after commit");
          return result;
        });
        const event = ControlPolicyRepository.prototype.event;
        const lookup = vi.spyOn(ControlPolicyRepository.prototype, "event").mockImplementation(async function (this: ControlPolicyRepository, ...args) {
          if (publication && mode === "unknown_commit") throw new Error("test edit receipt unavailable");
          return event.apply(this, args);
        });
        const revise = boundaryMutations.commitBoundaryResourceReviewMutation;
        const reviseBatch = boundaryMutations.commitBoundaryReviewMutationBatch;
        const tamper = <T extends Parameters<typeof revise>[1] | Parameters<typeof reviseBatch>[1]>(preview: T) => {
          const changed = structuredClone(preview);
          if (mode === "tampered_candidate") changed.candidate.budgets.max_top_n = 9;
          if (mode === "tampered_contract") changed.build.lock.generated_contract_digest = canonicalJsonDigest("different contract");
          return changed;
        };
        const expire = (decision: Parameters<typeof revise>[2]) => decision && mode === "expired_after_review"
          ? { ...decision, expires_at: new Date(Date.now() - 1000).toISOString() } : decision;
        const mutation = vi.spyOn(boundaryMutations, "commitBoundaryResourceReviewMutation")
          .mockImplementation((root, preview, decision) => revise(root, tamper(preview), expire(decision)));
        const batchMutation = vi.spyOn(boundaryMutations, "commitBoundaryReviewMutationBatch")
          .mockImplementation((root, preview, decision) => reviseBatch(root, tamper(preview), expire(decision)));
        try {
          const prepare = async () => {
            const common = ["--project-root", projectRoot, "--json"];
            let args: string[];
            if (method === "batch") {
              const context = await loadBoundaryReviewContext(projectRoot);
              const file = path.join(projectRoot, "decisions.json");
              await fs.writeFile(file, JSON.stringify({ schema_version: "synapsor.boundary-review-decisions.v1",
                review_bundle_digest: context.bundle.bundle_digest, bindings: context.bundle.mutation_bindings,
                actor: "alice", reason, resources: [{ resource_id: "inventory.items", withhold_from_model_fields: ["quantity"] }] }));
              args = [...common, "--apply-decisions", file];
            } else args = ["resource", coded ? "coded.x17" : "inventory.items", ...common,
              ...(coded ? ["--include", "--row-identity", "k01"] : ["--withhold-from-model", "quantity"]), "--actor", "alice", "--reason", reason];
            output = "";
            await boundaryReviewCommand(args, async () => inspection);
            const preview = JSON.parse(output);
            return { preview, args: [...args, "--apply", "--confirm", `APPLY REVIEW ${preview.decision_digest}`,
              "--config", selectedConfigPath, "--identity", "alice", "--identity-key", privatePath, "--required-role", "boundary_reviewer",
              "--nonce", "stable-read-edit-nonce-0001"] };
          };
          const request = await prepare();
          const run = () => boundaryReviewCommand(request.args, async () => inspection);
          const running = mode === "concurrent" ? Promise.allSettled([run(), run()]) : run();
          const refused = mode.endsWith("wrong_store") || ["commit_failure", "expired_after_review", "tampered_candidate", "tampered_contract"].includes(mode);
          if (refused) {
            if (mode.endsWith("wrong_store")) await expect(running).rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
            else if (mode === "commit_failure") await expect(running).rejects.toThrow("test edit commit refused");
            else await expect(running).rejects.toMatchObject({ code: "POLICY_READ_EDIT_DECISION_INVALID" });
            expect(await policies.current()).toEqual(before);
            if (publication) expect(await binding.repository.event(binding.deployment_id, publication.event.event_id)).toBeUndefined();
            if (!mode.endsWith("wrong_store")) {
              recording.mockRestore(); mutation.mockRestore(); batchMutation.mockRestore();
              await expect(run()).resolves.toBe(0);
            }
            await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
            await expect(fs.stat(path.join(projectRoot, "shadow.db"))).rejects.toMatchObject({ code: "ENOENT" });
            return;
          }
          if (mode === "unknown_commit") await expect(running).rejects.toMatchObject({ code: "POLICY_READ_EDIT_COMMIT_UNCONFIRMED" });
          else if (mode === "concurrent") {
            const results = await running as PromiseSettledResult<number>[];
            expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
            expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
          } else await expect(running).resolves.toBe(0);
          lookup.mockRestore(); recording.mockRestore();
          const saved = await policies.current();
          expect(saved.epoch).toBe(before.epoch + 1);
          expect(saved.active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(before.active.filter(({ policy }) => policy.type !== "read_authoring"));
          const review = (await readProjectReadAuthoring(projectRoot))!;
          if (coded) {
            expect(review.selected!.stage).toBe("metadata_only");
            expect(review.selected!.progress.review_overrides.resources["coded.x17"]!.row_identity?.value).toBe("k01");
            expect(saved.drafts.some(({ revision }) => revision.kind === "read" && revision.name === "coded_draft")).toBe(false);
          } else expect(review.selected!.progress.candidate.pack.resources[0]!.model_withheld_fields).toContain("quantity");
          expect(review.authoring.entries[1]).toEqual(authoring.entries[1]);
          const recorded = await binding.repository.event(binding.deployment_id, publication!.event.event_id);
          expect(recorded!.actor).toBe("alice");
          expect(recorded!.receipt).toMatchObject({ operation: "edit_prepared_read", verified_decision: {
            purpose: "edit_read", subject: "alice", provider, candidate_digest: request.preview.candidate_digest,
            review_decision_digest: request.preview.decision_digest,
            repository_id: binding.repository_id, deployment_id: binding.deployment_id, project_id: binding.project_id,
          } });
          const consent = (recorded!.receipt as { verified_decision: import("./control-policy-read-edit.js").GovernedReadEditDecision }).verified_decision;
          expect(provider === "jwt_oidc" ? verifyJwtOperatorProof(consent.operator_proof, attestation)
            : verifySignedOperatorProof(consent.operator_proof, publicPem)).toBe(true);
          expect(consent.operator_proof.decision.proposal_hash).toBe(canonicalJsonDigest(consent.operator_envelope));
          if (token) expect(JSON.stringify(recorded)).not.toContain(token);
          expect(JSON.stringify(recorded)).not.toContain("PRIVATE KEY");
          // New preview and issuance time must not refresh a consumed nonce.
          const replay = await prepare();
          await expect(boundaryReviewCommand(replay.args, async () => inspection))
            .rejects.toMatchObject({ code: "POLICY_EVENT_ALREADY_RECORDED" });
          expect(await policies.current()).toEqual(saved);
          await expect(fs.stat(path.join(projectRoot, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          stdout.mockRestore(); recording.mockRestore(); lookup.mockRestore(); mutation.mockRestore(); batchMutation.mockRestore();
          delete process.env[tokenEnv]; delete process.env[secretEnv];
        }
      });
    });

    it("rejects an old headless bundle even when a later review has the same authority digest", async () => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const context = await loadBoundaryReviewContext(projectRoot);
        const file = path.join(projectRoot, "review.json");
        await fs.writeFile(file, JSON.stringify(context.bundle));
        await saveBoundaryReviewProgress(projectRoot, createBoundaryReviewProgress({ draft: context.draft, candidate: context.candidate,
          previous: context.progress, confirmedDecisions: context.candidate.unresolved_decisions, revision: context.progress!.revision + 1,
          actor: "different_reviewer" }), context.bundle.mutation_bindings.authoring);
        const current = await loadBoundaryReviewContext(projectRoot);
        expect(current.bundle.bundle_digest).toBe(context.bundle.bundle_digest);
        const before = await policies.current();
        const args = ["--project-root", projectRoot, "--review-bundle", file, "--headless",
          "--confirm", `ACTIVATE ${context.bundle.candidate_digest}`];
        await expect(boundaryActivateCommand(args, async () => fixture().inspection))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        await fs.writeFile(file, JSON.stringify({ ...current.bundle, mutation_bindings: undefined }));
        await expect(boundaryActivateCommand(args, async () => fixture().inspection))
          .rejects.toMatchObject({ code: "POLICY_AUTHORING_REVIEW_CHANGED" });
        expect(await policies.current()).toEqual(before);
      });
    });

    it.each(["preview", "activate"])("refuses a Workbench %s changed during inspection and resumes the exact review", async (phase) => {
      await useRepository(async ({ policies, projectRoot }) => {
        const authoring = readAuthoringFixture();
        for (const [index, domain] of ["inventory", "university"].entries()) {
          authoring.entries[index]!.catalog = readAuthoringCatalog(fixture(domain).build);
        }
        await policies.commitReadAuthoring({ expected_epoch: (await policies.current()).epoch, expected_revision_id: null,
          authoring, actor: "operator", operation: "prepare" });
        const initial = await policies.current();
        let changeDuringInspection: (() => Promise<void>) | undefined;
        const inspect = vi.fn(async () => {
          const change = changeDuringInspection; changeDuringInspection = undefined;
          await change?.(); return fixture().inspection;
        });
        const server = await startLocalUiServer({ projectRoot, boundaryRoot: path.join(projectRoot, "synapsor/generated"),
          configPath: path.join(projectRoot, "synapsor.runner.json"), storePath: path.join(projectRoot, "control.db"),
          token: "activation-review-token", csrfToken: "activation-csrf", schemaInspector: inspect });
        try {
          const base = `http://${server.host}:${server.port}`;
          const bootstrap = await fetch(server.url, { redirect: "manual" });
          expect(bootstrap.status).toBe(303);
          const headers = { cookie: bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!,
            "content-type": "application/json", "x-synapsor-csrf": "activation-csrf" };
          const post = (route: string, body: unknown) => fetch(`${base}/api/boundary/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
          const get = async () => {
            const response = await fetch(`${base}/api/boundary`, { headers });
            const payload = await response.json(); expect(response.status, JSON.stringify(payload)).toBe(200); return payload;
          };
          const shown = await get();
          const body = { candidate: shown.candidate, confirmed_decisions: shown.candidate.unresolved_decisions,
            actor: "reviewer", expected_revision: shown.review_progress.revision,
            expected_digest: shown.candidate_digest, confirmation: `ACTIVATE ${shown.candidate_digest}`,
            authoring_binding: shown.authoring_binding };
          const missing = await post("preview", { ...body, authoring_binding: undefined });
          expect(missing.status).toBe(409); expect(inspect).not.toHaveBeenCalled();
          const preview = await post("preview", body);
          const previewBody = await preview.json(); expect(preview.status, JSON.stringify(previewBody)).toBe(200);
          expect(await policies.current()).toEqual(initial);
          changeDuringInspection = async () => {
            const current = (await readProjectReadAuthoring(projectRoot))!;
            const selected = current.selected!;
            const candidate = structuredClone(selected.progress.candidate); candidate.budgets.max_top_n = 6;
            await saveBoundaryReviewProgress(projectRoot, createBoundaryReviewProgress({ draft: selected.draft, candidate,
              previous: selected.progress, confirmedDecisions: candidate.unresolved_decisions, revision: selected.progress.revision + 1 }), current.bindings);
          };
          const stale = await post(phase, body);
          expect(stale.status, JSON.stringify(await stale.json())).toBe(409);
          const changed = await policies.current();
          expect(changed.active.filter(({ policy }) => policy.type !== "read_authoring"))
            .toEqual(initial.active.filter(({ policy }) => policy.type !== "read_authoring"));
          const refreshed = await get();
          const retry = { ...body, candidate: refreshed.candidate, confirmed_decisions: refreshed.candidate.unresolved_decisions,
            expected_revision: refreshed.review_progress.revision, authoring_binding: refreshed.authoring_binding,
            expected_digest: refreshed.candidate_digest, confirmation: `ACTIVATE ${refreshed.candidate_digest}` };
          const oldPreview = await post("activate", retry);
          expect(oldPreview.status).toBe(409);
          const renewed = await post("preview", retry);
          expect(renewed.status, JSON.stringify(await renewed.json())).toBe(200);
          const activated = await post("activate", retry);
          const result = await activated.json(); expect(activated.status, JSON.stringify(result)).toBe(200);
          expect(result.active.activation.digest).toBe(refreshed.candidate_digest);
          expect(result.source_database_changed).toBe(false);
          expect((await readProjectReadAuthoring(projectRoot))!.selected!.progress.candidate).toEqual(refreshed.candidate);
        } finally { await server.close(); }
      });
    });

    it("preserves the active identity when renaming a stored draft and uses its exact policy lock", async () => {
      await useRepository(async ({ binding, projectRoot }) => {
        const repository = new OperatorAuthorityRepository(binding);
        const before = await repository.current();
        const source = fixture();
        const candidateLock = { ...source.generation_lock, reviewed_overrides_digest: canonicalJsonDigest("separately reviewed field policy") };
        const candidate = { ...source.candidate, generation_lock_fingerprint: canonicalJsonDigest(candidateLock) };
        const progress = createBoundaryReviewProgress({ draft: source.candidate, candidate,
          confirmedDecisions: candidate.unresolved_decisions, revision: 1 });
        await repository.commitReadAuthoring({ expected_epoch: before.epoch, expected_revision_id: null,
          authoring: { type: "read_authoring", selected_boundary_id: progress.boundary_id,
            entries: [{ draft: source.candidate, draft_lock: source.generation_lock, candidate_lock: candidateLock, progress }] },
          actor: "reviewer", operation: "prepare_policy_revision" });
        const loaded = await loadBoundaryReviewContext(projectRoot);
        const authority = await resolveSavedBoundaryReviewAuthority({ projectRoot, draft: loaded.draft,
          candidate: loaded.candidate, progress: loaded.progress });
        expect(authority.generationLock).toEqual(candidateLock);
        expect(authority.reviewDraft.generation_lock_fingerprint).toBe(canonicalJsonDigest(authority.generationLock));
        const renamed = await renameSavedBoundary({ projectRoot, draft: loaded.draft, currentCandidate: loaded.candidate,
          currentProgress: loaded.progress, expectedAuthoring: loaded.bundle.mutation_bindings.authoring,
          name: loaded.candidate.pack.name, newName: "next_inventory", actor: "reviewer", reason: "Keep the active boundary separate" });
        expect(renamed.boundary_id).not.toBe(progress.boundary_id);
        const current = await repository.current();
        expect(current.drafts).toHaveLength(2);
        expect(current.active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
        const selected = await loadBoundaryReviewContext(projectRoot);
        expect(selected.candidate.pack.name).toBe("next_inventory");
        await expect(deleteSavedBoundary({ projectRoot, draft: selected.draft, currentCandidate: selected.candidate,
          currentProgress: selected.progress, expectedAuthoring: selected.bundle.mutation_bindings.authoring,
          name: source.boundary.pack.name })).rejects.toThrow("is active");
        await createSavedBoundary({ projectRoot, draft: selected.draft, currentCandidate: selected.candidate,
          currentProgress: selected.progress, expectedAuthoring: selected.bundle.mutation_bindings.authoring,
          name: "fresh_inventory", resourceId: "inventory.items", actor: "reviewer" });
        const fresh = await loadBoundaryReviewContext(projectRoot);
        expect(fresh.candidate.generation_lock_fingerprint).toBe(canonicalJsonDigest(source.generation_lock));
        expect((await repository.current()).active.filter(({ policy }) => policy.type !== "read_authoring")).toEqual(before.active);
      });
    });

    it("reads execution from the same repository, never from an edited export, and observes revocation", async () => {
      await useRepository(async ({ binding, projectRoot, config: storageConfig }) => {
        const draft = actionFixture(fixture());
        await writeActionRuleAuthorityDraft(projectRoot, draft);
        await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        const config = executionConfig();
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        config.action_rules!.project_root = projectRoot;
        config.supervised_worker!.outcomes![0]!.action_boundary_digest = draft.authority.action_boundary.digest;
        const file = path.join(projectRoot, "synapsor.actions.runner.json");
        await fs.writeFile(file, JSON.stringify(config));
        // Even a valid, enabled export cannot create missing authority.
        expect((await readRuntimeConfig(file)).supervised_worker).toBeUndefined();
        const policy = decodeOperatorAuthority(encodeOperatorExecutionPolicy(config)!, { runtimeConfig: config });
        const executor = new OperatorAuthorityRepository(binding, config);
        const before = await executor.current();
        await executor.commit({ expected_epoch: before.epoch, active: [{ key: OPERATOR_EXECUTION_POLICY, policy }],
          actor: "operator", operation: "reviewed_execution" });
        const forged = structuredClone(config);
        forged.supervised_worker = { enabled: "invalid export", capabilities: "not authority" } as never;
        await fs.writeFile(file, JSON.stringify(forged));
        expect((await readRuntimeConfig(file)).supervised_worker).toEqual(config.supervised_worker);
        if (backend === "sqlite") {
          const wrongStore = path.join(projectRoot, "shadow.db");
          for (const command of [
            ["run", "--supervised", "--once", "--batch-quiet"], ["pause"], ["resume"], ["drain"],
            ["disable", draft.authority.rules[0]!.rule.outcome, "--digest", draft.authority.action_boundary.digest],
            ["revoke", draft.authority.rules[0]!.rule.outcome, "--digest", draft.authority.action_boundary.digest],
            ["cancel", "latest"], ["dead-letter", "requeue", "missing"],
          ]) {
            await expect(workerCommand([...command, "--yes", "--config", file, "--store", wrongStore]))
              .rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
          }
          await expect(applyProposal(["--yes", "--config", file, "--store", wrongStore,
            "--worker-execution-mode", "supervised_worker", "--worker-lease-id", "copied_lease"], "missing"))
            .rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
          await expect(fs.stat(wrongStore)).rejects.toMatchObject({ code: "ENOENT" });
          await fs.copyFile(path.join(projectRoot, "control.db"), wrongStore);
          await expect(applyProposal(["--yes", "--config", file, "--store", wrongStore,
            "--runtime-store-bridge", "--worker-execution-mode", "supervised_worker", "--worker-lease-id", "copied_lease"], "missing"))
            .rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
        } else {
          const forgedStore = path.join(projectRoot, "forged-bridge.db");
          const args = ["--yes", "--config", file, "--store", forgedStore, "--runtime-store-bridge"];
          await expect(workerCommand(["pause", ...args])).rejects.toMatchObject({ code: "POLICY_RUNTIME_BRIDGE_REQUIRED" });
          await expect(applyProposal(args, "missing")).rejects.toMatchObject({ code: "POLICY_RUNTIME_BRIDGE_REQUIRED" });
          await expect(workerCommand(["pause", "--yes", "--config", file, "--shared-ledger-schema", "other_store"]))
            .rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
          await expect(fs.stat(forgedStore)).rejects.toMatchObject({ code: "ENOENT" });
          // Inspection reads an existing ledger; it must not initialize one.
          const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL });
          try { await migrateSharedPostgresRuntimeStore(pool, config.storage!.shared_postgres!.schema!); }
          finally { await pool.end(); }
          let expiredPath = "";
          const command = ["--config", file];
          await withSharedPostgresRuntimeStoreReadBridge(command, config, "test read bridge", async (storePath) => {
            expiredPath = storePath;
            const input = { args: argsWithRuntimeStoreBridge(command, storePath), config, configPath: file, storePath };
            await expect(assertGovernedLocalRuntimeStore({ ...input, readOnly: true })).resolves.toBeUndefined();
            await expect(assertGovernedLocalRuntimeStore(input)).rejects.toMatchObject({ code: "POLICY_RUNTIME_BRIDGE_REQUIRED" });
          });
          await expect(assertGovernedLocalRuntimeStore({ args: argsWithRuntimeStoreBridge(command, expiredPath),
            config, configPath: file, storePath: expiredPath, readOnly: true }))
            .rejects.toMatchObject({ code: "POLICY_RUNTIME_BRIDGE_REQUIRED" });
        }
        const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
        try {
          await expect(workerCommand(["status", "--config", file])).resolves.toBe(0);
          await expect(workerCommand(["dead-letter", "show", "missing", "--config", file]))
            .rejects.toThrow("worker queue item not found");
        } finally { output.mockRestore(); }
        const borrowed = await readOperatorExecutionConfig({ projectRoot, config: forged, policyStore: binding });
        expect(borrowed.config.supervised_worker).toEqual(config.supervised_worker);
        expect(borrowed.epoch).toBe(before.epoch + 1);
        forged.sources!.local_postgres!.write_url_env = "UNREVIEWED_WRITER";
        await expect(readOperatorExecutionConfig({ projectRoot, config: forged, policyStore: binding }))
          .rejects.toMatchObject({ code: "POLICY_EXECUTION_BINDING_CHANGED" });
        await executor.commit({ expected_epoch: borrowed.epoch!, active: [{ key: OPERATOR_EXECUTION_POLICY, policy: null }],
          actor: "operator", operation: "revoke_execution" });
        expect((await readRuntimeConfig(file)).supervised_worker).toBeUndefined();
        expect((await readOperatorExecutionConfig({ projectRoot, config, policyStore: binding })).config.supervised_worker).toBeUndefined();
        expect((await binding.repository.history({ deployment_id: binding.deployment_id, key: OPERATOR_EXECUTION_POLICY }))).toHaveLength(1);
      });
    });

    it("opens fixed-tool Ask with stored execution despite an invalid worker export and checks the selected store", async () => {
      await useRepository(async ({ binding, projectRoot, config: storageConfig }) => {
        const source = fixture(); const draft = actionFixture(source);
        await writeActionRuleAuthorityDraft(projectRoot, draft);
        await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        const config = executionConfig();
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        config.action_rules!.project_root = projectRoot;
        config.supervised_worker!.outcomes![0]!.action_boundary_digest = draft.authority.action_boundary.digest;
        const executor = new OperatorAuthorityRepository(binding, config);
        await executor.commit({ expected_epoch: (await executor.current()).epoch,
          active: [{ key: OPERATOR_EXECUTION_POLICY,
            policy: decodeOperatorAuthority(encodeOperatorExecutionPolicy(config)!, { runtimeConfig: config }) }],
          actor: "operator", operation: "reviewed_execution" });
        const file = path.join(projectRoot, "synapsor.actions.runner.json");
        await fs.writeFile(file, JSON.stringify({ ...config, supervised_worker: { enabled: "invalid export" } }));
        await fs.writeFile(path.join(projectRoot, ".synapsor/explore-audit.key"), Buffer.alloc(32, 7).toString("base64url"), { mode: 0o600 });
        const inspect = vi.spyOn(schemaInspector, "inspectDatabase").mockResolvedValue(source.inspection);
        const env = { TEST_POLICY_URL: process.env.SYNAPSOR_TEST_POSTGRES_URL,
          DATABASE_URL: "postgresql://fixture.invalid/not-used", SYNAPSOR_TENANT_ID: "tenant-a", SYNAPSOR_PRINCIPAL: "maya" };
        try {
          const input = { configPath: file, projectRoot, storePath: path.join(projectRoot, "control.db"), env };
          const gateway = await createWorkbenchAskMcpGateway(input);
          try {
            expect((await gateway.listTools()).map((tool) => tool.name).sort())
              .toEqual(["app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change"]);
            const described = await gateway.callTool("app.describe_actions", {});
            expect(described.ok).toBe(true);
            expect(JSON.stringify(described.value)).toContain("inventory.replenish");
          } finally { await gateway.close(); }
          if (backend === "sqlite") {
            inspect.mockClear();
            const wrongStore = path.join(projectRoot, "shadow-ask.db");
            await expect(createWorkbenchAskMcpGateway({ ...input, storePath: wrongStore }))
              .rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
            expect(inspect).not.toHaveBeenCalled();
            await expect(fs.stat(wrongStore)).rejects.toMatchObject({ code: "ENOENT" });
          }
        } finally { inspect.mockRestore(); }
      });
    });

    it("publishes execution only through exact writer review and preserves revocation across stale exports and reviews", async () => {
      await useRepository(async ({ binding, projectRoot, config: storageConfig }) => {
        const source = fixture(); const draft = actionFixture(source);
        await writeActionRuleAuthorityDraft(projectRoot, draft);
        await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        const config = executionConfig(); delete config.supervised_worker;
        config.action_rules!.project_root = "./";
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        const file = path.join(projectRoot, "synapsor.actions.runner.json");
        await fs.writeFile(file, JSON.stringify(config));
        const inspection = structuredClone(source.inspection);
        inspection.current_user = "inventory_writer";
        inspection.role_posture!.read_only = false;
        inspection.role_posture!.writable_relations = ["inventory.items"];
        inspection.tables[0]!.role_posture!.privileges.update = true;
        const input = { projectRoot, outcome: "inventory.replenish", profile: "staging" as const, writeUrlEnv: "WRITER_URL",
          env: { ...process.env, WRITER_URL: "postgresql://never-open-this-test-url" }, inspect: async () => inspection };
        const preview = await previewSemanticSupervisedExecution(input);
        expect(preview.policy_epoch).toBeDefined();
        const enable = { ...input, expectedActionBoundaryDigest: preview.action_boundary_digest,
          expectedConfigDigest: preview.current_config_digest, expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
          confirmation: semanticExecutionConfirmation(preview) };
        await expect(enableSemanticSupervisedExecution({ ...enable, confirmation: "yes" })).rejects.toThrow("EXECUTION_CONFIRMATION_REQUIRED");
        expect(await binding.repository.active(binding.deployment_id, OPERATOR_EXECUTION_POLICY)).toBeUndefined();
        await enableSemanticSupervisedExecution(enable);
        const active = await binding.repository.active(binding.deployment_id, OPERATOR_EXECUTION_POLICY);
        expect(active).toBeDefined();
        const exported = JSON.parse(await fs.readFile(file, "utf8")) as RuntimeConfig;
        expect(decodeOperatorAuthority(active!, { runtimeConfig: resolveRuntimeConfig(exported, projectRoot) }))
          .toMatchObject({ type: "execution", policy: { enabled: true } });
        exported.supervised_worker!.enabled = false;
        await fs.writeFile(file, JSON.stringify(exported));
        expect((await readSemanticSupervisedExecutionState({ projectRoot })).enabled).toBe(true);
        await disableSemanticSupervisedExecution({ projectRoot, outcome: input.outcome,
          expectedActionBoundaryDigest: draft.authority.action_boundary.digest });
        exported.supervised_worker!.enabled = true;
        await fs.writeFile(file, JSON.stringify(exported));
        expect((await readRuntimeConfig(file)).supervised_worker!.enabled).toBe(false);
        await expect(enableSemanticSupervisedExecution(enable)).rejects.toThrow("SEMANTIC_ACTION_CONFIG_CHANGED");
        const newReview = await previewSemanticSupervisedExecution(input);
        const beforeRace = await fs.readFile(file, "utf8");
        await expect(enableSemanticSupervisedExecution({ ...enable,
          expectedConfigDigest: newReview.current_config_digest,
          inspect: async () => { await deactivateExplorationBoundary(projectRoot); return inspection; } }))
          .rejects.toThrow("SEMANTIC_ACTION_CONFIG_CHANGED");
        expect(await fs.readFile(file, "utf8")).toBe(beforeRace);
        expect((await readSemanticSupervisedExecutionState({ projectRoot })).enabled).toBe(false);
        expect(await binding.repository.history({ deployment_id: binding.deployment_id, key: OPERATOR_EXECUTION_POLICY })).toHaveLength(2);
      });
    });

    it.each(["new_failed", "same_failed", "lost_response", "unknown_receipt", "different_receipt"])(
      "confirms execution publication from its exact transaction receipt: %s", async (mode) => {
      await useRepository(async ({ binding, projectRoot, config: storageConfig }) => {
        const source = fixture(), draft = actionFixture(source);
        await writeActionRuleAuthorityDraft(projectRoot, draft);
        await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        const config = executionConfig(); delete config.supervised_worker;
        config.action_rules!.project_root = "./";
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        const file = path.join(projectRoot, "synapsor.actions.runner.json");
        await fs.writeFile(file, JSON.stringify(config));
        const inspection = structuredClone(source.inspection);
        inspection.current_user = "inventory_writer"; inspection.role_posture!.read_only = false;
        inspection.role_posture!.writable_relations = ["inventory.items"];
        inspection.tables[0]!.role_posture!.privileges.update = true;
        const input = { projectRoot, outcome: "inventory.replenish", profile: "staging" as const, writeUrlEnv: "WRITER_URL",
          env: { ...process.env, WRITER_URL: "postgresql://fixture.invalid/not-used" }, inspect: async () => inspection };
        async function reviewedInput() {
          const preview = await previewSemanticSupervisedExecution(input);
          return { ...input, expectedActionBoundaryDigest: preview.action_boundary_digest,
            expectedConfigDigest: preview.current_config_digest, expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
            confirmation: semanticExecutionConfirmation(preview) };
        }
        if (mode === "same_failed") await enableSemanticSupervisedExecution(await reviewedInput());
        const reviewed = await reviewedInput();
        const before = await binding.repository.deployment(binding.deployment_id);
        const commit = ControlPolicyRepository.prototype.commit;
        const event = ControlPolicyRepository.prototype.event;
        let intercepted = false;
        const fault = vi.spyOn(ControlPolicyRepository.prototype, "commit").mockImplementation(async function (this: ControlPolicyRepository, change) {
          if ((change.event.receipt as { operation?: string }).operation !== "enable_reviewed_execution") return commit.call(this, change);
          intercepted = true;
          if (mode !== "new_failed" && mode !== "same_failed") await commit.call(this, change);
          throw new Error("Injected lost or failed publication response");
        });
        const lookup = vi.spyOn(ControlPolicyRepository.prototype, "event").mockImplementation(async function (this: ControlPolicyRepository, ...args) {
          if (intercepted && mode === "unknown_receipt") throw new Error("Injected unavailable receipt lookup");
          const result = await event.call(this, ...args);
          return intercepted && mode === "different_receipt" && result ? { ...result, actor: "a_different_review" } : result;
        });
        try {
          if (mode === "lost_response") await expect(enableSemanticSupervisedExecution(reviewed)).resolves.toBeDefined();
          else await expect(enableSemanticSupervisedExecution(reviewed)).rejects.toThrow("POLICY_EXECUTION_COMMIT_UNCONFIRMED");
        } finally { fault.mockRestore(); lookup.mockRestore(); }
        expect(intercepted).toBe(true);
        const after = await binding.repository.deployment(binding.deployment_id);
        expect(after!.epoch).toBe(before!.epoch + (mode === "new_failed" || mode === "same_failed" ? 0 : 1));
        // Uncertain saves never restore an older runtime config over a possibly
        // committed authority. The export itself grants no execution authority.
        const exported = JSON.parse(await fs.readFile(file, "utf8"));
        expect(exported.supervised_worker.enabled).toBe(true);
        expect((await readSemanticSupervisedExecutionState({ projectRoot })).enabled).toBe(mode !== "new_failed");
      });
    });

    it("refreshes execution in a long-running client between approved requests without claiming completion", async () => {
      await useRepository(async ({ binding, projectRoot, config: storageConfig }) => {
        const draft = actionFixture(fixture(), true);
        await writeActionRuleAuthorityDraft(projectRoot, draft);
        await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        const config = executionConfig();
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        config.action_rules!.project_root = projectRoot;
        config.supervised_worker!.outcomes![0]!.action_boundary_digest = draft.authority.action_boundary.digest;
        const store = createDefaultRuntimeStore(config, process.env, path.join(projectRoot, "control.db"));
        const key = Buffer.alloc(32, 71);
        const env = { ...process.env, SYNAPSOR_TENANT_ID: "tenant_one", SYNAPSOR_PRINCIPAL: "principal_one" };
        let id = "item_1";
        try {
          const runtime = await createOptionalActionRuleRuntimeServices({ projectRoot, config, store, key, env,
            deployment_scope: "inventory_test", workflow_session_id: "execution_refresh",
            factSessionFactory: async () => ({ fact_loader: { engine: "postgres",
              load: async () => [{ id, tenant_id: "tenant_one", principal_id: "principal_one", quantity: 1, version: 1 }] },
              close: async () => undefined }) });
          const rule = runtime!.authority.registry.rules[0]!;
          const scope = subjectReferenceScopeFingerprints({ key, deployment_scope: runtime!.deployment_scope,
            source_id: rule.compiled.source, tenant: "tenant_one", principal: "principal_one" });
          const request = async (nextId: string) => {
            id = nextId;
            const [subject] = await runtime!.subjectReferences.issue({ source_id: rule.compiled.source,
              read_boundary_digest: rule.read_boundary_digest, generation_lock_fingerprint: rule.compiled.generation_lock_fingerprint,
              ...scope, workflow_session_id: runtime!.workflow_session_id, resource: "inventory.items",
              evidence_bundle_id: `evidence_${id}`, observations: [{ row_index: 0, primary_key_value: id, observed_version_value: 1 }] });
            return runtime!.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: rule.compiled.outcome,
              subject_refs: { item: subject!.ref } });
          };
          const enqueue = store.enqueueWorkerProposal;
          store.enqueueWorkerProposal = undefined;
          await expect(request("item_1")).resolves.toMatchObject({ proposal: { status: "approved" }, execution: "not_enabled", source_database_changed: false });
          store.enqueueWorkerProposal = enqueue;
          const policies = new OperatorAuthorityRepository(binding, config);
          const policy = decodeOperatorAuthority(encodeOperatorExecutionPolicy(config)!, { runtimeConfig: config });
          await policies.commit({ expected_epoch: (await policies.current()).epoch,
            active: [{ key: OPERATOR_EXECUTION_POLICY, policy }], actor: "operator", operation: "enable_execution" });
          await expect(request("item_2")).resolves.toMatchObject({ proposal: { status: "approved" }, execution: "queued", source_database_changed: false });
          expect(await store.listWorkerQueue!()).toEqual([expect.objectContaining({ status: "queued", attempts: 0 })]);
          const file = path.join(projectRoot, "synapsor.actions.runner.json");
          await fs.writeFile(file, JSON.stringify(config));
          const read = cliProject.readRuntimeConfig;
          let reads = 0;
          const reader = vi.spyOn(cliProject, "readRuntimeConfig").mockImplementation(async (...args) => {
            reads++;
            // PostgreSQL includes one outer read before entering its actual
            // serialized ledger bridge. Revoke immediately before claim.
            if (reads === (backend === "postgres" ? 4 : 3)) {
              await policies.commit({ expected_epoch: (await policies.current()).epoch,
                active: [{ key: OPERATOR_EXECUTION_POLICY, policy: null }], actor: "operator", operation: "revoke_execution" });
            }
            return read(...args);
          });
          const claim = vi.spyOn(ProposalStore.prototype, "claimWorkerItem");
          try {
            expect(await workerCommand(["run", "--supervised", "--once", "--yes", "--batch-quiet",
              "--config", file, "--store", path.join(projectRoot, "control.db")])).toBe(0);
            expect(reads).toBe(backend === "postgres" ? 4 : 3);
            expect(claim).not.toHaveBeenCalled();
          } finally { reader.mockRestore(); claim.mockRestore(); }
          expect((await store.listWorkerQueue!()).every((item) => item.status === "queued" && item.attempts === 0)).toBe(true);
          expect(await binding.repository.active(binding.deployment_id, OPERATOR_EXECUTION_POLICY)).toBeUndefined();
          store.enqueueWorkerProposal = undefined;
          await expect(request("item_3")).resolves.toMatchObject({ proposal: { status: "approved" }, execution: "not_enabled", source_database_changed: false });
          const proposals = await store.listProposals!();
          expect(proposals).toHaveLength(3);
          for (const proposal of proposals) expect(await store.receipts(proposal.proposal_id)).toEqual([]);
        } finally { await store.close(); }
      });
    });

    it("serves and revokes the exact Read repository revision despite stale file exports", async () => {
      await useRepository(async ({ binding, original, projectRoot }) => {
        const source = fixture();
        const legacy = path.join(projectRoot, ".synapsor/exploration-boundary.active.json");
        await fs.writeFile(legacy, JSON.stringify(source.boundary));
        expect(await loadActivatedExplorationBoundary(projectRoot)).toEqual(source.boundary);
        expect(await loadActivatedExplorationBoundaries(projectRoot, binding)).toEqual([source.boundary]);
        expect(await loadGenerationLockForActivatedBoundary(projectRoot, source.boundary, binding)).toEqual(source.generation_lock);
        // Neither the current generation-lock export nor the authority export
        // supplies runtime permissions or metadata after migration.
        await fs.writeFile(path.join(projectRoot, ".synapsor/generation-lock.json"), '{"invalid":true}');
        await fs.writeFile(legacy, '{"invalid":true}');
        expect(await loadActivatedExplorationBoundary(projectRoot)).toEqual(source.boundary);
        expect(await loadGenerationLockForActivatedBoundary(projectRoot, source.boundary)).toEqual(source.generation_lock);
        await fs.writeFile(legacy, JSON.stringify(source.boundary));
        expect(await deactivateExplorationBoundary(projectRoot, source.boundary.pack.name))
          .toEqual({ disabled: [source.boundary.pack.name], remaining: [] });
        await expect(loadActivatedExplorationBoundaries(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(loadActivatedExplorationBoundary(projectRoot, { name: source.boundary.pack.name })).rejects.toMatchObject({ code: "ENOENT" });
        await expect(loadGenerationLockForActivatedBoundary(projectRoot, source.boundary)).rejects.toMatchObject({ code: "POLICY_READ_AUTHORITY_STALE" });
        expect(await fs.readFile(legacy, "utf8")).toBe(JSON.stringify(source.boundary));
        expect(await binding.repository.draft(binding.deployment_id, original.drafts[0]!)).toEqual(original.revisions[1]);
      });
    });

    it("publishes through the existing exact Read activation gate without rewriting an active file export", async () => {
      await useRepository(async ({ projectRoot, policies }) => {
        const source = fixture(); source.candidate.budgets.max_top_n = 12;
        const digest = explorationBoundaryCandidateDigest(source.candidate);
        const input = { projectRoot, candidate: source.candidate, reviewDraft: source.candidate, generationLock: source.generation_lock,
          expectedDigest: digest, actor: "exact_operator", confirmation: `ACTIVATE ${digest}`,
          confirmedDecisions: source.candidate.unresolved_decisions, currentInspection: source.inspection };
        await expect(activateExplorationBoundary({ ...input, confirmation: "yes" })).rejects.toThrow("exact confirmation");
        expect((await policies.current()).epoch).toBe(1);
        const active = await activateExplorationBoundary(input);
        expect(active.activation.digest).toBe(digest);
        expect(await loadActivatedExplorationBoundary(projectRoot)).toEqual(active);
        expect((await policies.current()).epoch).toBe(2);
        await expect(fs.stat(path.join(projectRoot, ".synapsor/exploration-boundary.active.json"))).rejects.toMatchObject({ code: "ENOENT" });
      });
    });

    it("serves Action drafts and active revisions from the repository through the existing gates and cached loader", async () => {
      await useRepository(async ({ binding, projectRoot, policies }) => {
        const source = fixture(); const draft = actionFixture(source);
        const exported = await writeActionRuleAuthorityDraft(projectRoot, draft);
        expect(await readActionRuleAuthorityDraft(projectRoot, draft.authority.name)).toEqual(draft);
        expect(await listActionRuleAuthorityDrafts(projectRoot)).toEqual([draft]);
        expect(await readActionRuleAuthorityActivation(projectRoot)).toBeUndefined();
        await fs.writeFile(path.join(projectRoot, exported), '{"state":"active","untrusted":true}');
        expect(await readActionRuleAuthorityDraft(projectRoot, draft.authority.name)).toEqual(draft);
        const input = { projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "exact_operator" };
        await expect(activateActionRuleAuthority({ ...input, confirmation: "yes" })).rejects.toMatchObject({ code: "ACTION_RULE_CONFIRMATION_REQUIRED" });
        expect((await policies.current()).epoch).toBe(2);
        const active = await activateActionRuleAuthority(input);
        expect(await listActionRuleAuthorityDrafts(projectRoot)).toEqual([]);
        expect(await readActionRuleAuthorityDraft(projectRoot, draft.authority.name)).toBeUndefined();
        expect(await readActionRuleAuthorityActivation(projectRoot)).toEqual(active);
        const loader = createActiveActionRuleAuthorityLoader(projectRoot, binding);
        const first = await loader();
        expect((await loader()).registry).toBe(first.registry);
        const activeExport = path.join(projectRoot, ".synapsor/action-rules/active.json");
        await fs.writeFile(activeExport, JSON.stringify(active));
        await deactivateExplorationBoundary(projectRoot);
        const blocked = await loader({ dependency_check: "report" });
        expect(blocked.registry).toBe(first.registry);
        expect(blocked.unavailable_outcomes).toEqual(["inventory.replenish"]);
        await expect(loader({ read_boundaries: [source.boundary] })).rejects.toMatchObject({ code: "ACTION_RULE_READ_AUTHORITY_STALE" });
        await expect(loadActiveActionRuleAuthority(projectRoot, { read_boundaries: [source.boundary] })).rejects.toMatchObject({ code: "ACTION_RULE_READ_AUTHORITY_STALE" });
        expect(await deactivateActionRuleAuthority(projectRoot)).toBe(true);
        expect(await deactivateActionRuleAuthority(projectRoot)).toBe(false);
        await expect(loader()).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readActionRuleAuthorityActivation(projectRoot)).toBeUndefined();
        expect(await fs.readFile(activeExport, "utf8")).toBe(JSON.stringify(active));
      });
    });

    it("keeps the selected Read last even when repository ordering places its name first", async () => {
      await useRepository(async ({ projectRoot, binding }) => {
        const source = fixture(); source.candidate.pack.name = "aaa_selected";
        const digest = explorationBoundaryCandidateDigest(source.candidate);
        const active = await activateExplorationBoundary({ projectRoot, candidate: source.candidate,
          reviewDraft: source.candidate, generationLock: source.generation_lock, expectedDigest: digest,
          actor: "operator", confirmation: `ACTIVATE ${digest}`, activeSetMode: "add",
          confirmedDecisions: source.candidate.unresolved_decisions, currentInspection: source.inspection });
        expect((await loadActivatedExplorationBoundaries(projectRoot, binding)).map((boundary) => boundary.pack.name))
          .toEqual([fixture().boundary.pack.name, "aaa_selected"]);
        expect(await loadActivatedExplorationBoundary(projectRoot)).toEqual(active);
      });
    });

    it("refuses an unrelated runtime ledger before Read inspection, scope resolution or Action facts", async () => {
      await useRepository(async ({ projectRoot, config }) => {
        const wrongStore = new ProposalStore(":memory:"); await wrongStore.controlPolicies.initialize();
        const inspect = vi.fn(async () => fixture().inspection);
        const facts = vi.fn(async () => { throw new Error("must not access source facts"); });
        const unavailable = vi.fn();
        try {
          const input = { projectRoot, store: wrongStore, config, factSessionFactory: facts };
          await expect(createOptionalActionRuleRuntimeServices(input)).rejects.toMatchObject({ code: "POLICY_REPOSITORY_MISMATCH" });
          await expect(createOptionalReadActionRuleRuntimeServices(input, unavailable)).rejects.toMatchObject({ code: "POLICY_REPOSITORY_MISMATCH" });
          for (const factory of [createScopedExploreRuntime, createScopedExploreBoundarySetRuntime]) {
            await expect(factory({ projectRoot, store: wrongStore, transport: "stdio", inspectDatabaseFn: inspect }))
              .rejects.toMatchObject({ code: "POLICY_REPOSITORY_MISMATCH" });
          }
          expect(inspect).not.toHaveBeenCalled(); expect(facts).not.toHaveBeenCalled();
          expect(unavailable).not.toHaveBeenCalled();
          expect(await wrongStore.controlPolicies.identity()).toBeTruthy();
        } finally { wrongStore.close(); }
      });
    });

    it.each(["read", "read_set", "read_inspection", "read_scope", "read_budget", "action", "action_loader", "lazy_action", "lazy_bind", "optional_init", "queue"])("requires an explicit runtime restart after repository cutover: %s", async (mode) => {
      await useRepository(async ({ projectRoot, config: storageConfig }) => {
        const source = fixture();
        const draft = actionFixture(source, true);
        await writeActionRuleAuthorityDraft(projectRoot, draft);
        await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        // Stage the exact imported repository before exposing its locator to a
        // client that started with the same legacy file authority.
        const locator = path.join(projectRoot, ".synapsor/control-policy");
        const staged = path.join(projectRoot, ".synapsor/staged-control-policy");
        await fs.rename(locator, staged);
        let cutover = false;
        const publish = async () => { if (!cutover) { await fs.rename(staged, locator); cutover = true; } };
        await writeAutoBoundaryArtifacts({ projectRoot, build: source.build, force: true });
        const readDigest = explorationBoundaryCandidateDigest(source.candidate);
        await activateExplorationBoundary({ projectRoot, candidate: source.candidate, expectedDigest: readDigest,
          actor: "operator", confirmation: `ACTIVATE ${readDigest}`, confirmedDecisions: source.candidate.unresolved_decisions,
          currentInspection: source.inspection });
        if (mode !== "lazy_action" && mode !== "lazy_bind") {
          await writeActionRuleAuthorityDraft(projectRoot, draft);
          await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
            confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        }
        const config = executionConfig(); config.action_rules!.project_root = projectRoot;
        config.storage = storageConfig.storage ?? { sqlite_path: "./control.db" };
        config.supervised_worker!.outcomes![0]!.action_boundary_digest = draft.authority.action_boundary.digest;
        const store = createDefaultRuntimeStore(config, process.env, path.join(projectRoot, "control.db"));
        const key = Buffer.alloc(32, 73);
        const createProposal = vi.spyOn(store, "createProposal");
        const audit = vi.spyOn(store, "recordQueryAudit");
        const env = { ...process.env, DATABASE_URL: "postgresql://unused/metadata_fixture",
          SYNAPSOR_TENANT_ID: "tenant_one", SYNAPSOR_PRINCIPAL: "principal_one" };
        const inspect = vi.fn(async () => source.inspection);
        const execute = vi.fn(async () => []);
        const scope = { tenant: "tenant_one", principal: "principal_one", tenant_source: "environment" as const,
          tenant_binding: "SYNAPSOR_TENANT_ID", principal_source: "environment" as const, principal_binding: "SYNAPSOR_PRINCIPAL" };
        const resolveScope = vi.fn(async () => scope);
        const claim = store.claimExploreBudgetReservation!.bind(store);
        const claimSpy = vi.fn(claim);
        store.claimExploreBudgetReservation = claimSpy;
        const facts = vi.fn(async () => ({ fact_loader: { engine: "postgres" as const,
          load: async () => [{ id: "item_1", tenant_id: "tenant_one", principal_id: "principal_one", quantity: 1, version: 1 }] },
          close: async () => undefined }));
        let read: Awaited<ReturnType<typeof createScopedExploreRuntime>> | Awaited<ReturnType<typeof createScopedExploreBoundarySetRuntime>> | undefined;
        try {
          if (mode.startsWith("read")) {
            const factory = mode === "read_set" ? createScopedExploreBoundarySetRuntime : createScopedExploreRuntime;
            read = await factory({ projectRoot, store, transport: "stdio", env, inspectDatabaseFn: inspect,
              executor: { execute, executeBatch: execute, close: async () => undefined },
              resolveTrustedScopeFn: resolveScope });
            await read.describe(); inspect.mockClear();
            if (mode === "read_inspection") {
              inspect.mockImplementationOnce(async () => { await publish(); return source.inspection; });
              await expect(read.explore({ kind: "rows", resource: "inventory.items", select: ["quantity"], limit: 1 }))
                .rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
              expect(audit).not.toHaveBeenCalled();
              inspect.mockClear();
            }
            if (mode === "read_scope") {
              resolveScope.mockImplementationOnce(async () => { await publish(); return scope; });
              await expect(read.validate({ kind: "rows", resource: "inventory.items", select: ["quantity"], limit: 1 }))
                .rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
              expect(claimSpy).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
              inspect.mockClear();
            }
            if (mode === "read_budget") {
              claimSpy.mockImplementation(async (request) => { const result = await claim(request); await publish(); return result; });
              await expect(read.explore({ kind: "rows", resource: "inventory.items", select: ["quantity"], limit: 1 }))
                .rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
              expect(claimSpy).toHaveBeenCalledOnce(); expect(audit).not.toHaveBeenCalled();
              inspect.mockClear();
            }
            await publish();
            await expect(read.describe()).rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
            await expect(read.validate({})).rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
            await expect(read.explore({})).rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
            expect(inspect).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
          } else {
            const factory = mode.startsWith("lazy") || mode === "optional_init" ? createOptionalReadActionRuleRuntimeServices : createOptionalActionRuleRuntimeServices;
            const borrow = policyStoreAccess.borrowRuntimeControlPolicies;
            let borrowCalls = 0;
            let loaderBlocked = false;
            const suppliedAuthority = mode === "action_loader" ? await loadActiveActionRuleAuthority(projectRoot) : undefined;
            const loader = suppliedAuthority ? async () => { if (loaderBlocked) await publish(); return suppliedAuthority; } : undefined;
            const borrowSpy = mode === "optional_init" ? vi.spyOn(policyStoreAccess, "borrowRuntimeControlPolicies").mockImplementation(async (...args) => {
              const result = await borrow(...args);
              if (++borrowCalls === 2) await publish();
              return result;
            }) : undefined;
            let runtime;
            try {
              const creating = factory({ projectRoot, config, store, key, env, factSessionFactory: facts, authorityLoader: loader });
              if (mode === "optional_init") {
                await expect(creating).rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
                expect(facts).not.toHaveBeenCalled(); expect(createProposal).not.toHaveBeenCalled();
                return;
              }
              runtime = await creating;
            } finally { borrowSpy?.mockRestore(); }
            expect(runtime).toBeDefined();
            const menu = await runtime!.semanticActions.callTool("app.describe_actions", {});
            if (mode.startsWith("lazy")) expect(menu).toMatchObject({ actions: [] });
            else expect(JSON.stringify(menu)).toContain("inventory.replenish");
            if (mode === "queue") {
              const authority = await loadActiveActionRuleAuthority(projectRoot);
              const rule = authority.registry.rules[0]!;
              const scope = subjectReferenceScopeFingerprints({ key, deployment_scope: runtime!.deployment_scope,
                source_id: rule.compiled.source, tenant: "tenant_one", principal: "principal_one" });
              const [subject] = await runtime!.subjectReferences.issue({ source_id: rule.compiled.source,
                read_boundary_digest: rule.read_boundary_digest, generation_lock_fingerprint: rule.compiled.generation_lock_fingerprint,
                ...scope, workflow_session_id: runtime!.workflow_session_id, resource: "inventory.items",
                evidence_bundle_id: "cutover_evidence", observations: [{ row_index: 0, primary_key_value: "item_1", observed_version_value: 1 }] });
              const approve = store.approveProposalByPolicy.bind(store);
              store.approveProposalByPolicy = async (...args) => { const result = await approve(...args); await publish(); return result; };
              await expect(runtime!.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: rule.compiled.outcome,
                subject_refs: { item: subject!.ref } })).resolves.toMatchObject({ execution: "held", source_database_changed: false });
              expect(await store.listWorkerQueue!()).toEqual([]);
            } else {
              if (mode === "lazy_bind") {
                const bindingRace = vi.spyOn(policyStoreAccess, "borrowRuntimeControlPolicies").mockImplementation(async (...args) => {
                  await publish(); return borrow(...args);
                });
                try {
                  await expect(runtime!.semanticActions.callTool("app.describe_actions", {}))
                    .rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
                } finally { bindingRace.mockRestore(); }
              } else if (mode === "action_loader") {
                loaderBlocked = true;
                await expect(runtime!.subjectReferences.observationRequirement("inventory.items"))
                  .rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
              } else await publish();
              await expect(runtime!.semanticActions.callTool("app.describe_actions", {}))
                .rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
              await expect(runtime!.subjectReferences.observationRequirement("inventory.items"))
                .rejects.toMatchObject({ code: "POLICY_RUNTIME_RESTART_REQUIRED" });
              expect(facts).not.toHaveBeenCalled(); expect(createProposal).not.toHaveBeenCalled();
            }
          }
          const restarted = await createOptionalActionRuleRuntimeServices({ projectRoot, config, store, key, env, factSessionFactory: facts });
          expect(JSON.stringify(await restarted!.semanticActions.callTool("app.describe_actions", {}))).toContain("inventory.replenish");
        } finally { createProposal.mockRestore(); audit.mockRestore(); store.claimExploreBudgetReservation = claim; await publish(); await read?.close(); await store.close(); }
      });
    });

    it("uses the same live repository for discovery and observes revocation without reopening a locator", async () => {
      await useRepository(async ({ projectRoot, config, binding }) => {
        const draft = actionFixture(fixture());
        await writeActionRuleAuthorityDraft(projectRoot, draft);
        await activateActionRuleAuthority({ projectRoot, name: draft.authority.name, expected_digest: draft.digest,
          confirmation: `ACTIVATE ${draft.digest}`, actor: "operator" });
        const store = createDefaultRuntimeStore(config, process.env, path.join(projectRoot, "control.db"));
        const inspect = vi.fn(async () => { throw new Error("discovery must not inspect source"); });
        const ignoredLoader = vi.fn(async () => { throw new Error("an injected snapshot cannot replace current repository authority"); });
        const url = process.env.TEST_POLICY_URL;
        // A borrowed PostgreSQL connection continues to work without credentials
        // for opening another connection from the migration locator.
        if (backend === "postgres") delete process.env.TEST_POLICY_URL;
        try {
          const action = await createOptionalActionRuleRuntimeServices({ projectRoot, config, store,
            key: Buffer.alloc(32, 7), authorityLoader: ignoredLoader,
            resolveCatalogAuthorization: async () => ({ scope_key: "test-tenant-a-maya", revision: "test" }),
          });
          expect(action!.authority.authority.name).toBe(draft.authority.name);
          const described = await action!.semanticActions.callTool("app.describe_actions", {});
          expect(JSON.stringify(described)).toContain("inventory.replenish");
          const read = await createScopedExploreBoundarySetRuntime({ projectRoot, store, transport: "stdio",
            deferTrustedScope: true, inspectDatabaseFn: inspect });
          expect(read.boundaries).toEqual([fixture().boundary]);
          await read.close();
          expect(await store.controlPolicies!.identity()).toBeTruthy();
          expect(inspect).not.toHaveBeenCalled(); expect(ignoredLoader).not.toHaveBeenCalled();
          // Operate through the borrowed connection, then verify the existing
          // runtime rejects stale authority even if exports still exist.
          const current = (await store.controlPolicies!.deployment(binding.deployment_id))!;
          await store.controlPolicies!.commit({ deployment_id: binding.deployment_id, expected_epoch: current.epoch,
            revisions: [], active: [{ scope: { level: "operator" }, kind: "action", name: draft.authority.name, revision_id: null }],
            event: { event_id: randomUUID(), actor: "test_operator", occurred_at: new Date().toISOString(), receipt: { operation: "revoke" } } });
          await expect(action!.semanticActions.callTool("app.describe_actions", {})).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          if (url !== undefined) process.env.TEST_POLICY_URL = url;
          await store.close();
        }
      });
    });

    it("atomically revokes Read authority and its selection without deleting the disabled draft", async () => {
      await useRepository(async ({ policies, original }) => {
        await expect(policies.commit({ expected_epoch: 1, active: [{ key: original.active[0]!, policy: null }],
          actor: "reviewer", operation: "incomplete_revoke" })).rejects.toMatchObject({ code: "POLICY_ACTIVE_SELECTION_INVALID" });
        expect((await policies.current()).epoch).toBe(1);
        await policies.commit({ expected_epoch: 1, active: [{ key: original.active[0]!, policy: null },
          { key: OPERATOR_READ_SELECTION, policy: { type: "read_selection", selected_name: null } }], actor: "reviewer", operation: "revoke_read" });
        expect(await policies.current()).toMatchObject({ epoch: 2,
          active: [{ policy: { type: "read_selection", selected_name: null } }], drafts: [{ revision: original.revisions[1] }] });
      });
    });

    it("refuses disabled-as-active, cross-scope, duplicate and wrong-key updates without partial changes", async () => {
      await useRepository(async ({ policies, original }) => {
        const policy = decodeOperatorAuthority(original.revisions[1]!);
        const key = original.drafts[0]!;
        await expect(policies.commit({ expected_epoch: 1, active: [{ key, policy }], actor: "reviewer", operation: "unreviewed" }))
          .rejects.toMatchObject({ code: "POLICY_ACTIVATION_STATE_MISMATCH" });
        await expect(policies.commit({ expected_epoch: 1, drafts: [{ key: { ...key, scope: { level: "tenant", tenant_id: "acme" } }, policy }],
          actor: "reviewer", operation: "wrong_scope" })).rejects.toMatchObject({ code: "POLICY_AUTHORITY_IDENTITY_MISMATCH" });
        await expect(policies.commit({ expected_epoch: 1, drafts: [{ key: { ...key, name: "other" }, policy }],
          actor: "reviewer", operation: "wrong_name" })).rejects.toMatchObject({ code: "POLICY_AUTHORITY_IDENTITY_MISMATCH" });
        await expect(policies.commit({ expected_epoch: 1, drafts: [{ key, policy: null }, { key, policy: null }],
          actor: "reviewer", operation: "duplicate" })).rejects.toMatchObject({ code: "POLICY_DUPLICATE_POINTER" });
        expect((await policies.current()).epoch).toBe(1);
      });
    });

    it("refuses stale review and admits only one concurrent revision of the same snapshot", async () => {
      await useRepository(async ({ policies, binding, original }) => {
        const originalState = await policies.current();
        const results = await Promise.allSettled([policies, new OperatorAuthorityRepository(binding)].map((writer) => writer.commit({
          expected_epoch: originalState.epoch, drafts: [{ key: original.drafts[0]!, policy: null }], actor: "reviewer", operation: "remove_draft",
        })));
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
          .toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
        const current = await policies.current();
        expect(current.epoch).toBe(2); expect(current.drafts).toEqual([]);
        expect(current.active).toEqual(originalState.active);
      });
    });

    it("preserves Action identity through Read revocation and rejects new stale Action or execution authority", async () => {
      await useRepository(async ({ policies, binding, original }) => {
        const source = fixture();
        const draft = actionFixture(source);
        const key = { scope: { level: "operator" as const }, kind: "action" as const, name: draft.authority.name };
        await policies.commit({ expected_epoch: 1, drafts: [{ key, policy: { type: "action", authority: draft } }],
          actor: "operator", operation: "save_disabled_action" });
        const authority: ActionRuleAuthorityActivationV1 = { schema_version: "synapsor.action-rule-authority-activation.v1",
          state: "active", authority: draft.authority, digest: draft.digest, reviews: draft.reviews,
          actor: "operator", activated_at: "2026-09-06T02:00:00.000Z" };
        await policies.commit({ expected_epoch: 2, active: [{ key, policy: { type: "action", authority } }],
          drafts: [{ key, policy: null }], actor: "operator", operation: "activate_reviewed_action" });
        const config = executionConfig();
        config.supervised_worker!.outcomes![0]!.action_boundary_digest = authority.authority.action_boundary.digest;
        const executor = new OperatorAuthorityRepository(binding, config);
        const execution = decodeOperatorAuthority(encodeOperatorExecutionPolicy(config)!, { runtimeConfig: config });
        await executor.commit({ expected_epoch: 3, active: [{ key: OPERATOR_EXECUTION_POLICY, policy: execution }],
          actor: "operator", operation: "enable_reviewed_execution" });
        const before = await executor.current();
        await executor.commit({ expected_epoch: 4, active: [{ key: original.active[0]!, policy: null },
          { key: OPERATOR_READ_SELECTION, policy: { type: "read_selection", selected_name: null } }],
          actor: "operator", operation: "revoke_read" });
        const revoked = await executor.current();
        expect(revoked.active.find((entry) => entry.policy.type === "action"))
          .toEqual(before.active.find((entry) => entry.policy.type === "action"));
        expect(revoked.active.find((entry) => entry.policy.type === "execution"))
          .toEqual(before.active.find((entry) => entry.policy.type === "execution"));
        const renewed = { ...authority, activated_at: "2026-09-06T03:00:00.000Z" };
        await expect(executor.commit({ expected_epoch: 5, active: [{ key, policy: { type: "action", authority: renewed } }],
          actor: "operator", operation: "stale_action" })).rejects.toMatchObject({ code: "ACTION_RULE_READ_AUTHORITY_STALE" });
        await executor.commit({ expected_epoch: 5, active: [{ key: OPERATOR_EXECUTION_POLICY, policy: null }],
          actor: "operator", operation: "disable_execution" });
        await expect(executor.commit({ expected_epoch: 6, active: [{ key: OPERATOR_EXECUTION_POLICY, policy: execution }],
          actor: "operator", operation: "stale_execution" })).rejects.toMatchObject({ code: "POLICY_EXECUTION_AUTHORITY_STALE" });
        expect((await executor.current()).epoch).toBe(6);
      });
    });
  });
}

function actionFixture(source: ReturnType<typeof fixture>, automaticApproval = false) {
  const idType = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const quantityType = { kind: "integer" } as const;
  const fingerprint = source.boundary.generation_lock_fingerprint;
  const catalog: ActionRuleCatalogV1 = { schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: fingerprint, relationships: [], resources: [{ name: "inventory.items", source: "local_postgres",
      engine: "postgres", schema: "inventory", table: "items", primary_key: "id", tenant_key: "tenant_id",
      principal_scope_key: "principal_id", version_field: "version", fields: [
        ...["id", "tenant_id", "principal_id"].map((name) => ({ name, type: idType, nullable: false })),
        ...["quantity", "version"].map((name) => ({ name, type: quantityType, nullable: false })),
      ] }] };
  const verification: RuleVerificationBoundarySpecV1 = { schema_version: "synapsor.verification-boundary.v1",
    name: "inventory.verify", source: "local_postgres", context: "trusted_context", generation_lock_fingerprint: fingerprint,
    resources: [{ binding: "item", resource: "inventory.items", source: { kind: "subject_ref" }, primary_key: "id",
      version_field: "version", fields: catalog.resources[0]!.fields,
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" }, cardinality: "one",
      max_rows: 1, overflow: "unsupported", lock: "for_update" }], lock_order: ["item"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" } };
  const envelope: DerivedEffectEnvelopeSpecV1 = { schema_version: "synapsor.derived-effect-envelope.v1",
    name: "inventory.effect", source: "local_postgres", operation: "update", target_resource: "inventory.items",
    target_binding: "item", primary_key: "id", tenant_key: "tenant_id", principal_scope_key: "principal_id",
    conflict_key: "version", max_rows: 1, allowed_fields: [{ name: "quantity", type: quantityType, minimum: 0, maximum: 10 }],
    version_advance: { column: "version", strategy: "integer_increment" }, approval_classes: ["inventory.review"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" } };
  const rule: ActionRuleSpecV1 = { schema_version: "synapsor.action-rule.v1", name: "inventory.replenish", outcome: "inventory.replenish",
    context: "trusted_context", source: "local_postgres", verification_boundary_ref: verification.name,
    effect_envelope_ref: envelope.name, subjects: [{ binding: "item", resource: "inventory.items", input: "opaque_subject_ref" }],
    require: { kind: "compare", operator: "lt", left: { kind: "field", binding: "item", field: "quantity" },
      right: { kind: "literal", value: 5, value_type: quantityType } }, derive: {},
    effect: { operation: "update", target_resource: "inventory.items", target_binding: "item",
      set: { quantity: { kind: "literal", value: 5, value_type: quantityType } } }, approval_class: "inventory.review", ttl_seconds: 300 };
  return buildActionRuleAuthorityDraft({ name: "inventory_actions", action_boundary_name: "inventory_changes", catalog,
    ...(automaticApproval ? { approval_classes: [{ name: "inventory.review", mode: "policy" as const,
      required_role: "inventory_reviewer", required_approvals: 1,
      rules: [{ outcome: rule.outcome, auto_approve_when: structuredClone(rule.require) }], shared_limits: [
        { id: "inventory_action_limit", kind: "count" as const, scope: "capability" as const,
          maximum: 10, window_seconds: 86_400, capability: rule.outcome },
        { id: "inventory_customer_limit", kind: "count" as const, scope: "tenant_principal" as const,
          maximum: 10, window_seconds: 86_400, capability: rule.outcome },
      ] }] } : {}),
    rules: [{ read_boundary_name: source.boundary.pack.name, read_boundary_digest: source.boundary.activation.digest,
      verification_boundary: verification, effect_envelope: envelope, rule }], reviews: [{ outcome: rule.outcome,
      when: "Stock is below five.", then: "Set stock to five.", refused: ["Stock is already sufficient."],
      human_review: "One inventory reviewer.", examples: [{ kind: "eligible", scenario: "One item remaining", result: "Create proposal" }] }],
    now: "2026-09-06T01:00:00.000Z" });
}
