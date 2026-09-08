import { exportSPKI, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { assertPolicyManagementRight, createPolicyManagementJwtAuthenticator,
  type PolicyManagerGrant } from "./policy-management-identity.js";
import { createJwtVerifier } from "./jwt-auth.js";

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

describe.each(["RS256", "ES256"] as const)("schema-shaped %s owner management authentication", (algorithm) => {
  const ownerManagement = { parent_name: "owner_settings", policy_name: "personal_rules", scope: "personal" as const,
    credential_env: "TEST_ASSISTANT_TOKEN", authentication: { provider: "jwt_asymmetric" as const,
      issuer: config.issuer, audience: config.audience, public_key_env: "TEST_OWNER_PUBLIC_KEY" },
    human_review: { credential_env: "TEST_HUMAN_TOKEN", audience: "runner-policy-review" } };
  let keys: Awaited<ReturnType<typeof generateKeyPair>>, publicKey: string;
  beforeAll(async () => {
    keys = await generateKeyPair(algorithm);
    publicKey = await exportSPKI(keys.publicKey);
  });
  function claims(channel: "assistant" | "human_review", overrides: Record<string, unknown> = {}) {
    return { sub: "maya-login", tenant_id: "acme", principal: "maya", sid: "session-a", actor_kind: "human",
      policy_channel: channel, iss: ownerManagement.authentication.issuer,
      aud: channel === "assistant" ? ownerManagement.authentication.audience : ownerManagement.human_review.audience,
      exp: Math.floor(Date.now() / 1000) + 300, ...overrides };
  }
  async function signed(channel: "assistant" | "human_review", overrides: Record<string, unknown> = {}) {
    return new SignJWT(claims(channel, overrides)).setProtectedHeader({ alg: algorithm }).sign(keys.privateKey);
  }
  it("accepts the current owner schema without an algorithms field for assistant and separate human review", async () => {
    expect(validateRunnerCapabilityConfig({ version: 1, mode: "review", capabilities: [], trusted_context: { provider: "environment" },
      sources: { reviewed: { engine: "postgres", read_only: true, read_url_env: "TEST_READER_URL" } },
      action_rules: { project_root: ".", owner_management: ownerManagement } })).toMatchObject({ ok: true, errors: [] });
    expect(ownerManagement.authentication).not.toHaveProperty("algorithms");
    const environment = { TEST_OWNER_PUBLIC_KEY: publicKey };
    const assistant = createPolicyManagementJwtAuthenticator(ownerManagement.authentication, "assistant", environment);
    const human = createPolicyManagementJwtAuthenticator({ ...ownerManagement.authentication,
      audience: ownerManagement.human_review.audience }, "human_review", environment);
    const assistantIdentity = await assistant(await signed("assistant")), humanIdentity = await human(await signed("human_review"));
    expect(assistantIdentity).toMatchObject({ subject: grant.subject, tenant_id: scope.tenant_id, principal: scope.principal, channel: "assistant" });
    expect(humanIdentity).toMatchObject({ subject: grant.subject, channel: "human_review", actor_kind: "human" });
    expect(() => assertPolicyManagementRight(assistantIdentity, [grant], scope, "activate")).toThrow("POLICY_HUMAN_REVIEW_REQUIRED");
    expect(() => assertPolicyManagementRight(humanIdentity, [grant], scope, "activate")).not.toThrow();
  });

  it.each(["assistant", "human_review"] as const)("rejects wrong claims, channel, signature, key and algorithm confusion for %s", async (channel) => {
    const authentication = { ...ownerManagement.authentication, audience: claims(channel).aud };
    const verify = createPolicyManagementJwtAuthenticator(authentication, channel, { TEST_OWNER_PUBLIC_KEY: publicKey });
    const otherChannel = channel === "assistant" ? "human_review" : "assistant";
    for (const overrides of [{ aud: "ordinary-reader" }, { iss: "https://untrusted.example" }, { policy_channel: otherChannel }, { exp: 1 }]) {
      await expect(verify(await signed(channel, overrides))).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    }
    await expect(verify(await signed(otherChannel))).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    if (channel === "human_review") {
      await expect(verify(await signed(channel, { actor_kind: "agent", agent_id: "agent-a" }))).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    }
    const credential = await signed(channel), parts = credential.split(".");
    const signature = Buffer.from(parts[2]!, "base64url"); signature[0] = signature[0]! ^ 1;
    await expect(verify(`${parts[0]}.${parts[1]}.${signature.toString("base64url")}`)).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    for (const keyAlgorithm of [algorithm, algorithm === "RS256" ? "ES256" : "RS256"] as const) {
      const wrongKey = await generateKeyPair(keyAlgorithm);
      const wrongVerifier = createPolicyManagementJwtAuthenticator(authentication, channel,
        { TEST_OWNER_PUBLIC_KEY: await exportSPKI(wrongKey.publicKey) });
      await expect(wrongVerifier(credential)).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    }
    const confused = await new SignJWT(claims(channel)).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(publicKey));
    await expect(verify(confused)).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    await expect(verify(new UnsecuredJWT(claims(channel)).encode())).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    const symmetric = createPolicyManagementJwtAuthenticator({ ...config, audience: authentication.audience }, channel, { TEST_POLICY_KEY: secret });
    await expect(symmetric(credential)).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
  });

  it("preserves explicit API allowlists instead of replacing or broadening them", async () => {
    const environment = { TEST_OWNER_PUBLIC_KEY: publicKey }, authentication = ownerManagement.authentication;
    const credential = await signed("assistant");
    const allowed = createPolicyManagementJwtAuthenticator({ ...authentication, algorithms: [algorithm] }, "assistant", environment);
    await expect(allowed(credential)).resolves.toMatchObject({ subject: grant.subject });
    const excluded = createPolicyManagementJwtAuthenticator({ ...authentication, algorithms: [algorithm === "RS256" ? "ES256" : "RS256"] }, "assistant", environment);
    await expect(excluded(credential)).rejects.toThrow(/^POLICY_AUTHENTICATION_FAILED$/u);
    expect(() => createPolicyManagementJwtAuthenticator({ ...authentication, algorithms: [] }, "assistant", environment)).toThrow("JWT algorithms must be explicitly configured");
    expect(() => createPolicyManagementJwtAuthenticator({ ...authentication, algorithms: ["HS256"] }, "assistant", environment)).toThrow("JWT algorithm is not valid for the configured provider");
    expect(() => createPolicyManagementJwtAuthenticator({ ...config, algorithms: [algorithm] }, "assistant", { TEST_POLICY_KEY: secret })).toThrow("JWT algorithm is not valid for the configured provider");
    const symmetric = createPolicyManagementJwtAuthenticator({ ...config, algorithms: ["HS256"] }, "assistant", { TEST_POLICY_KEY: secret });
    await expect(symmetric(await token())).resolves.toMatchObject({ subject: grant.subject });
  });

  it("does not default algorithms in the generic verifier or HTTP configuration", () => {
    expect(() => createJwtVerifier(ownerManagement.authentication, { TEST_OWNER_PUBLIC_KEY: publicKey })).toThrow("JWT algorithms must be explicitly configured");
    expect(validateRunnerCapabilityConfig({ version: 1, mode: "review", capabilities: [], trusted_context: { provider: "environment" },
      sources: { reviewed: { engine: "postgres", read_only: true, read_url_env: "TEST_READER_URL" } },
      session_auth: ownerManagement.authentication })).toMatchObject({ ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ code: "INVALID_SESSION_AUTH_ALGORITHMS", path: "$.session_auth.algorithms" })]) });
  });
});
