import { encodeOperatorAuthority } from "./control-policy-authority-codec.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActionRuleAuthority } from "@synapsor-runner/action-rules";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore, type ControlPolicyKey, type ControlPolicyRevision, type ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import { subjectReferenceScopeFingerprints, type RuntimeConfig, type StreamableHttpSessionFactory } from "@synapsor-runner/mcp-server";
import * as mcp from "@synapsor-runner/mcp-server";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import { compileOwnerPolicy } from "../../../packages/mcp-server/src/owner-policy-compiler.js";
import type { PolicyManagementParent } from "../../../packages/mcp-server/src/owner-policy-records.js";
import * as actionAuthority from "./action-rule-authority.js";
import * as semanticRuntime from "./semantic-action-runtime.js";
import * as authoringMcp from "./authoring-mcp.js";
import * as autoBoundary from "./auto-boundary.js";
import * as localTestIdentity from "./local-test-runtime-identity.js";
import { createProjectRuntimeStore, migrateProjectControlPolicies } from "./control-policy-store.js";
import { encodeOperatorExecutionPolicy, executionBindingDigest, readOperatorExecutionConfig } from "./control-policy-execution.js";
import { ownerPolicyCommand } from "./owner-policy-commands.js";
import { readRuntimeConfig } from "./cli-project.js";
import { mcpServe, productionExploreSessionFactory } from "./mcp-runtime.js";

vi.mock("@synapsor-runner/mcp-server", async (importOriginal) => ({
  ...await importOriginal<typeof import("@synapsor-runner/mcp-server")>(),
  serveStdio: vi.fn(),
  startStreamableHttpMcpServer: vi.fn(),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(mcp.serveStdio).mockReset();
  vi.mocked(mcp.startStreamableHttpMcpServer).mockReset();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function temporaryProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-selected-execution-config-"));
  roots.push(root);
  return root;
}

describe("selected execution configuration through public MCP callers", () => {
  it.each(["stdio", "streamable-http"] as const)("queues through %s after public connection and execution confirmations on a copied config", async (transport) => {
    const f = await delegatedExecutionFixture();
    let services: semanticRuntime.ActionRuleRuntimeServices | undefined;
    const create = semanticRuntime.createOptionalActionRuleRuntimeServices;
    const composed = vi.spyOn(semanticRuntime, "createOptionalActionRuleRuntimeServices").mockImplementation(async (input) => {
      services = await create({ ...input, factSessionFactory: f.facts });
      return services;
    });
    const output: string[] = [];
    const choose = vi.fn(async () => "confirm");
    try {
      const before = await f.binding.repository.scopeSnapshot({ deployment_id: f.binding.deployment_id, scope: { level: "operator" }, kinds: ["execution"] });
      expect(await ownerPolicyCommand(["connection", "--config", f.configPath, "--input", f.connectionPath], {
        env: f.env, io: { choose, read: async () => undefined, write: (text) => output.push(text), columns: () => 100 },
      })).toBe(0);
      expect(choose).toHaveBeenCalledTimes(2);
      expect(output.join("\n")).toContain("Review existing execution with changed sign-ins");
      const config = await readRuntimeConfig(f.configPath, { env: f.env });
      expect(config.action_rules!.owner_delegation).toEqual(f.connections.owner_delegation);
      expect(config.action_rules!.owner_management).toBeUndefined();
      expect(config.supervised_worker).toEqual(f.initial.supervised_worker);
      expect(await fs.readFile(f.canonicalPath, "utf8")).toBe(f.canonicalText);
      await expect(readOperatorExecutionConfig({ projectRoot: f.root, config: f.initial, policyStore: f.binding }))
        .rejects.toMatchObject({ code: "POLICY_EXECUTION_BINDING_CHANGED" });
      const reviewed = await f.binding.repository.scopeSnapshot({ deployment_id: f.binding.deployment_id, scope: { level: "operator" }, kinds: ["execution"] });
      expect(reviewed.epoch).toBe(before.epoch + 1);
      expect(reviewed.active[0]!.content).toMatchObject({ runtime_binding_digest: executionBindingDigest(config), policy: f.initial.supervised_worker });
      const selectedText = await fs.readFile(f.configPath, "utf8");
      let requests = 0;
      const request = async (runtime: semanticRuntime.ActionRuleRuntimeServices["semanticActions"], store: ProposalRuntimeStore) => {
        expect(services).toBeDefined();
        const active = f.authority.registry.rules[0]!;
        const [subject] = await services!.subjectReferences.issue({ source_id: active.compiled.source,
          read_boundary_digest: active.read_boundary_digest, generation_lock_fingerprint: active.compiled.generation_lock_fingerprint,
          workflow_session_id: services!.workflow_session_id, resource: f.policy.resource, evidence_bundle_id: "selected-config-evidence",
          ...subjectReferenceScopeFingerprints({ key: services!.key, deployment_scope: services!.deployment_scope,
            source_id: active.compiled.source, tenant: "acme", principal: "maya" }),
          observations: [{ row_index: 0, primary_key_value: "request-1", observed_version_value: 1 }],
        });
        const args = { outcome: active.compiled.outcome, subject_refs: { request: subject!.ref }, inputs: { quantity: 10 } };
        expect(await runtime.callTool("app.request_change", args)).toMatchObject({ execution: "queued", proposal: { status: "approved" }, source_database_changed: false });
        expect(await runtime.callTool("app.request_change", args)).toMatchObject({ execution: "queued", request_disposition: "already_recorded", source_database_changed: false });
        expect(await store.listWorkerQueue!()).toHaveLength(1);
        const proposals = await store.listProposals!();
        expect(proposals).toHaveLength(1);
        expect(await store.receipts(proposals[0]!.proposal_id)).toEqual([]);
        requests += 1;
      };
      for (const [name, value] of Object.entries(f.env)) vi.stubEnv(name, value);
      if (transport === "stdio") {
        vi.mocked(mcp.serveStdio).mockImplementation(async (input) => {
          if (!input) throw new Error("Expected the public stdio caller's selected runtime");
          expect(input.configPath).toBe(f.configPath);
          expect(input.semanticActions).toBe(services!.semanticActions);
          await request(input.semanticActions!, input.store!);
        });
        expect(await mcpServe(["--config", f.configPath, "--store", f.storePath])).toBe(0);
      } else {
        const completed = new Error("fixture transport callback completed");
        vi.mocked(mcp.startStreamableHttpMcpServer).mockImplementation(async (input) => {
          if (!input) throw new Error("Expected the public HTTP caller's selected runtime");
          expect(input.configPath).toBe(f.configPath);
          expect(input.streamableSessionFactory).toBeTypeOf("function");
          const store = await createProjectRuntimeStore({ projectRoot: f.root, config, env: f.env, storePath: f.storePath });
          let session: Awaited<ReturnType<StreamableHttpSessionFactory>> | undefined;
          try {
            session = await input.streamableSessionFactory!({ config, env: f.env, store,
              trustedContext: { tenant_id: "acme", principal: "maya", provenance: "http_claims" }, authenticationFingerprint: "selected-config-session" });
            await request(services!.semanticActions, store);
          } finally { await session?.close(); await store.close(); }
          throw completed;
        });
        await expect(mcpServe(["--transport", transport, "--config", f.configPath, "--store", f.storePath])).rejects.toBe(completed);
      }
      expect(requests).toBe(1);
      expect(composed).toHaveBeenCalledOnce();
      expect(composed.mock.calls[0]![0].configPath).toBe(f.configPath);
      expect(f.facts).toHaveBeenCalledTimes(2);
      for (const [input] of f.facts.mock.calls) expect(input.config).toEqual(config);
      expect((await f.binding.repository.deployment(f.binding.deployment_id))!.epoch).toBe(reviewed.epoch);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(selectedText);
      expect(await fs.readFile(f.canonicalPath, "utf8")).toBe(f.canonicalText);
    } finally { await f.binding.close(); }
  });

  it.each(["companion", "primary"] as const)("passes the actual managed %s selection, not the launch filename", async (selection) => {
    const root = await temporaryProject(), configPath = path.join(root, "custom.runner.json");
    const canonicalPath = path.join(root, "synapsor.actions.runner.json");
    const primary: RuntimeConfig = { version: 1, mode: "read_only", storage: { sqlite_path: path.join(root, "control.db") }, capabilities: [],
      trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "maya" } },
      sources: { local_postgres: { engine: "postgres", read_url_env: "READ_URL", read_only: true } }, action_rules: { project_root: root } };
    await fs.writeFile(configPath, JSON.stringify(primary));
    if (selection === "companion") await fs.writeFile(canonicalPath, JSON.stringify({ ...primary, mode: "review" }));
    const create = vi.spyOn(semanticRuntime, "createOptionalReadActionRuleRuntimeServices").mockResolvedValue(undefined);
    const serve = vi.spyOn(authoringMcp, "serveScopedExploreStdio").mockResolvedValue(undefined);
    expect(await mcpServe(["--authoring", "--project-root", root, "--config", configPath])).toBe(0);
    expect(serve).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({ configPath: selection === "companion" ? canonicalPath : configPath,
      config: { mode: selection === "companion" ? "review" : "read_only" } });
  });

  it.each([false, true])("default local launch uses the reviewed identity and preserves read-only override: %s", async (readOnly) => {
    const root = await temporaryProject(), configPath = path.join(root, "synapsor.runner.json");
    const actionPath = path.join(root, "synapsor.actions.runner.json");
    const primary: RuntimeConfig = { version: 1, mode: "read_only", capabilities: [],
      trusted_context: { provider: "environment" },
      sources: { local_postgres: { engine: "postgres", read_url_env: "READ_URL", read_only: true } },
      action_rules: { project_root: root } };
    await fs.writeFile(configPath, JSON.stringify(primary));
    await fs.writeFile(actionPath, JSON.stringify({ ...primary, mode: "review" }));
    vi.spyOn(autoBoundary, "loadActivatedExplorationBoundaries").mockResolvedValue([
      { activation: { state: "active" }, deployment_profile: "staging" },
    ] as never);
    const create = vi.spyOn(semanticRuntime, "createOptionalReadActionRuleRuntimeServices").mockResolvedValue(undefined);
    const serve = vi.spyOn(authoringMcp, "serveScopedExploreStdio").mockResolvedValue(undefined);
    const identity = vi.spyOn(localTestIdentity, "withLocalTestRuntimeIdentity");
    await expect(mcpServe(["--config", configPath, "--local-test-runtime", ".synapsor/local-test-runtime.json",
      ...(readOnly ? ["--read-only"] : [])])).resolves.toBe(0);
    expect(identity).toHaveBeenCalledExactlyOnceWith({ projectRoot: root, runtimePath: ".synapsor/local-test-runtime.json" }, expect.any(Function));
    expect(serve).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(readOnly ? 0 : 1);
    if (!readOnly) expect(create.mock.calls[0]![0]).toMatchObject({ configPath: actionPath, config: { mode: "review" } });
  });

  it("refuses a local identity option on an explicit action-only service", async () => {
    const root = await temporaryProject(), configPath = path.join(root, "synapsor.actions.runner.json");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "review", capabilities: [], action_rules: { project_root: root },
      trusted_context: { provider: "environment" },
      sources: { local_postgres: { engine: "postgres", read_url_env: "READ_URL", read_only: true } } }));
    await expect(mcpServe(["--config", configPath, "--local-test-runtime", ".synapsor/local-test-runtime.json"]))
      .rejects.toThrow("local reviewed stdio service");
    expect(mcp.serveStdio).not.toHaveBeenCalled();
  });

  it("starts an empty authoring project with the optional local runtime reference", async () => {
    const root = await temporaryProject();
    const configPath = path.join(root, "synapsor.runner.json");
    const serve = vi.spyOn(authoringMcp, "serveScopedExploreStdio").mockResolvedValue(undefined);
    await expect(mcpServe([
      "--authoring", "--project-root", root, "--config", configPath,
      "--local-test-runtime", ".synapsor/local-test-runtime.json",
    ])).resolves.toBe(0);
    expect(serve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectRoot: root, modelAuthorityMetadata: "semantic" }));
    await expect(fs.lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(path.join(root, ".synapsor"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])("propagates production factory path provenance only when supplied: %s", async (hasPath) => {
    const root = await temporaryProject(), configPath = path.join(root, "production/custom.runner.json");
    const store = new ProposalStore();
    const config = { version: 1, mode: "review", capabilities: [], sources: { local_postgres: { engine: "postgres", read_url_env: "READ_URL" } },
      production_explore: { enabled: true, project_root: root, required_oauth_scope: "synapsor:explore", budget_hmac_key_env: "BUDGET_KEY", accounting_namespace: randomUUID(),
        tenant_limits: { max_queries_per_rolling_24_hours: 10, max_extracted_cells_per_rolling_24_hours: 100,
          max_differencing_queries_per_rolling_24_hours: 2, requests_per_minute: 5 } } } as RuntimeConfig;
    const create = vi.spyOn(semanticRuntime, "createOptionalReadActionRuleRuntimeServices").mockResolvedValue(undefined);
    const runtimeClose = vi.fn(async () => undefined), serverClose = vi.fn(async () => undefined);
    const factory = productionExploreSessionFactory(config, { READ_URL: "fixture-source-not-opened", BUDGET_KEY: "fixture-budget-key-at-least-32-bytes" }, {
      ...(hasPath ? { configPath } : {}),
      loadBoundaries: async () => [{ source: "local_postgres" }] as never,
      createExecutor: () => ({ execute: async () => [], executeBatch: async () => [], close: async () => undefined }),
      createBoundarySetRuntime: async () => ({ close: runtimeClose }) as never,
      createMcpServer: () => ({ close: serverClose }) as never,
    });
    try {
      const session = await factory({ config, env: {}, store,
        trustedContext: { tenant_id: "acme", principal: "maya", provenance: "http_claims" }, authenticationFingerprint: "factory-session" });
      await session.close();
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]![0].configPath).toBe(hasPath ? configPath : undefined);
      expect(runtimeClose).toHaveBeenCalledOnce();
      expect(serverClose).toHaveBeenCalledOnce();
    } finally { await factory.close?.(); store.close(); }
  });
});

async function delegatedExecutionFixture() {
  const root = await temporaryProject(), policy = ownerPolicyTestFixture();
  const loaded = createActionRuleAuthority({ name: "reviewed_runtime_actions", action_boundary_name: "reviewed.actions",
    catalog: { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: policy.compiled.generation_lock_fingerprint,
      resources: [policy.compiled.target_resource], relationships: [] },
    rules: [{ read_boundary_name: "reviewed.read", read_boundary_digest: canonicalJsonDigest("fixture-read"),
      rule: policy.compiled.rule, verification_boundary: policy.compiled.verification_boundary, effect_envelope: policy.compiled.effect_envelope,
      activated_at: "2026-09-09T00:00:00.000Z" }],
    approval_classes: [{ name: policy.compiled.approval_class, mode: "policy", required_role: "reviewer", required_approvals: 1,
      rules: [{ outcome: policy.compiled.outcome, auto_approve_when: policy.compiled.rule.require }], shared_limits: [
        { id: "boundary", kind: "count", scope: "boundary", maximum: 10, window_seconds: 86400 },
        { id: "tenant", kind: "count", scope: "tenant", maximum: 3, window_seconds: 86400 },
      ] }],
  });
  const authority = { ...loaded, activation: { schema_version: "synapsor.action-rule-authority-activation.v1" as const, state: "active" as const,
    authority: loaded.authority, digest: loaded.authority.digest, actor: "fixture_operator", activated_at: "2026-09-09T00:00:00.000Z", reviews: [{ outcome: policy.compiled.outcome,
      when: "Reviewed facts permit the request.", then: "Create a proposal.", refused: ["Facts do not permit the request."],
      human_review: "A human review may be required.", examples: [{kind: "eligible" as const, scenario: "Eligible", result: "Create a proposal"}] }] } };

  vi.spyOn(actionAuthority, "loadActiveActionRuleAuthority").mockResolvedValue(authority);
  const owner = { level: "principal", tenant_id: "acme", principal: "maya" } as const;
  const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: "runtime_parent" };
  const ownerKey: ControlPolicyKey = { scope: owner, kind: "delegation", name: "maya_runtime_policy" };
  const record = (key: ControlPolicyKey, content: unknown, digest: ControlPolicyRevision["authority_digest"] = canonicalJsonDigest(content)): ControlPolicyRevision => ({ ...key,
    revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest: digest });
  const parentDocument: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", managers: [], delegation: policy.parent,
    agent_owners: [{ agent: "agent-a", scope: owner }], runtime_delegations: [{ agent: "agent-a", delegator: "maya", owner,
      policies: [{ scope: owner, name: ownerKey.name }], expires_at: new Date(Date.now() + 600000).toISOString() }] };
  const parent = record(parentKey, parentDocument);
  const compiledOwner = compileOwnerPolicy({ parent: { ...policy.parent, agents: ["agent-a"] }, definition: policy.definition,
    rules: [loaded.registry.rules[0]!.compiled] });
  const ownerPolicy = record(ownerKey, { schema_version: "synapsor.managed-owner-policy.v1", parent_name: parentKey.name,
    parent_revision_id: parent.revision_id, parent_authority_digest: parent.authority_digest,
    definition: policy.definition, compiled_digest: compiledOwner.digest }, compiledOwner.digest);
  const storePath = path.join(root, "control.db"), canonicalPath = path.join(root, "synapsor.actions.runner.json"), configPath = path.join(root, "custom.runner.json");
  const initial: RuntimeConfig = { version: 1, mode: "review", capabilities: [], storage: { sqlite_path: storePath },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "maya" } },
    sources: { local_postgres: { engine: "postgres", read_url_env: "READ_URL", write_url_env: "WRITE_URL", read_only: false, receipts: { authority: "runner_ledger" } } },
    action_rules: { project_root: root, subject_reference_hmac_key_env: "SUBJECT_KEY", subject_reference_namespace: "selected-config-fixture" },
    supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [{ outcome: policy.compiled.outcome,
      action_boundary_digest: loaded.authority.action_boundary.digest, mode: "supervised_worker", concurrency: 1, queue_limit: 10,
      lease_seconds: 60, max_attempts: 3, proposal_ttl_seconds: 300, rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "WRITE_URL" }] } };
  const secret = "selected_config_workload_key_at_least_32_bytes", issuer = "https://fixture-identity.example", audience = "fixture-workload";
  const token = await new SignJWT({ sub: "agent-workload", tenant_id: "acme", principal: "maya", agent_id: "agent-a", delegator: "maya", run_id: "run-1",
    actor_kind: "agent", delegation_channel: "runtime" }).setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience(audience)
    .setExpirationTime("5m").sign(new TextEncoder().encode(secret));
  const env = { SUBJECT_KEY: "selected_config_subject_key_at_least_32_bytes", WORKLOAD_SECRET: secret, WORKLOAD_TOKEN: token };
  const connections = { owner_delegation: { parent_name: parentKey.name, credential_env: "WORKLOAD_TOKEN",
    authentication: { provider: "jwt_hs256", issuer, audience, secret_env: "WORKLOAD_SECRET" } } };
  const connectionPath = path.join(root, "workload-connection.json"), canonicalText = JSON.stringify(initial);
  await fs.writeFile(canonicalPath, canonicalText);
  await fs.copyFile(canonicalPath, configPath);
  await fs.writeFile(connectionPath, JSON.stringify(connections));
  const actionRecord = encodeOperatorAuthority({ type: "action", authority: actionAuthority.parseStoredActionRuleAuthority(authority.activation) });
  const revisions = [actionRecord, parent, ownerPolicy, encodeOperatorExecutionPolicy(initial)!];
  const snapshot = { revisions, active: revisions.map(({ scope, kind, name, revision_id }) => ({ scope, kind, name, revision_id })), drafts: [], provenance: [] };
  const { binding } = await migrateProjectControlPolicies({ projectRoot: root, config: initial, storePath, env, actor: "fixture_operator",
    readLegacySnapshot: async () => structuredClone(snapshot), validateSnapshot: async (candidate) => { expect(candidate).toEqual(snapshot); } });
  vi.spyOn(actionAuthority, "createActiveActionRuleAuthorityLoader").mockReturnValue(async () => ({ ...authority,
    policy_revision: { deployment_id: binding.deployment_id, action_name: actionRecord.name, revision_id: actionRecord.revision_id } }));
  const facts = vi.fn(async (_input: Parameters<NonNullable<semanticRuntime.ActionRuleRuntimeServiceInput["factSessionFactory"]>>[0]) => ({
    fact_loader: { engine: "postgres" as const, load: async () => structuredClone(policy.facts.bindings.request!.rows) }, close: async () => undefined,
  }));
  return { root, policy, authority, binding, initial, configPath, storePath, canonicalPath, canonicalText, connectionPath, connections, env, facts };
}
