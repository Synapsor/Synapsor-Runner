import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActionRuleApprovalClasses, createActionRuleRegistry, evaluateSemanticActionEligibility } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest, type NormalizedWritebackJobV5 } from "@synapsor-runner/protocol";
import { createDelegatedSemanticRuntime, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { postgresControlPolicyRepository, sqliteControlPolicyRepository, type ControlPolicyKey, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { createPostgresActionRuleFactLoader, applyPostgresJob } from "@synapsor-runner/postgres";
import type { ApplyAdapter, RunnerConfig } from "@synapsor-runner/worker-core";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import { compileOwnerPolicy } from "../../../packages/mcp-server/src/owner-policy-compiler.js";
import type { PolicyManagementParent } from "../../../packages/mcp-server/src/owner-policy-records.js";
import { applyRuntimeDatabaseJob } from "./delegated-writeback.js";
import { openBoundProjectControlPolicies, assertProjectControlPolicyBinding } from "./control-policy-store.js";
import { createActiveActionRuleAuthorityLoader } from "./action-rule-authority.js";

vi.mock("./control-policy-store.js", () => ({ openBoundProjectControlPolicies: vi.fn(), assertProjectControlPolicyBinding: vi.fn() }));
vi.mock("./action-rule-authority.js", () => ({ createActiveActionRuleAuthorityLoader: vi.fn() }));
const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
afterEach(() => vi.resetAllMocks());

// The locator and already-reviewed Action loader are injected. Both policy
// backends, fact queries, source transactions, one-use admission and receipts
// are real; every physical source/control schema belongs to this test.
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(!url)(`delegated database execution: ${backend} control`, () => {
    async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, coded = false) {
      const f = await setup(coded);
      try { await run(f); } finally {
        f.db?.close();
        try { await f.pool.query(`DROP SCHEMA IF EXISTS "${f.schema}" CASCADE; DROP SCHEMA IF EXISTS "${f.controlSchema}" CASCADE`); }
        finally { await f.pool.end(); }
      }
    }
    async function setup(coded: boolean) {
      const schema = `source_del_${randomBytes(6).toString("hex")}`, controlSchema = `control_del_${randomBytes(6).toString("hex")}`;
      const f = ownerPolicyTestFixture(schema, coded), pool = new Pool({ connectionString: url, max: 6 });
      const table = f.compiled.target_resource.table;
      await pool.query(`CREATE SCHEMA "${schema}"; CREATE TABLE "${schema}"."${table}" (
        id text PRIMARY KEY, tenant_id text NOT NULL, principal_id text NOT NULL, version integer NOT NULL,
        "${f.amount}" integer NOT NULL, available boolean NOT NULL, category text NOT NULL, expires_at timestamptz NOT NULL)`);
      await pool.query(`INSERT INTO "${schema}"."${table}" VALUES
        ('request-1','acme','maya',1,5,true,'routine','2030-01-01'),
        ('request-2','acme','maya',1,5,true,'routine','2030-01-01')`);
      const db = backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
      db?.exec("PRAGMA foreign_keys = ON");
      const repository = db ? sqliteControlPolicyRepository(db) : postgresControlPolicyRepository(pool, controlSchema);
      await repository.initialize();
      f.parent.budgets = [{ meter: "units", title: "Units", scope: "tenant", unit: "units", scale: 1, maximum: 30, window_ms: 86_400_000 }];
      f.parent.outcomes[0]!.budget_charges = [{ meter: "units", kind: "effect_field", field: f.amount }];
      f.definition.budget_limits = [{ meter: "units", maximum: 25 }];
      const owner = { level: "principal" as const, tenant_id: "acme", principal: "maya" }, deployment = randomUUID();
      const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: "workload_policy" };
      const ownerKey: ControlPolicyKey = { scope: owner, kind: "delegation", name: "owner_rules" };
      const parentDocument: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", managers: [], delegation: f.parent,
        agent_owners: [{ agent: "agent-a", scope: owner }], runtime_delegations: [{ agent: "agent-a", delegator: "maya", owner,
          policies: [{ scope: owner, name: ownerKey.name }], expires_at: new Date(Date.now() + 300_000).toISOString() }] };
      const make = (key: ControlPolicyKey, content: unknown, authority_digest: string = canonicalJsonDigest(content)): ControlPolicyRevision => ({ ...key,
        revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest });
      const parent = make(parentKey, parentDocument), compiled = compileOwnerPolicy({ parent: { ...f.parent, agents: ["agent-a"] }, definition: f.definition, rules: [f.compiled] });
      const policy = make(ownerKey, { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
        parent_revision_id: parent.revision_id, parent_authority_digest: parent.authority_digest,
        definition: f.definition, compiled_digest: compiled.digest }, compiled.digest);
      const event = () => ({ event_id: randomUUID(), actor: "test-reviewed-operator", occurred_at: new Date().toISOString(), receipt: {} });
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest(deployment),
        revisions: [parent, policy], active: [parent, policy], event: event() });
      const runtime = createDelegatedSemanticRuntime({ repository, deployment_id: deployment, parent_name: parentKey.name,
        resolveRules: async () => [f.compiled], authenticate: async () => ({ subject: "workload", tenant_id: "acme", principal: "maya", agent_id: "agent-a",
          delegator: "maya", run_id: "periodic-run", actor_digest: canonicalJsonDigest("verified workload"), expires_at_ms: Date.now() + 120_000 }) });
      const registry = createActionRuleRegistry({ name: "actions", rules: [{ compiled: f.compiled,
        read_boundary_name: "read", read_boundary_digest: canonicalJsonDigest("read"), action_boundary_name: "actions",
        action_boundary_digest: canonicalJsonDigest("actions"), activated_at: new Date().toISOString() }],
        approval_classes: createActionRuleApprovalClasses({ rules: [f.compiled], sources: [{ name: f.compiled.approval_class,
          mode: "policy", rules: [{ outcome: f.compiled.outcome, auto_approve_when: f.compiled.rule.require }],
          required_role: "reviewer", required_approvals: 1, shared_limits: [
            { id: "overall", kind: "count", scope: "capability", capability: f.compiled.outcome, maximum: 10, window_seconds: 86_400 },
            { id: "owner", kind: "count", scope: "tenant_principal", capability: f.compiled.outcome, maximum: 3, window_seconds: 86_400 },
          ] }] }) });
      vi.mocked(openBoundProjectControlPolicies).mockResolvedValue({ repository, deployment_id: deployment, repository_id: "test-repo", project_id: deployment, close: async () => undefined });
      vi.mocked(assertProjectControlPolicyBinding).mockResolvedValue();
      vi.mocked(createActiveActionRuleAuthorityLoader).mockReturnValue(async () => ({ registry }) as never);
      const runtimeConfig: RuntimeConfig = { version: 1, mode: "review", action_rules: { project_root: ".", owner_delegation: {
        parent_name: parentKey.name, credential_env: "TOKEN", authentication: { provider: "jwt_hs256", issuer: "backend", audience: "workloads", secret_env: "KEY" } } }, capabilities: [] };
      const runnerConfig: RunnerConfig = { controlPlaneUrl: "http://localhost", runnerToken: "not-used", runnerId: "test-executor", sourceId: "local_postgres",
        databaseUrl: url!, engine: "postgres", pollIntervalMs: 1000, statementTimeoutMs: 5000, logLevel: "error", dryRun: false, stateDir: "/unused",
        receipts: { authority: "source_db", provisioning: "auto_migrate", schema, table: "receipts" } };
      const adapter: ApplyAdapter = { doctor: async () => ({ ok: true, details: {} }), apply: applyPostgresJob };
      async function propose(id = "request-1", quantity = 15) {
        const context = await runtime.begin("verified-backend-test"), proposalId = `proposal_${randomUUID()}`;
        const client = await pool.connect();
        let decision;
        try {
          await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          decision = await evaluateSemanticActionEligibility({ registry, outcome: f.compiled.outcome, inputs: { quantity },
            subjects: [{ binding: "request", resource: f.resource, primary_key: { column: "id", value: id }, subject_ref_digest: canonicalJsonDigest(id) }],
            trusted: { tenant: "acme", principal: "maya", transaction_time: new Date().toISOString() },
            adapter: createPostgresActionRuleFactLoader(client), proposal_id: proposalId, trusted_context_digest: canonicalJsonDigest("trusted"),
            evidence_provenance_digest: canonicalJsonDigest("evidence"), check_delegation: context.checkProposal });
        } finally { await client.query("ROLLBACK"); client.release(); }
        if (decision.result !== "eligible") throw new Error("Test proposal refused");
        const effect = decision.semantic_authority.effect;
        const version = (await pool.query(`SELECT version FROM "${schema}"."${table}" WHERE id=$1`, [id])).rows[0].version;
        return { protocol_version: "5.0", job_id: `job_${proposalId}`, proposal_id: proposalId,
          approval_id: canonicalJsonDigest("trusted-approval"), proposal_hash: canonicalJsonDigest(proposalId), source_id: effect.source, engine: "postgres", operation: effect.operation,
          target: { schema, table, primary_key: effect.primary_key, tenant_guard: effect.tenant_guard,
            principal_scope: { schema_version: "synapsor.principal-scope.v1", column: "principal_id", binding: "principal", provider: "environment",
              value: "maya", value_fingerprint: canonicalJsonDigest("maya") } },
          allowed_columns: effect.allowed_columns, patch: effect.set, conflict_guard: { kind: "version_column", column: "version", expected_value: version },
          version_advance: effect.version_advance, semantic_authority: decision.semantic_authority,
          idempotency_key: `semantic:${proposalId}`, lease_expires_at: new Date(Date.now() + 120_000).toISOString(), attempt_count: 1 } satisfies NormalizedWritebackJobV5;
      }
      const execute = (job: NormalizedWritebackJobV5, selectedAdapter = adapter, config = runnerConfig) => applyRuntimeDatabaseJob({ job, adapter: selectedAdapter,
        runnerConfig: config, runtimeConfig, configPath: "/test/runtime.json" });
      const usage = () => repository.budgets.inspect({ deployment_id: deployment, account: { scope: { level: "tenant", tenant_id: "acme" },
        meter: "units", unit: "units", scale: 1, limit: 25, window_ms: 86_400_000 } });
      const revoke = async () => repository.commit({ deployment_id: deployment, expected_epoch: (await repository.deployment(deployment))!.epoch,
        revisions: [], active: [{ ...ownerKey, revision_id: null }], event: event() });
      return { ...f, pool, db, schema, controlSchema, repository, deployment, propose, execute, usage, revoke, adapter, runnerConfig };
    }

    it("settles actual source receipts once and reconciles replay after revocation", async () => fixture(async (f) => {
      const job = await f.propose();
      expect(await f.execute(job)).toMatchObject({ status: "applied", affected_rows: 1 });
      expect(await f.usage()).toMatchObject({ committed: 15, reserved: 0 });
      const queued = await f.propose("request-2", 5);
      await f.revoke();
      expect(await f.execute(job)).toMatchObject({ status: "already_applied", affected_rows: 0 });
      expect(await f.usage()).toMatchObject({ committed: 15, reserved: 0 });
      expect(await f.execute(queued)).toMatchObject({ status: "failed", affected_rows: 0 });
      expect((await f.pool.query(`SELECT "${f.amount}", version FROM "${f.schema}"."${f.compiled.target_resource.table}" WHERE id='request-2'`)).rows[0]).toMatchObject({ [f.amount]: 5, version: 1 });
    }, true));

    it("holds unknown effects until the exact source receipt is recovered", async () => fixture(async (f) => {
      const job = await f.propose();
      const lostAck: ApplyAdapter = { ...f.adapter, apply: async (j, c) => { await f.adapter.apply(j, c); throw new Error("lost source acknowledgment"); } };
      await expect(f.execute(job, lostAck)).rejects.toThrow("lost source acknowledgment");
      expect(await f.usage()).toMatchObject({ reserved: 15, committed: 0 });
      await f.revoke();
      expect(await f.execute(job)).toMatchObject({ status: "already_applied" });
      expect(await f.usage()).toMatchObject({ committed: 15, reserved: 0 });
    }));

    it("reserves a shared cap before mutation and never charges a dry run", async () => fixture(async (f) => {
      const first = await f.propose(), second = await f.propose("request-2");
      expect(await f.execute(first, f.adapter, { ...f.runnerConfig, dryRun: true })).toMatchObject({ status: "failed", affected_rows: 0 });
      expect(await f.usage()).toMatchObject({ committed: 0, reserved: 0 });
      const results = await Promise.all([f.execute(first), f.execute(second)]);
      expect(results.filter((r) => r.status === "applied")).toHaveLength(1);
      expect(results.filter((r) => r.status === "failed")).toHaveLength(1);
      expect(await f.usage()).toMatchObject({ committed: 15, reserved: 0 });
      const rows = (await f.pool.query(`SELECT version FROM "${f.schema}"."${f.compiled.target_resource.table}"`)).rows;
      expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
    }));
  });
}
