import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary, explorationBoundaryCandidateDigest, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { decodeOperatorAuthority, encodeOperatorAuthority, encodeOperatorExecutionPolicy, OPERATOR_READ_SELECTION,
  validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { migrateProjectControlPolicies, openProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";

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
  return { candidate, boundary, generation_lock: build.lock };
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
