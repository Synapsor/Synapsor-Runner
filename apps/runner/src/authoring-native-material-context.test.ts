import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectDatabaseWithConnection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION, type BuildAutoBoundaryInput } from "./auto-boundary.js";
import { initializeGuidedProject } from "./guided-project.js";
import { initializeFreshGovernedAuthoring } from "./control-policy-fresh-authoring.js";
import { readRuntimeConfig } from "./cli-project.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { assertAuthoringMaterial, resolveAuthoringMaterialContext, type AuthoringMaterialOwner } from "./authoring-resume-material.js";
import type { TrustedContext } from "@synapsor-runner/mcp-server";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

// The actual inspector consumes declared metadata only. No Source connection,
// rows, provider or native authority identifiers/confirmations are synthesized.
async function fixture(provider: "environment" | "http_claims" = "environment") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-material-screen-")); roots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const schema = "app", table = "cases";
  const fields = [["case_id", "text"], ["status", "text"]];
  const client = Object.assign(new Client(), { release() {} });
  const query = vi.spyOn(client, "query").mockImplementation(async request => {
    const sql = request;
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("SELECT version()")) rows = [{ version: "PostgreSQL 17.0", current_user: "declared_reader", superuser: false, bypass_rls: false }];
    else if (sql.includes("SELECT schema_name")) rows = [{ schema_name: schema }];
    else if (sql.includes("AS row_level_security")) rows = fields.map(([column_name]) => ({ schema, table_name: table, column_name, row_level_security: false }));
    else if (sql.includes("FROM information_schema.tables")) rows = [{ schema, name: table, type: "BASE TABLE" }];
    else if (sql.includes("FROM information_schema.columns")) rows = fields.map(([name, data_type], index) => ({ schema, table_name: table, name,
      data_type, udt_name: data_type, is_nullable: "NO", is_generated: "NEVER", is_identity: "NO", ordinal_position: index + 1 }));
    else if (sql.includes("con.contype IN ('p', 'u')")) rows = [{ schema, table_name: table, constraint_name: `${table}_pkey`, constraint_type: "PRIMARY KEY", column_name: "case_id", ordinal_position: 1 }];
    else if (sql.includes("AS current_role_is_owner")) rows = [{ schema, table_name: table, owner: "declared_owner", current_role_is_owner: false,
      current_role_can_assume_owner: false, can_select: true, can_insert: false, can_update: false, can_delete: false,
      can_truncate: false, can_references: false, can_trigger: false, row_security_forced: false }];
    else if (sql.includes("AS enabled")) rows = [{ schema, table_name: table, enabled: false, forced: false }];
    else if (!["BEGIN READ ONLY", "SET LOCAL", "COMMIT", "ROLLBACK", "FROM pg_catalog.pg_constraint", "FROM pg_catalog.pg_trigger",
      "FROM pg_catalog.pg_policies", "FROM pg_catalog.pg_index"].some(fragment => sql.includes(fragment))) throw new Error("Undeclared fixture metadata query");
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  });
  try {
    const inspection = await inspectDatabaseWithConnection({ engine: "postgres", databaseUrlEnv: "FIXTURE_READ_URL", schema,
      verifySingleOrganization: true, env: { FIXTURE_READ_URL: "postgres://unused.invalid/declared_metadata" } }, { engine: "postgres", connection: client });
    const input = { inspection, sourceEnv: "FIXTURE_READ_URL", inspectedSchema: "app",
      singleOrganization: { organizationId: "reviewed-organization" },
      ...(provider === "http_claims" ? { deploymentProfile: "production" as const } : {}),
      configuredTrustedContext: provider === "environment" ? { schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
        provider: "environment" as const, tenant_env: "FIXTURE_TENANT", principal_env: "FIXTURE_PERSON" }
        : { schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION, provider: "http_claims" as const, principal_claim: "fixture_subject" },
      project: { root, package_manager: "npm" as const, frameworks: [], schema_inputs: [], database_env_names: ["FIXTURE_READ_URL"] } } satisfies BuildAutoBoundaryInput;
    const build = buildAutoBoundary(input);
    const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0", instantOnboarding: true });
    if (provider === "http_claims") {
      // Configuration setup only; the verified-session port below is a declared
      // host contract fixture, never an authenticator or production gate proof.
      const configured = JSON.parse(await fs.readFile(guided.config_path, "utf8"));
      configured.trusted_context = { provider: "http_claims" };
      configured.session_auth = { provider: "jwt_hs256", secret_env: "SESSION_SECRET", principal_claim: "fixture_subject" };
      await fs.writeFile(guided.config_path, JSON.stringify(configured));
    }
    const config = await readRuntimeConfig(guided.config_path);
    const initial = await initializeFreshGovernedAuthoring({ projectRoot: root, build, config, storePath: guided.store_path, actor: "fixture reviewer" });
    const env: NodeJS.ProcessEnv = { FIXTURE_TENANT: "private-tenant", FIXTURE_PERSON: "private-person", USER: "local-actor" };
    const owner = { projectRoot: root, jobCreatedAt: "2026-10-09T10:00:00.000Z" };
    const context = await resolveAuthoringMaterialContext({ ...owner, env });
    const check = (value: unknown) => assertAuthoringMaterial({ value, owner, context, origin: "retained_material" });
    return { root, input, inspection, config, guided, initial, env, owner, context, check };
  } finally { query.mockRestore(); }
}

describe("native configured identities before runtime capabilities", () => {
  it("screens the current native names without adding runtime obligations or a local actor identity", async () => {
    const f = await fixture();
    expect(f.config.capabilities).toEqual([]);
    expect(f.config.trusted_context?.values).toEqual({});
    expect(f.context.kind).toBe("configured");
    await expect(f.check({ answer: "ordinary choice", actor: "local-actor" })).resolves.toBe('{"answer":"ordinary choice","actor":"local-actor"}');
    expect(await readRuntimeConfig(f.guided.config_path)).toEqual(f.config);
    expect(() => JSON.stringify(f.context)).toThrow("CONTEXT_UNAVAILABLE");
  });
  it.each(["private-tenant", "private-person", "reviewed-organization"])("blocks nested current identity %s", async value => {
    const f = await fixture();
    await expect(f.check({ nested: { [value]: "retained" } })).rejects.toThrow("TRUSTED_IDENTITY_BLOCKED");
  });
  it.each(["FIXTURE_TENANT", "FIXTURE_PERSON"])("refuses missing declared %s despite ambient defaults or actor", async name => {
    const f = await fixture(); delete f.env[name];
    f.env.SYNAPSOR_TENANT_ID = "ambient-tenant"; f.env.SYNAPSOR_PRINCIPAL = "ambient-person";
    expect((await resolveAuthoringMaterialContext({ ...f.owner, env: f.env })).kind).toBe("unavailable");
    await expect(f.check("ordinary choice")).rejects.toThrow("CONTEXT_CHANGED");
  });
  it("refuses environment drift before retention and ambiguous business collisions", async () => {
    const f = await fixture(); f.env.FIXTURE_PERSON = "changed-person";
    await expect(f.check("ordinary choice")).rejects.toThrow("CONTEXT_CHANGED");
    const context = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env });
    await expect(assertAuthoringMaterial({ value: "changed-person", owner: f.owner, context, origin: "business_value" })).rejects.toThrow("IDENTITY_AMBIGUOUS");
  });
  it("does not lose the actual native identity names when a runtime export path is omitted", async () => {
    const f = await fixture(); const config = JSON.parse(await fs.readFile(f.guided.config_path, "utf8"));
    delete config.generated_authority;
    await fs.writeFile(f.guided.config_path, JSON.stringify(config));
    const context = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env });
    expect(context.kind).toBe("configured");
    await expect(assertAuthoringMaterial({ value: { answer: f.env.FIXTURE_PERSON }, owner: f.owner, context,
      origin: "retained_material" })).rejects.toThrow("TRUSTED_IDENTITY_BLOCKED");
    await expect(f.check("ordinary choice")).rejects.toThrow("CONTEXT_CHANGED");
  });
  it("refuses a changed native revision with identical runtime configuration", async () => {
    const f = await fixture();
    const preview = await prepareBoundaryResourceReviewMutation(f.root, { resource_id: "app.cases", include: true,
      principal_key: null, allow_reviewed_fields: ["case_id", "status"], selectable_fields: ["case_id", "status"],
      actor: "fixture reviewer", reason: "Review identifiers and status within the declared organization." }, async () => f.inspection);
    await commitBoundaryResourceReviewMutation(f.root, preview);
    await expect(f.check("ordinary choice")).rejects.toThrow("CONTEXT_CHANGED");
    expect(await readRuntimeConfig(f.guided.config_path)).toEqual(f.config);
  });
  it.each(["source", "binding"])("refuses native/configured %s disagreement", async kind => {
    const f = await fixture(); const config = JSON.parse(await fs.readFile(f.guided.config_path, "utf8"));
    if (kind === "source") Object.values(config.sources).forEach(source => { (source as {read_url_env:string}).read_url_env = "OTHER_READ_URL"; });
    else config.trusted_context.values.principal_env = "OTHER_PERSON";
    await fs.writeFile(f.guided.config_path, JSON.stringify(config));
    f.env.OTHER_PERSON = "another-person";
    expect((await resolveAuthoringMaterialContext({ ...f.owner, env: f.env })).kind).toBe("unavailable");
    await expect(f.check("ordinary choice")).rejects.toThrow("CONTEXT_CHANGED");
  });
  it("preserves the production/environment refusal at its actual generation owner", async () => {
    const f = await fixture();
    expect(() => buildAutoBoundary({ ...f.input, deploymentProfile: "production" })).toThrow("Production Explore requires trusted_context.provider=http_claims");
  });
});

function privacyOwner(f: Awaited<ReturnType<typeof fixture>>, kind: "job" | "source" | "read"): AuthoringMaterialOwner {
  if (kind === "read") return { projectRoot: f.root, readEntry: {
    entry_id: f.initial.authoring.selected!.progress.boundary_id, bindings: f.initial.authoring.bindings } };
  // This Source frame exercises privacy only; its UUID is not Source custody.
  if (kind === "source") return { projectRoot: f.root, sourceSessionId: randomUUID() };
  return f.owner;
}

describe("native privacy currentness across host awaits", () => {
  it.each(["job", "source", "read"] as const)("refuses incompatible provider retention for the %s owner", async kind => {
    const f = await fixture(), owner = privacyOwner(f, kind);
    const config = JSON.parse(await fs.readFile(f.guided.config_path, "utf8"));
    config.trusted_context = { provider: "static_dev", values: { tenant_id: "unrelated-org", principal: "unrelated-person" } };
    await fs.writeFile(f.guided.config_path, JSON.stringify(config));
    const context = await resolveAuthoringMaterialContext({ ...owner, env: f.env });
    await expect(assertAuthoringMaterial({ value: { nested: f.env.FIXTURE_PERSON }, owner, context,
      origin: "retained_material" })).rejects.toThrow("CONTEXT_UNAVAILABLE");
  });
  it("refuses configured absence despite an otherwise valid unconfigured cloud setup", async () => {
    const f = await fixture();
    await fs.writeFile(f.guided.config_path, JSON.stringify({ version: 1, mode: "cloud", cloud: {
      base_url_env: "CLOUD_URL", runner_token_env: "CLOUD_TOKEN", adapter_id: "fixture", source_id: "fixture" } }));
    const context = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env });
    await expect(assertAuthoringMaterial({ value: f.env.FIXTURE_PERSON, owner: f.owner, context,
      origin: "retained_material" })).rejects.toThrow("CONTEXT_UNAVAILABLE");
  });
  it.each(["job", "source", "read"] as const)("refuses env drift during a verified-session await for the %s owner", async kind => {
    const f = await fixture(), owner = privacyOwner(f, kind);
    const config = JSON.parse(await fs.readFile(f.guided.config_path, "utf8"));
    config.contexts = { actual: { provider: "http_claims", principal_binding: "actor" } };
    config.session_auth = { provider: "jwt_hs256", secret_env: "SESSION_SECRET" };
    await fs.writeFile(f.guided.config_path, JSON.stringify(config));
    let change = false;
    const currentVerifiedSession = async (): Promise<TrustedContext> => {
      await Promise.resolve(); if (change) f.env.FIXTURE_PERSON = "changed-identity-z";
      return { tenant_id: "verified-org", principal: "verified-person", provenance: "http_claims" };
    };
    const context = await resolveAuthoringMaterialContext({ ...owner, env: f.env, currentVerifiedSession });
    expect(context.kind).toBe("configured"); change = true;
    await expect(assertAuthoringMaterial({ value: { answer: "changed-identity-z" }, owner, context,
      origin: "retained_material" })).rejects.toThrow("CONTEXT_CHANGED");
  });
  it("rechecks a replaced process environment after the last awaited session owner", async () => {
    const f = await fixture(), originalEnv = process.env;
    const config = JSON.parse(await fs.readFile(f.guided.config_path, "utf8"));
    config.contexts = { actual: { provider: "http_claims", principal_binding: "actor" } };
    config.session_auth = { provider: "jwt_hs256", secret_env: "SESSION_SECRET" };
    await fs.writeFile(f.guided.config_path, JSON.stringify(config));
    let change = false;
    const currentVerifiedSession = async (): Promise<TrustedContext> => {
      await Promise.resolve(); if (change) process.env = { ...process.env, FIXTURE_PERSON: "swapped-identity-z" };
      return { tenant_id: "verified-org", principal: "verified-person", provenance: "http_claims" };
    };
    try {
      process.env = { ...originalEnv, ...f.env };
      const context = await resolveAuthoringMaterialContext({ ...f.owner, currentVerifiedSession });
      expect(context.kind).toBe("configured"); change = true;
      await expect(assertAuthoringMaterial({ value: "swapped-identity-z", owner: f.owner, context,
        origin: "retained_material" })).rejects.toThrow("CONTEXT_CHANGED");
    } finally { process.env = originalEnv; }
  });
  it("keeps production HTTP metadata bound to a genuine current host session port", async () => {
    const f = await fixture("http_claims");
    expect(f.context.kind).toBe("unavailable");
    let session: TrustedContext | undefined = { tenant_id: "reviewed-organization", principal: "verified-person", provenance: "http_claims" };
    const currentVerifiedSession = async () => session;
    const context = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env, currentVerifiedSession });
    expect(context.kind).toBe("configured");
    for (const value of ["verified-person", "reviewed-organization"])
      await expect(assertAuthoringMaterial({ value, owner: f.owner, context, origin: "retained_material" })).rejects.toThrow("IDENTITY_BLOCKED");
    session = undefined;
    await expect(assertAuthoringMaterial({ value: "ordinary", owner: f.owner, context,
      origin: "retained_material" })).rejects.toThrow("CONTEXT_CHANGED");
  });
});
