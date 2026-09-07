import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import * as schemaInspector from "@synapsor-runner/schema-inspector";
import { createDefaultRuntimeStore, resolveRuntimeConfig, subjectReferenceScopeFingerprints,
  REQUEST_CHANGE_TOOL, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { migrateSharedPostgresRuntimeStore, ProposalStore } from "@synapsor-runner/proposal-store";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { RuleVerificationBoundarySpecV1, DerivedEffectEnvelopeSpecV1, ActionRuleSpecV1 } from "@synapsor/spec";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, activateExplorationBoundary, buildAutoBoundary, deactivateExplorationBoundary,
  explorationBoundaryCandidateDigest, loadActivatedExplorationBoundary, loadActivatedExplorationBoundaries,
  loadGenerationLockForActivatedBoundary, writeAutoBoundaryArtifacts, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { decodeOperatorAuthority, encodeOperatorAuthority, encodeOperatorExecutionPolicy, OPERATOR_READ_SELECTION, OPERATOR_READ_AUTHORING, OPERATOR_EXECUTION_POLICY,
  validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { migrateProjectControlPolicies, openProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { createOptionalActionRuleRuntimeServices, createOptionalReadActionRuleRuntimeServices } from "./semantic-action-runtime.js";
import { createScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";
import { readOperatorExecutionConfig } from "./control-policy-execution.js";
import type { StoredReadAuthoring } from "./control-policy-read-authoring.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { readBoundaryReviewProgress, saveBoundaryReviewProgress } from "./boundary-review-persistence.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { createSavedBoundary, deleteSavedBoundary, discardOnlySavedBoundaryReview, renameSavedBoundary, switchSavedBoundary,
  resolveSavedBoundaryReviewAuthority, synchronizeBoundaryLibrary } from "./boundary-library.js";
import { readRuntimeConfig } from "./cli-project.js";
import * as cliProject from "./cli-project.js";
import { workerCommand } from "./worker-runtime.js";
import { applyProposal } from "./guarded-apply.js";
import { argsWithRuntimeStoreBridge, assertGovernedLocalRuntimeStore, withSharedPostgresRuntimeStoreReadBridge } from "./store-shared.js";
import { createWorkbenchAskMcpGateway } from "./ask-mcp-gateway.js";
import { disableSemanticSupervisedExecution, enableSemanticSupervisedExecution,
  previewSemanticSupervisedExecution, readSemanticSupervisedExecutionState, semanticExecutionConfirmation } from "./semantic-action-deployment.js";
import { activateActionRuleAuthority, buildActionRuleAuthorityDraft, createActiveActionRuleAuthorityLoader,
  deactivateActionRuleAuthority, listActionRuleAuthorityDrafts, loadActiveActionRuleAuthority, readActionRuleAuthorityActivation,
  readActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, type ActionRuleAuthorityActivationV1 } from "./action-rule-authority.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

function fixture(domain = "inventory") {
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
  const build = buildAutoBoundary({ inspection, inspectedSchema: domain, sourceEnv: "DATABASE_URL", overrides: {
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

function snapshot(): ControlPolicyMigrationSnapshot {
  const input = fixture();
  const active = encodeOperatorAuthority({ type: "read", boundary: input.boundary, generation_lock: input.generation_lock });
  const draft = encodeOperatorAuthority({ type: "read", boundary: input.candidate, generation_lock: input.generation_lock });
  const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: active.name });
  const pointer = ({ scope, kind, name, revision_id }: typeof active) => ({ scope, kind, name, revision_id });
  return { revisions: [active, draft, selection], active: [pointer(active), pointer(selection)], drafts: [pointer(draft)],
    provenance: [{ path: ".synapsor/exploration-boundary.active.json", digest: canonicalJsonDigest(input.boundary) }] };
}

function readAuthoringFixture(): StoredReadAuthoring {
  const entries = ["inventory", "university"].map((domain) => {
    const source = fixture(domain);
    source.candidate.pack.name = `${domain}_draft`;
    return { draft: source.candidate, draft_lock: source.generation_lock, candidate_lock: source.generation_lock,
      progress: createBoundaryReviewProgress({ draft: source.candidate, candidate: source.candidate,
        confirmedDecisions: source.candidate.unresolved_decisions, actor: "reviewer", revision: 1 }) };
  });
  return { type: "read_authoring", selected_boundary_id: entries[0]!.progress.boundary_id, entries };
}

describe("exact stored operator authority", () => {
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
    }) => Promise<void>) {
      const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-operator-policy-")); roots.push(projectRoot);
      const schema = `operator_policy_${randomUUID().replaceAll("-", "")}`;
      const config = backend === "sqlite" ? {} as RuntimeConfig : { storage: { shared_postgres: {
        mode: "runtime_store", url_env: "TEST_POLICY_URL", schema,
      } } } as RuntimeConfig;
      const original = snapshot();
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
