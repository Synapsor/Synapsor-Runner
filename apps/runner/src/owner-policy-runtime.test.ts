import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore, type ControlPolicyKey, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import type { PolicyManagementParent } from "../../../packages/mcp-server/src/owner-policy-records.js";
import * as actionAuthority from "./action-rule-authority.js";
import { createWorkbenchAskMcpGateway } from "./ask-mcp-gateway.js";
import { migrateProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { inspectMcpToolBoundary, mcpServeHttp, mcpServeStreamableHttp } from "./mcp-runtime.js";
import { createOptionalOwnerPolicyRuntime } from "./owner-policy-runtime.js";
import { tryAsk } from "./try-ask.js";

const roots: string[] = [];
const stores: ProposalStore[] = [];
const signingKey = "owner_policy_runtime_test_signing_key_32bytes";
const issuer = "https://owner-policy.identity.example";
const assistantAudience = "synapsor-owner-assistant";
const humanAudience = "synapsor-owner-human-review";
const parentName = "owner_settings";
const policyName = "my_agent_rules";
type OwnerPolicyRuntime = NonNullable<Awaited<ReturnType<typeof createOptionalOwnerPolicyRuntime>>>;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function credential(input: {
  tenant?: string;
  principal?: string;
  session?: string;
  human?: boolean;
  audience?: string;
}) {
  const human = input.human ?? false;
  return new SignJWT({
    sub: "maya-login",
    tenant_id: input.tenant ?? "acme",
    principal: input.principal ?? "maya",
    actor_kind: "human",
    sid: input.session ?? (human ? "human-review-session" : "assistant-session"),
    policy_channel: human ? "human_review" : "assistant",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(issuer)
    .setAudience(input.audience ?? (human ? humanAudience : assistantAudience))
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(signingKey));
}

function ownerConfig(root: string, controlPath: string, scope: "personal" | "tenant" = "personal"): RuntimeConfig {
  return {
    version: 1,
    mode: "review",
    storage: { sqlite_path: controlPath },
    sources: { source: { engine: "postgres", read_url_env: "UNUSED_SOURCE_URL" } },
    capabilities: [],
    trusted_context: { provider: "environment" },
    action_rules: {
      project_root: root,
      owner_management: {
        parent_name: parentName,
        policy_name: policyName,
        scope,
        credential_env: "ASSISTANT_OWNER_TOKEN",
        authentication: {
          provider: "jwt_hs256",
          issuer,
          audience: assistantAudience,
          secret_env: "OWNER_POLICY_SIGNING_KEY",
        },
        human_review: {
          credential_env: "HUMAN_OWNER_TOKEN",
          audience: humanAudience,
        },
      },
    },
  };
}

function revision(key: ControlPolicyKey, content: unknown): ControlPolicyRevision {
  return {
    ...key,
    revision_id: randomUUID(),
    content,
    content_digest: canonicalJsonDigest(content),
    authority_digest: canonicalJsonDigest(content),
  };
}

async function fixture(options: { scope?: "personal" | "tenant"; migrate?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-owner-policy-runtime-"));
  roots.push(root);
  const controlPath = path.join(root, ".synapsor", "control.db");
  const policyFixture = ownerPolicyTestFixture();
  const parentKey: ControlPolicyKey = { scope: { level: "operator" }, kind: "parent", name: parentName };
  const owner = (tenant_id: string) => ({ level: "principal" as const, tenant_id, principal: "maya" });
  const parentDocument: PolicyManagementParent = {
    schema_version: "synapsor.policy-management-parent.v1",
    delegation: policyFixture.parent,
    agent_owners: [
      { agent: "agent-a", scope: owner("acme") },
      { agent: "agent-a", scope: owner("beta") },
      { agent: "agent-a", scope: { level: "tenant", tenant_id: "acme" } },
      { agent: "agent-a", scope: { level: "tenant", tenant_id: "beta" } },
    ],
    managers: ["acme", "beta"].flatMap((tenant_id) => [
      {
        subject: "maya-login",
        actor_kind: "human" as const,
        tenant_id,
        scope: { mode: "personal" as const },
        permissions: ["inspect", "draft", "activate", "revoke", "audit"] as const,
      },
      {
        subject: "maya-login",
        actor_kind: "human" as const,
        tenant_id,
        scope: { mode: "exact" as const, scope: { level: "tenant" as const, tenant_id } },
        permissions: ["inspect", "draft", "activate", "revoke", "audit"] as const,
      },
    ]),
  };
  const parent = revision(parentKey, parentDocument);
  const snapshot: ControlPolicyMigrationSnapshot = {
    revisions: [parent],
    active: [{ ...parentKey, revision_id: parent.revision_id }],
    drafts: [],
    provenance: [{ path: ".synapsor/owner-policy-parent.json", digest: canonicalJsonDigest(parentDocument) }],
  };
  const env: NodeJS.ProcessEnv = {
    OWNER_POLICY_SIGNING_KEY: signingKey,
    ASSISTANT_OWNER_TOKEN: await credential({ tenant: "acme" }),
    HUMAN_OWNER_TOKEN: await credential({ tenant: "acme", human: true }),
    TENANT_ID: "untrusted-environment-tenant",
  };
  const config = ownerConfig(root, controlPath, options.scope);
  if (options.migrate !== false) {
    const migrated = await migrateProjectControlPolicies({
      projectRoot: root,
      storePath: controlPath,
      config,
      env,
      actor: "test-operator",
      readLegacySnapshot: async () => structuredClone(snapshot),
      validateSnapshot: async (candidate) => { expect(candidate).toEqual(snapshot); },
    });
    await migrated.binding.close();
  }
  const store = new ProposalStore(controlPath);
  stores.push(store);
  vi.spyOn(actionAuthority, "createActiveActionRuleAuthorityLoader").mockReturnValue(async () => ({
    registry: { rules: [{ compiled: policyFixture.compiled }] },
  }) as any);
  const create = () => createOptionalOwnerPolicyRuntime({ projectRoot: root, config, store, env });
  const parentRevision = (managers = parentDocument.managers) => revision(parentKey, { ...parentDocument, managers });
  const replaceParent = async (managers: PolicyManagementParent["managers"]) => {
    const current = (await store.controlPolicies.deployment(await deploymentId(root)))!;
    const next = parentRevision(managers);
    await store.controlPolicies.commit({
      deployment_id: await deploymentId(root),
      expected_epoch: current.epoch,
      revisions: [next],
      active: [{ ...parentKey, revision_id: next.revision_id }],
      event: policyEvent("replace-parent"),
    });
  };
  return { root, controlPath, config, env, store, create, policyFixture, parentDocument, replaceParent };
}

async function deploymentId(root: string): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, ".synapsor", "control-policy", "migration.json"), "utf8")) as { deployment_id?: unknown };
  if (typeof manifest.deployment_id !== "string") throw new Error("Expected migrated control-policy deployment.");
  return manifest.deployment_id;
}

function policyEvent(operation: string) {
  return { event_id: randomUUID(), actor: "test-operator", occurred_at: new Date().toISOString(), receipt: { operation } };
}

async function summary(runtime: OwnerPolicyRuntime) {
  return runtime.tools.callTool("app.explore_data", { policy_view: "agent_rules", section: "summary" });
}

async function saveDraft(runtime: OwnerPolicyRuntime, definition: unknown) {
  const current = await summary(runtime);
  return runtime.tools.callTool("app.request_change", {
    policy_view: "agent_rules",
    outcome: "agent_rules.propose_revision",
    control_ref: current.control_ref,
    definition,
  });
}

async function saveOwnerManagementConfig(
  f: Awaited<ReturnType<typeof fixture>>,
  fileName: "synapsor.actions.runner.json" | "synapsor.runner.json",
) {
  const config = structuredClone(f.config);
  config.action_rules = {
    ...config.action_rules!,
    subject_reference_hmac_key_env: "OWNER_SETTINGS_SUBJECT_KEY",
    subject_reference_namespace: "owner-settings-test",
  };
  f.env.OWNER_SETTINGS_SUBJECT_KEY = "owner_settings_subject_reference_key_32bytes";
  await fs.writeFile(path.join(f.root, fileName), JSON.stringify(config, null, 2));
}

async function expectOwnerSettingsOnlyGateway(
  f: Awaited<ReturnType<typeof fixture>>,
  configPath: string,
) {
  const gateway = await createWorkbenchAskMcpGateway({
    configPath,
    storePath: f.controlPath,
    projectRoot: f.root,
    env: f.env,
    mode: "authoring",
  });
  try {
    expect(gateway.ownerSettingsOnly).toBe(true);
    expect(gateway.ownerManagementBinding).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect((await gateway.listTools()).map((tool) => tool.name)).toEqual([
      "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change",
    ]);
    await expect(gateway.callTool("app.describe_data", { policy_view: "agent_rules" }))
      .resolves.toMatchObject({ ok: true, value: { resources: [{ id: "runner.agent_rules" }] } });
    await expect(gateway.callTool("app.describe_actions", { policy_view: "agent_rules" }))
      .resolves.toMatchObject({ ok: true, value: { actions: [{ outcome: "agent_rules.propose_revision" }] } });
    const viewed = await gateway.callTool("app.explore_data", { policy_view: "agent_rules", section: "summary" });
    expect(viewed).toMatchObject({ ok: true, value: { active: null, draft: null } });
    await expect(gateway.callTool("app.request_change", {
      policy_view: "agent_rules",
      outcome: "agent_rules.propose_revision",
      control_ref: viewed.value.control_ref,
      definition: f.policyFixture.definition,
    })).resolves.toMatchObject({ ok: true, value: { status: "draft_saved", source_database_changed: false } });
    await expect(gateway.callTool("app.explore_data", {
      plan: { kind: "rows", resource: "source.requests", select: ["id"] },
    })).resolves.toMatchObject({ ok: false, error_code: "MCP_TOOL_ARGUMENTS_INVALID" });
  } finally {
    await gateway.close();
  }
}

describe("governed owner-policy runtime sidecar", () => {
  it("has no effect when absent and fails closed for unmigrated or shadow SQLite stores", async () => {
    const f = await fixture({ migrate: false });
    const absent = { ...f.config, action_rules: { project_root: f.root } } as RuntimeConfig;
    expect(await createOptionalOwnerPolicyRuntime({ projectRoot: f.root, config: absent, store: f.store, env: f.env })).toBeUndefined();
    await expect(f.create()).rejects.toMatchObject({ code: "POLICY_STORE_REVIEW_REQUIRED" });

    const migrated = await fixture();
    const shadow = new ProposalStore(path.join(migrated.root, "shadow-control.db"));
    stores.push(shadow);
    await expect(createOptionalOwnerPolicyRuntime({ projectRoot: migrated.root, config: migrated.config, store: shadow, env: migrated.env }))
      .rejects.toMatchObject({ code: "POLICY_REPOSITORY_UNAVAILABLE" });
  }, 20_000);

  it("uses verified identity claims for personal and tenant scope, never environment identity, and isolates Maya's owners", async () => {
    const f = await fixture();
    const runtime = await f.create();
    if (!runtime) throw new Error("Expected configured owner-policy runtime.");

    const acme = await summary(runtime);
    expect(acme).toMatchObject({ scope: "Your personal agent rules", agents_available: ["agent-a"], active: null, draft: null });
    f.env.ASSISTANT_OWNER_TOKEN = await credential({ tenant: "beta" });
    const beta = await summary(runtime);
    expect(beta).toMatchObject({ scope: "Your personal agent rules", agents_available: ["agent-a"], active: null, draft: null });
    await expect(runtime.tools.callTool("app.request_change", {
      policy_view: "agent_rules", outcome: "agent_rules.propose_revision", control_ref: acme.control_ref, definition: f.policyFixture.definition,
    })).rejects.toMatchObject({ code: "POLICY_REFERENCE_UNAVAILABLE" });
    await saveDraft(runtime, f.policyFixture.definition);
    f.env.ASSISTANT_OWNER_TOKEN = await credential({ tenant: "acme" });
    expect(await summary(runtime)).toMatchObject({ draft: null });

    const shared = await fixture({ scope: "tenant" });
    const tenantRuntime = await shared.create();
    if (!tenantRuntime) throw new Error("Expected configured tenant owner-policy runtime.");
    expect(await summary(tenantRuntime)).toMatchObject({ scope: "Your account's shared agent rules" });
    shared.env.ASSISTANT_OWNER_TOKEN = await credential({ tenant: "beta" });
    expect(await summary(tenantRuntime)).toMatchObject({ scope: "Your account's shared agent rules" });
    await saveDraft(tenantRuntime, shared.policyFixture.definition);
    shared.env.ASSISTANT_OWNER_TOKEN = await credential({ tenant: "acme" });
    expect(await summary(tenantRuntime)).toMatchObject({ draft: null });
  }, 20_000);

  it("saves a disabled draft through the provider and requires the separate human audience, environment, and session to activate", async () => {
    const f = await fixture();
    const runtime = await f.create();
    if (!runtime) throw new Error("Expected configured owner-policy runtime.");

    const draft = await saveDraft(runtime, f.policyFixture.definition);
    expect(draft).toMatchObject({ status: "draft_saved", authority_changed: false, source_database_changed: false,
      review: { state: "human_review_pending" } });
    expect((await summary(runtime))).toMatchObject({ active: null, draft: { action_count: 1 } });

    delete f.env.HUMAN_OWNER_TOKEN;
    await expect(runtime.review.prepare()).rejects.toMatchObject({ code: "POLICY_CREDENTIAL_REQUIRED" });
    f.env.HUMAN_OWNER_TOKEN = f.env.ASSISTANT_OWNER_TOKEN;
    await expect(runtime.review.prepare()).rejects.toMatchObject({ code: "POLICY_AUTHENTICATION_FAILED" });
    const firstHuman = await credential({ tenant: "acme", human: true, session: "review-session-one" });
    f.env.HUMAN_OWNER_TOKEN = firstHuman;
    const review = await runtime.review.prepare();
    expect(review.summary).toMatchObject({ source_database_changed: false });
    f.env.HUMAN_OWNER_TOKEN = await credential({ tenant: "acme", human: true, session: "review-session-two" });
    await expect(review.confirm()).rejects.toMatchObject({ code: "POLICY_REVIEW_INVALID" });
    f.env.HUMAN_OWNER_TOKEN = firstHuman;
    await expect(review.confirm()).resolves.toMatchObject({ status: "committed", source_database_changed: false });
    expect(await summary(runtime)).toMatchObject({ active: { action_count: 1 }, draft: null });

    f.env.ASSISTANT_OWNER_TOKEN = await credential({ tenant: "acme", audience: "source-reader" });
    await expect(summary(runtime)).rejects.toMatchObject({ code: "POLICY_AUTHENTICATION_FAILED" });
  });

  it("denies confirmation after parent grants are revoked", async () => {
    const f = await fixture();
    const runtime = await f.create();
    if (!runtime) throw new Error("Expected configured owner-policy runtime.");

    await saveDraft(runtime, f.policyFixture.definition);
    const review = await runtime.review.prepare();
    await f.replaceParent([]);
    await expect(review.confirm()).rejects.toMatchObject({ code: "POLICY_MANAGEMENT_FORBIDDEN" });
    expect(await f.store.controlPolicies.active(await deploymentId(f.root), {
      scope: { level: "principal", tenant_id: "acme", principal: "maya" }, kind: "delegation", name: policyName,
    })).toBeUndefined();
  });

  it("lets a rebuilt runtime review and activate the durable existing draft", async () => {
    const f = await fixture();
    const runtime = await f.create();
    if (!runtime) throw new Error("Expected configured owner-policy runtime.");
    await saveDraft(runtime, f.policyFixture.definition);
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const rebuiltStore = new ProposalStore(f.controlPath);
    stores.push(rebuiltStore);
    const rebuilt = await createOptionalOwnerPolicyRuntime({ projectRoot: f.root, config: f.config, store: rebuiltStore, env: f.env });
    if (!rebuilt) throw new Error("Expected rebuilt owner-policy runtime.");
    expect(await summary(rebuilt)).toMatchObject({ active: null, draft: { action_count: 1 } });
    const resumed = await rebuilt.review.prepare();
    await expect(resumed.confirm()).resolves.toMatchObject({ status: "committed", source_database_changed: false });
    expect(await summary(rebuilt)).toMatchObject({ active: { action_count: 1 }, draft: null });
  });

  it("uses the real Ask gateway's owner-settings-only fallback when source Read is absent", async () => {
    const f = await fixture();
    await saveOwnerManagementConfig(f, "synapsor.actions.runner.json");
    await expectOwnerSettingsOnlyGateway(f, path.join(f.root, "synapsor.runner.json"));
  }, 20_000);

  it("uses main-config owner management when the companion action config is absent", async () => {
    const f = await fixture();
    await fs.rm(path.join(f.root, "synapsor.actions.runner.json"), { force: true });
    const configPath = path.join(f.root, "synapsor.runner.json");
    await saveOwnerManagementConfig(f, "synapsor.runner.json");
    await expectOwnerSettingsOnlyGateway(f, configPath);
  }, 20_000);

  it("previews the authenticated owner-settings boundary without Read and rejects HTTP serving before a server starts", async () => {
    const f = await fixture();
    const configPath = path.join(f.root, "synapsor.runner.json");
    await saveOwnerManagementConfig(f, "synapsor.runner.json");
    for (const [name, value] of Object.entries(f.env)) vi.stubEnv(name, value ?? "");
    try {
      const preview = await inspectMcpToolBoundary(["--config", configPath]);
      expect(preview).toMatchObject({
        ok: true,
        surface: "owner_settings",
        configPath,
        storePath: f.controlPath,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "source authority reported separately", ok: true,
            detail: expect.stringContaining("Source Read authority is disabled") }),
        ]),
      });
      expect(preview.names.sort()).toEqual(["app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change"]);
      await expect(mcpServeHttp(["--config", configPath, "--port", "48765"]))
        .rejects.toThrow("Owner-rule management currently requires local stdio MCP");
      await expect(mcpServeStreamableHttp(["--config", configPath, "--port", "48765"]))
        .rejects.toThrow("Owner-rule management currently requires local stdio MCP");
    } finally {
      vi.unstubAllEnvs();
    }
  }, 20_000);

  it("opens bare governed owner settings with an unknown profile and makes no provider request", async () => {
    const f = await fixture();
    const configPath = path.join(f.root, "synapsor.runner.json");
    await saveOwnerManagementConfig(f, "synapsor.runner.json");
    const writes: string[] = [];
    const confirmEgress = vi.fn(async () => true);
    const requestJson = vi.fn();
    const profileResolver = vi.fn(async () => "unknown" as const);
    const close = vi.fn();

    await expect(tryAsk([
      "--project-root", f.root,
      "--config", configPath,
      "--store", f.controlPath,
      "--provider", "openai",
      "--model", "gpt-owner-settings-test",
    ], {
      env: { ...f.env, OPENAI_API_KEY: "sk-owner-settings-no-request" },
      gatewayFactory: createWorkbenchAskMcpGateway,
      profileResolver,
      confirmEgress,
      providerDependencies: { requestJson },
      boundaryCatalogLoader: async () => undefined,
      shellIo: {
        read: async () => "/exit",
        write: (value) => writes.push(value),
        columns: () => 100,
        onInterrupt: () => () => undefined,
        close,
      },
    })).resolves.toBe(0);

    expect(profileResolver).toHaveBeenCalledWith(f.root);
    expect(confirmEgress).toHaveBeenCalledOnce();
    expect(requestJson).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(writes.join("\n")).toContain("Agent settings - source Read authority is disabled");
    expect(writes.join("\n")).not.toContain("Scoped Explore active");
  }, 20_000);
});
