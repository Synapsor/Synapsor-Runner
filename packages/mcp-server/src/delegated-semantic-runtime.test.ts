import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createActionRuleApprovalClasses, createActionRuleRegistry, createSemanticActionVerifier, evaluateSemanticActionEligibility } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest, type NormalizedWritebackJobV5 } from "@synapsor-runner/protocol";
import { postgresControlPolicyRepository, sqliteControlPolicyRepository, type ControlPolicyKey, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { createDelegatedSemanticExecutor, createDelegatedSemanticRuntime } from "./delegated-semantic-runtime.js";
import { compileOwnerPolicy } from "./owner-policy-compiler.js";
import { ownerPolicyTestFixture } from "./owner-policy-test-fixture.js";
import type { PolicyManagementParent } from "./owner-policy-records.js";
import type { OwnerRuntimeIdentity } from "./owner-runtime-identity.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !url)(`delegated semantic runtime: ${backend}`, () => {
    let pool: Pool;
    const connections: DatabaseSync[] = [], schema = `delegated_run_${process.pid}_${randomBytes(4).toString("hex")}`;
    beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 4 }); });
    afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); });
    afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });
    async function fixture(domain = "inventory", coded = false, withBudget = false) {
      const f = ownerPolicyTestFixture(domain, coded), deployment = randomUUID();
      if (withBudget) {
        f.parent.budgets = [{ meter: "allocated_units", title: "Allocated units", scope: "tenant", unit: "units", scale: 1, maximum: 30, window_ms: 86_400_000 }];
        f.parent.outcomes[0]!.budget_charges = [{ meter: "allocated_units", kind: "effect_field", field: f.amount }];
        f.definition.budget_limits = [{ meter: "allocated_units", maximum: 25 }];
        f.definition.agents = ["agent-a", "agent-b"];
      }
      const db = backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
      if (db) { connections.push(db); db.exec("PRAGMA foreign_keys = ON"); }
      const repository = db ? sqliteControlPolicyRepository(db) : postgresControlPolicyRepository(pool, schema);
      await repository.initialize();
      const owner = { level: "principal" as const, tenant_id: "acme", principal: "maya" };
      const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: "workload_policy" };
      const ownerKey: ControlPolicyKey = { scope: owner, kind: "delegation", name: "owner_rules" };
      const parentDocument: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", managers: [], delegation: f.parent,
        agent_owners: f.definition.agents.map((agent) => ({ agent, scope: owner })), runtime_delegations: f.definition.agents.map((agent) => ({ agent, delegator: "maya", owner,
          policies: [{ scope: owner, name: ownerKey.name }], expires_at: new Date(Date.now() + 90_000).toISOString() })) };
      const make = (key: ControlPolicyKey, content: unknown, authority_digest: string = canonicalJsonDigest(content)): ControlPolicyRevision => ({ ...key,
        revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest });
      const scopedParent = { ...f.parent, agents: f.definition.agents };
      const parent = make(parentKey, parentDocument), compiledOwner = compileOwnerPolicy({ parent: scopedParent, definition: f.definition, rules: [f.compiled] });
      const policy = make(ownerKey, { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
        parent_revision_id: parent.revision_id, parent_authority_digest: parent.authority_digest,
        definition: f.definition, compiled_digest: compiledOwner.digest }, compiledOwner.digest);
      const event = () => ({ event_id: randomUUID(), actor: "authenticated-test-operator", occurred_at: new Date().toISOString(), receipt: {} });
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest(deployment),
        revisions: [parent, policy], active: [parent, policy], event: event() });
      const actor: OwnerRuntimeIdentity = { subject: "agent-workload", tenant_id: "acme", principal: "maya", agent_id: "agent-a", delegator: "maya", run_id: "run-1",
        actor_digest: canonicalJsonDigest("verified-run-1"), expires_at_ms: Date.now() + 120_000 };
      const authenticate = vi.fn(async (_credential: string) => structuredClone(actor));
      const options = { repository, deployment_id: deployment, parent_name: parentKey.name, resolveRules: async () => [f.compiled] };
      const runtime = createDelegatedSemanticRuntime({ ...options, authenticate });
      const registry = createActionRuleRegistry({ name: "reviewed_actions", rules: [{ compiled: f.compiled,
        read_boundary_name: "read", read_boundary_digest: canonicalJsonDigest("read"), action_boundary_name: "actions",
        action_boundary_digest: canonicalJsonDigest("actions"), activated_at: new Date().toISOString() }],
        approval_classes: createActionRuleApprovalClasses({ rules: [f.compiled], sources: [{ name: f.compiled.approval_class,
          mode: "policy", rules: [{ outcome: f.compiled.outcome, auto_approve_when: f.compiled.rule.require }],
          required_role: "reviewer", required_approvals: 1, shared_limits: [
            { id: "overall", kind: "count", scope: "capability", capability: f.compiled.outcome, maximum: 10, window_seconds: 86_400 },
            { id: "owner", kind: "count", scope: "tenant_principal", capability: f.compiled.outcome, maximum: 3, window_seconds: 86_400 },
          ] }] }) });
      const adapter = { engine: "postgres" as const, load: vi.fn(async () => structuredClone(f.facts.bindings.request!.rows)) };
      async function propose(quantity = 10, proposalId = `proposal_${randomUUID()}`, credential = "private-bearer-test") {
        const context = await runtime.begin(credential);
        const decision = await evaluateSemanticActionEligibility({ registry, outcome: f.compiled.outcome, inputs: { quantity },
          subjects: [{ binding: "request", resource: f.resource, primary_key: { column: "id", value: "request-1" }, subject_ref_digest: canonicalJsonDigest("ref") }],
          trusted: f.facts.trusted, adapter, proposal_id: proposalId, trusted_context_digest: canonicalJsonDigest("trusted"),
          evidence_provenance_digest: canonicalJsonDigest("evidence"), check_delegation: context.checkProposal });
        if (decision.result !== "eligible") throw new Error("Fixture not eligible");
        const effect = decision.semantic_authority.effect;
        const job: NormalizedWritebackJobV5 = { protocol_version: "5.0", job_id: `job_${proposalId}`, proposal_id: proposalId,
          approval_id: canonicalJsonDigest("approval"), proposal_hash: canonicalJsonDigest("proposal"), source_id: effect.source, engine: "postgres", operation: effect.operation,
          target: { schema: effect.schema, table: effect.table, primary_key: effect.primary_key, tenant_guard: effect.tenant_guard,
            principal_scope: { schema_version: "synapsor.principal-scope.v1", column: effect.principal_scope!.column, binding: "principal", provider: "environment",
              value: effect.principal_scope!.value, value_fingerprint: canonicalJsonDigest("maya") } },
          allowed_columns: effect.allowed_columns, patch: effect.set, conflict_guard: { kind: "version_column", column: "version", expected_value: 1 },
          version_advance: effect.version_advance, semantic_authority: decision.semantic_authority,
          idempotency_key: `semantic:${proposalId}`, lease_expires_at: new Date(Date.now() + 120_000).toISOString(), attempt_count: 1 };
        return { job, decision, context };
      }
      const executor = createDelegatedSemanticExecutor(options);
      const execute = (job: NormalizedWritebackJobV5) => {
        const attempt = executor.forJob(job), verifier = createSemanticActionVerifier({ registry, check_delegation: attempt.check });
        return { attempt, verify: () => verifier({ job, factLoader: adapter }) };
      };
      const revoke = async () => repository.commit({ deployment_id: deployment, expected_epoch: (await repository.deployment(deployment))!.epoch,
        revisions: [], active: [{ ...ownerKey, revision_id: null }], event: event() });
      const reviseBudget = async (maximum: number) => {
        const definition = { ...f.definition, budget_limits: [{ meter: "allocated_units", maximum }] };
        const compiled = compileOwnerPolicy({ parent: scopedParent, definition, rules: [f.compiled] });
        const next = make(ownerKey, { ...policy.content as object, definition, compiled_digest: compiled.digest }, compiled.digest);
        await repository.commit({ deployment_id: deployment, expected_epoch: (await repository.deployment(deployment))!.epoch,
          revisions: [next], active: [next], event: event() });
      };
      return { ...f, repository, deployment, owner, actor, authenticate, options, runtime, registry, adapter, propose, execute, revoke, reviseBudget, parentDocument };
    }

    it.each([["inventory", false], ["university", true], ["support", false]])("binds %s exact effects and short-lived verified workload without storing tokens", async (domain, coded) => {
      const f = await fixture(String(domain), Boolean(coded)), { job, context, decision } = await f.propose();
      expect(decision.approval.path).toBe("automatic_eligible");
      expect(job.semantic_authority.proof.delegation?.valid_until).toBe(f.parentDocument.runtime_delegations![0]!.expires_at);
      await context.checkExisting(job.proposal_id, job.semantic_authority);
      const record = await f.repository.runtimeProofs.get({ deployment_id: f.deployment, proposal_id: job.proposal_id, scope: f.owner,
        content_digest: job.semantic_authority.proof.delegation!.binding_digest });
      expect(JSON.stringify(record)).not.toContain("private-bearer-test");
      expect(record.content).not.toHaveProperty("facts");
      const { attempt, verify } = f.execute(job);
      expect(await verify()).toMatchObject({ status: "reverified", effect_digest: job.semantic_authority.effect.effect_digest });
      expect(await attempt.record({ state: "completed", receipt_digest: canonicalJsonDigest("source receipt") })).toMatchObject({ state: "completed" });
      await expect(f.execute(job).verify()).rejects.toThrow("RECONCILIATION_REQUIRED");
    });
    it("refuses parent/owner hard conditions before saving a proof, while valid exceptions require human review", async () => {
      const f = await fixture();
      const register = vi.spyOn(f.repository.runtimeProofs, "register");
      await expect(f.propose(21)).rejects.toThrow("DELEGATION_REQUEST_REFUSED");
      expect(register).not.toHaveBeenCalled();
      f.facts.bindings.request!.rows[0]!.category = "exception";
      const { job, context, decision } = await f.propose(10);
      expect(decision.approval.path).toBe("human_review");
      job.semantic_authority.proof.approval_path = "automatic_eligible";
      await expect(context.checkExisting(job.proposal_id, job.semantic_authority)).rejects.toThrow("DELEGATION_PROOF_INVALID");
    });
    it("binds runs and owners to references and blocks an old proposal after revocation", async () => {
      const f = await fixture(), { context, job } = await f.propose(), session = context.workflowSessionId("mcp-session");
      f.authenticate.mockResolvedValue({ ...f.actor, run_id: "run-2", actor_digest: canonicalJsonDigest("run-2") });
      const other = await f.runtime.begin("new-token");
      expect(other.workflowSessionId("mcp-session")).not.toBe(session);
      await expect(other.checkExisting(job.proposal_id, job.semantic_authority)).rejects.toThrow("DELEGATION_CHANGED");
      await f.revoke();
      await expect(f.execute(job).verify()).rejects.toThrow("DELEGATION_NOT_AVAILABLE");
    });
    it("current epoch fences revocation between policy resolution and dispatch", async () => {
      const f = await fixture(), { job } = await f.propose();
      const prepare = f.repository.effects.prepare.bind(f.repository.effects), dispatch = vi.spyOn(f.repository.effects, "dispatch");
      vi.spyOn(f.repository.effects, "prepare").mockImplementationOnce(async (input) => { const result = await prepare(input); await f.revoke(); return result; });
      await expect(f.execute(job).verify()).rejects.toThrow("POLICY_REVISION_CONFLICT");
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it("two concurrent attempts cannot receive two effect admissions; unknown is not released or retried", async () => {
      const f = await fixture(), { job } = await f.propose(), first = f.execute(job), second = f.execute(job);
      const results = await Promise.allSettled([first.verify(), second.verify()]);
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      const winner = results[0]!.status === "fulfilled" ? first : second;
      expect(await winner.attempt.record({ state: "unknown", receipt_digest: canonicalJsonDigest("timeout") })).toMatchObject({ state: "unknown" });
      await expect(f.execute(job).verify()).rejects.toThrow("RECONCILIATION_REQUIRED");
      await f.revoke();
      // A restarted trusted executor can record real source evidence even
      // after revocation. It does not acquire another execution permit.
      expect(await f.execute(job).attempt.record({ state: "completed", receipt_digest: canonicalJsonDigest("reconciled") })).toMatchObject({ state: "completed" });
      await expect(f.execute(job).verify()).rejects.toThrow("DELEGATION_NOT_AVAILABLE");
    });
    it("recovers a lost dispatch acknowledgement without permitting a second effect or exposing a nonce", async () => {
      const f = await fixture(), { job } = await f.propose(), dispatch = f.repository.effects.dispatch.bind(f.repository.effects);
      vi.spyOn(f.repository.effects, "dispatch").mockImplementationOnce(async (input) => { await dispatch(input); throw new Error("acknowledgement lost"); });
      await expect(f.execute(job).verify()).rejects.toThrow("acknowledgement lost");
      const proof = job.semantic_authority.proof.delegation!;
      const status = await f.repository.effects.inspect({ deployment_id: f.deployment, request_id: job.proposal_id, actor_digest: proof.actor_digest,
        policy_chain_digest: proof.policy_chain_digest, effect_digest: job.semantic_authority.effect.effect_digest });
      expect(status).toMatchObject({ state: "dispatched" }); expect(status).not.toHaveProperty("nonce");
      await expect(f.execute(job).verify()).rejects.toThrow("RECONCILIATION_REQUIRED");
      expect(await f.execute(job).attempt.record({ state: "no_effect", receipt_digest: canonicalJsonDigest("verified transaction rollback") })).toMatchObject({ state: "no_effect" });
      await expect(f.repository.effects.inspect({ deployment_id: f.deployment, request_id: job.proposal_id, actor_digest: canonicalJsonDigest("different workload"),
        policy_chain_digest: proof.policy_chain_digest, effect_digest: job.semantic_authority.effect.effect_digest })).rejects.toThrow("EFFECT_ADMISSION_INVALID");
    });
    it("does not admit a stale source effect, substituted job, missing proof, or altered business inputs", async () => {
      const f = await fixture(), { job, context } = await f.propose(), prepare = vi.spyOn(f.repository.effects, "prepare");
      const tampered = structuredClone(job); tampered.semantic_authority.business_inputs = { quantity: 11 };
      await expect(context.checkExisting(job.proposal_id, tampered.semantic_authority)).rejects.toThrow("DELEGATION_PROOF_INVALID");
      const noProof = structuredClone(job); delete noProof.semantic_authority.proof.delegation;
      await expect(f.execute(noProof).verify()).rejects.toThrow("required current delegation");
      f.facts.bindings.request!.rows[0]!.version = 2;
      await expect(f.execute(job).verify()).rejects.toThrow("no longer prove");
      expect(prepare).not.toHaveBeenCalled();
    });
    it("does not register a proposal when authority changes while its attestation is being saved", async () => {
      const f = await fixture(), register = f.repository.runtimeProofs.register.bind(f.repository.runtimeProofs);
      vi.spyOn(f.repository.runtimeProofs, "register").mockImplementationOnce(async (input) => { await f.revoke(); return register(input); });
      await expect(f.propose()).rejects.toThrow("POLICY_REVISION_CONFLICT");
    });
    it("counts actual effects, preserves usage across owner cap edits, and blocks human-reviewed overspending", async () => {
      const f = await fixture("inventory", false, true), account = { scope: { level: "tenant" as const, tenant_id: "acme" },
        meter: "allocated_units", unit: "units", scale: 1, limit: 25, window_ms: 86_400_000 };
      const first = await f.propose(15), attempt = f.execute(first.job);
      expect(await f.repository.budgets.inspect({ deployment_id: f.deployment, account })).toEqual({ committed: 0, reserved: 0, available: 25 });
      await attempt.verify();
      await attempt.attempt.record({ state: "completed", receipt_digest: canonicalJsonDigest("first source effect") });
      f.facts.bindings.request!.rows[0]!.category = "exception";
      const second = await f.propose(15);
      expect(second.decision.approval.path).toBe("human_review");
      await expect(f.execute(second.job).verify()).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      await f.reviseBudget(30);
      await expect(f.execute(second.job).verify()).rejects.toThrow("DELEGATION_CHANGED");
      const renewed = await f.propose(15), next = f.execute(renewed.job);
      await next.verify(); await next.attempt.record({ state: "completed", receipt_digest: canonicalJsonDigest("second source effect") });
      expect(await f.repository.budgets.inspect({ deployment_id: f.deployment, account: { ...account, limit: 30 } })).toEqual({ committed: 30, reserved: 0, available: 0 });
      await f.reviseBudget(10);
      const lowered = await f.propose(1);
      await expect(f.execute(lowered.job).verify()).rejects.toThrow("HARD_BUDGET_EXCEEDED");
    });
    it("shares reservations across authenticated agents and retains unknown effects without a new allowance", async () => {
      const f = await fixture("university", true, true);
      f.authenticate.mockImplementation(async (credential) => credential === "agent-b-token"
        ? { ...f.actor, agent_id: "agent-b", run_id: "another-run", actor_digest: canonicalJsonDigest("verified-agent-b") } : structuredClone(f.actor));
      const first = await f.propose(15), second = await f.propose(15, "second-agent-proposal", "agent-b-token");
      const a = f.execute(first.job), b = f.execute(second.job), results = await Promise.allSettled([a.verify(), b.verify()]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = results[0]!.status === "fulfilled" ? a : b;
      await winner.attempt.record({ state: "unknown", receipt_digest: canonicalJsonDigest("timeout") });
      const third = await f.propose(15);
      await expect(f.execute(third.job).verify()).rejects.toThrow("HARD_BUDGET_EXCEEDED");
      const account = { scope: { level: "tenant" as const, tenant_id: "acme" }, meter: "allocated_units", unit: "units", scale: 1, limit: 25, window_ms: 86_400_000 };
      expect(await f.repository.budgets.inspect({ deployment_id: f.deployment, account })).toEqual({ committed: 0, reserved: 15, available: 10 });
    });
  });
}
