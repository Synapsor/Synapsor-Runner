import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SignJWT } from "jose";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActionRuleAuthority } from "@synapsor-runner/action-rules";
import {
  createPolicyManagementService,
  createPolicyManagementTools,
  createPolicyReviewContinuationService,
  REQUEST_CHANGE_TOOL,
  subjectReferenceScopeFingerprints,
  type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest, parseWritebackJob, type NormalizedWritebackJobV5 } from "@synapsor-runner/protocol";
import {
  semanticApprovalSetDigest,
  type ControlPolicyKey,
  type ControlPolicyRevision,
  type ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import { applyPostgresJob, createPostgresActionRuleFactLoader } from "@synapsor-runner/postgres";
import type { ApplyAdapter, RunnerConfig } from "@synapsor-runner/worker-core";
import { compileOwnerPolicy } from "../../../packages/mcp-server/src/owner-policy-compiler.js";
import { createPolicyManagementJwtAuthenticator } from "../../../packages/mcp-server/src/policy-management-identity.js";
import type { PolicyManagementParent } from "../../../packages/mcp-server/src/owner-policy-records.js";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import * as actionAuthority from "./action-rule-authority.js";
import { createOwnerSettingsMcpServer } from "./authoring-mcp.js";
import { createProjectRuntimeStore, migrateProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { applyRuntimeDatabaseJob } from "./delegated-writeback.js";
import { createOptionalActionRuleRuntimeServices } from "./semantic-action-runtime.js";

const postgresUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const issuer = "https://journey-identity.example";
const assistantAudience = "journey-settings-assistant";
const humanAudience = "journey-settings-human";
const workloadAudience = "journey-workload";
const assistantSecret = "journey_assistant_secret_at_least_32_bytes";
const humanSecret = "journey_human_secret_at_least_32_bytes";
const workloadSecret = "journey_workload_secret_at_least_32_bytes";
const subjectKey = "journey_subject_reference_key_at_least_32_bytes";

type OwnerScope = { level: "principal"; tenant_id: string; principal: string };

const owner = (tenant_id: string): OwnerScope => ({ level: "principal", tenant_id, principal: "maya" });

async function signedOwnerJwt(tenant_id: string, human = false) {
  return new SignJWT({
    sub: "maya-login",
    tenant_id,
    principal: "maya",
    actor_kind: "human",
    sid: `maya-${tenant_id}-settings`,
    policy_channel: human ? "human_review" : "assistant",
  }).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer)
    .setAudience(human ? humanAudience : assistantAudience).setExpirationTime("5m")
    .sign(new TextEncoder().encode(human ? humanSecret : assistantSecret));
}

async function signedWorkloadJwt(agent_id: string, run_id: string) {
  return new SignJWT({
    sub: `${agent_id}-workload`,
    tenant_id: "acme",
    principal: "maya",
    agent_id,
    delegator: "maya",
    run_id,
    actor_kind: "agent",
    delegation_channel: "runtime",
  }).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience(workloadAudience)
    .setExpirationTime("5m").sign(new TextEncoder().encode(workloadSecret));
}

// This test bootstraps the reviewed Action artifact with the compiler fixture.
// It does not mock policy storage, identity, fact reads, queueing, source writes,
// or receipt accounting. The observed subject rows below identify real PG rows;
// full Scoped Explore generation is intentionally outside this delegated-writeback journey.
function reviewedAction(schema: string) {
  const f = ownerPolicyTestFixture(schema, true);
  f.parent.agents = ["agent-a", "agent-a2", "agent-b"];
  f.parent.budgets = [{ meter: "units", title: "Units", scope: "tenant", unit: "units", scale: 1, maximum: 25, window_ms: 86_400_000 }];
  f.parent.outcomes[0]!.budget_charges = [{ meter: "units", kind: "effect_field", field: f.amount }];
  const loaded = createActionRuleAuthority({
    name: "journey_reviewed_actions",
    action_boundary_name: "journey.actions",
    catalog: { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: f.compiled.generation_lock_fingerprint,
      resources: [f.compiled.target_resource], relationships: [] },
    rules: [{ read_boundary_name: "journey.read", read_boundary_digest: canonicalJsonDigest("journey-read"),
      verification_boundary: f.compiled.verification_boundary, effect_envelope: f.compiled.effect_envelope,
      rule: f.compiled.rule, activated_at: "2026-09-07T00:00:00.000Z" }],
    approval_classes: [{ name: f.compiled.approval_class, mode: "policy", required_role: "reviewer", required_approvals: 1,
      rules: [{ outcome: f.compiled.outcome, auto_approve_when: f.compiled.rule.require }], shared_limits: [
        { id: "action_limit", kind: "count", scope: "capability", capability: f.compiled.outcome, maximum: 10, window_seconds: 86_400 },
        { id: "owner_limit", kind: "count", scope: "tenant_principal", capability: f.compiled.outcome, maximum: 3, window_seconds: 86_400 },
      ] }],
  });
  return { f, reviewed: { ...loaded, activation: { schema_version: "synapsor.action-rule-authority-activation.v1" as const,
    state: "active" as const, authority: loaded.authority, digest: loaded.authority.digest, actor: "journey-operator",
    activated_at: "2026-09-07T00:00:00.000Z", reviews: [] } } };
}

async function queuedJobFromStoredProposal(store: ProposalRuntimeStore, proposalId: string): Promise<NormalizedWritebackJobV5> {
  const proposal = await store.getProposal(proposalId);
  const enqueue = store.enqueueWorkerProposal;
  const approvals = store.approvals;
  if (!proposal || !enqueue || !approvals) throw new Error("The selected governed runtime store cannot queue a semantic proposal.");
  if (proposal.change_set.schema_version !== "synapsor.change-set.v4") throw new Error("Expected a semantic v4 proposal.");
  const changeSet = proposal.change_set;
  const contractDigest = changeSet.semantic_authority.proof.action_boundary_digest;
  if (!/^sha256:[a-f0-9]{64}$/u.test(contractDigest)) throw new Error("Expected the proposal's exact Action boundary digest.");
  await enqueue.call(store, { proposal_id: proposalId, execution_mode: "supervised_worker",
    contract_digest: contractDigest as `sha256:${string}`, max_attempts: 1 });
  // PostgresProposalRuntimeStore has no public v5 job-builder method. This is
  // the adapter envelope for its real, already-approved proposal and approval
  // records, not a synthetic approval or a fabricated source result.
  const job = parseWritebackJob({
    schema_version: "synapsor.writeback-job.v5",
    writeback_job_id: `wbj_${proposal.proposal_id}`,
    proposal_id: proposal.proposal_id,
    proposal_hash: proposal.proposal_hash,
    approval_id: semanticApprovalSetDigest(proposal, await approvals.call(store, proposal.proposal_id)),
    ...(changeSet.contract ? { contract: { contract_id: "journey", contract_version_id: changeSet.contract.version, digest: changeSet.contract.digest } } : {}),
    runner_scope: { project_id: "journey", source_id: proposal.source_id },
    engine: "postgres",
    operation: changeSet.operation,
    target: {
      schema: proposal.source_schema,
      table: proposal.source_table,
      primary_key: changeSet.source.primary_key,
      ...(changeSet.guards.tenant ? { tenant_guard: changeSet.guards.tenant } : {}),
      ...(changeSet.guards.organization_scope ? { organization_scope: changeSet.guards.organization_scope } : {}),
      ...(changeSet.guards.principal_scope ? { principal_scope: changeSet.guards.principal_scope } : {}),
    },
    allowed_columns: changeSet.guards.allowed_columns,
    patch: changeSet.patch,
    conflict_guard: changeSet.guards.expected_version
      ? { kind: "version_column", column: changeSet.guards.expected_version.column, expected_value: changeSet.guards.expected_version.value }
      : { kind: "none" },
    ...(changeSet.guards.version_advance ? { version_advance: changeSet.guards.version_advance } : {}),
    ...(changeSet.guards.deduplication ? { deduplication: changeSet.guards.deduplication } : {}),
    semantic_authority: changeSet.semantic_authority,
    idempotency_key: `semantic:${proposal.proposal_id}`,
    lease: { lease_id: `lease_${proposal.proposal_id}`, attempt: 1, expires_at: new Date(Date.now() + 120_000).toISOString() },
  });
  if (job.protocol_version !== "5.0") throw new Error("Expected a normalized semantic v5 writeback job.");
  return job;
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(!postgresUrl)(`owner delegation journey: ${backend} governed control`, () => {
    it("keeps two maya owners isolated while actual delegated PG writes use reviewed proposals and receipts", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `synapsor-owner-journey-${backend}-`));
      roots.push(root);
      const sourceSchema = `journey_source_${randomBytes(6).toString("hex")}`;
      const controlSchema = `journey_control_${randomBytes(6).toString("hex")}`;
      const { f, reviewed } = reviewedAction(sourceSchema);
      const pool = new Pool({ connectionString: postgresUrl, max: 8 });
      const clients: McpClient[] = [];
      const servers: ReturnType<typeof createOwnerSettingsMcpServer>[] = [];
      let store: Awaited<ReturnType<typeof createProjectRuntimeStore>> | undefined;
      try {
        await pool.query(`CREATE SCHEMA "${sourceSchema}"; CREATE TABLE "${sourceSchema}"."${f.compiled.target_resource.table}" (
          id text PRIMARY KEY, tenant_id text NOT NULL, principal_id text NOT NULL, version integer NOT NULL,
          "${f.amount}" integer NOT NULL, available boolean NOT NULL, category text NOT NULL, expires_at timestamptz NOT NULL)`);
        await pool.query(`INSERT INTO "${sourceSchema}"."${f.compiled.target_resource.table}" VALUES
          ('request-1','acme','maya',1,5,true,'routine','2030-01-01'),
          ('request-2','acme','maya',1,5,true,'routine','2030-01-01'),
          ('request-3','acme','maya',1,5,true,'routine','2030-01-01')`);

        const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: "journey_parent" };
        const ownerAKey: ControlPolicyKey = { scope: owner("acme"), kind: "delegation", name: "journey_rules" };
        const ownerBKey: ControlPolicyKey = { scope: owner("beta"), kind: "delegation", name: "journey_rules" };
        const ownerADefinition = { ...f.definition, agents: ["agent-a", "agent-a2"], budget_limits: [{ meter: "units", maximum: 25 }] };
        const ownerBDefinition = { ...f.definition, agents: ["agent-b"], budget_limits: [{ meter: "units", maximum: 25 }] };
        const parentDocument: PolicyManagementParent = {
          schema_version: "synapsor.policy-management-parent.v1",
          delegation: f.parent,
          managers: ["acme", "beta"].map((tenant_id) => ({ subject: "maya-login", tenant_id, actor_kind: "human" as const,
            scope: { mode: "personal" as const }, permissions: ["inspect", "draft", "activate", "revoke", "audit"] })),
          agent_owners: [{ agent: "agent-a", scope: owner("acme") }, { agent: "agent-a2", scope: owner("acme") }, { agent: "agent-b", scope: owner("beta") }],
          runtime_delegations: ["agent-a", "agent-a2"].map((agent) => ({ agent, delegator: "maya", owner: owner("acme"),
            policies: [{ scope: owner("acme"), name: ownerAKey.name }], expires_at: new Date(Date.now() + 300_000).toISOString() })),
        };
        const make = (key: ControlPolicyKey, content: unknown, authority_digest: string = canonicalJsonDigest(content)): ControlPolicyRevision => ({
          ...key, revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest,
        });
        const parent = make(parentKey, parentDocument);
        const compiledB = compileOwnerPolicy({ parent: { ...f.parent, agents: ["agent-b"] }, definition: ownerBDefinition,
          rules: [reviewed.registry.rules[0]!.compiled] });
        const ownerBPolicy = make(ownerBKey, { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
          parent_revision_id: parent.revision_id, parent_authority_digest: parent.authority_digest,
          definition: ownerBDefinition, compiled_digest: compiledB.digest }, compiledB.digest);
        const env: NodeJS.ProcessEnv = {
          ASSISTANT_TOKEN: await signedOwnerJwt("acme"), ASSISTANT_SECRET: assistantSecret,
          HUMAN_SECRET: humanSecret, WORKLOAD_SECRET: workloadSecret, SUBJECT_KEY: subjectKey, SOURCE_URL: postgresUrl, CONTROL_URL: postgresUrl,
        };
        const controlPath = path.join(root, ".synapsor", "journey.db");
        const config: RuntimeConfig = { version: 1, mode: "review", storage: backend === "postgres"
          ? { shared_postgres: { mode: "runtime_store", schema: controlSchema, url_env: "CONTROL_URL" } }
          : { sqlite_path: controlPath }, capabilities: [],
          sources: { local_postgres: { engine: "postgres", read_url_env: "SOURCE_URL", write_url_env: "SOURCE_URL" } },
          trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "maya" } },
          action_rules: { project_root: root, subject_reference_hmac_key_env: "SUBJECT_KEY", subject_reference_namespace: "journey",
            owner_management: { parent_name: parentKey.name, policy_name: ownerAKey.name, scope: "personal", credential_env: "ASSISTANT_TOKEN",
              authentication: { provider: "jwt_hs256", issuer, audience: assistantAudience, secret_env: "ASSISTANT_SECRET" },
              human_review: { credential_env: "HUMAN_TOKEN", audience: humanAudience } },
            owner_delegation: { parent_name: parentKey.name, credential_env: "WORKLOAD_TOKEN",
              authentication: { provider: "jwt_hs256", issuer, audience: workloadAudience, secret_env: "WORKLOAD_SECRET" } } } };
        const snapshot: ControlPolicyMigrationSnapshot = {
          revisions: [parent, ownerBPolicy],
          active: [parent, ownerBPolicy].map(({ scope, kind, name, revision_id }) => ({ scope, kind, name, revision_id })),
          drafts: [],
          provenance: [{ path: ".synapsor/journey-owner-policy.json", digest: canonicalJsonDigest({ parent, ownerBPolicy }) }],
        };
        const migration = await migrateProjectControlPolicies({ projectRoot: root, storePath: controlPath, config, env, actor: "journey-operator",
          readLegacySnapshot: async () => structuredClone(snapshot), validateSnapshot: async (candidate) => { expect(candidate).toEqual(snapshot); } });
        const { deployment_id: deployment } = migration.binding;
        await migration.binding.close();
        store = await createProjectRuntimeStore({ projectRoot: root, storePath: controlPath, config, env });
        const repository = store.controlPolicies;
        if (!repository) throw new Error("Expected the selected runtime store to expose governed policies.");
        const event = (operation: string) => ({ event_id: randomUUID(), actor: "journey-operator", occurred_at: new Date().toISOString(), receipt: { operation } });

        const service = createPolicyManagementService({ repository, deployment_id: deployment, parent_name: parentKey.name,
          assistant_authenticate: createPolicyManagementJwtAuthenticator(config.action_rules!.owner_management!.authentication, "assistant", env),
          human_authenticate: createPolicyManagementJwtAuthenticator({ ...config.action_rules!.owner_management!.authentication, audience: humanAudience,
            secret_env: "HUMAN_SECRET" }, "human_review", env), resolveRules: async () => reviewed.registry.rules.map((rule) => rule.compiled) });
        const review = createPolicyReviewContinuationService(service);
        const connect = async (tenant_id: string) => {
          const credential = await signedOwnerJwt(tenant_id);
          const tools = createPolicyManagementTools({ service, resolveContext: async () => ({ credential, scope: owner(tenant_id),
            policy_name: ownerAKey.name, scope_label: `${tenant_id}/maya`, session_id: `mcp-${tenant_id}`, expires_at_ms: Date.now() + 300_000 }),
            publishReview: async (target) => review.publish(target).handle });
          const server = createOwnerSettingsMcpServer(tools); servers.push(server);
          const client = new McpClient({ name: `journey-${tenant_id}`, version: "1" }); clients.push(client);
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport); await client.connect(clientTransport);
          return client;
        };
        const acme = await connect("acme"), beta = await connect("beta");
        expect((await acme.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
          "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change",
        ]);
        const call = (client: McpClient, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
        const view = { policy_view: "agent_rules" };
        const initial = (await call(acme, "app.explore_data", { ...view, section: "summary" })).structuredContent as Record<string, unknown>;
        const controlRef = initial.control_ref as string;
        expect(initial).toMatchObject({ active: null, agents_available: ["agent-a", "agent-a2"] });
        const beforeB = await repository.active(deployment, ownerBKey);
        expect((await call(beta, "app.request_change", { ...view, outcome: "agent_rules.propose_revision", control_ref: controlRef, definition: ownerADefinition })).isError).toBe(true);
        expect((await call(acme, "app.request_change", { ...view, outcome: "agent_rules.propose_revision", control_ref: controlRef,
          definition: { ...ownerADefinition, agents: ["agent-a", "agent-b"] } })).isError).toBe(true);
        const proposed = await call(acme, "app.request_change", { ...view, outcome: "agent_rules.propose_revision", control_ref: controlRef, definition: ownerADefinition });
        expect(proposed.structuredContent).toMatchObject({ status: "draft_saved", source_database_changed: false });
        const handle = ((proposed.structuredContent as Record<string, any>).review as { continuation: string }).continuation;
        await expect(review.prepare(await signedOwnerJwt("acme"), handle)).rejects.toThrow("POLICY_AUTHENTICATION_FAILED");
        const prepared = await review.prepare(await signedOwnerJwt("acme", true), handle);
        await review.confirm(await signedOwnerJwt("acme", true), handle, prepared);
        expect((await call(acme, "app.explore_data", { ...view, section: "summary" })).structuredContent).toMatchObject({ active: { action_count: 1 }, draft: null });
        expect((await repository.active(deployment, ownerBKey))?.revision_id).toBe(beforeB?.revision_id);

        // The loader is the isolated reviewed-artifact seam described above.
        vi.spyOn(actionAuthority, "createActiveActionRuleAuthorityLoader").mockReturnValue(async () => reviewed);
        const factSessionFactory = async () => {
          const client = await pool.connect();
          await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
          return { fact_loader: createPostgresActionRuleFactLoader(client), close: async () => { await client.query("ROLLBACK"); client.release(); } };
        };
        const createServices = async (agent: string, run: string) => createOptionalActionRuleRuntimeServices({ projectRoot: root, config,
          env: { ...env, WORKLOAD_TOKEN: await signedWorkloadJwt(agent, run) }, store: store!, key: Buffer.from(subjectKey), deployment_scope: deployment,
          workflow_session_id: `session-${agent}-${run}`, factSessionFactory });
        const servicesA = await createServices("agent-a", "run-1");
        const servicesA2 = await createServices("agent-a2", "run-1");
        if (!servicesA || !servicesA2) throw new Error("Expected delegated semantic services");
        const issue = async (services: NonNullable<typeof servicesA>, id: string, evidence: string) => {
          const activated = reviewed.registry.rules[0]!;
          const fingerprints = subjectReferenceScopeFingerprints({ key: Buffer.from(subjectKey), deployment_scope: deployment,
            source_id: activated.compiled.source, tenant: "acme", principal: "maya" });
          const [subject] = await services.subjectReferences.issue({ source_id: activated.compiled.source,
            read_boundary_digest: activated.read_boundary_digest, generation_lock_fingerprint: activated.compiled.generation_lock_fingerprint,
            ...fingerprints, workflow_session_id: services.workflow_session_id, resource: f.resource, evidence_bundle_id: evidence,
            observations: [{ row_index: 0, primary_key_value: id, observed_version_value: 1 }] });
          return subject!.ref;
        };
        const oldRef = await issue(servicesA, "request-1", "reviewed-observation-old-run");
        const servicesFresh = await createServices("agent-a", "run-2");
        if (!servicesFresh) throw new Error("Expected fresh delegated semantic services");
        await expect(servicesFresh.semanticActions.callTool(REQUEST_CHANGE_TOOL, { outcome: f.compiled.outcome, subject_refs: { request: oldRef }, inputs: { quantity: 15 } }))
          .rejects.toMatchObject({ code: "SUBJECT_REFERENCE_UNAVAILABLE" });
        const firstRef = await issue(servicesFresh, "request-1", "reviewed-observation-fresh"), secondRef = await issue(servicesA2, "request-2", "reviewed-observation-agent-a2");
        const createProposal = (services: NonNullable<typeof servicesA>, ref: string, quantity: number) => services.semanticActions.callTool(REQUEST_CHANGE_TOOL,
          { outcome: f.compiled.outcome, subject_refs: { request: ref }, inputs: { quantity } });
        await Promise.all([createProposal(servicesFresh, firstRef, 15), createProposal(servicesA2, secondRef, 15)]);
        const listProposals = store.listProposals;
        if (!listProposals) throw new Error("The selected governed runtime store cannot list semantic proposals.");
        const accepted = (await listProposals.call(store)).filter((proposal) => proposal.state === "approved" || proposal.state === "pending_worker");
        expect(accepted).toHaveLength(2);
        const jobs = await Promise.all(accepted.map((proposal) => queuedJobFromStoredProposal(store!, proposal.proposal_id)));
        const runnerConfig: RunnerConfig = { controlPlaneUrl: "http://localhost", runnerToken: "journey", runnerId: "journey-worker", sourceId: "local_postgres",
          databaseUrl: postgresUrl!, engine: "postgres", pollIntervalMs: 1000, statementTimeoutMs: 5000, logLevel: "error", dryRun: false, stateDir: root,
          receipts: { authority: "source_db", provisioning: "auto_migrate", schema: sourceSchema, table: "receipts" } };
        const adapter: ApplyAdapter = { doctor: async () => ({ ok: true, details: {} }), apply: applyPostgresJob };
        const execute = (job: typeof jobs[number]) => applyRuntimeDatabaseJob({ job, adapter, runnerConfig, runtimeConfig: config,
          configPath: path.join(root, "synapsor.runner.json"), env });
        const results = await Promise.all(jobs.map(execute));
        expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
        expect(results.filter((result) => result.status === "failed")).toHaveLength(1);

        const queuedRef = await issue(servicesFresh, "request-3", "reviewed-observation-revoked");
        await createProposal(servicesFresh, queuedRef, 5);
        const queued = (await listProposals.call(store)).find((proposal) => proposal.state === "approved" && !accepted.some((prior) => prior.proposal_id === proposal.proposal_id));
        expect(queued).toBeDefined();
        const queuedJob = await queuedJobFromStoredProposal(store, queued!.proposal_id);
        const current = await repository.deployment(deployment);
        await repository.commit({ deployment_id: deployment, expected_epoch: current!.epoch, revisions: [], active: [{ ...ownerAKey, revision_id: null }], event: event("revoke-before-worker") });
        await expect(execute(queuedJob)).resolves.toMatchObject({ status: "failed", affected_rows: 0 });
        const sourceRows = (await pool.query(`SELECT id, "${f.amount}" AS amount, version FROM "${sourceSchema}"."${f.compiled.target_resource.table}" ORDER BY id`)).rows;
        expect(sourceRows.filter((row) => row.version === 2)).toHaveLength(1);
        expect(sourceRows.find((row) => row.id === "request-3")).toMatchObject({ amount: 5, version: 1 });
        expect((await pool.query(`SELECT COUNT(*)::int AS count FROM "${sourceSchema}"."receipts"`)).rows[0]).toMatchObject({ count: 1 });
      } finally {
        for (const client of clients) await client.close();
        for (const server of servers) await server.close();
        await store?.close();
        await pool.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE; DROP SCHEMA IF EXISTS "${controlSchema}" CASCADE`).catch(() => undefined);
        await pool.end();
      }
    }, 60_000);
  });
}
