import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { evaluateSemanticActionEligibility } from "@synapsor-runner/action-rules";
import { createPostgresActionRuleFactLoader } from "@synapsor-runner/postgres";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { describe, expect, it, vi } from "vitest";
import { activateExplorationBoundary, AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary,
  explorationBoundaryCandidateDigest, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { generateModelActionRuleDraft, type ModelActionRuleDraftResult } from "./action-rule-model.js";
import { secureAskJsonRequest } from "./model-ask.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { activateActionRuleAuthority, buildActionRuleAuthorityDraft, loadActiveActionRuleAuthority,
  writeActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { createOptionalActionRuleRuntimeServices } from "./semantic-action-runtime.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";
import { enqueueApprovedForSupervisedWorker, workerCommand } from "./worker-runtime.js";

// Explicit paid-provider opt-in. Never fall back to a project's database or key file.
describe.skipIf(process.env.SYNAPSOR_TEST_GUIDED_ATOMIC_LIVE !== "1")("guided atomic live Terra qualification", () => {
  it("authors one atomic action, revises only fallback review, then requests and completes it through fixed MCP and the supervised worker", async () => {
    const adminUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
    if (!adminUrl) throw new Error("Set SYNAPSOR_TEST_POSTGRES_URL to a disposable PostgreSQL database");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Live qualification requires OPENAI_API_KEY");
    const suffix = randomBytes(6).toString("hex");
    const schema = `guided_atomic_${suffix}`;
    const reader = `${schema}_reader`, writer = `${schema}_writer`;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-atomic-"));
    const pool = new Pool({ connectionString: adminUrl, max: 3, connectionTimeoutMillis: 3000 });
    const evidencePath = process.env.SYNAPSOR_GUIDED_ATOMIC_REPORT;
    if (evidencePath && !path.isAbsolute(evidencePath)) throw new Error("SYNAPSOR_GUIDED_ATOMIC_REPORT must be an absolute path");
    const evidence: Record<string, unknown> = { model: "gpt-5.6-terra", schema, started_at: new Date().toISOString(),
      coverage: "programmatic real metadata + live model conversation + real MCP + supervised worker; not full UI", stages: [] };
    const stages = evidence.stages as string[];
    const progress: string[] = [];
    const responses: Array<{ status: number; tools: string[]; model?: unknown; usage?: unknown }> = [];
    const checkpoint = async (stage: string) => {
      stages.push(stage); evidence.progress = progress; evidence.provider_responses = responses;
      if (evidencePath) await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.log(`guided-atomic: ${stage}`);
    };
    let store: ProposalStore | undefined;
    let runtime: Awaited<ReturnType<typeof createScopedExploreRuntime>> | undefined;
    let client: Client | undefined;
    let server: ReturnType<typeof createScopedExploreMcpServer> | undefined;
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      const readerPassword = randomBytes(18).toString("hex"), writerPassword = randomBytes(18).toString("hex");
      await pool.query(`CREATE ROLE "${reader}" LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await pool.query(`CREATE ROLE "${writer}" LOGIN PASSWORD '${writerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
      await pool.query(`CREATE TABLE "${schema}".subscriptions (
        row_id varchar(64) PRIMARY KEY, account_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        subscription_id varchar(64) NOT NULL, plan varchar(64) NOT NULL, version integer NOT NULL,
        UNIQUE (account_id, subscription_id))`);
      await pool.query(`CREATE TABLE "${schema}".plan_offers (
        offer_id varchar(64) PRIMARY KEY, account_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        subscription_id varchar(64) NOT NULL, old_plan varchar(64) NOT NULL, new_plan varchar(64) NOT NULL,
        status varchar(16) NOT NULL CHECK (status IN ('available', 'consumed')), valid_until timestamptz NOT NULL,
        auto_eligible boolean NOT NULL, version integer NOT NULL,
        CONSTRAINT offer_subscription_fk FOREIGN KEY (account_id, subscription_id)
          REFERENCES "${schema}".subscriptions(account_id, subscription_id))`);
      await pool.query(`INSERT INTO "${schema}".subscriptions VALUES
        ('sub_auto', 'acct_1', 'customer_1', 's1', 'plan_a', 7),
        ('sub_human', 'acct_1', 'customer_1', 's2', 'plan_a', 7),
        ('sub_foreign', 'acct_2', 'customer_1', 's1', 'foreign_plan', 7)`);
      await pool.query(`INSERT INTO "${schema}".plan_offers VALUES
        ('offer_auto', 'acct_1', 'customer_1', 's1', 'plan_a', 'plan_b', 'available', now() + interval '1 day', true, 4),
        ('offer_human', 'acct_1', 'customer_1', 's2', 'plan_a', 'plan_c', 'available', now() + interval '1 day', false, 4),
        ('offer_foreign', 'acct_2', 'customer_1', 's1', 'foreign_plan', 'foreign_target', 'available', now() + interval '1 day', true, 4)`);
      for (const role of [reader, writer]) {
        await pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
        await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      }
      await pool.query(`GRANT UPDATE (row_id, plan, version) ON "${schema}".subscriptions TO "${writer}"`);
      await pool.query(`GRANT UPDATE (offer_id, status, version) ON "${schema}".plan_offers TO "${writer}"`);
      const readerUrl = new URL(adminUrl); readerUrl.username = reader; readerUrl.password = readerPassword;
      const writerUrl = new URL(adminUrl); writerUrl.username = writer; writerUrl.password = writerPassword;
      const env = { DATABASE_URL: readerUrl.toString(), GUIDED_ATOMIC_WRITE_URL: writerUrl.toString(),
        SYNAPSOR_TENANT_ID: "acct_1", SYNAPSOR_PRINCIPAL: "customer_1" };
      const inspection = await inspectDatabase({ databaseUrlEnv: "DATABASE_URL", schema, env });
      const decision = { actor: "synthetic_fixture_reviewer", reason: "Owned test data only; account and principal scope with private policy facts.", decided_at: new Date().toISOString() };
      const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", sourceName: "atomic_source", inspectedSchema: schema,
        project: { root, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] },
        overrides: { schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
          resources: Object.fromEntries(inspection.tables.map(table => [`${schema}.${table.name}`, {
            tenant_key: { ...decision, value: "account_id" }, principal_key: { ...decision, value: "principal_id" },
            fields: Object.fromEntries(["row_id", "offer_id", "subscription_id", "auto_eligible"].filter(field => table.columns.some(c => c.name === field))
              .map(field => [field, { ...decision, exposure: "withhold_from_model" as const }])),
          }])) } });
      const readBoundary = build.exploration_boundary;
      const readDigest = explorationBoundaryCandidateDigest(readBoundary);
      const builtCatalog = buildActionRuleAuthoringCatalog({ boundary: readBoundary, inspection });
      expect(builtCatalog.catalog.relationships).toContainEqual(expect.objectContaining({ name: "offer_subscription_fk",
        field_pairs: [{ local_field: "account_id", target_field: "account_id" }, { local_field: "subscription_id", target_field: "subscription_id" }], target_unique: true }));
      const offerCatalog = builtCatalog.authoring.resources.find(resource => resource.name.endsWith(".plan_offers"))!;
      expect(offerCatalog.fields.find(field => field.name === "auto_eligible")?.role).toBe("runner_verification_only");
      expect(builtCatalog.authoring.resources.map(resource => resource.selected_version_field)).toEqual(["version", "version"]);
      const rows = async () => ({ subscriptions: (await pool.query(`SELECT * FROM "${schema}".subscriptions ORDER BY row_id`)).rows,
        offers: (await pool.query(`SELECT * FROM "${schema}".plan_offers ORDER BY offer_id`)).rows });
      const before = await rows();
      evidence.catalog = builtCatalog.authoring;
      await checkpoint("real_metadata_and_private_composite_catalog_pass");
      const intent = `Prepare ONE business action called atomic.accept_plan_offer for a signed-in customer to accept their selected ${schema}.plan_offers row. `
        + "The offer must belong to their trusted account and principal, have status available, be unexpired at the current transaction time, and its old_plan must equal the linked subscription's current plan. "
        + "Use the inspected composite offer_subscription_fk, including BOTH account_id and subscription_id, to resolve the one linked subscription. "
        + "Atomically update that subscription's plan from the selected offer.new_plan AND mark that SAME offer status consumed; both exact row versions must advance. "
        + "Use subscriptions as the primary UPDATE and the selected plan_offers as its one atomic companion, not two independent actions or approvals. "
        + "Eligible requests automatically approve only when the private offer.auto_eligible is true, capped at 10 overall and 3 per account in a rolling 24 hours. "
        + "Use overall scope boundary and account scope tenant, with no capability filter on either count. Otherwise retain human fallback requiring one billing_reviewer. "
        + "Keep auto_eligible, row identities and versions private. No caller patch, IDs, versions or eligibility flags as business inputs. Prepare supervised execution only as disabled configuration; execution needs separate review and no setup write is authorized.";
      const session = { provider: "openai" as const, model: "gpt-5.6-terra", conversation: createModelAuthoringConversation(),
        dependencies: {
          onProgress: (event: { phase: "provider" | "tool"; tool?: string }) => { progress.push(event.tool ?? event.phase); },
          requestJson: async (input: Parameters<typeof secureAskJsonRequest>[0]) => {
            if (responses.length >= 24) throw new Error("Live qualification provider-request budget exhausted");
            if (input.endpoint.hostname !== "api.openai.com") throw new Error("Unexpected provider endpoint");
            const response = await secureAskJsonRequest(input);
            const output = Array.isArray(response.body.output) ? response.body.output as Array<Record<string, unknown>> : [];
            responses.push({ status: response.status, model: response.body.model, usage: response.body.usage,
              tools: output.filter(item => item.type === "function_call").map(item => String(item.name)) });
            return response;
          },
        } };
      const common = { session, builtCatalog, readBoundary, readBoundaryDigest: readDigest, egressAcknowledged: true,
        env: { OPENAI_API_KEY: apiKey }, signal: AbortSignal.timeout(360_000),
        askClarification: async (question: string) => {
          (evidence.clarifications as string[] | undefined ?? (evidence.clarifications = [] as string[])).push(question);
          return "The selected offer is the subject; use the inspected composite relationship to its subscription. Available and unexpired plus matching old plan are hard eligibility; auto_eligible only controls automatic approval, with human fallback. Limits are 10 across this business action and 3 per trusted account over rolling 24h. Both updates must be atomic. Require billing_reviewer. Save a disabled supervised draft; activation and execution review are separate.";
        } };
      const created = await generateModelActionRuleDraft({ ...common, intent });
      evidence.created = created;
      assertAtomicDraft(created, schema, 1);
      expect(await rows()).toEqual(before);
      await checkpoint("live_terra_atomic_draft_pass");
      const revised = await generateModelActionRuleDraft({ ...common, existingDraft: created.compiled.draft,
        intent: "Change only the human fallback quorum to two distinct billing reviewers instead of one. Preserve the same outcome, both atomic effects, eligibility, private automatic-approval predicate, rolling 24h limits (10 overall and 3 per account), and disabled supervised execution posture." });
      evidence.revised = revised;
      assertAtomicDraft(revised, schema, 2);
      expect(revised.compiled.draft.effect).toEqual(created.compiled.draft.effect);
      expect(revised.compiled.draft.require).toEqual(created.compiled.draft.require);
      expect(revised.compiled.draft.verification).toEqual(created.compiled.draft.verification);
      expect(revised.compiled.draft.approval).toEqual({ ...created.compiled.draft.approval, required_approvals: 2 });
      expect(revised.revision?.changed_phases).toContain("approval");
      expect(revised.compiled.rule).toEqual(created.compiled.rule);
      for (const field of ["when", "then", "refused"] as const) expect(revised.compiled.review[field]).toEqual(created.compiled.review[field]);
      expect(await rows()).toEqual(before);
      await checkpoint("live_terra_day_two_preservation_pass");

      const probes: Array<{ name: string; result: string; approval?: string }> = [];
      for (const scenario of ["eligible", "consumed", "expired", "changed_plan", "human_fallback"] as const) {
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
          if (scenario === "consumed") await connection.query(`UPDATE "${schema}".plan_offers SET status = 'consumed' WHERE offer_id = 'offer_auto'`);
          if (scenario === "expired") await connection.query(`UPDATE "${schema}".plan_offers SET valid_until = now() - interval '1 second' WHERE offer_id = 'offer_auto'`);
          if (scenario === "changed_plan") await connection.query(`UPDATE "${schema}".subscriptions SET plan = 'plan_changed' WHERE row_id = 'sub_auto'`);
          if (scenario === "human_fallback") await connection.query(`UPDATE "${schema}".plan_offers SET auto_eligible = false WHERE offer_id = 'offer_auto'`);
          expect(revised.compiled.rule.subjects).toHaveLength(1);
          const subject = revised.compiled.rule.subjects[0]!;
          expect(subject.resource).toBe(`${schema}.plan_offers`);
          const now = new Date().toISOString();
          const evaluated = await evaluateSemanticActionEligibility({ registry: revised.compiled.loaded.registry,
            outcome: revised.compiled.rule.outcome, subjects: [{ binding: subject.binding, resource: subject.resource,
              primary_key: { column: "offer_id", value: "offer_auto" }, subject_ref_digest: canonicalJsonDigest({ scenario }) }],
            trusted: { tenant: "acct_1", principal: "customer_1", transaction_time: now },
            adapter: createPostgresActionRuleFactLoader(connection), proposal_id: `probe_${scenario}`, verified_at: now,
            trusted_context_digest: canonicalJsonDigest({ tenant: "acct_1", principal: "customer_1" }),
            evidence_provenance_digest: canonicalJsonDigest({ scenario, fixture: schema }) });
          probes.push({ name: scenario, result: evaluated.result, ...(evaluated.result === "eligible" ? { approval: evaluated.approval.path } : {}) });
          expect(evaluated.result).toBe(scenario === "eligible" || scenario === "human_fallback" ? "eligible" : "ineligible");
          if (evaluated.result === "eligible") expect(evaluated.approval.path).toBe(scenario === "human_fallback" ? "human_review" : "automatic_eligible");
        } finally { await connection.query("ROLLBACK"); connection.release(); }
      }
      evidence.eligibility_probes = probes;
      expect(await rows()).toEqual(before);
      await checkpoint("live_draft_real_database_eligibility_and_fallback_probes_pass");

      // Explicit test-owned Read and Action reviews. Model generation above grants neither.
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await activateExplorationBoundary({ projectRoot: root, candidate: readBoundary, expectedDigest: readDigest,
        confirmation: `ACTIVATE ${readDigest}`, actor: "synthetic_fixture_reviewer", currentInspection: inspection,
        confirmedDecisions: readBoundary.unresolved_decisions });
      const compiled = revised.compiled;
      const draft = buildActionRuleAuthorityDraft({ name: "guided_atomic_authority", action_boundary_name: "atomic.actions",
        catalog: compiled.loaded.authority.catalog, rules: [{ read_boundary_name: readBoundary.pack.name, read_boundary_digest: readDigest,
          verification_boundary: compiled.verification_boundary, effect_envelope: compiled.effect_envelope, rule: compiled.rule }],
        approval_classes: [compiled.approval_class], reviews: [{ outcome: compiled.rule.outcome, ...compiled.review }] });
      await writeActionRuleAuthorityDraft(root, draft);
      await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name, expected_digest: draft.digest,
        confirmation: `ACTIVATE ${draft.digest}`, actor: "synthetic_fixture_reviewer" });
      const active = await loadActiveActionRuleAuthority(root);
      const storePath = path.join(root, ".synapsor/local.db"), configPath = path.join(root, "synapsor.runner.json");
      store = new ProposalStore(storePath);
      const config: RuntimeConfig = { version: 1, mode: "review", storage: { sqlite_path: storePath },
        sources: { atomic_source: { engine: "postgres", read_url_env: "DATABASE_URL", write_url_env: "GUIDED_ATOMIC_WRITE_URL", receipts: { authority: "runner_ledger" } } },
        trusted_context: { provider: "environment", values: { tenant_id_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" } },
        capabilities: [], action_rules: { project_root: root } };
      await fs.writeFile(configPath, JSON.stringify(config));
      const services = await createOptionalActionRuleRuntimeServices({ projectRoot: root, config, configPath, store, env });
      expect(services).toBeDefined();
      runtime = await createScopedExploreRuntime({ projectRoot: root, transport: "stdio", env, store,
        subjectReferences: { service: services!.subjectReferences, workflow_session_id: services!.workflow_session_id } });
      server = createScopedExploreMcpServer(runtime, { semanticActions: services!.semanticActions });
      client = new Client({ name: "guided-atomic-test-client", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
        "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change"]);
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client!.callTool({ name, arguments: args });
        if (response.isError) throw new Error(`MCP ${name}: ${JSON.stringify(response.structuredContent ?? response.content)}`);
        return response.structuredContent as Record<string, unknown>;
      };
      await call("app.describe_data", { resource: `${schema}.plan_offers` });
      const actions = await call("app.describe_actions", {});
      expect((actions.actions as unknown[])).toHaveLength(1);
      const subjectBinding = compiled.rule.subjects.find(subject => subject.resource === `${schema}.plan_offers`)!;
      expect(compiled.rule.subjects).toHaveLength(1);
      expect(subjectBinding).toBeDefined();
      const explore = await call("app.explore_data", { plan: { kind: "rows", resource: `${schema}.plan_offers`,
        select: ["new_plan", "status"], limit: 10 } });
      evidence.mcp_explore = explore;
      expect(JSON.stringify(explore.data)).not.toMatch(/auto_eligible|version|subscription_id|offer_id|foreign_target/);
      const data = explore.data as Array<Record<string, unknown>>;
      const subjects = explore.subjects as Array<{ row_index: number; ref: string }>;
      expect(data).toHaveLength(2);
      const requestFor = (plan: string) => ({ outcome: compiled.rule.outcome,
        subject_refs: { [subjectBinding.binding]: subjects.find(subject => subject.row_index === data.findIndex(row => row.new_plan === plan))!.ref } });
      const automaticRequest = requestFor("plan_b");
      const auto = await call("app.request_change", automaticRequest);
      const human = await call("app.request_change", requestFor("plan_c"));
      evidence.mcp_requests = { automatic: auto, human };
      expect(auto).toMatchObject({ authorization: { approval: "automatic", execution: "not_enabled" }, source_database_changed: false });
      expect(human).toMatchObject({ authorization: { approval: "pending_human_review", execution: "human_review" }, source_database_changed: false });
      expect(await rows()).toEqual(before);
      const proposals = store.listProposals();
      expect(proposals).toHaveLength(2);
      const automaticProposal = proposals.find(proposal => proposal.state === "approved")!;
      const humanProposal = proposals.find(proposal => proposal.state === "pending_review")!;
      expect(automaticProposal).toBeDefined(); expect(humanProposal).toBeDefined();
      expect(store.getWorkerQueueItem(automaticProposal.proposal_id)).toBeUndefined();
      expect(store.approvals(automaticProposal.proposal_id)).toHaveLength(1);
      expect(humanProposal.change_set.approval.required_approvals).toBe(2);
      await checkpoint("fixed_four_mcp_private_facts_automatic_and_fallback_separate_execution_pass");

      // Separate programmatic fixture execution review binds the exact activated Action digest and narrow writer.
      config.supervised_worker = { enabled: true, profile: "staging", capabilities: [], outcomes: [{
        outcome: compiled.rule.outcome, action_boundary_digest: active.registry.rules[0]!.action_boundary_digest,
        mode: "supervised_worker", concurrency: 1, queue_limit: 10, lease_seconds: 60, max_attempts: 1,
        proposal_ttl_seconds: 3600, rate_limit: { executions: 10, window_seconds: 60 },
        write_url_env: "GUIDED_ATOMIC_WRITE_URL", worker_identity: "guided_atomic_worker" }] };
      await fs.writeFile(configPath, JSON.stringify(config));
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      vi.stubEnv("SYNAPSOR_RUNNER_ID", undefined);
      await enqueueApprovedForSupervisedWorker(store, config, configPath, {});
      expect(store.getWorkerQueueItem(automaticProposal.proposal_id)).toMatchObject({ status: "queued" });
      expect(store.getWorkerQueueItem(humanProposal.proposal_id)).toBeUndefined();
      expect(await workerCommand(["run", "--supervised", "--once", "--yes", "--batch-quiet", "--config", configPath, "--store", storePath])).toBe(0);
      const receipts = store.receipts(automaticProposal.proposal_id);
      evidence.receipts = receipts;
      evidence.queue = store.getWorkerQueueItem(automaticProposal.proposal_id);
      expect(evidence.queue).toMatchObject({ status: "completed", terminal_outcome: "applied", attempts: 1 });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.receipt).toMatchObject({ schema_version: "synapsor.execution-receipt.v5", status: "applied", rows_affected: 2,
        atomic_effects: [{ table: "subscriptions", affected_rows: 1 }, { table: "plan_offers", affected_rows: 1 }] });
      const after = await rows();
      expect(after.subscriptions).toEqual(before.subscriptions.map(row => row.row_id === "sub_auto" ? { ...row, plan: "plan_b", version: 8 } : row));
      expect(after.offers).toEqual(before.offers.map(row => row.offer_id === "offer_auto" ? { ...row, status: "consumed", version: 5 } : row));
      expect(await workerCommand(["run", "--supervised", "--once", "--yes", "--batch-quiet", "--config", configPath, "--store", storePath])).toBe(0);
      expect(await rows()).toEqual(after);
      expect(store.receipts(automaticProposal.proposal_id)).toEqual(receipts);
      await checkpoint("supervised_worker_two_target_receipt_and_repeat_delivery_pass");
      evidence.status = "passed";
    } catch (error) {
      const message = String(error).replaceAll(apiKey, "[redacted]");
      evidence.status = "failed"; evidence.failure = message;
      throw new Error(message);
    } finally {
      try { await client?.close(); await server?.close(); await runtime?.close(); store?.close(); }
      finally {
        vi.unstubAllEnvs();
        try {
          await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          for (const role of [reader, writer]) await pool.query(`DROP ROLE IF EXISTS "${role}"`);
          expect((await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rows).toEqual([]);
          expect((await pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [[reader, writer]])).rows).toEqual([]);
          evidence.database_cleanup = "verified";
        } finally {
          await pool.end(); await fs.rm(root, { recursive: true, force: true });
          evidence.temp_cleanup = "removed"; evidence.completed_at = new Date().toISOString();
          evidence.progress = progress; evidence.provider_responses = responses;
          if (evidencePath) {
            await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
            console.log(`guided-atomic evidence: ${evidencePath}`);
          }
        }
      }
    }
  }, 480_000);
});

function assertAtomicDraft(result: ModelActionRuleDraftResult, schema: string, fallback: number) {
  expect(result).toMatchObject({ state: "ready", authority_granted: false, source_database_changed: false, provider: "openai", model: "gpt-5.6-terra" });
  const { compiled } = result;
  expect(compiled.loaded.registry.rules).toHaveLength(1);
  expect(compiled.rule.outcome).toBe("atomic.accept_plan_offer");
  expect(compiled.effect_envelope).toMatchObject({ operation: "update", target_resource: `${schema}.subscriptions`, max_rows: 1,
    conflict_key: "version", version_advance: { column: "version", strategy: "integer_increment" },
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
    atomic_updates: [{ operation: "update", target_resource: `${schema}.plan_offers`, max_rows: 1,
      conflict_key: "version", version_advance: { column: "version", strategy: "integer_increment" } }] });
  expect(Object.keys(compiled.rule.effect.set)).toEqual(["plan"]);
  expect(Object.keys(compiled.rule.atomic_updates![0]!.set)).toEqual(["status"]);
  expect(JSON.stringify(compiled.rule.effect.set)).toMatch(/new_plan/);
  expect(JSON.stringify(compiled.rule.atomic_updates)).toMatch(/consumed/);
  expect(compiled.rule.inputs ?? []).toEqual([]);
  expect(compiled.approval_class).toMatchObject({ mode: "policy", required_role: "billing_reviewer", required_approvals: fallback });
  expect(compiled.approval_class.shared_limits).toHaveLength(2);
  for (const [scope, maximum] of [["boundary", 10], ["tenant", 3]] as const) {
    const limit = compiled.approval_class.shared_limits.find(limit => limit.scope === scope)!;
    expect(limit).toMatchObject({ kind: "count", maximum, window_seconds: 86400 });
    expect(limit.capability).toBeUndefined();
  }
  expect(JSON.stringify(compiled.approval_class.rules[0]!.auto_approve_when)).toContain("auto_eligible");
  expect(JSON.stringify(compiled.rule.require)).not.toContain("auto_eligible");
  for (const field of ["status", "old_plan", "plan", "valid_until", "transaction_time"]) expect(JSON.stringify(compiled.rule.require)).toContain(field);
}
