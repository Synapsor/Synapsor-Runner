import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sqliteControlPolicyRepository, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { createPolicyManagementService, createPolicyManagementTools, createPolicyReviewContinuationService } from "@synapsor-runner/mcp-server";
import { createPolicyManagementJwtAuthenticator } from "../../../packages/mcp-server/src/policy-management-identity.js";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";
import type { ScopedExploreRuntime } from "./scoped-explore.js";

describe("owner settings through the existing MCP server", () => {
  it("keeps four tools, separates two owners and hands the exact disabled revision to authenticated human review", async () => {
    const db = new DatabaseSync(":memory:");
    const clients: Client[] = [], servers: ReturnType<typeof createScopedExploreMcpServer>[] = [];
    try {
      db.exec("PRAGMA foreign_keys = ON");
      const repository = sqliteControlPolicyRepository(db); await repository.initialize();
      const f = ownerPolicyTestFixture(), secret = randomBytes(32), deployment = randomUUID();
      const scope = (tenant_id: string) => ({ level: "principal" as const, tenant_id, principal: "maya" });
      const content = { schema_version: "synapsor.policy-management-parent.v1", delegation: f.parent,
        agent_owners: [{ agent: "agent-a", scope: scope("acme") }, { agent: "agent-b", scope: scope("beta") }],
        managers: ["acme", "beta"].map((tenant_id) => ({ subject: "maya-login", tenant_id, actor_kind: "human", scope: { mode: "personal" },
          permissions: ["inspect", "draft", "activate", "revoke", "audit"] })) };
      const parent: ControlPolicyRevision = { scope: { level: "operator" }, kind: "parent", name: "agent_settings", revision_id: randomUUID(),
        content, content_digest: canonicalJsonDigest(content), authority_digest: canonicalJsonDigest(content) };
      await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest({ deployment }),
        revisions: [parent], active: [{ ...parent, revision_id: parent.revision_id }],
        event: { event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {} } });
      const authConfig = { provider: "jwt_hs256" as const, issuer: "https://identity.example", audience: "settings-assistant", secret_env: "KEY" };
      const key = secret.toString("base64");
      const credential = (tenant: string, human = false) => new SignJWT({ sub: "maya-login", tenant_id: tenant, principal: "maya", actor_kind: "human", sid: "local-session",
        policy_channel: human ? "human_review" : "assistant" }).setProtectedHeader({ alg: "HS256" }).setIssuer(authConfig.issuer)
        .setAudience(human ? "settings-review" : authConfig.audience).setExpirationTime("5m").sign(new TextEncoder().encode(key));
      const service = createPolicyManagementService({ repository, deployment_id: deployment, parent_name: parent.name,
        assistant_authenticate: createPolicyManagementJwtAuthenticator(authConfig, "assistant", { KEY: key }),
        human_authenticate: createPolicyManagementJwtAuthenticator({ ...authConfig, audience: "settings-review" }, "human_review", { KEY: key }),
        resolveRules: async () => [f.compiled] });
      const review = createPolicyReviewContinuationService(service);
      const source = vi.fn(async () => { throw new Error("Settings must never call the source adapter"); });
      // The Read runtime is a transport stub. Policy storage, JWT verification,
      // compiler, human review and MCP request/response validation are real.
      const runtime = { boundary: { pack: { name: "source_reads", resources: [] }, activation: { digest: canonicalJsonDigest("read") } },
        session_fingerprint: canonicalJsonDigest("source_session"), describe: source, validate: source, explore: source, close: async () => {} } as unknown as ScopedExploreRuntime;
      async function connect(tenant: string) {
        const jwt = await credential(tenant);
        const tools = createPolicyManagementTools({ service, resolveContext: async () => ({ credential: jwt, scope: scope(tenant),
          policy_name: "my_agent_rules", scope_label: `${tenant} / Maya / Agent rules`, session_id: "mcp-session", expires_at_ms: Date.now() + 300_000 }),
          publishReview: async (target) => review.publish(target).handle });
        const server = createScopedExploreMcpServer(runtime, { policyManagement: tools }); servers.push(server);
        const client = new Client({ name: `settings-${tenant}`, version: "1" }); clients.push(client);
        const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
        return client;
      }
      const acme = await connect("acme"), beta = await connect("beta");
      const names = ["app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change"];
      const listed = (await acme.listTools()).tools;
      expect(listed.map((tool) => tool.name).sort()).toEqual(names);
      for (const tool of listed) expect(tool.inputSchema.properties).toHaveProperty("policy_view");
      expect(listed.find((tool) => tool.name === "app.describe_actions")!.inputSchema.properties).toHaveProperty("query");
      const call = async (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
      const view = { policy_view: "agent_rules" };
      expect((await call(acme, "app.describe_data", view)).structuredContent).toMatchObject({ resources: [{ id: "runner.agent_rules" }], source: "runner_control_plane" });
      const initial = (await call(acme, "app.explore_data", { ...view, section: "summary" })).structuredContent as Record<string, unknown>;
      const ref = initial.control_ref;
      expect(initial).toMatchObject({ active: null, agents_available: ["agent-a"] });
      expect((await call(beta, "app.explore_data", { ...view, section: "summary" })).structuredContent).toMatchObject({ active: null, agents_available: ["agent-b"] });
      const request = { ...view, outcome: "agent_rules.propose_revision", control_ref: ref, definition: f.definition };
      expect((await call(beta, "app.request_change", request)).structuredContent).toMatchObject({ error_code: "POLICY_REFERENCE_UNAVAILABLE" });
      const proposed = await call(acme, "app.request_change", request);
      expect(proposed.isError).not.toBe(true);
      expect(proposed.structuredContent).toMatchObject({ status: "draft_saved", authority_changed: false, review: { state: "human_review_pending" } });
      expect(JSON.stringify(proposed)).not.toMatch(/nonce|compiled_digest|parent_revision_id|tenant_id/u);
      const handle = ((proposed.structuredContent as Record<string, unknown>).review as { continuation: string }).continuation;
      await expect(review.prepare(await credential("acme"), handle)).rejects.toThrow("POLICY_AUTHENTICATION_FAILED");
      const human = await credential("acme", true), prepared = await review.prepare(human, handle);
      expect(prepared.summary).toMatchObject({ scope: scope("acme"), name: "my_agent_rules", source_database_changed: false });
      expect((await call(acme, "app.explore_data", { ...view, section: "summary" })).structuredContent).toMatchObject({ active: null, draft: { action_count: 1 } });
      await review.confirm(human, handle, prepared);
      expect((await call(acme, "app.explore_data", { ...view, section: "summary" })).structuredContent).toMatchObject({ active: { action_count: 1 }, draft: null });
      expect((await call(beta, "app.explore_data", { ...view, section: "summary" })).structuredContent).toMatchObject({ active: null, draft: null });
      expect((await acme.listTools()).tools.map((tool) => tool.name).sort()).toEqual(names);
      expect((await call(acme, "app.explore_data", { ...view, section: "summary", plan: { kind: "rows", resource: "app.requests" } })).isError).toBe(true);
      expect((await call(acme, "app.explore_data", { section: "summary" })).isError).toBe(true);
      expect((await call(acme, "app.describe_data", { ...view, query: "mix routes" })).isError).toBe(true);
      expect(source).not.toHaveBeenCalled();
    } finally { for (const client of clients) await client.close(); for (const server of servers) await server.close(); db.close(); }
  });
});
