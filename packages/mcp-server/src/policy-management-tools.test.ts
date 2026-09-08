import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sqliteControlPolicyRepository, postgresControlPolicyRepository, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { createPolicyManagementJwtAuthenticator } from "./policy-management-identity.js";
import { createPolicyManagementService } from "./policy-management.js";
import { createPolicyManagementTools, type PolicyManagementToolContext } from "./policy-management-tools.js";
import { ownerPolicyTestFixture } from "./owner-policy-test-fixture.js";

const secret = "disposable_policy_tool_test_signing_key_32_bytes";
const config = { provider: "jwt_hs256" as const, issuer: "https://identity.example", audience: "policy-assistant", secret_env: "KEY" };
const scope = { level: "principal" as const, tenant_id: "acme", principal: "maya" };
const beta = { ...scope, tenant_id: "beta" };
const view = { policy_view: "agent_rules" };
async function token(tenant = "acme", overrides: Record<string, unknown> = {}) {
  return new SignJWT({ sub: "maya-login", tenant_id: tenant, principal: "maya", actor_kind: "human", sid: "session-a",
    iss: config.issuer, aud: config.audience, policy_channel: "assistant", exp: Math.floor(Date.now() / 1000) + 300, ...overrides })
    .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
}
const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
for (const backend of ["sqlite", "postgres"] as const) describe.skipIf(backend === "postgres" && !url)(`four-tool owner settings: ${backend}`, () => {
  let pool: Pool;
  const connections: DatabaseSync[] = [];
  const schema = `owner_tools_${process.pid}_${randomBytes(4).toString("hex")}`;
  beforeAll(() => { if (backend === "postgres") pool = new Pool({ connectionString: url, max: 4 }); });
  afterEach(() => { for (const db of connections.splice(0)) db.close(); });
  afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } } });
  async function fixture() {
    const f = ownerPolicyTestFixture();
    const db = backend === "sqlite" ? new DatabaseSync(":memory:") : undefined;
    if (db) { connections.push(db); db.exec("PRAGMA foreign_keys = ON"); }
    const repository = db ? sqliteControlPolicyRepository(db) : postgresControlPolicyRepository(pool, schema);
    await repository.initialize();
    const deployment = randomUUID();
    const key = { scope: { level: "operator" as const }, kind: "parent" as const, name: "settings" };
    const content = { schema_version: "synapsor.policy-management-parent.v1", delegation: f.parent,
      agent_owners: [{ agent: "agent-a", scope }, { agent: "agent-b", scope: beta }],
      managers: ["acme", "beta"].map((tenant_id) => ({ subject: "maya-login", actor_kind: "human", tenant_id,
        scope: { mode: "personal" }, permissions: ["inspect", "draft", "activate", "revoke", "audit"] })) };
    const revision = (body = content): ControlPolicyRevision => ({ ...key, revision_id: randomUUID(), content: body,
      content_digest: canonicalJsonDigest(body), authority_digest: canonicalJsonDigest(body) });
    const first = revision();
    const event = () => ({ event_id: randomUUID(), actor: "operator", occurred_at: new Date().toISOString(), receipt: {} });
    await repository.importDeployment({ deployment_id: deployment, project_id: deployment, migration_digest: canonicalJsonDigest({ deployment }),
      revisions: [first], active: [{ ...key, revision_id: first.revision_id }], event: event() });
    const service = createPolicyManagementService({ repository, deployment_id: deployment, parent_name: key.name,
      assistant_authenticate: createPolicyManagementJwtAuthenticator(config, "assistant", { KEY: secret }),
      human_authenticate: createPolicyManagementJwtAuthenticator({ ...config, audience: "policy-review" }, "human_review", { KEY: secret }),
      resolveRules: async () => [f.compiled] });
    let current: PolicyManagementToolContext = { credential: await token(), scope, policy_name: "my_agent_rules",
      scope_label: "Acme / Maya / Agent rules", session_id: "settings-session", expires_at_ms: Date.now() + 300_000 };
    let now = Date.now();
    const publishReview = vi.fn(async () => `pvr_${randomBytes(32).toString("base64url")}`);
    const tools = createPolicyManagementTools({ service, resolveContext: async () => current, publishReview, clock: () => now });
    const summary = () => tools.callTool("app.explore_data", { ...view, section: "summary" });
    const request = (ref: unknown, definition: unknown = f.definition) => tools.callTool("app.request_change", {
      ...view, outcome: "agent_rules.propose_revision", control_ref: ref, definition });
    async function replaceParent(body = content) {
      const next = revision(body), state = (await repository.deployment(deployment))!;
      await repository.commit({ deployment_id: deployment, expected_epoch: state.epoch, revisions: [next],
        active: [{ ...key, revision_id: next.revision_id }], event: event() });
    }
    return { ...f, tools, service, repository, deployment, summary, request, publishReview, replaceParent, content,
      setContext: (value: Partial<PolicyManagementToolContext>) => { current = { ...current, ...value }; }, advance: (ms: number) => { now += ms; } };
  }

  it("discovers virtual settings, submits one disabled revision and hands off human review without adding a tool", async () => {
    const f = await fixture();
    expect(await f.tools.callTool("app.describe_data", view)).toMatchObject({ source: "runner_control_plane", resources: [{ resource: "runner.agent_rules" }] });
    expect(await f.tools.callTool("app.describe_actions", view)).toMatchObject({ actions: [{ outcome: "agent_rules.propose_revision", activation_exposed: false }] });
    const initial = await f.summary();
    expect(initial).toMatchObject({ active: null, draft: null, agents_available: ["agent-a"] });
    expect(initial.control_ref).toMatch(/^pol_/u);
    const results = await Promise.all([f.request(initial.control_ref), f.request(initial.control_ref)]);
    for (const result of results) expect(result).toMatchObject({ status: "draft_saved", authority_changed: false, source_database_changed: false,
      review: { state: "human_review_pending" } });
    // PostgreSQL requests can finish their initial permission reads in either order.
    expect(results.filter((result) => result.replay === true)).toHaveLength(1);
    expect(results.filter((result) => result.replay === undefined)).toHaveLength(1);
    expect(results[0]!.review).toEqual(results[1]!.review);
    expect(f.publishReview).toHaveBeenCalledTimes(1);
    expect((await f.repository.deployment(f.deployment))?.epoch).toBe(2);
    const saved = await f.service.detail(await token(), scope, "my_agent_rules");
    expect(saved.active).toBeUndefined(); expect(saved.draft?.definition).toEqual(f.definition);
    const transcript = JSON.stringify(results);
    expect(transcript).not.toMatch(/nonce|session_digest|compiled_digest|parent_authority_digest|tenant_id|"principal"/u);
    expect(f.tools.handles({ plan: { resource: "app.requests" } })).toBe(false);
    await expect(f.tools.callTool("app.activate_policy", view)).rejects.toMatchObject({ code: "TOOL_NOT_FOUND" });
  });

  it("returns a replay to an earlier request whose permission read finishes last", async () => {
    const f = await fixture(), initial = await f.summary();
    const detail = f.service.detail.bind(f.service);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const read = vi.spyOn(f.service, "detail").mockImplementationOnce(async (...args) => {
      const snapshot = await detail(...args);
      entered(); await held; return snapshot;
    });
    const first = f.request(initial.control_ref);
    try {
      await reading;
      const second = await f.request(initial.control_ref);
      expect(second).toMatchObject({ status: "draft_saved", authority_changed: false, source_database_changed: false });
      expect(second).not.toHaveProperty("replay");
      release();
      const delayed = await first;
      expect(delayed).toMatchObject({ status: "draft_saved", replay: true, authority_changed: false, source_database_changed: false });
      expect(delayed.review).toEqual(second.review);
      expect(f.publishReview).toHaveBeenCalledOnce();
      expect((await f.repository.deployment(f.deployment))?.epoch).toBe(2);
      const saved = await detail(await token(), scope, "my_agent_rules");
      expect(saved.active).toBeUndefined();
      expect(saved.draft?.definition).toEqual(f.definition);
    } finally { release(); await first.catch(() => undefined); read.mockRestore(); }
  });

  it("isolates two owners named maya and rejects cross-session, source-object and forged scope arguments", async () => {
    const f = await fixture(), initial = await f.summary();
    f.setContext({ credential: await token("beta"), scope: beta, scope_label: "Beta / Maya / Agent rules" });
    await expect(f.request(initial.control_ref)).rejects.toMatchObject({ code: "POLICY_REFERENCE_UNAVAILABLE" });
    expect(await f.summary()).toMatchObject({ active: null, draft: null, agents_available: ["agent-b"] });
    await expect(f.tools.callTool("app.explore_data", { ...view, section: "summary", tenant_id: "acme" })).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
    await expect(f.request(`obj_${"a".repeat(43)}`)).rejects.toMatchObject({ code: "ARGUMENT_INVALID" });
    f.setContext({ credential: await token(), scope, session_id: "different-session" });
    await expect(f.request(initial.control_ref)).rejects.toMatchObject({ code: "POLICY_REFERENCE_UNAVAILABLE" });
    expect((await f.repository.deployment(f.deployment))?.epoch).toBe(1);
  });

  it("rechecks current permissions before disclosure and replay; refreshed revisions require fresh references", async () => {
    const f = await fixture(), initial = await f.summary();
    await f.replaceParent();
    await expect(f.request(initial.control_ref)).rejects.toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
    const fresh = await f.summary(); await f.request(fresh.control_ref);
    await f.replaceParent();
    const replay = await f.request(fresh.control_ref);
    expect(replay).toMatchObject({ replay: true, review: { state: "review_context_changed" } });
    expect(JSON.stringify(replay.review)).not.toContain("continuation");
    await f.replaceParent({ ...f.content, managers: [] });
    await expect(f.request(fresh.control_ref)).rejects.toMatchObject({ code: "POLICY_MANAGEMENT_FORBIDDEN" });
    await expect(f.summary()).rejects.toMatchObject({ code: "POLICY_MANAGEMENT_FORBIDDEN" });
  });

  it("pages complete public vocabulary entries and invalidates the cursor after a parent edit", async () => {
    const f = await fixture();
    const first = await f.tools.callTool("app.explore_data", { ...view, section: "vocabulary", limit: 1 });
    expect(first.resources).toHaveLength(1); expect(first.next_cursor).toMatch(/^cur_/u);
    expect(JSON.stringify(first.resources)).not.toContain('"source"');
    const next = await f.tools.callTool("app.explore_data", { ...view, section: "vocabulary", limit: 1, cursor: first.next_cursor });
    expect(next.resources).toHaveLength(1);
    const again = await f.tools.callTool("app.explore_data", { ...view, section: "vocabulary", limit: 1 });
    await f.replaceParent();
    await expect(f.tools.callTool("app.explore_data", { ...view, section: "vocabulary", limit: 1, cursor: again.next_cursor }))
      .rejects.toMatchObject({ code: "CATALOG_CURSOR_INVALID" });
  });

  it("derives public fact types and enum values from the compiled rule without disclosing private source mappings", async () => {
    const f = await fixture();
    const described = await f.tools.callTool("app.describe_actions", view);
    expect(described).toMatchObject({ actions: [{ rule_contract: { approval: {
      allowed_values: ["inherit", "human"],
      human: expect.stringContaining("human review"),
      inherit: expect.stringContaining("does not approve"),
      auto_approve_when: expect.stringContaining("non-match or unknown requires human review"),
      vocabulary_values: expect.stringContaining("literal_values when present"),
    } }, conditional_narrowing_example: {
      outcome: f.compiled.outcome, approval: "inherit",
      auto_approve_when: { kind: "one_of", fact: "request_category", values: ["routine"] },
    } }] });
    const page = await f.tools.callTool("app.explore_data", { ...view, section: "vocabulary", limit: 20 });
    const category = (page.resources as Array<Record<string, unknown>>).find((entry) => entry.record_kind === "fact" && entry.name === "request_category");
    expect(category).toMatchObject({ value_type: "string", allowed_values: ["routine", "exception"] });
    const serialized = JSON.stringify(page.resources);
    expect(serialized).not.toContain('"source"');
    expect(serialized).not.toContain('"binding"');
    expect(serialized).not.toContain('"field"');
    expect(serialized).not.toContain('"f09"');

    const narrowed = structuredClone(f.content);
    narrowed.delegation.outcomes[0]!.facts.find((fact) => fact.name === "request_category")!.literal_values = ["routine"];
    await f.replaceParent(narrowed);
    const narrowedPage = await f.tools.callTool("app.explore_data", { ...view, section: "vocabulary", limit: 20 });
    const narrowedCategory = (narrowedPage.resources as Array<Record<string, unknown>>).find((entry) => entry.record_kind === "fact" && entry.name === "request_category");
    expect(narrowedCategory).toMatchObject({ literal_values: ["routine"], allowed_values: ["routine"] });
  });

  it("uses a numeric allowlisted value for the conditional example and omits an unusable one", async () => {
    const f = await fixture();
    const narrowed = structuredClone(f.content);
    const facts = narrowed.delegation.outcomes[0]!.facts;
    facts.find((fact) => fact.name === "request_category")!.operators = ["eq"];
    facts.find((fact) => fact.name === "requested_units")!.literal_values = [8, 1];
    await f.replaceParent(narrowed);
    await expect(f.tools.callTool("app.describe_actions", view)).resolves.toMatchObject({ actions: [{ conditional_narrowing_example: {
      auto_approve_when: { kind: "compare", fact: "requested_units", operator: "lte", value: 8 },
    } }] });

    const unusable = structuredClone(narrowed);
    unusable.delegation.outcomes[0]!.facts.find((fact) => fact.name === "requested_units")!.literal_values = [51];
    await f.replaceParent(unusable);
    const described = await f.tools.callTool("app.describe_actions", view) as { actions: Array<Record<string, unknown>> };
    expect(described.actions[0]).not.toHaveProperty("conditional_narrowing_example");
  });

  it("fails closed when the saved parent fact cannot be resolved to a supported compiled scalar", async () => {
    const f = await fixture();
    const unknownSource = structuredClone(f.content);
    unknownSource.delegation.outcomes[0]!.facts[0]!.source = { kind: "field", binding: "request", field: "missing" };
    await f.replaceParent(unknownSource);
    await expect(f.tools.callTool("app.explore_data", { ...view, section: "vocabulary", limit: 20 }))
      .rejects.toMatchObject({ code: "POLICY_DELEGATION_PARENT_CHANGED" });

    const unknownType = await fixture();
    const category = unknownType.compiled.bindings.find((binding) => binding.binding === "request")!.verification;
    if (category.cardinality !== "one") throw new Error("Expected one-row request binding.");
    const field = category.fields.find((value) => value.name === "category")!;
    field.type = { kind: "unknown" } as never;
    await expect(unknownType.summary()).resolves.toMatchObject({ can_edit: true });
    await expect(unknownType.tools.callTool("app.describe_actions", view)).rejects.toMatchObject({ code: "POLICY_DELEGATION_PARENT_CHANGED" });
  });

  it("preserves a saved draft when human UI fails and preserves the parent on invalid or expired edits", async () => {
    const f = await fixture(), initial = await f.summary();
    await expect(f.request(initial.control_ref, { ...f.definition, agents: ["unreviewed-agent"] })).rejects.toMatchObject({ code: "OWNER_POLICY_AGENT_NOT_DELEGABLE" });
    expect((await f.repository.deployment(f.deployment))?.epoch).toBe(1);
    f.publishReview.mockRejectedValueOnce(new Error("private_backend_information"));
    expect(await f.request(initial.control_ref)).toMatchObject({ status: "draft_saved", review: { state: "human_review_connection_unavailable" } });
    await expect(f.request(initial.control_ref, { ...f.definition, rules: f.definition.rules.map((r) => ({ ...r, approval: "human" })) }))
      .rejects.toMatchObject({ code: "POLICY_REFERENCE_USED" });
    f.advance(300_001);
    await expect(f.summary()).rejects.toMatchObject({ code: "POLICY_AUTHENTICATION_FAILED" });
    expect((await f.repository.deployment(f.deployment))?.epoch).toBe(2);
  });

  it("shows inspect-only settings without advertising a mutation and never exposes private backend diagnostics", async () => {
    const f = await fixture();
    await f.replaceParent({ ...f.content, managers: f.content.managers.map((grant) => ({ ...grant, permissions: ["inspect"] })) });
    expect(await f.tools.callTool("app.describe_actions", view)).toMatchObject({ actions: [], management_access: "inspect_only" });
    expect(await f.summary()).toMatchObject({ can_edit: false });
    const initial = await f.summary();
    await expect(f.request(initial.control_ref)).rejects.toMatchObject({ code: "POLICY_MANAGEMENT_FORBIDDEN" });
    vi.spyOn(f.service, "detail").mockRejectedValueOnce(new Error("postgres://private-backend-secret"));
    const error = await f.summary().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "POLICY_MANAGEMENT_UNAVAILABLE" });
    expect(String(error)).not.toContain("private-backend-secret");
  });
});
