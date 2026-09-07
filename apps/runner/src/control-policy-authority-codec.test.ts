import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { createDefaultRuntimeStore, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import type { RuleVerificationBoundarySpecV1, DerivedEffectEnvelopeSpecV1, ActionRuleSpecV1 } from "@synapsor/spec";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, activateExplorationBoundary, buildAutoBoundary, deactivateExplorationBoundary,
  explorationBoundaryCandidateDigest, loadActivatedExplorationBoundary, loadActivatedExplorationBoundaries,
  loadGenerationLockForActivatedBoundary, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { decodeOperatorAuthority, encodeOperatorAuthority, encodeOperatorExecutionPolicy, OPERATOR_READ_SELECTION, OPERATOR_EXECUTION_POLICY,
  validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { migrateProjectControlPolicies, openProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { createOptionalActionRuleRuntimeServices, createOptionalReadActionRuleRuntimeServices } from "./semantic-action-runtime.js";
import { createScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";
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
  return { candidate, boundary, generation_lock: build.lock, inspection };
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

describe("exact stored operator authority", () => {
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

function actionFixture(source: ReturnType<typeof fixture>) {
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
    rules: [{ read_boundary_name: source.boundary.pack.name, read_boundary_digest: source.boundary.activation.digest,
      verification_boundary: verification, effect_envelope: envelope, rule }], reviews: [{ outcome: rule.outcome,
      when: "Stock is below five.", then: "Set stock to five.", refused: ["Stock is already sufficient."],
      human_review: "One inventory reviewer.", examples: [{ kind: "eligible", scenario: "One item remaining", result: "Create proposal" }] }],
    now: "2026-09-06T01:00:00.000Z" });
}
