import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
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
