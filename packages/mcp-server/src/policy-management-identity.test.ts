import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { assertPolicyManagementRight, createPolicyManagementJwtAuthenticator,
  type PolicyManagerGrant } from "./policy-management-identity.js";

const secret = "disposable_policy_identity_key_32_bytes_minimum";
const config = { provider: "jwt_hs256" as const, secret_env: "TEST_POLICY_KEY", issuer: "https://identity.example", audience: "runner-policy-assistant" };
const assistant = createPolicyManagementJwtAuthenticator(config, "assistant", { TEST_POLICY_KEY: secret });
const reviewer = createPolicyManagementJwtAuthenticator({ ...config, audience: "runner-policy-review" }, "human_review", { TEST_POLICY_KEY: secret });
const scope = { level: "principal" as const, tenant_id: "acme", principal: "maya" };
const grant: PolicyManagerGrant = { subject: "maya-login", actor_kind: "human", tenant_id: "acme",
  scope: { mode: "personal" }, permissions: ["inspect", "draft", "activate", "revoke", "audit"] };

async function token(overrides: Record<string, unknown> = {}, key = secret) {
  return new SignJWT({ sub: "maya-login", tenant_id: "acme", principal: "maya", sid: "session-a", actor_kind: "human",
    policy_channel: "assistant", iss: config.issuer, aud: config.audience, exp: Math.floor(Date.now() / 1000) + 300, ...overrides })
    .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(key));
}

describe("authenticated policy management rights", () => {
  it("requires explicit management rights even for a verified reader with owner/admin-looking roles", async () => {
    const identity = await assistant(await token({ roles: ["owner", "admin"] }));
    expect(() => assertPolicyManagementRight(identity, [], scope, "inspect")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    expect(() => assertPolicyManagementRight(identity, [grant], scope, "draft")).not.toThrow();
    expect(() => assertPolicyManagementRight(identity, [grant], scope, "activate")).toThrow("POLICY_HUMAN_REVIEW_REQUIRED");
  });

  it("keeps identical principal names in different tenants isolated", async () => {
    const identity = await assistant(await token());
    expect(() => assertPolicyManagementRight(identity, [grant], { ...scope, tenant_id: "beta" }, "inspect")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    expect(() => assertPolicyManagementRight(identity, [grant], { ...scope, principal: "alex" }, "draft")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    expect(() => assertPolicyManagementRight(identity, [grant], { level: "tenant", tenant_id: "acme" }, "draft")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    expect(() => assertPolicyManagementRight(identity, [grant], { level: "operator" }, "inspect")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
  });

  it("does not let a tenant admin inspect personal policies or other tenants without a separate grant", async () => {
    const identity = await assistant(await token());
    const admin = { ...grant, scope: { mode: "exact", scope: { level: "tenant", tenant_id: "acme" } } };
    expect(() => assertPolicyManagementRight(identity, [admin], { level: "tenant", tenant_id: "acme" }, "draft")).not.toThrow();
    expect(() => assertPolicyManagementRight(identity, [admin], scope, "inspect")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
    expect(() => assertPolicyManagementRight(identity, [admin], { level: "tenant", tenant_id: "beta" }, "inspect")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
  });

  it("requires an explicit deployment-wide grant for operator inspection", async () => {
    const identity = await assistant(await token());
    const operator = { ...grant, scope: { mode: "deployment" }, permissions: ["inspect"] };
    expect(() => assertPolicyManagementRight(identity, [operator], { ...scope, tenant_id: "beta" }, "inspect")).not.toThrow();
    expect(() => assertPolicyManagementRight(identity, [operator], scope, "draft")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
  });

  it("uses a distinct human confirmation credential rather than generic MCP permission", async () => {
    const identity = await reviewer(await token({ aud: "runner-policy-review", policy_channel: "human_review" }));
    expect(() => assertPolicyManagementRight(identity, [grant], scope, "activate")).not.toThrow();
    await expect(reviewer(await token())).rejects.toThrow("POLICY_AUTHENTICATION_FAILED");
    await expect(assistant(await token({ aud: "runner-policy-review", policy_channel: "human_review" }))).rejects.toThrow("POLICY_AUTHENTICATION_FAILED");
    await expect(reviewer(await token({ aud: "runner-policy-review", policy_channel: "human_review", actor_kind: "agent", agent_id: "agent-a" }))).rejects.toThrow("POLICY_AUTHENTICATION_FAILED");
  });

  it("allows explicitly delegated agent drafting but never agent activation or self-selected management grants", async () => {
    const identity = await assistant(await token({ actor_kind: "agent", agent_id: "agent-a" }));
    const agentGrant = { ...grant, actor_kind: "agent", permissions: ["inspect", "draft"] };
    expect(() => assertPolicyManagementRight(identity, [agentGrant], scope, "draft")).not.toThrow();
    expect(() => assertPolicyManagementRight(identity, [agentGrant], scope, "activate")).toThrow("POLICY_HUMAN_REVIEW_REQUIRED");
    expect(() => assertPolicyManagementRight(identity, [{ ...agentGrant, permissions: ["activate"] }], scope, "activate")).toThrow("POLICY_MANAGEMENT_CONFIGURATION_INVALID");
    expect(() => assertPolicyManagementRight(identity, [grant], scope, "draft")).toThrow("POLICY_MANAGEMENT_FORBIDDEN");
  });

  it.each([
    { iss: "https://other.example" }, { aud: "ordinary-data-reader" }, { exp: 1 }, { sub: "" }, { sid: "" },
    { tenant_id: "" }, { principal: "" }, { actor_kind: "agent" }, { actor_kind: "robot" },
    { agent_id: "agent-a" }, { policy_channel: "human_review" },
  ])("refuses malformed or inappropriate authenticated context %j without leaking token details", async (claims) => {
    await expect(assistant(await token(claims))).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
  });

  it("binds review identity to the verified session and rejects a forged signature", async () => {
    const identity = await assistant(await token());
    const refreshed = await assistant(await token({ exp: Math.floor(Date.now() / 1000) + 600 }));
    expect(refreshed.session_digest).toBe(identity.session_digest);
    expect((await assistant(await token({ sid: "session-b" }))).session_digest).not.toBe(identity.session_digest);
    await expect(assistant(await token({}, "another_disposable_secret_32_bytes_long"))).rejects.toThrow("POLICY_AUTHENTICATION_FAILED");
    expect(JSON.stringify(identity)).not.toContain(secret);
  });

  it("requires a dedicated issuer and audience in trusted configuration", () => {
    expect(() => createPolicyManagementJwtAuthenticator({ ...config, audience: "" }, "assistant", { TEST_POLICY_KEY: secret })).toThrow("POLICY_AUTH_CONFIGURATION_INVALID");
    expect(() => createPolicyManagementJwtAuthenticator({ ...config, issuer: "" }, "assistant", { TEST_POLICY_KEY: secret })).toThrow("POLICY_AUTH_CONFIGURATION_INVALID");
  });
});
