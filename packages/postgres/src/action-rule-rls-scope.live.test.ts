import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { compileActionRule } from "../../action-rules/src/compile.js";
import { evaluateActionRule } from "../../action-rules/src/evaluate.js";
import { loadActionRuleFacts } from "../../action-rules/src/fact-loader.js";
import { completeCollectionFixture } from "../../action-rules/src/testing/complete-collection-fixture.js";
import { bindPostgresActionRuleScope, createPostgresActionRuleFactLoader } from "./index.js";

function sharedReferenceFixture() {
  const fixture = completeCollectionFixture("postgres");
  const id = { kind: "string", max_length: 64, comparison: "exact" } as const;
  const fields = [{ name: "tenant_id", type: id, nullable: false }, { name: "enabled", type: { kind: "boolean" } as const, nullable: false }];
  fixture.catalog.resources[0]!.fields.push({ name: "section_id", type: id, nullable: false });
  const pairs = [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "section_id", target_field: "section_id" }];
  for (const [table, key] of [["institutions", "tenant_id"], ["sections", "section_id"]] as const) {
    const resource = { name: `collections.${table}`, source: "database", engine: "postgres" as const, schema: "collections", table,
      primary_key: key, tenant_key: "tenant_id", fields: [...fields, ...(key === "tenant_id" ? [] : [{ name: key, type: id, nullable: false }])] };
    fixture.catalog.resources.push(resource);
    const relationship = { name: `customer_${table}_fk`, from_resource: "collections.customers", to_resource: resource.name,
      ...(table === "institutions" ? { local_field: "tenant_id", target_field: "tenant_id" } : { field_pairs: pairs }),
      cardinality: "many_to_one" as const, nullable: false, target_unique: true };
    fixture.catalog.relationships.push(relationship);
    fixture.verification_boundary.resources.push({ binding: table, resource: resource.name, primary_key: key, fields: resource.fields,
      source: { kind: "relationship", from_binding: "customer", relationship: relationship.name, direction: "forward",
        ...(table === "institutions" ? { local_field: "tenant_id", target_field: "tenant_id" } : { field_pairs: pairs }) },
      scope: { mode: "columns", tenant_field: "tenant_id" }, cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" });
    fixture.verification_boundary.lock_order.push(table);
  }
  fixture.rule.require = { kind: "all", expressions: [fixture.rule.require!, ...["institutions", "sections"].map(binding => ({
    kind: "compare" as const, operator: "eq" as const, left: { kind: "field" as const, binding, field: "enabled" },
    right: { kind: "literal" as const, value: true, value_type: { kind: "boolean" as const } },
  }))] };
  return fixture;
}

describe.skipIf(process.env.SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE !== "1")("owned PostgreSQL private shared-reference verification", () => {
  const name = `synapsor-shared-rls-${randomUUID().slice(0, 8)}`;
  const f = sharedReferenceFixture();
  const compiled = compileActionRule(f);
  const scope = { tenantId: "t1", principal: "p1", tenantSetting: "synapsor.tenant_id", principalSetting: "synapsor.principal" };
  const tenant = "tenant_id::text = nullif(current_setting('synapsor.tenant_id', true), '')";
  const customer = `${tenant} AND principal_id::text = nullif(current_setting('synapsor.principal', true), '')`;
  let admin: Pool, reader: Pool, writer: Pool;
  let started = false;
  beforeAll(async () => {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=shared_refs", "-p", "127.0.0.1::5432", "postgres:17"], { stdio: "pipe" });
    started = true;
    const port = Number(execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
    const config = { host: "127.0.0.1", port, database: "shared_refs", user: "postgres", password: "fixture", connectionTimeoutMillis: 1000 };
    admin = new Pool(config);
    for (let attempt = 0; ; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 60) throw error; await sleep(250); }
    }
    await admin.query(`CREATE SCHEMA collections;
      CREATE ROLE shared_reader LOGIN PASSWORD 'fixture'; CREATE ROLE shared_writer LOGIN PASSWORD 'fixture';
      CREATE TABLE collections.institutions (tenant_id varchar(64) PRIMARY KEY, enabled boolean NOT NULL);
      CREATE TABLE collections.sections (section_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, enabled boolean NOT NULL,
        UNIQUE (tenant_id, section_id));
      CREATE TABLE collections.customers (customer_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        state varchar(16) NOT NULL, version integer NOT NULL, section_id varchar(64) NOT NULL, UNIQUE (tenant_id, principal_id, customer_id),
        CONSTRAINT customer_institutions_fk FOREIGN KEY (tenant_id) REFERENCES collections.institutions (tenant_id),
        CONSTRAINT customer_sections_fk FOREIGN KEY (tenant_id, section_id) REFERENCES collections.sections (tenant_id, section_id));
      CREATE TABLE collections.holds (hold_id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL, principal_id varchar(64) NOT NULL,
        customer_id varchar(64) NOT NULL, state varchar(16) NOT NULL,
        CONSTRAINT holds_customer_fk FOREIGN KEY (tenant_id, principal_id, customer_id) REFERENCES collections.customers (tenant_id, principal_id, customer_id));
      GRANT USAGE ON SCHEMA collections TO shared_reader, shared_writer;
      GRANT SELECT ON ALL TABLES IN SCHEMA collections TO shared_reader, shared_writer;
      GRANT UPDATE (state, version) ON collections.customers TO shared_writer;
      GRANT UPDATE (hold_id) ON collections.holds TO shared_writer;
      GRANT UPDATE (tenant_id) ON collections.institutions TO shared_writer;
      GRANT UPDATE (section_id) ON collections.sections TO shared_writer;`);
    for (const table of ["customers", "holds", "institutions", "sections"]) {
      const predicate = ["customers", "holds"].includes(table) ? customer : tenant;
      await admin.query(`ALTER TABLE collections.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE collections.${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY reviewed_read ON collections.${table} FOR SELECT TO shared_reader, shared_writer USING (${predicate});
        CREATE POLICY reviewed_lock ON collections.${table} FOR UPDATE TO shared_writer USING (${predicate}) WITH CHECK (${predicate});`);
    }
    reader = new Pool({ ...config, user: "shared_reader" }); writer = new Pool({ ...config, user: "shared_writer" });
  }, 60_000);
  afterAll(async () => {
    await reader?.end(); await writer?.end(); await admin?.end();
    if (started) execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  });
  beforeEach(async () => {
    await admin.query(`TRUNCATE collections.holds, collections.customers, collections.sections, collections.institutions;
      INSERT INTO collections.institutions VALUES ('t1',true), ('t2',true);
      INSERT INTO collections.sections VALUES ('section1','t1',true), ('section2','t2',true);
      INSERT INTO collections.customers VALUES ('c1','t1','p1','active',1,'section1'), ('c2','t1','p2','active',1,'section1'), ('c3','t2','p1','active',1,'section2');`);
  });
  async function load(mode: "proposal_snapshot" | "transaction_reverify", identity = scope) {
    const client = await (mode === "proposal_snapshot" ? reader : writer).connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await bindPostgresActionRuleScope(client, identity);
      const loaded = await loadActionRuleFacts({ compiled, subjects: f.subjects,
        trusted: { transaction_time: f.facts.trusted.transaction_time, tenant: identity.tenantId, principal: identity.principal }, mode,
        adapter: createPostgresActionRuleFactLoader(client, identity) });
      const bound = (await client.query("SELECT current_setting('synapsor.tenant_id') AS tenant, current_setting('synapsor.principal') AS principal")).rows[0];
      return { ...loaded, bound };
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  it.each(["proposal_snapshot", "transaction_reverify"] as const)("uses scalar and composite shared references in %s without requiring a student column on them", async mode => {
    const loaded = await load(mode);
    expect(loaded.bound).toEqual({ tenant: "t1", principal: "p1" });
    expect(loaded.facts.bindings.institutions!.rows).toEqual([{ tenant_id: "t1", enabled: true }]);
    expect(loaded.facts.bindings.sections!.rows).toEqual([{ tenant_id: "t1", section_id: "section1", enabled: true }]);
    expect(evaluateActionRule({ compiled, facts: loaded.facts, proposal_id: "shared" }).result).toBe("eligible");
    expect((await admin.query("SELECT state,version FROM collections.customers WHERE customer_id='c1'")).rows[0]).toEqual({ state: "active", version: 1 });
  });
  it.each([{ ...scope, principal: "p2" }, { ...scope, tenantId: "t2" }])("does not expose shared facts through another customer's subject (%j)", async identity => {
    await expect(load("proposal_snapshot", identity)).rejects.toThrow("Complete collection requires its exact existing parent");
    expect((await admin.query("SELECT state,version FROM collections.customers WHERE customer_id='c1'")).rows[0]).toEqual({ state: "active", version: 1 });
  });
  it("rechecks a shared prerequisite that changed after preparation", async () => {
    expect(evaluateActionRule({ compiled, facts: (await load("proposal_snapshot")).facts, proposal_id: "fresh" }).result).toBe("eligible");
    await admin.query("UPDATE collections.sections SET enabled=false WHERE section_id='section1'");
    expect(evaluateActionRule({ compiled, facts: (await load("transaction_reverify")).facts, proposal_id: "fresh" }).result).toBe("ineligible");
    expect((await admin.query("SELECT state,version FROM collections.customers WHERE customer_id='c1'")).rows[0]).toEqual({ state: "active", version: 1 });
  });
  it("refuses missing institutional RLS rather than silently relying on the parent", async () => {
    await admin.query("ALTER POLICY reviewed_read ON collections.sections USING (true)");
    try { await expect(load("proposal_snapshot")).rejects.toThrow("POSTGRES_RLS_SELECT_SETTING_MISSING:synapsor.tenant_id"); }
    finally { await admin.query(`ALTER POLICY reviewed_read ON collections.sections USING (${tenant})`); }
  });
  it("rejects a composite tuple inconsistent with the reviewed relationship during compilation", () => {
    const changed = sharedReferenceFixture();
    const binding = changed.verification_boundary.resources.find(item => item.binding === "sections")!;
    if (binding.source.kind === "relationship") binding.source.field_pairs = [
      { local_field: "principal_id", target_field: "tenant_id" }, { local_field: "section_id", target_field: "section_id" },
    ];
    expect(() => compileActionRule(changed)).toThrow();
  });
});
