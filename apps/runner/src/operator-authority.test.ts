import { describe, expect, it } from "vitest";
import type { RuntimeConfig, RuntimeCapabilityConfig } from "@synapsor-runner/mcp-server";
import { trustedCliContext } from "./operator-authority.js";

const capability: RuntimeCapabilityConfig = { name: "stockroom.quantity_adjustment", kind: "proposal",
  context: "trusted_context", source: "stockroom", target: { schema: "stockroom", table: "items", primary_key: "id" },
  args: {}, lookup: { id_from_arg: "id" }, visible_columns: [] };
const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [], trusted_context: {
  provider: "environment", values: { tenant_id_env: "COMPANY", principal_env: "EMPLOYEE" } } };
const env = { COMPANY: " acme ", EMPLOYEE: " maya ", SYNAPSOR_TENANT_ID: "other", SYNAPSOR_PRINCIPAL: "other" };

describe("local CLI trusted context selection", () => {
  it.each([undefined, "trusted_context"])("resolves generated top-level context for %s", (context) => {
    expect(trustedCliContext(config, { ...capability, context }, env)).toEqual({ tenant_id: "acme", principal: "maya" });
  });
  it.each(["trusted_context", "named_context"])("preserves the explicit named %s context over top-level defaults", (context) => {
    const named = { ...config, contexts: { [context]: { provider: "static_dev" as const,
      values: { tenant_id: "named-company", principal: "named-person" } } } };
    expect(trustedCliContext(named, { ...capability, context }, {})).toEqual({ tenant_id: "named-company", principal: "named-person" });
  });
  it.each(["missing_context", "__proto__", "constructor"])("does not alias arbitrary missing context %s", (context) => {
    expect(() => trustedCliContext({ ...config, contexts: {} }, { ...capability, context }, env))
      .toThrowError(expect.objectContaining({ code: "TRUSTED_CONTEXT_MISSING" }));
  });
  it("reports an actionable typed missing-context error without binding values", () => {
    expect(() => trustedCliContext({ ...config, trusted_context: undefined }, capability, env))
      .toThrowError(expect.objectContaining({ code: "TRUSTED_CONTEXT_MISSING", message: expect.stringContaining("trusted_context") }));
  });
  it.each(["http_claims", "cloud_session"] as const)("never substitutes environment values for %s", (provider) => {
    expect(() => trustedCliContext({ ...config, contexts: { trusted_context: { provider } } }, capability, env))
      .toThrowError(expect.objectContaining({ code: "TRUSTED_CONTEXT_UNAVAILABLE" }));
  });
  it("requires both configured environment values and does not use static values or default env names", () => {
    expect(() => trustedCliContext({ ...config, trusted_context: { ...config.trusted_context!,
      values: { ...config.trusted_context!.values, principal: "not-an-env-binding" } } }, capability,
    { COMPANY: "acme", SYNAPSOR_PRINCIPAL: "not-the-configured-binding" }))
      .toThrowError(expect.objectContaining({ code: "TRUSTED_BINDING_MISSING" }));
  });
});
