import { exportSPKI, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { createOwnerRuntimeJwtAuthenticator } from "./owner-runtime-identity.js";

const key = "disposable_workload_test_signing_key_32bytes";
const config = { provider: "jwt_hs256" as const, secret_env: "TEST_WORKLOAD_KEY", issuer: "https://identity.example", audience: "agent-runtime" };
const authenticate = createOwnerRuntimeJwtAuthenticator(config, { TEST_WORKLOAD_KEY: key });
async function token(overrides: Record<string, unknown> = {}, secret = key) {
  return new SignJWT({ iss: config.issuer, aud: config.audience, sub: "verified-agent-service", tenant_id: "acme", principal: "maya",
    actor_kind: "agent", agent_id: "agent-a", delegator: "owner-maya", run_id: "run-1", delegation_channel: "runtime",
    exp: Math.floor(Date.now() / 1000) + 300, ...overrides }).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
}
describe("distinct authenticated delegation workload identity", () => {
  it("binds the acting agent, delegator, tenant, principal and fresh run separately", async () => {
    const first = await authenticate(await token());
    expect(first).toMatchObject({ tenant_id: "acme", principal: "maya", agent_id: "agent-a", delegator: "owner-maya", run_id: "run-1" });
    const next = await authenticate(await token({ run_id: "run-2" }));
    expect(next.actor_digest).not.toBe(first.actor_digest);
    expect(first).not.toHaveProperty("permissions"); expect(first).not.toHaveProperty("credential");
  });
  it.each([
    { actor_kind: "human" }, { delegation_channel: "human_review" }, { agent_id: undefined }, { delegator: undefined }, { run_id: undefined },
    { tenant_id: " " }, { principal: "bad\nprincipal" }, { aud: "policy-assistant" }, { iss: "https://untrusted.example" }, { exp: 1 },
  ])("refuses invalid or ordinary human credentials %j", async (overrides) => {
    await expect(authenticate(await token(overrides))).rejects.toThrow("DELEGATION_AUTHENTICATION_FAILED");
  });
  it("refuses tampered signatures without leaking verification diagnostics", async () => {
    await expect(authenticate(await token({}, "untrusted_signature_key_long_enough"))).rejects.toThrow("DELEGATION_AUTHENTICATION_FAILED");
  });
});

describe.each(["RS256", "ES256"] as const)("schema-shaped %s owner workload authentication", (algorithm) => {
  const ownerDelegation = { parent_name: "workload_policy", credential_env: "TEST_WORKLOAD_TOKEN",
    authentication: { provider: "jwt_asymmetric" as const, issuer: config.issuer, audience: config.audience, public_key_env: "TEST_WORKLOAD_PUBLIC_KEY" } };
  let keys: Awaited<ReturnType<typeof generateKeyPair>>, publicKey: string;
  beforeAll(async () => {
    keys = await generateKeyPair(algorithm);
    publicKey = await exportSPKI(keys.publicKey);
  });
  function claims(overrides: Record<string, unknown> = {}) {
    return { iss: config.issuer, aud: config.audience, sub: "verified-agent-service", tenant_id: "acme", principal: "maya",
      actor_kind: "agent", agent_id: "agent-a", delegator: "owner-maya", run_id: "run-1", delegation_channel: "runtime",
      exp: Math.floor(Date.now() / 1000) + 300, ...overrides };
  }
  async function signed(overrides: Record<string, unknown> = {}) {
    return new SignJWT(claims(overrides)).setProtectedHeader({ alg: algorithm }).sign(keys.privateKey);
  }
  it("accepts the current owner schema without an algorithms field for workload identity", async () => {
    expect(validateRunnerCapabilityConfig({ version: 1, mode: "review", capabilities: [], trusted_context: { provider: "environment" },
      sources: { reviewed: { engine: "postgres", read_only: true, read_url_env: "TEST_READER_URL" } },
      action_rules: { project_root: ".", owner_delegation: ownerDelegation } })).toMatchObject({ ok: true, errors: [] });
    expect(ownerDelegation.authentication).not.toHaveProperty("algorithms");
    const authenticate = createOwnerRuntimeJwtAuthenticator(ownerDelegation.authentication, { TEST_WORKLOAD_PUBLIC_KEY: publicKey });
    const identity = await authenticate(await signed());
    expect(identity).toMatchObject({ tenant_id: "acme", principal: "maya", agent_id: "agent-a", delegator: "owner-maya", run_id: "run-1" });
    expect(identity).not.toHaveProperty("permissions");
    expect(identity).not.toHaveProperty("credential");
  });

  it("rejects wrong claims, channels, signatures, keys and algorithm confusion", async () => {
    const verify = createOwnerRuntimeJwtAuthenticator(ownerDelegation.authentication, { TEST_WORKLOAD_PUBLIC_KEY: publicKey });
    for (const overrides of [{ aud: "policy-assistant" }, { aud: "policy-human-review" }, { iss: "https://untrusted.example" },
      { delegation_channel: "assistant" }, { delegation_channel: "human_review" }, { actor_kind: "human" }, { exp: 1 }]) {
      await expect(verify(await signed(overrides))).rejects.toThrow(/^DELEGATION_AUTHENTICATION_FAILED$/u);
    }
    const credential = await signed(), parts = credential.split(".");
    const signature = Buffer.from(parts[2]!, "base64url"); signature[0] = signature[0]! ^ 1;
    await expect(verify(`${parts[0]}.${parts[1]}.${signature.toString("base64url")}`)).rejects.toThrow(/^DELEGATION_AUTHENTICATION_FAILED$/u);
    for (const keyAlgorithm of [algorithm, algorithm === "RS256" ? "ES256" : "RS256"] as const) {
      const wrongKey = await generateKeyPair(keyAlgorithm);
      const wrongVerifier = createOwnerRuntimeJwtAuthenticator(ownerDelegation.authentication,
        { TEST_WORKLOAD_PUBLIC_KEY: await exportSPKI(wrongKey.publicKey) });
      await expect(wrongVerifier(credential)).rejects.toThrow(/^DELEGATION_AUTHENTICATION_FAILED$/u);
    }
    const confused = await new SignJWT(claims()).setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(publicKey));
    await expect(verify(confused)).rejects.toThrow(/^DELEGATION_AUTHENTICATION_FAILED$/u);
    await expect(verify(new UnsecuredJWT(claims()).encode())).rejects.toThrow(/^DELEGATION_AUTHENTICATION_FAILED$/u);
    await expect(authenticate(credential)).rejects.toThrow(/^DELEGATION_AUTHENTICATION_FAILED$/u);
  });

  it("preserves explicit API allowlists instead of replacing or broadening them", async () => {
    const environment = { TEST_WORKLOAD_PUBLIC_KEY: publicKey }, authentication = ownerDelegation.authentication;
    const credential = await signed();
    const allowed = createOwnerRuntimeJwtAuthenticator({ ...authentication, algorithms: [algorithm] }, environment);
    await expect(allowed(credential)).resolves.toMatchObject({ agent_id: "agent-a" });
    const excluded = createOwnerRuntimeJwtAuthenticator({ ...authentication, algorithms: [algorithm === "RS256" ? "ES256" : "RS256"] }, environment);
    await expect(excluded(credential)).rejects.toThrow(/^DELEGATION_AUTHENTICATION_FAILED$/u);
    expect(() => createOwnerRuntimeJwtAuthenticator({ ...authentication, algorithms: [] }, environment)).toThrow("JWT algorithms must be explicitly configured");
    expect(() => createOwnerRuntimeJwtAuthenticator({ ...authentication, algorithms: ["HS256"] }, environment)).toThrow("JWT algorithm is not valid for the configured provider");
    expect(() => createOwnerRuntimeJwtAuthenticator({ ...config, algorithms: [algorithm] }, { TEST_WORKLOAD_KEY: key })).toThrow("JWT algorithm is not valid for the configured provider");
    const symmetric = createOwnerRuntimeJwtAuthenticator({ ...config, algorithms: ["HS256"] }, { TEST_WORKLOAD_KEY: key });
    await expect(symmetric(await token())).resolves.toMatchObject({ agent_id: "agent-a" });
  });
});
