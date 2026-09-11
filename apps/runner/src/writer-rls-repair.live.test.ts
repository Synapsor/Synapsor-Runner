import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { writerProvisioningPlan, writerProvisioningSql, type WriterProvisioningPlan } from "./writer-provisioning.js";
import { writerPolicyRepair } from "./writer-rls-repair.js";
import { bindPostgresActionRuleScope } from "@synapsor-runner/postgres";
import { CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION, buildAutoBoundary, seedConfiguredPrincipalBindingReview } from "./auto-boundary.js";
import { assertReviewedReadCurrentStatePrerequisite, prepareReviewedReadCurrentStatePrerequisite } from "./read-prerequisite.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { prepareBoundaryRescan, commitBoundaryRescan, formatBoundaryRescanReport } from "./boundary-rescan.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { migrateProjectControlPolicies } from "./control-policy-store.js";
import { encodeOperatorAuthority, validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { readAuthoringCatalog } from "./control-policy-read-authoring.js";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { compileActionRule } from "@synapsor-runner/action-rules";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { collectWriterRowScopes, type WriterRowScope } from "./writer-rls-requirements.js";

describe.skipIf(process.env.SYNAPSOR_TEST_COMPLETE_COLLECTIONS_LIVE !== "1")("owned PostgreSQL administrator policy handoff", () => {
  const name = `synapsor-policy-repair-${randomUUID().slice(0, 8)}`;
  const tenant = "institution_id::text = nullif(current_setting('app.institution',true),'')";
  const student = `${tenant} AND student_id::text = nullif(current_setting('app.student',true),'')`;
  let admin: Pool, writer: Pool, plan: WriterProvisioningPlan;
  let readerUrl: string;
  let started = false;
  const psql = (sql: string) => execFileSync("docker", ["exec", "-i", name, "psql", "-U", "postgres", "-d", "repair", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  async function inspectPlan(outcome = "school.enroll") {
    const inspection = await inspectDatabase({ engine: "postgres", databaseUrlEnv: "FIXTURE_READER", schema: "school", env: { FIXTURE_READER: readerUrl } });
    return writerProvisioningPlan({ inspection, outcome, actionDigest: `sha256:${"a".repeat(64)}`, writerEnv: "FIXTURE_WRITER",
      assessment: { ok: false, fingerprint: `sha256:${"b".repeat(64)}`, expected_fingerprint: null, reasons: [], allowed_relations: [], writable_relations: [],
        required_relations: [
          { relation: "school.students", privileges: ["select", "update"], update_columns: ["status", "version"], lock_column: "student_id", rls_required: true,
            row_scope: [{ field: "institution_id", setting: "app.institution" }, { field: "student_id", setting: "app.student" }] },
          { relation: "school.institutions", privileges: ["select"], update_columns: [], lock_column: "institution_id", rls_required: true,
            row_scope: [{ field: "institution_id", setting: "app.institution" }] },
        ] } })!;
  }
  beforeAll(async () => {
    execFileSync("docker", ["run", "--rm", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=repair", "-p", "127.0.0.1::5432", "postgres:17"], { stdio: "pipe" });
    started = true;
    const port = Number(execFileSync("docker", ["port", name, "5432/tcp"], { encoding: "utf8" }).trim().split(":").at(-1));
    const config = { host: "127.0.0.1", port, database: "repair", user: "postgres", password: "fixture", connectionTimeoutMillis: 1000 };
    admin = new Pool(config);
    for (let attempt = 0; ; attempt++) {
      try { await admin.query("SELECT 1"); break; } catch (error) { if (attempt === 60) throw error; await sleep(250); }
    }
    await admin.query(`CREATE SCHEMA school; CREATE ROLE fixture_reader LOGIN PASSWORD 'fixture';
      CREATE TABLE school.students (student_id text PRIMARY KEY, institution_id text NOT NULL, status text NOT NULL, version integer NOT NULL,
        UNIQUE (institution_id,student_id));
      CREATE TABLE school.institutions (institution_id text PRIMARY KEY, label text NOT NULL);
      INSERT INTO school.students VALUES ('s1','i1','admitted',1), ('s2','i1','admitted',1), ('s3','i2','admitted',1);
      INSERT INTO school.institutions VALUES ('i1','First institution'), ('i2','Second institution');
      GRANT USAGE ON SCHEMA school TO fixture_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA school TO fixture_reader;
      ALTER TABLE school.students ENABLE ROW LEVEL SECURITY; ALTER TABLE school.students FORCE ROW LEVEL SECURITY;
      ALTER TABLE school.institutions ENABLE ROW LEVEL SECURITY; ALTER TABLE school.institutions FORCE ROW LEVEL SECURITY;
      CREATE POLICY reviewed_read ON school.students FOR SELECT TO fixture_reader USING (${student});
      CREATE POLICY reviewed_read ON school.institutions FOR SELECT TO PUBLIC USING (${tenant});`);
    readerUrl = `postgres://fixture_reader:fixture@127.0.0.1:${port}/repair`;
    plan = await inspectPlan();
    expect(plan.relations).toHaveLength(2);
    psql(writerProvisioningSql(plan));
    await admin.query(`ALTER ROLE "${plan.suggested_role}" LOGIN PASSWORD 'fixture'`);
    writer = new Pool({ ...config, user: plan.suggested_role });
  }, 60_000);
  afterAll(async () => {
    await writer?.end(); await admin?.end();
    if (started) execFileSync("docker", ["rm", "-f", name], { stdio: "pipe" });
  });
  beforeEach(async () => {
    const generated = await admin.query("SELECT schemaname,tablename,policyname FROM pg_policies WHERE schemaname='school' AND policyname LIKE 'runner_scope_%'");
    for (const policy of generated.rows) await admin.query(`DROP POLICY "${policy.policyname}" ON school."${policy.tablename}"`);
  });
  const policyCount = async () => Number((await admin.query("SELECT count(*) FROM pg_policies WHERE schemaname='school' AND policyname LIKE 'runner_scope_%'")).rows[0].count);
  const sourceRows = async () => (await admin.query("SELECT * FROM school.students ORDER BY student_id")).rows;
  it("derives a private principal mapping from live RLS before generating a narrow writer", async () => {
    const input = completeCollectionFixture();
    for (const resource of input.catalog.resources) delete resource.principal_scope_key;
    for (const binding of input.verification_boundary.resources) if (binding.scope.mode === "columns") delete binding.scope.principal_field;
    delete input.effect_envelope.principal_scope_key;
    const compiled = compileActionRule(input);
    await admin.query(`CREATE SCHEMA collections;
      CREATE TABLE collections.customers (customer_id text PRIMARY KEY, tenant_id text NOT NULL, principal_id text NOT NULL,
        state text NOT NULL, version integer NOT NULL);
      CREATE TABLE collections.holds (hold_id text PRIMARY KEY, customer_id text NOT NULL, tenant_id text NOT NULL,
        principal_id text NOT NULL, state text NOT NULL);
      INSERT INTO collections.customers VALUES ('c1','t1','p1','active',1),('c2','t1','p2','active',1),('c3','t2','p1','active',1);
      GRANT USAGE ON SCHEMA collections TO fixture_reader; GRANT SELECT ON ALL TABLES IN SCHEMA collections TO fixture_reader;`);
    for (const table of ["customers", "holds"]) await admin.query(`ALTER TABLE collections.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE collections.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY own_rows ON collections.${table} FOR SELECT TO fixture_reader USING
      (tenant_id = NULLIF(current_setting('app.organization', true),'') AND principal_id = NULLIF(current_setting('app.person', true),''));`);
    let generated: WriterProvisioningPlan | undefined, generatedWriter: Pool | undefined;
    try {
      const inspection = await inspectDatabase({ engine: "postgres", databaseUrlEnv: "FIXTURE_READER", schema: "collections", env: { FIXTURE_READER: readerUrl } });
      const scopes = new Map<string, WriterRowScope | null>();
      collectWriterRowScopes(compiled, { engine: "postgres", read_url_env: "FIXTURE_READER",
        database_scope: { mode: "postgres_rls", tenant_setting: "app.organization", principal_setting: "app.person" } }, scopes, inspection);
      expect(scopes.get("collections.customers")).toEqual([
        { field: "principal_id", setting: "app.person" }, { field: "tenant_id", setting: "app.organization" },
      ]);
      generated = writerProvisioningPlan({ inspection, outcome: "collections.ready", actionDigest: plan.action_digest, writerEnv: "COLLECTION_WRITER",
        assessment: { ok: false, fingerprint: `sha256:${"a".repeat(64)}`, expected_fingerprint: null, reasons: [], allowed_relations: [], writable_relations: [],
          required_relations: [{ relation: "collections.customers", privileges: ["select", "update"], update_columns: ["state", "version"],
            lock_column: "customer_id", rls_required: true, row_scope: scopes.get("collections.customers")! }] } })!;
      const repair = writerPolicyRepair(generated);
      expect(repair.blockers).toEqual([]);
      psql(writerProvisioningSql(generated)); psql(repair.sql!);
      await admin.query(`ALTER ROLE "${generated.suggested_role}" LOGIN PASSWORD 'fixture'`);
      generatedWriter = new Pool({ connectionString: readerUrl.replace("fixture_reader:", `${generated.suggested_role}:`) });
      const client = await generatedWriter.connect();
      try {
        await client.query("BEGIN");
        await bindPostgresActionRuleScope(client, { tenantSetting: "app.organization", principalSetting: "app.person", tenantId: "t1", principal: "p1" });
        expect((await client.query("UPDATE collections.customers SET state='ready', version=version+1 RETURNING customer_id")).rows).toEqual([{ customer_id: "c1" }]);
        await client.query("ROLLBACK");
        expect((await client.query("SELECT * FROM collections.customers")).rows).toEqual([]);
      } finally { await client.query("ROLLBACK"); client.release(); }
      expect((await admin.query("SELECT state FROM collections.customers")).rows.every(row => row.state === "active")).toBe(true);
    } finally {
      await generatedWriter?.end();
      if (generated) await admin.query(`DROP OWNED BY "${generated.suggested_role}"; DROP ROLE "${generated.suggested_role}";`);
      await admin.query("DROP SCHEMA collections CASCADE");
    }
  });
  it("exports and verifies scoped writer policies for inspected UUID identities", async () => {
    const t = randomUUID(), p = randomUUID(), other = randomUUID();
    const predicate = "institution_id = nullif(current_setting('app.institution',true),'')::uuid AND student_id = nullif(current_setting('app.student',true),'')::uuid";
    await admin.query(`CREATE TABLE school.uuid_records (record_id uuid PRIMARY KEY, institution_id uuid NOT NULL, student_id uuid NOT NULL,
      status text NOT NULL, version integer NOT NULL);
      GRANT SELECT ON school.uuid_records TO fixture_reader;
      ALTER TABLE school.uuid_records ENABLE ROW LEVEL SECURITY; ALTER TABLE school.uuid_records FORCE ROW LEVEL SECURITY;
      CREATE POLICY reviewed_read ON school.uuid_records FOR SELECT TO fixture_reader USING (${predicate});`);
    await admin.query("INSERT INTO school.uuid_records VALUES ($1,$2,$3,'ready',1),($4,$2,$4,'ready',1),($5,$4,$3,'ready',1)", [randomUUID(), t, p, other, randomUUID()]);
    let uuidPlan: WriterProvisioningPlan | undefined, uuidWriter: Pool | undefined;
    try {
      const inspection = await inspectDatabase({ engine: "postgres", databaseUrlEnv: "FIXTURE_READER", schema: "school", env: { FIXTURE_READER: readerUrl } });
      uuidPlan = writerProvisioningPlan({ inspection, outcome: "school.uuid_update", actionDigest: plan.action_digest, writerEnv: "UUID_WRITER",
        assessment: { ok: false, fingerprint: `sha256:${"b".repeat(64)}`, expected_fingerprint: null, reasons: [], allowed_relations: [], writable_relations: [],
          required_relations: [{ relation: "school.uuid_records", privileges: ["select", "update"], update_columns: ["status", "version"],
            lock_column: "record_id", rls_required: true, row_scope: [{ field: "institution_id", setting: "app.institution" }, { field: "student_id", setting: "app.student" }] }] } })!;
      expect(uuidPlan.relations[0]!.native_uuid_scope_columns).toEqual(["institution_id", "student_id"]);
      const repair = writerPolicyRepair(uuidPlan);
      expect(repair.blockers).toEqual([]);
      psql(writerProvisioningSql(uuidPlan)); psql(repair.sql!);
      await admin.query(`ALTER ROLE "${uuidPlan.suggested_role}" LOGIN PASSWORD 'fixture'`);
      uuidWriter = new Pool({ connectionString: readerUrl.replace("fixture_reader:", `${uuidPlan.suggested_role}:`) });
      const client = await uuidWriter.connect();
      try {
        await client.query("BEGIN");
        await bindPostgresActionRuleScope(client, { tenantSetting: "app.institution", principalSetting: "app.student", tenantId: t, principal: p });
        expect((await client.query("SELECT institution_id, student_id FROM school.uuid_records FOR UPDATE")).rows).toEqual([{ institution_id: t, student_id: p }]);
        expect((await client.query("UPDATE school.uuid_records SET status='done', version=version+1 RETURNING status")).rows).toEqual([{ status: "done" }]);
        await client.query("ROLLBACK");
        expect((await client.query("SELECT * FROM school.uuid_records")).rows).toEqual([]);
      } finally { await client.query("ROLLBACK"); client.release(); }
      expect((await admin.query("SELECT status FROM school.uuid_records")).rows.every(row => row.status === "ready")).toBe(true);
      expect(() => psql(repair.sql!)).toThrow("Policies changed after export");
    } finally {
      await uuidWriter?.end();
      if (uuidPlan) await admin.query(`DROP OWNED BY "${uuidPlan.suggested_role}"; DROP ROLE "${uuidPlan.suggested_role}";`);
      await admin.query("DROP TABLE school.uuid_records");
    }
  });
  it("repairs exact customer and shared-reference policies without changing data or other roles", async () => {
    const before = await sourceRows(), repair = writerPolicyRepair(plan);
    expect(repair.blockers).toEqual([]); expect(repair.changes).toHaveLength(3);
    expect(await policyCount()).toBe(0);
    psql(repair.sql!);
    expect(await policyCount()).toBe(3);
    const client = await writer.connect();
    try {
      await client.query("BEGIN");
      await bindPostgresActionRuleScope(client, { tenantSetting: "app.institution", principalSetting: "app.student", tenantId: "i1", principal: "s1" });
      expect((await client.query("SELECT student_id FROM school.students FOR UPDATE")).rows).toEqual([{ student_id: "s1" }]);
      expect((await client.query("SELECT institution_id FROM school.institutions FOR UPDATE")).rows).toEqual([{ institution_id: "i1" }]);
      await client.query("ROLLBACK");
      await expect(client.query("UPDATE school.institutions SET label='changed'")).rejects.toThrow("permission denied");
      expect((await client.query("SELECT student_id FROM school.students")).rows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect(await sourceRows()).toEqual(before);
    expect((await admin.query("SELECT rolname FROM pg_roles WHERE oid IN (SELECT member FROM pg_auth_members) AND rolname=$1", [plan.suggested_role])).rows).toEqual([]);
    expect(() => psql(repair.sql!)).toThrow("Policies changed after export");
    expect(await policyCount()).toBe(3);
  });
  it("provisions a second independent writer without replacing the first writer or its equivalent policies", async () => {
    const before = await sourceRows();
    psql(writerPolicyRepair(plan).sql!);
    const policiesBefore = (await admin.query("SELECT * FROM pg_policies WHERE schemaname='school' ORDER BY tablename,policyname")).rows;
    const second = await inspectPlan("school.restore");
    expect(second.suggested_role).not.toBe(plan.suggested_role);
    const repair = writerPolicyRepair(second);
    expect(repair.blockers).toEqual([]); expect(repair.changes).toHaveLength(3);
    psql(writerProvisioningSql(second));
    let other: Pool | undefined;
    try {
      psql(repair.sql!);
      await admin.query(`ALTER ROLE "${second.suggested_role}" LOGIN PASSWORD 'fixture'`);
      other = new Pool({ connectionString: readerUrl.replace("fixture_reader:", `${second.suggested_role}:`) });
      for (const pool of [writer, other]) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await bindPostgresActionRuleScope(client, { tenantSetting: "app.institution", principalSetting: "app.student", tenantId: "i1", principal: "s1" });
          expect((await client.query("SELECT student_id FROM school.students FOR UPDATE")).rows).toEqual([{ student_id: "s1" }]);
          expect((await client.query("SELECT institution_id FROM school.institutions FOR UPDATE")).rows).toEqual([{ institution_id: "i1" }]);
        } finally { await client.query("ROLLBACK"); client.release(); }
      }
      expect(await sourceRows()).toEqual(before);
      expect(await policyCount()).toBe(6);
      const policiesAfter = (await admin.query("SELECT * FROM pg_policies WHERE schemaname='school' ORDER BY tablename,policyname")).rows;
      expect(policiesAfter.filter(row => policiesBefore.some(old => old.tablename === row.tablename && old.policyname === row.policyname))).toEqual(policiesBefore);
      expect(() => psql(repair.sql!)).toThrow("Policies changed after export");
    } finally {
      await other?.end();
      await admin.query(`DROP OWNED BY "${second.suggested_role}"; DROP ROLE "${second.suggested_role}";`);
    }
  });
  it("rolls back the whole repair when a source policy changes after export", async () => {
    const repair = writerPolicyRepair(plan);
    await admin.query(`ALTER POLICY reviewed_read ON school.students USING ((${student}) AND status='admitted')`);
    try {
      expect(() => psql(repair.sql!)).toThrow("Policies changed after export");
      expect(await policyCount()).toBe(0);
      expect(writerPolicyRepair(await inspectPlan()).sql).toBeUndefined();
    } finally { await admin.query(`ALTER POLICY reviewed_read ON school.students USING (${student})`); }
  });
  it.each(["predicate", "role", "removed"])("refuses second SELECT %s drift without changing existing writer policies", async change => {
    psql(writerPolicyRepair(plan).sql!);
    const second = await inspectPlan("school.restore");
    const repair = writerPolicyRepair(second);
    expect(repair.blockers).toEqual([]);
    psql(writerProvisioningSql(second));
    const read = second.relations.find(relation => relation.table === "students")!.policies
      .find(policy => policy.command === "SELECT" && policy.roles.includes(plan.suggested_role))!;
    try {
      if (change === "predicate") await admin.query(`ALTER POLICY "${read.name}" ON school.students USING ((${student}) AND status='admitted')`);
      if (change === "role") await admin.query(`ALTER POLICY "${read.name}" ON school.students TO PUBLIC`);
      if (change === "removed") await admin.query(`DROP POLICY "${read.name}" ON school.students`);
      const before = (await admin.query("SELECT * FROM pg_policies WHERE schemaname='school' ORDER BY tablename,policyname")).rows;
      const records = await sourceRows();
      expect(() => psql(repair.sql!)).toThrow("Policies changed after export");
      expect((await admin.query("SELECT * FROM pg_policies WHERE schemaname='school' ORDER BY tablename,policyname")).rows).toEqual(before);
      expect(await sourceRows()).toEqual(records);
    } finally {
      await admin.query(`DROP OWNED BY "${second.suggested_role}"; DROP ROLE "${second.suggested_role}";`);
    }
  });
  it("refreshes a saved private admission proof after unrelated writer policies without dropping its condition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-private-rescan-"));
    try {
      await admin.query(`CREATE TABLE school.admissions (
        institution_id text NOT NULL, student_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('admitted','withdrawn')),
        effective_from timestamptz NOT NULL, effective_until timestamptz NOT NULL,
        CONSTRAINT admissions_subject UNIQUE (institution_id,student_id),
        FOREIGN KEY (institution_id,student_id) REFERENCES school.students (institution_id,student_id));
        GRANT SELECT ON school.admissions TO fixture_reader;
        ALTER TABLE school.admissions ENABLE ROW LEVEL SECURITY;
        ALTER TABLE school.admissions FORCE ROW LEVEL SECURITY;
        CREATE POLICY admissions_reader ON school.admissions FOR SELECT TO fixture_reader USING (${student});`);
      const inspect = () => inspectDatabase({ engine: "postgres", databaseUrlEnv: "FIXTURE_READER", schema: "school", env: { FIXTURE_READER: readerUrl } });
      const before = await inspect();
      const build = buildAutoBoundary({ inspection: before,
        project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["FIXTURE_READER"] },
        sourceEnv: "FIXTURE_READER", inspectedSchema: "school",
        configuredTrustedContext: { schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION, provider: "environment",
          tenant_binding: "institution_id", principal_binding: "student_id", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL" },
        overrides: seedConfiguredPrincipalBindingReview({ inspection: before, principalBinding: "student_id", actor: "fixture-operator", decidedAt: new Date().toISOString() }),
      });
      const candidate = structuredClone(build.exploration_boundary);
      candidate.read_prerequisite = prepareReviewedReadCurrentStatePrerequisite({
        source: { schema: "school", table: "admissions" },
        subject: { tenant_column: "institution_id", principal_column: "student_id", unique_constraint: "admissions_subject" },
        current_state: { state_column: "status", positive_state: "admitted", effective_from_column: "effective_from", effective_until_column: "effective_until", interval: "[effective_from,effective_until)", clock: "database_utc" },
        semantic_consent: { source_description: "Fixture completion: current registrar admission, not registration inference.", positive_state_description: "Only admitted during its current interval.", confirmed: true },
      }, before, candidate);
      const progress = createBoundaryReviewProgress({ draft: build.exploration_boundary, candidate,
        confirmedDecisions: [], reviewOverrides: build.overrides, actor: "fixture-operator", revision: 1 });
      const revision = encodeOperatorAuthority({ type: "read_authoring", selected_boundary_id: progress.boundary_id,
        entries: [{ draft: build.exploration_boundary, draft_lock: build.lock, candidate_lock: build.lock, progress, catalog: readAuthoringCatalog(build) }] });
      const readRevision = encodeOperatorAuthority({ type: "read", boundary: candidate, generation_lock: build.lock });
      const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: null });
      const initialized = await migrateProjectControlPolicies({ projectRoot: root, config: {} as RuntimeConfig,
        storePath: path.join(root, "control.db"), actor: "fixture-operator", validateSnapshot: async snapshot => validateOperatorPolicySnapshot(snapshot),
        readLegacySnapshot: async () => ({ revisions: [revision, readRevision, selection],
          active: [revision, selection].map(value => ({ scope: value.scope, kind: value.kind, name: value.name, revision_id: value.revision_id })),
          drafts: [{ scope: readRevision.scope, kind: readRevision.kind, name: readRevision.name, revision_id: readRevision.revision_id }], provenance: [] }),
      });
      await initialized.binding.close();
      const original = await readProjectReadAuthoring(root);
      expect(original?.selected?.progress.candidate.read_prerequisite).toEqual(candidate.read_prerequisite);
      await admin.query(`CREATE POLICY admissions_writer ON school.admissions FOR SELECT TO "${plan.suggested_role}" USING (${student})`);
      const after = await inspect();
      expect(after.tables.find(table => table.name === "admissions")!.role_posture!.row_security_applicable_policies).toEqual(["admissions_reader"]);
      expect(() => assertReviewedReadCurrentStatePrerequisite(candidate.read_prerequisite!, after)).toThrow(/changed/);
      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: after });
      expect(formatBoundaryRescanReport(preview.report)).toContain("Private access condition preserved");
      expect((await readProjectReadAuthoring(root))?.bindings).toEqual(original!.bindings);
      const refreshed = preview.selectedProgress.candidate.read_prerequisite!;
      expect(refreshed.dependency.fingerprint).not.toBe(candidate.read_prerequisite!.dependency.fingerprint);
      expect({ ...refreshed, dependency: candidate.read_prerequisite!.dependency }).toEqual(candidate.read_prerequisite);
      await commitBoundaryRescan(preview);
      const saved = await readProjectReadAuthoring(root);
      expect(saved?.selected?.progress.candidate.read_prerequisite).toEqual(refreshed);
      expect(saved?.selected?.progress.candidate.activation).toBe("disabled_unreviewed");
      assertReviewedReadCurrentStatePrerequisite(refreshed, after);
      await admin.query(`ALTER POLICY admissions_writer ON school.admissions TO fixture_reader`);
      const applicable = await inspect();
      await expect(prepareBoundaryRescan({ projectRoot: root, inspection: applicable })).rejects.toThrow(/private current-state access condition/);
      expect((await readProjectReadAuthoring(root))?.bindings).toEqual(saved!.bindings);
      expect((await admin.query("SELECT count(*) FROM school.admissions")).rows[0].count).toBe("0");
    } finally {
      await admin.query("DROP TABLE IF EXISTS school.admissions");
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.each(["bypass", "membership", "writer_grantee", "unforced"])("refuses changed %s before creating any policy", async change => {
    const repair = writerPolicyRepair(plan);
    if (change === "bypass") await admin.query(`ALTER ROLE "${plan.suggested_role}" BYPASSRLS`);
    if (change === "membership") await admin.query(`GRANT fixture_reader TO "${plan.suggested_role}"`);
    if (change === "writer_grantee") await admin.query(`GRANT "${plan.suggested_role}" TO fixture_reader`);
    if (change === "unforced") await admin.query("ALTER TABLE school.institutions NO FORCE ROW LEVEL SECURITY");
    try { expect(() => psql(repair.sql!)).toThrow(); expect(await policyCount()).toBe(0); }
    finally {
      if (change === "bypass") await admin.query(`ALTER ROLE "${plan.suggested_role}" NOBYPASSRLS`);
      if (change === "membership") await admin.query(`REVOKE fixture_reader FROM "${plan.suggested_role}"`);
      if (change === "writer_grantee") await admin.query(`REVOKE "${plan.suggested_role}" FROM fixture_reader`);
      if (change === "unforced") await admin.query("ALTER TABLE school.institutions FORCE ROW LEVEL SECURITY");
    }
  });
  it("treats a policy name containing SQL and dollar delimiters as metadata", async () => {
    const unusual = "$runner_scope_review$; DROP TABLE school.students; -- '";
    const quoted = `"${unusual.replaceAll('"', '""')}"`;
    await admin.query(`ALTER POLICY reviewed_read ON school.students RENAME TO ${quoted}`);
    const before = await sourceRows();
    try {
      const repair = writerPolicyRepair(await inspectPlan());
      expect(repair.blockers).toEqual([]);
      psql(repair.sql!);
      expect(await policyCount()).toBe(3);
      expect(await sourceRows()).toEqual(before);
    } finally { await admin.query(`ALTER POLICY ${quoted} ON school.students RENAME TO reviewed_read`); }
  });
});
