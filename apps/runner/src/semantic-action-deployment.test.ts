import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { resolveActivatedActionRule, type ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import { loadRuntimeConfigFromFile, resolveRuntimeConfig, resolveSemanticSupervisedWorkerEligibility } from "@synapsor-runner/mcp-server";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ActionRuleSpecV1, DerivedEffectEnvelopeSpecV1, RuleVerificationBoundarySpecV1 } from "@synapsor/spec";
import { activateSemanticActionRuntime, restoreReviewedSemanticReadScope, previewSemanticSupervisedExecution,
  enableSemanticSupervisedExecution, executionReReviewOutcomesForActionActivation, semanticExecutionConfirmation } from "./semantic-action-deployment.js";
import { inspectDraftSemanticWriter, prepareSemanticWriterHandoff } from "./semantic-action-deployment.js";
import { SemanticWriterPostureError } from "./semantic-execution-setup.js";
import { buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, loadActiveActionRuleAuthority,
  writeActionRuleAuthorityDraftIfCurrent, readActionRuleAuthorityDraft,
  type ActionRuleAuthorityActivationV1, type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { assessSemanticSupervisedWriterPosture } from "./worker-policy.js";
import { readPostActivationReadiness } from "./post-activation-ask.js";
import { prepareSavedActionRuleRemoval } from "./action-rule-removal.js";
import { createOptionalActionRuleRuntimeServices } from "./semantic-action-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("mixed-state semantic Read scope repair", () => {
  it("leaves an Action config without active semantic authority untouched", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mixed-scope-")); roots.push(root);
    const configPath = path.join(root, "synapsor.actions.runner.json");
    const config = `${JSON.stringify({ version: 1, action_rules: { project_root: root },
      capabilities: [], sources: {}, supervised_worker: { enabled: false } }, null, 2)}\n`;
    await fs.writeFile(configPath, config);
    await expect(restoreReviewedSemanticReadScope(root)).resolves.toBe(false);
    expect(await fs.readFile(configPath, "utf8")).toBe(config);
    await expect(fs.stat(path.join(root, ".synapsor/action-rules/active.json"))).rejects.toHaveProperty("code", "ENOENT");
  });

  it("repairs only already-reviewed RLS wiring and reports human proposal-only authority without worker claims", async () => {
    const fixture = await activeProject();
    const before = await Promise.all(fixture.authorityPaths.map((file) => fs.readFile(file, "utf8")));
    expect(await restoreReviewedSemanticReadScope(fixture.root)).toBe(true);
    expect(JSON.parse(await fs.readFile(fixture.configPath, "utf8")).sources.local_postgres.database_scope)
      .toEqual({ mode: "postgres_rls", tenant_setting: "synapsor.tenant_id" });
    expect(await restoreReviewedSemanticReadScope(fixture.root)).toBe(false);
    expect(await Promise.all(fixture.authorityPaths.map((file) => fs.readFile(file, "utf8")))).toEqual(before);
    expect(await readPostActivationReadiness(fixture.root)).toEqual({
      read: "active", legacy_actions: "inactive", semantic_actions: "active", worker: "not_checked",
      semantic_outcomes: [{ outcome: "billing.pause_notifications", approval_mode: "human", execution_enabled: false }],
    });
  });

  it.each(["malformed", "digest", "missing_immutable", "missing_read", "stale_read"])("does not mistake %s active authority for absence", async (mode) => {
    const fixture = await activeProject();
    if (mode === "malformed") await fs.writeFile(fixture.activePath, "{");
    if (mode === "digest") {
      const active = JSON.parse(await fs.readFile(fixture.activePath, "utf8"));
      active.authority.rules[0].rule.ttl_seconds++;
      await fs.writeFile(fixture.activePath, JSON.stringify(active));
    }
    if (mode === "missing_immutable") await fs.rm(fixture.revisionPath);
    if (mode === "missing_read") await fs.rm(fixture.readPath);
    if (mode === "stale_read") {
      const activeRead = JSON.parse(await fs.readFile(fixture.readPath, "utf8"));
      activeRead.boundaries[0].activation.digest = `sha256:${"c".repeat(64)}`;
      await fs.writeFile(fixture.readPath, JSON.stringify(activeRead));
    }
    const beforeConfig = await fs.readFile(fixture.configPath, "utf8");
    const beforeAuthority = await fs.readFile(fixture.activePath, "utf8");
    await expect(restoreReviewedSemanticReadScope(fixture.root)).rejects.toThrow();
    await expect(readPostActivationReadiness(fixture.root)).rejects.toThrow();
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(beforeConfig);
    expect(await fs.readFile(fixture.activePath, "utf8")).toBe(beforeAuthority);
  });

  it("does not restore revoked semantic authority from its retained config or immutable revision", async () => {
    const fixture = await activeProject();
    await fs.rm(fixture.activePath);
    const before = await fs.readFile(fixture.configPath, "utf8");
    expect(await restoreReviewedSemanticReadScope(fixture.root)).toBe(false);
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(before);
    expect((await readPostActivationReadiness(fixture.root)).semantic_actions).toBe("inactive");
    await expect(fs.stat(fixture.activePath)).rejects.toHaveProperty("code", "ENOENT");
    expect((await fs.stat(fixture.revisionPath)).isFile()).toBe(true);
  });

  it.each([false, true])("reports policy approval separately from exact execution binding (matches=%s)", async (matches) => {
    const fixture = await activeProject("policy");
    const active = JSON.parse(await fs.readFile(fixture.activePath, "utf8"));
    const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    config.supervised_worker = { enabled: true, capabilities: [], outcomes: [{ outcome: "billing.pause_notifications",
      action_boundary_digest: matches ? active.authority.action_boundary.digest : `sha256:${"f".repeat(64)}`,
      mode: "supervised_worker", write_url_env: "PRIVATE_WRITER_ENV", concurrency: 1, queue_limit: 100,
      lease_seconds: 300, max_attempts: 5, proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 } }] };
    await fs.writeFile(fixture.configPath, JSON.stringify(config));
    const before = await fs.readFile(fixture.configPath, "utf8");
    const readiness = await readPostActivationReadiness(fixture.root);
    expect(readiness.semantic_outcomes).toEqual([
      { outcome: "billing.pause_notifications", approval_mode: "policy", execution_enabled: matches },
    ]);
    expect(readiness.worker).toBe("not_checked");
    expect(JSON.stringify(readiness)).not.toContain("PRIVATE_WRITER_ENV");
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(before);
  });
});

describe("complete Action Boundary execution re-review", () => {
  it("retires one action from the same client only after activation and cannot resurrect it from the active baseline", async () => {
    const fixture = await activeProject("human", true);
    const original = await loadActiveActionRuleAuthority(fixture.root);
    const readBefore = await fs.readFile(fixture.readPath, "utf8");
    const store = new ProposalStore(":memory:");
    const facts = vi.fn(async () => { throw new Error("Removed action must not access source facts"); });
    try {
      const services = await createOptionalActionRuleRuntimeServices({ projectRoot: fixture.root,
        config: { version: 1, mode: "review", sources: {}, trusted_context: { provider: "environment" } },
        env: { SYNAPSOR_TENANT_ID: "test-account", SYNAPSOR_PRINCIPAL: "test-customer" },
        store, key: Buffer.alloc(32, 7), factSessionFactory: facts });
      const client = services!.semanticActions;
      const list = async () => (await client.callTool("app.describe_actions", {})).actions as Array<{ outcome: string }>;
      expect((await list()).map(action => action.outcome)).toEqual(["billing.pause_notifications", "billing.set_priority"]);
      const prepared = await prepareSavedActionRuleRemoval(fixture.root, "billing.set_priority");
      if (prepared.mode === "deactivate") throw new Error("Two-outcome removal must retain the other outcome.");
      expect(prepared.draft.authority.rules.map(({ activated_at: _activatedAt, ...rule }) => rule)).toEqual(original.authority.rules.filter(rule => rule.rule.outcome !== "billing.set_priority")
        .map(({ activated_at: _activatedAt, ...rule }) => rule));
      await writeActionRuleAuthorityDraftIfCurrent(fixture.root, prepared.draft, prepared.baseline);
      expect((await list()).map(action => action.outcome)).toContain("billing.set_priority");
      expect((await loadActiveActionRuleAuthority(fixture.root)).authority).toEqual(original.authority);
      const repeated = await prepareSavedActionRuleRemoval(fixture.root, "billing.set_priority");
      expect(repeated.alreadyRemoved).toBe(true);
      expect(repeated.draft).toEqual(prepared.draft);
      const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
      config.supervised_worker = { enabled: true, profile: "staging", capabilities: [],
        outcomes: ["billing.pause_notifications", "billing.set_priority"].map(outcome => ({ outcome,
          action_boundary_digest: original.authority.action_boundary.digest, mode: "supervised_worker", write_url_env: "WRITER_URL",
          concurrency: 1, queue_limit: 100, lease_seconds: 300, max_attempts: 5, proposal_ttl_seconds: 3600,
          rate_limit: { executions: 10, window_seconds: 60 } })) };
      await fs.writeFile(fixture.configPath, JSON.stringify(config));
      await activateSemanticActionRuntime({ projectRoot: fixture.root, draft: prepared.draft, actor: "test reviewer" });
      expect((await list()).map(action => action.outcome)).toEqual(["billing.pause_notifications"]);
      await expect(client.callTool("app.request_change", { outcome: "billing.set_priority", subject_refs: { preference: `obj_${"x".repeat(40)}` } }))
        .rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNAVAILABLE" });
      expect(facts).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(fixture.configPath, "utf8")).supervised_worker).toBeUndefined();
      expect(await fs.readFile(fixture.readPath, "utf8")).toBe(readBefore);
    } finally { store.close(); }
  });

  it("refuses a removal publication if another reviewer changes the saved bundle", async () => {
    const fixture = await activeProject("human", true);
    const prepared = await prepareSavedActionRuleRemoval(fixture.root, "billing.set_priority");
    if (prepared.mode === "deactivate") throw new Error("Two-outcome removal must retain the other outcome.");
    const competing = { ...fixture.draft, reviews: fixture.draft.reviews.map(review => ({ ...review, when: `${review.when}; revised explanation` })) };
    await writeActionRuleAuthorityDraft(fixture.root, competing);
    await expect(writeActionRuleAuthorityDraftIfCurrent(fixture.root, prepared.draft, prepared.baseline))
      .rejects.toMatchObject({ code: "ACTION_BOUNDARY_REVISION_CHANGED" });
    expect(await readActionRuleAuthorityDraft(fixture.root, competing.authority.name)).toEqual(competing);
    expect((await loadActiveActionRuleAuthority(fixture.root)).authority.rules).toHaveLength(2);
  });

  it("identifies only current enabled outcomes retained by a replacement bundle", () => {
    const oldDigest = `sha256:${"a".repeat(64)}` as const;
    const nextDigest = `sha256:${"b".repeat(64)}` as const;
    const active = { authority: { action_boundary: { digest: oldDigest } } } as ActionRuleAuthorityActivationV1;
    const draft = { authority: { action_boundary: { digest: nextDigest, rules: [
      { outcome: "warehouse.correct_quantity", writeback: { mode: "direct_sql", supervised_worker: "allowed" } },
      { outcome: "warehouse.new_availability", writeback: { mode: "direct_sql", supervised_worker: "allowed" } },
      { outcome: "warehouse.proposal_only", writeback: { mode: "none" } },
    ] } } } as ActionRuleAuthorityDraftV1;
    const policies = [{ outcome: "warehouse.correct_quantity", action_boundary_digest: oldDigest },
      { outcome: "warehouse.removed", action_boundary_digest: oldDigest },
      { outcome: "warehouse.correct_quantity", action_boundary_digest: nextDigest }];

    expect(executionReReviewOutcomesForActionActivation({ active, draft,
      execution: { enabled: true, config_path: "synapsor.actions.runner.json", policies: policies as never } }))
      .toEqual(["warehouse.correct_quantity"]);
    expect(executionReReviewOutcomesForActionActivation({ active, draft,
      execution: { enabled: false, config_path: "synapsor.actions.runner.json", policies: policies as never } })).toEqual([]);
  });
});

describe("metadata-only writer preflight before activation", () => {
  it.each([false, true])("checks the whole planned writer envelope without activating (multiple=%s)", async (multiple) => {
    const fixture = await activeProject("human", multiple);
    await fs.rm(fixture.activePath);
    const configBefore = await fs.readFile(fixture.configPath, "utf8");
    const draftBefore = JSON.stringify(fixture.draft);
    const inspection = writerInspection("dedicated", "status");
    inspection.tables[0]!.row_level_security = true;
    reviewedRls(inspection);
    if (multiple) inspection.tables[0]!.role_posture!.column_privileges!.update!.push("priority");
    const inspect = vi.fn(async () => inspection);
    const input = { draft: fixture.draft, reads: [fixture.reviewedRead], engine: "postgres" as const,
      readUrlEnv: "DATABASE_URL", env: { SYNAPSOR_DATABASE_WRITE_URL: "postgresql://private-test-credential" }, inspect };
    const result = await inspectDraftSemanticWriter(input);
    expect(result!.assessment.ok).toBe(true);
    expect(result!.outcomes).toHaveLength(multiple ? 2 : 1);
    expect(result!.assessment.required_relations![0]!.update_columns).toEqual(multiple ? ["priority", "status", "version"] : ["status", "version"]);
    expect(inspect).toHaveBeenCalledWith({ engine: "postgres", databaseUrlEnv: "SYNAPSOR_DATABASE_WRITE_URL", statementTimeoutMs: 5000, env: input.env });
    expect(JSON.stringify(result)).not.toContain("private-test-credential");
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
    expect(JSON.stringify(fixture.draft)).toBe(draftBefore);
    await expect(fs.stat(fixture.activePath)).rejects.toHaveProperty("code", "ENOENT");

    inspection.tables[0]!.role_posture!.row_security_forced = false;
    const unforced = await inspectDraftSemanticWriter(input);
    expect(unforced!.assessment.reasons).toContain("writer_rls_prerequisite_failed");
    expect(unforced!.rls_issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("FORCE ROW LEVEL SECURITY") })]));
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
    inspection.tables[0]!.role_posture!.row_security_forced = true;

    inspection.tables[0]!.role_posture!.column_privileges!.update!.push("unrelated_secret");
    inspection.tables[0]!.role_posture!.row_security_update_permitted = false;
    const refused = await inspectDraftSemanticWriter(input);
    expect(refused!.assessment.reasons).toEqual(expect.arrayContaining(["writer_excess_column_privilege", "writer_row_lock_rls_policy_missing"]));
  });

  it("refuses stale dependencies and missing credentials before opening a database connection", async () => {
    const fixture = await activeProject();
    const inspect = vi.fn(async () => writerInspection("writer", "status"));
    const input = { draft: fixture.draft, reads: [fixture.reviewedRead], engine: "postgres" as const,
      readUrlEnv: "DATABASE_URL", env: {}, inspect };
    await expect(inspectDraftSemanticWriter(input)).rejects.toThrow(/WRITER_URL_MISSING/);
    await expect(inspectDraftSemanticWriter({ ...input, env: { SYNAPSOR_DATABASE_WRITE_URL: "postgresql://test" },
      reads: [{ ...fixture.reviewedRead, digest: `sha256:${"f".repeat(64)}` }] })).rejects.toThrow(/READ_SCOPE_STALE/);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not call the reader a checked writer, but still derives requirements through it", async () => {
    const fixture = await activeProject();
    const inspection = writerInspection("reader", "status");
    reviewedRls(inspection);
    const inspect = vi.fn(async () => inspection);
    const input = { draft: fixture.draft, reads: [fixture.reviewedRead], engine: "postgres" as const,
      readUrlEnv: "DATABASE_URL", env: { DATABASE_URL: "postgresql://reader-private", SYNAPSOR_DATABASE_WRITE_URL: "postgresql://reader-private" }, inspect };
    await expect(inspectDraftSemanticWriter(input)).rejects.toThrow(/WRITER_READER_CONNECTION/);
    expect(inspect).not.toHaveBeenCalled();
    expect(await inspectDraftSemanticWriter({ ...input, requirementsOnly: true })).toMatchObject({
      writer_status: "not_checked", inspected_connection_env: "DATABASE_URL", assessment: { ok: false },
    });
  });

  it.each([false, true])("derives complete requirements through a read-only connection without claiming writer readiness (multiple=%s)", async (multiple) => {
    const fixture = await activeProject("human", multiple);
    await fs.rm(fixture.activePath);
    const before = await fs.readFile(fixture.configPath, "utf8");
    const inspection = writerInspection("reader", "status");
    inspection.role_posture!.read_only = true;
    inspection.role_posture!.writable_relations = [];
    const table = inspection.tables[0]!;
    table.type = "table";
    table.columns = fixture.draft.authority.catalog.resources[0]!.fields.map((field) => ({ name: field.name })) as typeof table.columns;
    table.role_posture!.column_privileges = {};
    const inspect = vi.fn(async () => inspection);
    const input = { draft: fixture.draft, reads: [fixture.reviewedRead], engine: "postgres" as const,
      readUrlEnv: "DATABASE_URL", env: { DATABASE_URL: "postgres://reader-secret" }, inspect };
    const result = await inspectDraftSemanticWriter(input);
    expect(result).toMatchObject({ writer_status: "not_checked", inspected_connection_env: "DATABASE_URL",
      assessment: { ok: false, reasons: ["writer_connection_not_checked"] } });
    expect(result!.plan!.outcomes).toHaveLength(multiple ? 2 : 1);
    expect(result!.plan!).toMatchObject({ read_env: "DATABASE_URL", writer_env: "SYNAPSOR_DATABASE_WRITE_URL" });
    expect(result!.plan!.relations[0]!.update_columns).toEqual(multiple ? ["priority", "status", "version"] : ["status", "version"]);
    expect(result!.plan!.relations[0]!.privileges).toEqual(["select", "update"]);
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ databaseUrlEnv: "DATABASE_URL" }));
    expect(JSON.stringify(result)).not.toContain("reader-secret");
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(before);
    await expect(fs.stat(fixture.activePath)).rejects.toHaveProperty("code", "ENOENT");
    if (multiple) {
      const single = await inspectDraftSemanticWriter({ ...input, outcome: "billing.set_priority" });
      expect(single!.plan!.outcomes).toEqual(["billing.set_priority"]);
      expect(single!.plan!.relations[0]!.update_columns).toEqual(["priority", "version"]);
    }
  });

  it.each([false, true])("retains exact foreign Read dependencies only for executable outcomes (executable=%s)", async (executable) => {
    const fixture = await activeProject("human", true);
    const foreign = { pack: { ...fixture.reviewedRead.pack, name: "other_reviewed_read" }, digest: `sha256:${"d".repeat(64)}` };
    const draft = buildActionRuleAuthorityDraft({ name: fixture.draft.authority.name,
      action_boundary_name: fixture.draft.authority.action_boundary.name, catalog: fixture.draft.authority.catalog,
      reviews: fixture.draft.reviews, approval_classes: fixture.draft.authority.approval_classes,
      rules: fixture.draft.authority.rules.map(({ activated_at: _time, ...rule }, index) => index === 0 ? rule : ({ ...rule,
        read_boundary_name: foreign.pack.name, read_boundary_digest: foreign.digest as `sha256:${string}`,
        effect_envelope: { ...rule.effect_envelope, writeback: executable ? rule.effect_envelope.writeback : { mode: "none", supervised_worker: "disabled" } } })) });
    const inspection = writerInspection("dedicated", "status");
    reviewedRls(inspection);
    if (executable) inspection.tables[0]!.role_posture!.column_privileges!.update!.push("priority");
    const inspect = vi.fn(async () => inspection);
    const input = { draft, engine: "postgres" as const, readUrlEnv: "DATABASE_URL",
      env: { SYNAPSOR_DATABASE_WRITE_URL: "postgresql://test" }, inspect };
    if (executable) {
      await expect(inspectDraftSemanticWriter({ ...input, reads: [fixture.reviewedRead] })).rejects.toThrow(/READ_SCOPE_STALE/);
      expect(inspect).not.toHaveBeenCalled();
    }
    const result = await inspectDraftSemanticWriter({ ...input, reads: executable ? [fixture.reviewedRead, foreign] : [fixture.reviewedRead] });
    expect(result!.assessment.ok).toBe(true);
    expect(result!.outcomes).toHaveLength(executable ? 2 : 1);
  });
});

describe("separate exact semantic writers", () => {
  it.each(["same_reference", "same_value"])("refuses the reader as a writer before inspection or publication (%s)", async (kind) => {
    const fixture = await activeProject("human", true);
    const configBefore = await fs.readFile(fixture.configPath, "utf8");
    const reader = JSON.parse(configBefore).sources.local_postgres.read_url_env;
    const writeUrlEnv = kind === "same_reference" ? reader : "DUPLICATE_READER_URL";
    const env = { [reader]: "postgresql://reader-private", [writeUrlEnv]: "postgresql://reader-private" };
    const inspect = vi.fn(async () => writerInspection("narrow-but-shared", "priority"));
    const input = { projectRoot: fixture.root, outcome: "billing.set_priority", profile: "staging" as const,
      writeUrlEnv, env, inspect };
    await expect(previewSemanticSupervisedExecution(input)).rejects.toThrow(/SEMANTIC_ACTION_WRITER_READER_CONNECTION/);
    await expect(enableSemanticSupervisedExecution({ ...input,
      expectedActionBoundaryDigest: fixture.draft.authority.action_boundary.digest,
      expectedConfigDigest: canonicalJsonDigest(JSON.parse(configBefore)),
      expectedWriterPostureFingerprint: canonicalJsonDigest({}), confirmation: "not reached" })).rejects.toThrow(/SEMANTIC_ACTION_WRITER_READER_CONNECTION/);
    expect(inspect).not.toHaveBeenCalled();
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
  });

  it("exports a stable action-specific writer instead of replacing a connection used by another action", async () => {
    const fixture = await activeProject("human", true);
    const inspection = writerInspection("reader", "priority");
    reviewedRls(inspection);
    const env = { DATABASE_URL: "postgresql://reader", SYNAPSOR_DATABASE_WRITE_URL: "postgresql://first" };
    const input = { projectRoot: fixture.root, outcome: "billing.set_priority",
      reads: [fixture.reviewedRead], env, inspect: async () => inspection };
    const before = await prepareSemanticWriterHandoff(input);
    expect(before.plan.writer_env).not.toBe("SYNAPSOR_DATABASE_WRITE_URL");
    expect(before.plan.relations[0]!.update_columns).toEqual(["priority", "version"]);
    await enableWriter(fixture.root, "billing.pause_notifications", "SYNAPSOR_DATABASE_WRITE_URL", writerInspection("first", "status"), env);
    const configBefore = await fs.readFile(fixture.configPath, "utf8");
    const after = await prepareSemanticWriterHandoff({ ...input, writeUrlEnv: "SYNAPSOR_DATABASE_WRITE_URL" });
    expect(after.plan.writer_env).toBe(before.plan.writer_env);
    expect(after.plan.relations).toEqual(before.plan.relations);
    expect(after.plan.outcomes).toEqual(["billing.set_priority"]);
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
  });

  it("rejects rebinding another action's writer and offers a per-action repair that can enable both", async () => {
    const fixture = await activeProject("human", true);
    const env = { SYNAPSOR_DATABASE_WRITE_URL: "postgresql://first" };
    const first = await enableWriter(fixture.root, "billing.pause_notifications", "SYNAPSOR_DATABASE_WRITE_URL", writerInspection("first", "status"), env);
    const configBefore = await fs.readFile(fixture.configPath, "utf8");
    const rebound = writerInspection("replacement", "priority");
    reviewedRls(rebound);
    // The replacement has enough grants for both, but is not the reviewed credential.
    rebound.tables[0]!.role_posture!.column_privileges!.update!.push("status");
    const error = await previewSemanticSupervisedExecution({ projectRoot: fixture.root, outcome: "billing.set_priority",
      profile: "staging", writeUrlEnv: "SYNAPSOR_DATABASE_WRITE_URL", env, inspect: async () => rebound }).catch(value => value);
    expect(error).toBeInstanceOf(SemanticWriterPostureError);
    expect(error.problem.details.join("\n")).toContain("writer_shared_connection_changed");
    expect(error.provisioning.relations[0].update_columns).toEqual(["priority", "version"]);
    expect(error.provisioning.writer_env).not.toBe("SYNAPSOR_DATABASE_WRITE_URL");
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
    const ownEnv = error.provisioning.writer_env;
    const second = await enableWriter(fixture.root, "billing.set_priority", ownEnv, writerInspection("second", "priority"),
      { ...env, [ownEnv]: "postgresql://second" });
    const config = resolveRuntimeConfig(await loadRuntimeConfigFromFile(fixture.configPath));
    expect(config.supervised_worker!.outcomes).toEqual([first.policy, second.policy]);
    const { registry } = await loadActiveActionRuleAuthority(fixture.root);
    expect(assessSemanticSupervisedWriterPosture(config, first.policy, registry, writerInspection("first", "status")).ok).toBe(true);
    expect(assessSemanticSupervisedWriterPosture(config, second.policy, registry, writerInspection("second", "priority")).ok).toBe(true);
  });

  it("keeps shared-connection failure requirements distinct from dedicated replacement instructions", async () => {
    const fixture = await activeProject("human", true);
    const env = { SYNAPSOR_DATABASE_WRITE_URL: "postgresql://first" };
    const inspection = writerInspection("first", "status");
    reviewedRls(inspection);
    await enableWriter(fixture.root, "billing.pause_notifications", "SYNAPSOR_DATABASE_WRITE_URL", inspection, env);
    const error = await previewSemanticSupervisedExecution({ projectRoot: fixture.root, outcome: "billing.set_priority",
      profile: "staging", writeUrlEnv: "SYNAPSOR_DATABASE_WRITE_URL", env, inspect: async () => inspection }).catch(value => value);
    expect(error).toBeInstanceOf(SemanticWriterPostureError);
    expect(error.problem.details.join("\n")).toContain("priority, status, version");
    expect(error.provisioning.relations[0].update_columns).toEqual(["priority", "version"]);
    expect(error.provisioning.outcomes).toEqual(["billing.set_priority"]);
    expect(error.problem.details.join("\n")).toContain(error.provisioning.writer_env);
  });

  it("preserves the first enabled outcome after missing credentials, declined consent, posture drift, or stale config", async () => {
    const fixture = await activeProject("human", true);
    const env = { FIRST_WRITER_URL: "postgresql://first-test-writer", SECOND_WRITER_URL: "postgresql://second-test-writer" };
    await enableWriter(fixture.root, "billing.pause_notifications", "FIRST_WRITER_URL", writerInspection("first", "status"), env);
    const before = await fs.readFile(fixture.configPath, "utf8");
    const inspect = vi.fn(async () => writerInspection("second", "priority"));
    const input = { projectRoot: fixture.root, outcome: "billing.set_priority", writeUrlEnv: "SECOND_WRITER_URL",
      profile: "staging" as const, workerIdentity: "semantic_action_worker", env, inspect };
    await expect(previewSemanticSupervisedExecution({ ...input, env: {} })).rejects.toThrow(/WRITER_URL_MISSING/);
    expect(inspect).not.toHaveBeenCalled();
    const preview = await previewSemanticSupervisedExecution(input);
    const enable = { ...input, expectedActionBoundaryDigest: preview.action_boundary_digest,
      expectedConfigDigest: preview.current_config_digest, expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
      confirmation: semanticExecutionConfirmation(preview) };
    await expect(enableSemanticSupervisedExecution({ ...enable, confirmation: "declined" })).rejects.toThrow(/CONFIRMATION_REQUIRED/);
    await expect(enableSemanticSupervisedExecution({ ...enable, inspect: async () => writerInspection("changed-role", "priority") }))
      .rejects.toThrow(/WRITER_POSTURE_CHANGED/);
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(before);
    const changed = JSON.parse(before);
    changed.sources.local_postgres.statement_timeout_ms = 1234;
    await fs.writeFile(fixture.configPath, JSON.stringify(changed));
    await expect(enableSemanticSupervisedExecution(enable)).rejects.toThrow(/CONFIG_CHANGED/);
    expect(JSON.parse(await fs.readFile(fixture.configPath, "utf8"))).toEqual(changed);
  });

  it("enables two outcomes without replacing the first writer or widening either writer's columns", async () => {
    const fixture = await activeProject("human", true);
    const env = { FIRST_WRITER_URL: "postgresql://first-test-writer", SECOND_WRITER_URL: "postgresql://second-test-writer" };
    const authorityBefore = await Promise.all(fixture.authorityPaths.map((file) => fs.readFile(file, "utf8")));
    const first = await enableWriter(fixture.root, "billing.pause_notifications", "FIRST_WRITER_URL", writerInspection("first", "status"), env);
    const firstConfig = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    const second = await enableWriter(fixture.root, "billing.set_priority", "SECOND_WRITER_URL", writerInspection("second", "priority"), env);
    const config = resolveRuntimeConfig(await loadRuntimeConfigFromFile(fixture.configPath));
    expect(config.sources!.local_postgres).toEqual(firstConfig.sources.local_postgres);
    expect(config.supervised_worker!.outcomes).toEqual([first.policy, second.policy]);
    const { registry } = await loadActiveActionRuleAuthority(fixture.root);
    for (const [outcome, policy, inspection] of [
      ["billing.pause_notifications", first.policy, writerInspection("first", "status")],
      ["billing.set_priority", second.policy, writerInspection("second", "priority")],
    ] as const) {
      const activated = resolveActivatedActionRule(registry, outcome);
      expect(resolveSemanticSupervisedWorkerEligibility(config, activated, { workerIdentity: "semantic_action_worker" }).eligible).toBe(true);
      expect(assessSemanticSupervisedWriterPosture(config, policy, registry, inspection).ok).toBe(true);
      inspection.tables[0]!.role_posture!.column_privileges!.update!.push(outcome === "billing.set_priority" ? "status" : "priority");
      expect(assessSemanticSupervisedWriterPosture(config, policy, registry, inspection).reasons).toContain("writer_excess_column_privilege");
    }
    expect(await Promise.all(fixture.authorityPaths.map((file) => fs.readFile(file, "utf8")))).toEqual(authorityBefore);
    expect(JSON.stringify(config)).not.toContain("postgresql://");
  });
});

async function enableWriter(root: string, outcome: string, writeUrlEnv: string, inspection: SchemaInspection, env: NodeJS.ProcessEnv) {
  const input = { projectRoot: root, outcome, profile: "staging" as const, writeUrlEnv,
    workerIdentity: "semantic_action_worker", env, inspect: async () => inspection };
  const preview = await previewSemanticSupervisedExecution(input);
  return enableSemanticSupervisedExecution({ ...input, expectedActionBoundaryDigest: preview.action_boundary_digest,
    expectedConfigDigest: preview.current_config_digest, expectedWriterPostureFingerprint: preview.writer_posture_fingerprint,
    confirmation: semanticExecutionConfirmation(preview) });
}

function writerInspection(role: string, field: string): SchemaInspection {
  return { engine: "postgres", server_version: "PostgreSQL 16", current_user: role, inspected_at: "2026-09-08T00:00:00.000Z",
    schemas: ["billing"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: false, writable_relations: ["billing.preferences"], owned_relations: [], reasons: [] },
    tables: [{ schema: "billing", name: "preferences", row_level_security: false,
      role_posture: { privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        column_privileges: { update: [field, "version"] } } } as SchemaInspection["tables"][number]],
  };
}

function reviewedRls(inspection: SchemaInspection): void {
  const table = inspection.tables[0]!;
  table.type = "table";
  table.columns = ["preference_id", "account_id", "principal_id", "status", "version", "priority"].map(name => ({ name })) as typeof table.columns;
  table.row_level_security = true;
  const expression = "account_id = current_setting('synapsor.tenant_id')";
  table.row_level_security_policies = ["SELECT", "UPDATE"].map(command => ({ name: command, command,
    permissive: true, roles: ["public"], using_expression: expression, check_expression: expression }));
  Object.assign(table.role_posture!, { current_role_is_owner: false, current_role_can_assume_owner: false,
    row_security_forced: true, row_security_effective_for_current_role: true, row_security_update_permitted: true,
    row_security_applicable_policies: ["SELECT", "UPDATE"] });
}

async function activeProject(approvalMode: "human" | "policy" = "human", twoOutcomes = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mixed-active-")); roots.push(root);
  const lock = `sha256:${"a".repeat(64)}` as const;
  const stringType = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const stateType = { ...stringType, enum: ["active", "paused"] };
  const catalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: lock,
    resources: [{ name: "billing.preferences", source: "local_postgres", engine: "postgres", schema: "billing", table: "preferences",
      primary_key: "preference_id", tenant_key: "account_id", principal_scope_key: "principal_id", version_field: "version",
      fields: ["preference_id", "account_id", "principal_id"].map((name) => ({ name, type: stringType, nullable: false }))
        .concat([{ name: "status", type: stateType, nullable: false }]) }], relationships: [],
  };
  catalog.resources[0]!.fields.push({ name: "version", type: { kind: "integer" }, nullable: false });
  if (twoOutcomes) catalog.resources[0]!.fields.push({ name: "priority", type: { kind: "integer" }, nullable: false });
  const verification: RuleVerificationBoundarySpecV1 = {
    schema_version: "synapsor.verification-boundary.v1", name: "billing.pause_verification", source: "local_postgres",
    context: "trusted_context", generation_lock_fingerprint: lock,
    resources: [{ binding: "preference", resource: "billing.preferences", source: { kind: "subject_ref" },
      primary_key: "preference_id", version_field: "version", fields: catalog.resources[0]!.fields,
      scope: { mode: "columns", tenant_field: "account_id", principal_field: "principal_id" },
      cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" }],
    lock_order: ["preference"], transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const envelope: DerivedEffectEnvelopeSpecV1 = {
    schema_version: "synapsor.derived-effect-envelope.v1", name: "billing.pause_effect", source: "local_postgres",
    operation: "update", target_resource: "billing.preferences", target_binding: "preference", primary_key: "preference_id",
    tenant_key: "account_id", principal_scope_key: "principal_id", conflict_key: "version", max_rows: 1,
    allowed_fields: [{ name: "status", type: stateType, values: ["paused"] }],
    version_advance: { column: "version", strategy: "integer_increment" }, approval_classes: ["billing.standard_change"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const rule: ActionRuleSpecV1 = {
    schema_version: "synapsor.action-rule.v1", name: "billing.pause_notifications", outcome: "billing.pause_notifications",
    context: "trusted_context", source: "local_postgres", verification_boundary_ref: verification.name, effect_envelope_ref: envelope.name,
    subjects: [{ binding: "preference", resource: "billing.preferences", input: "opaque_subject_ref" }],
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "preference", field: "status" },
      right: { kind: "literal", value: "active", value_type: stateType } }, derive: {},
    effect: { operation: "update", target_resource: "billing.preferences", target_binding: "preference",
      set: { status: { kind: "literal", value: "paused", value_type: stateType } } },
    approval_class: "billing.standard_change", ttl_seconds: 300,
  };
  const read = { schema_version: "synapsor.exploration-boundary.v1", activation: "reviewed",
    deployment_profile: "staging", source: "local_postgres", compiler_version: "test", spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
    generation_lock_fingerprint: lock, role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    pack: { name: "reviewed_billing", resources: [{ id: "billing.preferences", schema: "billing", table: "preferences", primary_key: "preference_id", tenant_key: "account_id", principal_key: "principal_id",
      field_types: { status: "text", version: "integer" }, field_enums: {}, selectable_fields: ["status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["preference_id", "account_id", "principal_id", "version"], relationships: [], minimum_cohort_size: 1, suppression_aware_totals: true as const,
      rls_session: { tenant_setting: "synapsor.tenant_id" } }] }, budgets: { max_rows: 50, max_response_cells: 500 } };
  const digest = canonicalJsonDigest(read);
  const activeRead = { ...read, activation: { state: "active", digest, actor: "test", activated_at: "2026-09-08T19:00:00.000Z",
    generation_lock_fingerprint: lock, reviewed_decisions: [] } };
  await fs.mkdir(path.join(root, ".synapsor"));
  const readPath = path.join(root, ".synapsor/exploration-boundaries.active.json");
  await fs.writeFile(readPath, JSON.stringify({ schema_version: "synapsor.active-exploration-boundaries.v1",
    selected_name: read.pack.name, boundaries: [activeRead], updated_at: activeRead.activation.activated_at }));
  await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify({ version: 1, mode: "read_only",
    storage: { sqlite_path: "./.synapsor/local.db" }, trusted_context: { provider: "environment" }, capabilities: [],
    sources: { local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL", read_only: true } } }));
  const draft = buildActionRuleAuthorityDraft({ name: "billing_rules", action_boundary_name: "billing_actions", catalog,
    rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: digest, verification_boundary: verification, effect_envelope: envelope, rule },
      ...(twoOutcomes ? [{ read_boundary_name: read.pack.name, read_boundary_digest: digest, verification_boundary: verification,
        effect_envelope: { ...envelope, name: "billing.priority_effect", allowed_fields: [{ name: "priority", type: { kind: "integer" as const }, values: [1] }] },
        rule: { ...rule, name: "billing.set_priority", outcome: "billing.set_priority", effect_envelope_ref: "billing.priority_effect",
          effect: { ...rule.effect, set: { priority: { kind: "literal" as const, value: 1, value_type: { kind: "integer" as const } } } } } }] : [])],
    ...(approvalMode === "policy" ? { approval_classes: [{ name: rule.approval_class, mode: "policy" as const,
      rules: [{ outcome: rule.outcome, auto_approve_when: rule.require }], required_role: "billing_reviewer", required_approvals: 1,
      shared_limits: [{ id: "overall", kind: "count" as const, scope: "boundary" as const, maximum: 10, window_seconds: 3600 },
        { id: "account", kind: "count" as const, scope: "tenant" as const, maximum: 2, window_seconds: 3600 }] }] } : {}),
    reviews: [{ outcome: rule.outcome, when: "Preference is active", then: "Propose pausing notifications",
      refused: ["Preference is already paused"], human_review: "One billing reviewer must approve", examples: [
        { kind: "eligible", scenario: "Active preference", result: "Create proposal" },
        { kind: "ineligible", scenario: "Paused preference", result: "Refuse" },
      ] }, ...(twoOutcomes ? [{ outcome: "billing.set_priority", when: "Preference is active", then: "Set priority to one",
        refused: ["Preference is paused"], human_review: "One reviewer must approve", examples: [
          { kind: "eligible" as const, scenario: "Active preference", result: "Create proposal" },
          { kind: "ineligible" as const, scenario: "Paused preference", result: "Refuse" }] }] : [])] });
  await writeActionRuleAuthorityDraft(root, draft);
  await activateSemanticActionRuntime({ projectRoot: root, draft, actor: "test reviewer" });
  const configPath = path.join(root, "synapsor.actions.runner.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  delete config.sources.local_postgres.database_scope;
  await fs.writeFile(configPath, JSON.stringify(config));
  const activePath = path.join(root, ".synapsor/action-rules/active.json");
  const revisionPath = path.join(root, ".synapsor/action-rules/revisions", draft.digest.slice("sha256:".length), "authority.json");
  return { root, configPath, readPath, activePath, revisionPath, authorityPaths: [readPath, activePath, revisionPath], draft,
    reviewedRead: { pack: read.pack as Parameters<typeof inspectDraftSemanticWriter>[0]["reads"][number]["pack"], digest } };
}
