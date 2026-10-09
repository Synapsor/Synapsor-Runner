import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfigFromFile, type RuntimeConfig, type TrustedContext } from "@synapsor-runner/mcp-server";
import { assertAuthoringMaterial, resolveAuthoringMaterialContext, type AuthoringMaterialContext, type AuthoringMaterialOrigin } from "./authoring-resume-material.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const sources = { app: { engine: "postgres" as const, read_url_env: "READ_DB" } };
const identity = { provider: "environment" as const, values: { tenant_id_env: "PRIVATE_TENANT", principal_env: "PRIVATE_PRINCIPAL" } };
async function fixture(config: RuntimeConfig = { version: 1, mode: "read_only", trusted_context: identity }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "resume-material-")); roots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const file = path.join(root, "synapsor.runner.json");
  await fs.writeFile(file, JSON.stringify({ ...(config.mode === "cloud" ? {} : { capabilities: [] }), sources, ...config }));
  loadRuntimeConfigFromFile(file);
  const owner = { projectRoot: root, jobCreatedAt: "2026-10-09T10:00:00.000Z" };
  const env: NodeJS.ProcessEnv = { PRIVATE_TENANT: "acme-corp", PRIVATE_PRINCIPAL: "person-123" };
  const context = await resolveAuthoringMaterialContext({ ...owner, env });
  const check = (value: unknown, origin: AuthoringMaterialOrigin = "retained_material") => assertAuthoringMaterial({ value, origin, owner, context });
  return { root, file, owner, env, context, check };
}

describe("configured identity retention", () => {
  it("refuses the exact configured identity without an English role prefix", async () => {
    const f = await fixture(); expect(f.context.kind).toBe("configured");
    await expect(f.check({ conversation: [{ answer: "acme-corp" }] })).rejects.toThrow("TRUSTED_IDENTITY_BLOCKED");
  });
  it("refuses the exact configured identity used as a retained object key", async () => {
    const f = await fixture();
    await expect(f.check({ "person-123": "answer" })).rejects.toThrow("TRUSTED_IDENTITY_BLOCKED");
  });
  it.each(["tenant is acme-corp", "principal=person-123", '"acme-corp"', "prefix person-123 suffix", "**acme-corp**"])
    ("preserves concrete identity negatives without interpreting words: %s", async value => {
      const f = await fixture(); await expect(f.check(value)).rejects.toThrow("TRUSTED_IDENTITY_BLOCKED");
    });
  it("keeps exact bytes and ordinary business explanations without English exemptions", async () => {
    const f = await fixture();
    await expect(f.check("Each tenant is exactly one organization. ACME-CORP is a distinct business string.")).resolves.toBeUndefined();
    await expect(f.check({ status: "ready", count: 2 })).resolves.toBeUndefined();
  });
  it.each(["api_key=private", "https://private.example/path", "mysql://private", "postgres://private", "BEGIN PRIVATE KEY", "Bearer private-token"])
    ("retains credential/endpoint guard: %s", async value => {
      const f = await fixture(); await expect(f.check(value)).rejects.toThrow("PRIVATE_MATERIAL_BLOCKED");
    });
  it("blocks short scalar and text business collisions as ambiguous, never a quota exemption", async () => {
    const f = await fixture(); f.env.PRIVATE_TENANT = "2";
    const context = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env });
    for (const value of [2, "2", { count: 2 }, "Tenant: maximum 2 per day."])
      await expect(assertAuthoringMaterial({ value, origin: "business_value", owner: f.owner, context })).rejects.toThrow("IDENTITY_AMBIGUOUS");
  });
  it("forbids typed identity slots even if the value is not a known configured value", async () => {
    const f = await fixture(); await expect(f.check("foreign-value", "forbidden_identity")).rejects.toThrow("TRUSTED_IDENTITY_BLOCKED");
  });
  it("requires actual absence of root AND named config, not fallback names or absent env", async () => {
    const f = await fixture({ version: 1, mode: "cloud", cloud: {
      base_url_env: "CLOUD_URL", runner_token_env: "CLOUD_TOKEN", adapter_id: "adapter", source_id: "app",
    } });
    expect(f.context.kind).toBe("unconfigured");
    await expect(f.check("Ordinary business material")).resolves.toBeUndefined();
    await fs.writeFile(f.file, JSON.stringify({ version: 1, mode: "read_only", capabilities: [], sources, trusted_context: identity, contexts: { actual: identity } }));
    await expect(f.check("Ordinary business material")).rejects.toThrow("CONTEXT_CHANGED");
    const named = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env });
    expect(named.kind).toBe("configured");
    await expect(assertAuthoringMaterial({ value: "person-123", origin: "retained_material", owner: f.owner, context: named })).rejects.toThrow("IDENTITY_BLOCKED");
    delete f.env.PRIVATE_TENANT;
    expect((await resolveAuthoringMaterialContext({ ...f.owner, env: f.env })).kind).toBe("unavailable");
  });
  it.each(["missing", "corrupt", "empty-provider"])("never treats %s config as unconfigured", async kind => {
    const f = await fixture();
    if (kind === "missing") await fs.rm(f.file);
    else await fs.writeFile(f.file, kind === "corrupt" ? "{" : JSON.stringify({ version: 1, mode: "read_only", capabilities: [], contexts: { bad: {} } }));
    const context = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env });
    expect(context.kind).toBe("unavailable");
    await expect(assertAuthoringMaterial({ value: "safe-looking", origin: "retained_material", owner: f.owner, context })).rejects.toThrow("CONTEXT_UNAVAILABLE");
  });
  it("fences wrong root/job, forged and serialized context; does not expose private proof", async () => {
    const f = await fixture(), other = await fixture();
    for (const owner of [other.owner, { ...f.owner, jobCreatedAt: "2026-10-09T11:00:00.000Z" }])
      await expect(assertAuthoringMaterial({ value: "business", owner, origin: "retained_material", context: f.context })).rejects.toThrow("CONTEXT_CHANGED");
    await expect(assertAuthoringMaterial({ value: "business", owner: f.owner, origin: "retained_material", context: { kind: "unconfigured" } as AuthoringMaterialContext })).rejects.toThrow("CONTEXT_UNAVAILABLE");
    expect(Object.keys(f.context)).toEqual(["kind"]);
    expect(() => JSON.stringify(f.context)).toThrow("CONTEXT_UNAVAILABLE");
    await expect(f.check("acme-corp")).rejects.not.toThrow("acme-corp");
  });
  it("re-resolves current environment and configuration instead of retaining an old safe context", async () => {
    const f = await fixture(); f.env.PRIVATE_PRINCIPAL = "new-person";
    await expect(f.check("business")).rejects.toThrow("CONTEXT_CHANGED");
    f.env.PRIVATE_PRINCIPAL = "person-123";
    await fs.writeFile(f.file, JSON.stringify({ version: 1, mode: "read_only", capabilities: [] }));
    await expect(f.check("business")).rejects.toThrow("CONTEXT_CHANGED");
  });
  it("requires a current verified-session owner for HTTP; no session reconstruction", async () => {
    const f = await fixture({ version: 1, mode: "read_only", trusted_context: { provider: "http_claims", principal_binding: "actor" }, session_auth: { provider: "jwt_hs256", secret_env: "SESSION_SECRET" } });
    expect(f.context.kind).toBe("unavailable");
    // This callback is the host port contract, not proof of an HTTP authenticator.
    let session: TrustedContext | undefined = { tenant_id: "org-http", principal: "person-http", provenance: "http_claims" };
    const context = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env, currentVerifiedSession: async request => {
      expect(request.projectRoot).toBe(f.root); expect(request.jobCreatedAt).toBe(f.owner.jobCreatedAt); return session;
    } });
    expect(context.kind).toBe("configured");
    await expect(assertAuthoringMaterial({ value: "person-http", origin: "retained_material", owner: f.owner, context })).rejects.toThrow("IDENTITY_BLOCKED");
    session = undefined;
    await expect(assertAuthoringMaterial({ value: "business", origin: "retained_material", owner: f.owner, context })).rejects.toThrow("CONTEXT_CHANGED");
  });
  it("does not turn a local config missing its required provider into unconfigured", async () => {
    const f = await fixture(); await fs.writeFile(f.file, JSON.stringify({ version: 1, mode: "read_only", sources, capabilities: [] }));
    expect((await resolveAuthoringMaterialContext({ ...f.owner, env: f.env })).kind).toBe("unavailable");
  });
  it("does not accept inherited ambient values instead of the configured names", async () => {
    const f = await fixture(); delete f.env.PRIVATE_PRINCIPAL;
    f.env.SYNAPSOR_PRINCIPAL = "person-123"; f.env.USER = "person-123";
    expect((await resolveAuthoringMaterialContext({ ...f.owner, env: f.env })).kind).toBe("unavailable");
  });
  it("uses actual static-dev configuration literals without persisting them in context", async () => {
    const f = await fixture({ version: 1, mode: "read_only", trusted_context: { provider: "static_dev", values: { tenant_id: "literal-org", principal: "literal-person" } } });
    expect(f.context.kind).toBe("configured");
    await expect(f.check("literal-person")).rejects.toThrow("IDENTITY_BLOCKED");
  });
  it("refuses non-JSON containers instead of missing hidden identity values", async () => {
    const f = await fixture(); await expect(f.check(new Map([["key", "person-123"]]))).rejects.toThrow("CONTEXT_UNAVAILABLE");
  });
  it.each([
    { generation_recovery: { operations: [{ producer_input: { operator_message: "person-123" } }] } },
    { operator_questions: [{ raw_answer: { text: "person-123" } }] },
    { pending_read_revision_state: { checkpoint: { dispatch_question: "person-123" } } },
    { operator_messages: ["person-123"] },
  ])("screens nested native/Source material without a text exemption", async value => {
    const f = await fixture(); await expect(f.check(value)).rejects.toThrow("IDENTITY_BLOCKED");
  });
  it("captures typed origin before awaiting currentness instead of accepting a mutable exemption", async () => {
    const f = await fixture();
    const input = { value: "foreign-value", origin: "forbidden_identity" as AuthoringMaterialOrigin, owner: f.owner, context: f.context };
    const pending = assertAuthoringMaterial(input); input.origin = "retained_material";
    await expect(pending).rejects.toThrow("IDENTITY_BLOCKED");
  });
  it("re-reads the default process environment even if its object is replaced", async () => {
    const f = await fixture(); const original = process.env;
    try {
      process.env = { ...original, ...f.env };
      const context = await resolveAuthoringMaterialContext(f.owner);
      expect(context.kind).toBe("configured");
      process.env = { ...process.env, PRIVATE_PRINCIPAL: "changed-principal" };
      await expect(assertAuthoringMaterial({ value: "business", owner: f.owner, context, origin: "retained_material" })).rejects.toThrow("CONTEXT_CHANGED");
    } finally { process.env = original; }
  });
  it("screens a snapshot captured before asynchronous currentness checks", async () => {
    const f = await fixture(); const value = { answer: "person-123" };
    const pending = f.check(value); value.answer = "business";
    await expect(pending).rejects.toThrow("IDENTITY_BLOCKED");
  });
});
