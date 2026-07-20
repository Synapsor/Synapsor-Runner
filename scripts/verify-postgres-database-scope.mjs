import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "../packages/postgres/node_modules/pg/lib/index.js";
import {
  applyPostgresJob,
  applyPostgresJobWithClient,
  bindPostgresRlsScope,
  inspectPostgresRlsTarget,
} from "../packages/postgres/dist/index.js";
import { createMcpRuntime, preflightPostgresDatabaseScope } from "../packages/mcp-server/dist/index.js";
import { parseWritebackJob, principalScopeFingerprint } from "../packages/protocol/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "examples/runner-fleet/docker-compose.yml");
const cli = path.join(root, "apps/runner/dist/cli.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-postgres-rls-"));
const adminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const readerUrl = "postgresql://synapsor_rls_reader:reader_password@127.0.0.1:55439/synapsor_fleet";
const writerUrl = "postgresql://synapsor_rls_writer:writer_password@127.0.0.1:55439/synapsor_fleet";
const { Pool } = pg;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const ready = run("docker", ["compose", "-f", compose, "exec", "-T", "postgres", "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet"], { allowFailure: true });
    if (ready.status === 0) {
      const probe = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 1000 });
      try {
        const result = await probe.query("SELECT pg_postmaster_start_time() > initialized_at AS ready FROM public.synapsor_fixture_ready LIMIT 1");
        if (result.rows[0]?.ready === true) return;
      } catch {
        // Docker's entrypoint restarts PostgreSQL after loading init scripts.
      } finally {
        await probe.end().catch(() => undefined);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("PostgreSQL RLS fixture did not become ready");
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

class MemoryIntentStore {
  records = new Map();

  claimWritebackIntent(job) {
    const existing = this.records.get(job.idempotency_key);
    if (existing?.result) return { decision: "existing_result", intent_id: existing.intentId, result: existing.result };
    if (existing) return { decision: "reconciliation_required", intent_id: existing.intentId, reason: "unfinished synthetic intent" };
    const intentId = `wbi:${job.idempotency_key}`;
    this.records.set(job.idempotency_key, { intentId });
    return { decision: "proceed", intent_id: intentId };
  }

  markWritebackIntentApplying() {}

  completeWritebackIntent(intentId, result) {
    const record = [...this.records.values()].find((item) => item.intentId === intentId);
    if (!record) throw new Error("synthetic intent not found");
    record.result = result;
  }

  requireWritebackReconciliation() {}
}

async function setup(admin) {
  await admin.query(`
    DO $$
    BEGIN
      CREATE ROLE synapsor_rls_reader LOGIN PASSWORD 'reader_password';
      CREATE ROLE synapsor_rls_writer LOGIN PASSWORD 'writer_password';
      CREATE ROLE synapsor_rls_owner LOGIN PASSWORD 'owner_password';
      CREATE ROLE synapsor_rls_bypass LOGIN BYPASSRLS PASSWORD 'bypass_password';
      CREATE ROLE synapsor_rls_super LOGIN SUPERUSER PASSWORD 'super_password';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END
    $$;

    DROP TABLE IF EXISTS public.rls_owner_items;
    DROP TABLE IF EXISTS public.rls_missing_policy_items;
    DROP TABLE IF EXISTS public.rls_disabled_items;
    DROP TABLE IF EXISTS public.rls_items;

    CREATE TABLE public.rls_items (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      principal_id text NOT NULL,
      value_cents integer NOT NULL,
      version integer NOT NULL
    );
    INSERT INTO public.rls_items VALUES
      ('A-1', 'acme', 'alice', 100, 1),
      ('A-2', 'acme', 'bob', 200, 1),
      ('G-1', 'globex', 'alice', 300, 1);
    ALTER TABLE public.rls_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.rls_items FORCE ROW LEVEL SECURITY;
    CREATE POLICY rls_items_scope ON public.rls_items
      AS PERMISSIVE FOR ALL
      TO synapsor_rls_reader, synapsor_rls_writer, synapsor_rls_bypass, synapsor_rls_super
      USING (
        tenant_id = current_setting('synapsor.tenant_id', true)
        AND principal_id = current_setting('synapsor.principal_id', true)
      )
      WITH CHECK (
        tenant_id = current_setting('synapsor.tenant_id', true)
        AND principal_id = current_setting('synapsor.principal_id', true)
      );

    CREATE TABLE public.rls_owner_items (LIKE public.rls_items INCLUDING ALL);
    INSERT INTO public.rls_owner_items VALUES ('OWNER-1', 'acme', 'alice', 1, 1);
    ALTER TABLE public.rls_owner_items OWNER TO synapsor_rls_owner;
    ALTER TABLE public.rls_owner_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.rls_owner_items FORCE ROW LEVEL SECURITY;
    CREATE POLICY rls_owner_scope ON public.rls_owner_items
      AS PERMISSIVE FOR SELECT TO synapsor_rls_owner
      USING (
        tenant_id = current_setting('synapsor.tenant_id', true)
        AND principal_id = current_setting('synapsor.principal_id', true)
      );

    CREATE TABLE public.rls_missing_policy_items (LIKE public.rls_items INCLUDING ALL);
    INSERT INTO public.rls_missing_policy_items VALUES ('MISSING-1', 'acme', 'alice', 1, 1);
    ALTER TABLE public.rls_missing_policy_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.rls_missing_policy_items FORCE ROW LEVEL SECURITY;

    CREATE TABLE public.rls_disabled_items (LIKE public.rls_items INCLUDING ALL);
    INSERT INTO public.rls_disabled_items VALUES ('DISABLED-1', 'acme', 'alice', 1, 1);
    CREATE POLICY rls_disabled_scope ON public.rls_disabled_items
      AS PERMISSIVE FOR SELECT TO synapsor_rls_reader
      USING (
        tenant_id = current_setting('synapsor.tenant_id', true)
        AND principal_id = current_setting('synapsor.principal_id', true)
      );

    GRANT CONNECT ON DATABASE synapsor_fleet TO
      synapsor_rls_reader, synapsor_rls_writer, synapsor_rls_owner,
      synapsor_rls_bypass, synapsor_rls_super;
    GRANT USAGE ON SCHEMA public TO
      synapsor_rls_reader, synapsor_rls_writer, synapsor_rls_owner,
      synapsor_rls_bypass, synapsor_rls_super;
    GRANT SELECT ON public.rls_items TO synapsor_rls_reader;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.rls_items TO
      synapsor_rls_writer, synapsor_rls_bypass, synapsor_rls_super;
    GRANT SELECT ON public.rls_missing_policy_items, public.rls_disabled_items TO synapsor_rls_reader;
  `);
}

function scope(tenantId = "acme", principal = "alice") {
  return {
    mode: "postgres_rls",
    tenantSetting: "synapsor.tenant_id",
    principalSetting: "synapsor.principal_id",
    tenantId,
    principal,
  };
}

function reviewedPrincipalScope() {
  const input = {
    column: "principal_id",
    binding: "principal",
    provider: "static_dev",
    value: "alice",
  };
  return {
    schema_version: "synapsor.principal-scope.v1",
    ...input,
    value_fingerprint: principalScopeFingerprint(input),
  };
}

async function verifyDirectRlsAndPoolReset() {
  const pool = new Pool({ connectionString: readerUrl, max: 1 });
  try {
    const first = await pool.connect();
    try {
      await first.query("BEGIN");
      await bindPostgresRlsScope(first, scope());
      const rows = await first.query("SELECT id FROM public.rls_items ORDER BY id");
      assert(JSON.stringify(rows.rows.map((row) => row.id)) === JSON.stringify(["A-1"]), "RLS did not constrain an intentionally tenant-unscoped query", rows.rows);
      await first.query("COMMIT");
    } finally {
      first.release();
    }

    const reused = await pool.connect();
    try {
      await reused.query("BEGIN");
      const before = await reused.query(
        "SELECT current_setting($1, true) AS tenant, current_setting($2, true) AS principal",
        ["synapsor.tenant_id", "synapsor.principal_id"],
      );
      assert(before.rows[0]?.tenant !== "acme" && before.rows[0]?.principal !== "alice", "transaction-local RLS context leaked into the next pooled checkout", before.rows[0]);
      await bindPostgresRlsScope(reused, scope("globex", "alice"));
      const globex = await reused.query("SELECT id FROM public.rls_items ORDER BY id");
      assert(JSON.stringify(globex.rows.map((row) => row.id)) === JSON.stringify(["G-1"]), "reused pooled connection retained another tenant/principal scope", globex.rows);
      await reused.query("COMMIT");
    } finally {
      reused.release();
    }
  } finally {
    await pool.end();
  }
}

function runtimeConfig(table = "rls_items") {
  return {
    version: 1,
    mode: "read_only",
    result_format: 2,
    storage: { sqlite_path: ":memory:" },
    sources: {
      source: {
        engine: "postgres",
        read_url_env: "RLS_DATABASE_URL",
        database_scope: {
          mode: "postgres_rls",
          tenant_setting: "synapsor.tenant_id",
          principal_setting: "synapsor.principal_id",
        },
      },
    },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "alice" } },
    capabilities: [{
      name: "scope.inspect_item",
      kind: "read",
      source: "source",
      target: {
        schema: "public",
        table,
        primary_key: "id",
        tenant_key: "tenant_id",
        principal_scope_key: "principal_id",
      },
      args: { item_id: { type: "string", required: true, max_length: 64 } },
      lookup: { id_from_arg: "item_id" },
      visible_columns: ["id", "tenant_id", "value_cents", "version"],
      evidence: "required",
      max_rows: 1,
    }],
  };
}

async function verifyRuntimeRead() {
  const runtime = createMcpRuntime(runtimeConfig(), {
    env: { RLS_DATABASE_URL: readerUrl },
    storePath: ":memory:",
  });
  try {
    const own = await runtime.callTool("scope.inspect_item", { item_id: "A-1" });
    assert(own.ok === true && own.data?.id === "A-1", "hardened runtime read rejected reviewed scope", own);
    const crossPrincipal = await runtime.callTool("scope.inspect_item", { item_id: "A-2" });
    assert(crossPrincipal.ok === false && crossPrincipal.error?.code === "NOT_FOUND_IN_TENANT", "cross-principal runtime read was not denied generically", crossPrincipal);
    const crossTenant = await runtime.callTool("scope.inspect_item", { item_id: "G-1" });
    assert(crossTenant.ok === false && crossTenant.error?.code === "NOT_FOUND_IN_TENANT", "cross-tenant runtime read was not denied generically", crossTenant);
  } finally {
    await runtime.close();
  }
}

async function verifyWithCheck() {
  const pool = new Pool({ connectionString: writerUrl, max: 1 });
  const client = await pool.connect();
  try {
    for (const statement of [
      "UPDATE public.rls_items SET tenant_id = 'globex' WHERE id = 'A-1'",
      "UPDATE public.rls_items SET principal_id = 'bob' WHERE id = 'A-1'",
      "INSERT INTO public.rls_items VALUES ('BAD-1', 'globex', 'alice', 1, 1)",
    ]) {
      await client.query("BEGIN");
      await bindPostgresRlsScope(client, scope());
      let denied = false;
      try {
        await client.query(statement);
      } catch (error) {
        denied = String(error?.code) === "42501";
      }
      await client.query("ROLLBACK");
      assert(denied, "PostgreSQL WITH CHECK did not reject a tenant/principal move", statement);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

function updateJob() {
  return parseWritebackJob({
    schema_version: "synapsor.writeback-job.v2",
    writeback_job_id: "wbj_rls_update",
    proposal_id: "wrp_rls_update",
    proposal_version: 1,
    proposal_hash: digest("rls-update"),
    runner_scope: { project_id: "rls-proof", source_id: "source" },
    engine: "postgres",
    target: { schema: "public", table: "rls_items", primary_key: { column: "id", value: "A-1" } },
    tenant_guard: { column: "tenant_id", value: "acme" },
    principal_scope: reviewedPrincipalScope(),
    allowed_columns: ["value_cents"],
    mutation: {
      kind: "single_row_update",
      values: { value_cents: 101 },
      conflict_guard: { kind: "column", column: "version", expected_value: 1 },
      version_advance: { column: "version", strategy: "integer_increment" },
    },
    idempotency_key: "idem-rls-update",
    lease: { lease_id: "lease-rls-update", attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
}

function setJob(row) {
  const before = {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    principal_id: String(row.principal_id),
    value_cents: Number(row.value_cents),
    version: Number(row.version),
  };
  const after = { ...before, value_cents: 102, version: before.version + 1 };
  const member = {
    primary_key: { column: "id", value: before.id },
    expected_version: { column: "version", value: before.version },
    before,
    after,
    before_digest: digest({ primary_key: before.id, before }),
    after_digest: digest({ primary_key: before.id, after }),
  };
  const aggregateBounds = [{ column: "value_cents", measure: "before", maximum: 1000, actual: before.value_cents }];
  return parseWritebackJob({
    schema_version: "synapsor.writeback-job.v3",
    writeback_job_id: "wbj_rls_set",
    proposal_id: "wrp_rls_set",
    proposal_version: 1,
    proposal_hash: digest("rls-set"),
    runner_scope: { project_id: "rls-proof", source_id: "source" },
    engine: "postgres",
    operation: "set_update",
    target: { schema: "public", table: "rls_items", primary_key: { column: "id" } },
    tenant_guard: { column: "tenant_id", value: "acme" },
    principal_scope: reviewedPrincipalScope(),
    allowed_columns: ["value_cents"],
    patch: { value_cents: 102 },
    version_advance: { column: "version", strategy: "integer_increment" },
    frozen_set: {
      max_rows: 1,
      row_count: 1,
      aggregate_bounds: aggregateBounds,
      members: [member],
      set_digest: digest({ operation: "set_update", members: [member], aggregate_bounds: aggregateBounds }),
    },
    idempotency_key: "idem-rls-set",
    lease: { lease_id: "lease-rls-set", attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
}

function compensationJob(forward, row) {
  const expected = {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    principal_id: String(row.principal_id),
    value_cents: Number(row.value_cents),
    version: Number(row.version),
  };
  const principalScope = forward.target.principal_scope;
  return parseWritebackJob({
    schema_version: "synapsor.writeback-job.v4",
    writeback_job_id: "wbj_rls_compensation",
    proposal_id: "wrp_rls_compensation",
    proposal_version: 1,
    proposal_hash: digest("rls-compensation"),
    runner_scope: { project_id: "rls-proof", source_id: "source" },
    engine: "postgres",
    operation: "restore_update",
    target: { schema: "public", table: "rls_items", primary_key: { column: "id", value: "A-1" } },
    tenant_guard: { column: "tenant_id", value: "acme" },
    principal_scope: principalScope,
    allowed_columns: ["value_cents"],
    compensation: {
      schema_version: "synapsor.inverse-descriptor.v1",
      availability: "available",
      reason_codes: [],
      operation: "restore_update",
      cardinality: "single",
      forward_proposal_id: forward.proposal_id,
      forward_writeback_job_id: forward.job_id,
      target: { source_id: "source", schema: "public", table: "rls_items", primary_key_column: "id" },
      tenant_guard: { column: "tenant_id", value: "acme" },
      principal_scope: principalScope,
      allowed_columns: ["value_cents"],
      members: [{
        primary_key: { column: "id", value: "A-1" },
        expected_state: expected,
        restore_values: { value_cents: 101 },
      }],
      max_rows: 1,
      aggregate_bounds: [],
      version_advance: { column: "version", strategy: "integer_increment" },
      lineage: {
        root_proposal_id: forward.proposal_id,
        parent_proposal_id: forward.proposal_id,
        reverts_proposal_id: forward.proposal_id,
        depth: 1,
      },
    },
    forward_receipt_hash: digest("forward-receipt"),
    idempotency_key: "idem-rls-compensation",
    lease: { lease_id: "lease-rls-compensation", attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
}

async function scopedRow(pool) {
  const result = await pool.query("SELECT id, tenant_id, principal_id, value_cents, version FROM public.rls_items WHERE id = 'A-1'");
  return result.rows[0];
}

async function verifyGuardedWritePaths(admin) {
  const store = new MemoryIntentStore();
  const baseConfig = {
    controlPlaneUrl: "http://127.0.0.1:1",
    runnerToken: "synthetic",
    runnerId: "rls-proof",
    sourceId: "source",
    databaseUrl: writerUrl,
    engine: "postgres",
    pollIntervalMs: 1000,
    statementTimeoutMs: 5000,
    logLevel: "error",
    dryRun: false,
    stateDir: temp,
    receipts: { authority: "runner_ledger" },
    writebackIntentStore: store,
    databaseScope: scope(),
  };
  const update = updateJob();
  const writerPool = new Pool({ connectionString: writerUrl, max: 1 });
  const writerClient = await writerPool.connect();
  let updated;
  try {
    updated = await applyPostgresJobWithClient(update, baseConfig, writerClient);
  } finally {
    writerClient.release();
    await writerPool.end();
  }
  assert(updated.status === "applied", "hardened single-row update failed", updated);
  const retried = await applyPostgresJob(update, baseConfig);
  assert(retried.status === "already_applied", "hardened update retry was not idempotent", retried);

  const beforeSet = await scopedRow(admin);
  const set = setJob(beforeSet);
  const setResult = await applyPostgresJob(set, baseConfig);
  assert(setResult.status === "applied", "hardened bounded-set update failed", setResult);

  const beforeCompensation = await scopedRow(admin);
  const compensation = compensationJob(set, beforeCompensation);
  const compensationResult = await applyPostgresJob(compensation, baseConfig);
  assert(compensationResult.status === "applied", "hardened compensation failed", compensationResult);
  const final = await scopedRow(admin);
  assert(Number(final.value_cents) === 101 && Number(final.version) === 4, "compensation changed the wrong scoped state", final);
}

function writeDoctorConfig(table) {
  const directory = path.join(temp, `doctor-${table}`);
  fs.mkdirSync(directory, { recursive: true });
  const configPath = path.join(directory, "synapsor.runner.json");
  fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig(table), null, 2)}\n`);
  return configPath;
}

function doctor(table, url, expectOk) {
  const result = run(process.execPath, [
    cli,
    "doctor",
    "--config",
    writeDoctorConfig(table),
    "--store",
    path.join(temp, `doctor-${table}.db`),
    "--check-rls",
    "--json",
  ], {
    allowFailure: true,
    env: {
      RLS_DATABASE_URL: url,
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "alice",
    },
  });
  const report = JSON.parse(result.stdout);
  assert(report.ok === expectOk, `doctor ${table} returned the wrong RLS result`, report);
  return report;
}

async function verifyDoctorAndInspector() {
  await preflightPostgresDatabaseScope(runtimeConfig(), { RLS_DATABASE_URL: readerUrl });
  await assertRejectsCode(
    () => preflightPostgresDatabaseScope(runtimeConfig("rls_owner_items"), {
      RLS_DATABASE_URL: "postgresql://synapsor_rls_owner:owner_password@127.0.0.1:55439/synapsor_fleet",
    }),
    "POSTGRES_RLS_PREREQUISITE_FAILED",
    "MCP startup preflight did not reject an RLS-bypassing owner role",
  );
  const valid = doctor("rls_items", readerUrl, true);
  assert(valid.checks.some((check) => check.name.includes("postgres-rls:reader") && check.level === "pass"), "valid RLS doctor report omitted metadata");

  const owner = doctor("rls_owner_items", "postgresql://synapsor_rls_owner:owner_password@127.0.0.1:55439/synapsor_fleet", false);
  assert(JSON.stringify(owner).includes("POSTGRES_RLS_ROLE_TABLE_OWNER"), "doctor did not reject a table-owner role");
  const bypass = doctor("rls_items", "postgresql://synapsor_rls_bypass:bypass_password@127.0.0.1:55439/synapsor_fleet", false);
  assert(JSON.stringify(bypass).includes("POSTGRES_RLS_ROLE_BYPASSRLS"), "doctor did not reject BYPASSRLS");
  const superuser = doctor("rls_items", "postgresql://synapsor_rls_super:super_password@127.0.0.1:55439/synapsor_fleet", false);
  assert(JSON.stringify(superuser).includes("POSTGRES_RLS_ROLE_SUPERUSER"), "doctor did not reject superuser");
  const missing = doctor("rls_missing_policy_items", readerUrl, false);
  assert(JSON.stringify(missing).includes("POLICY_MISSING"), "doctor did not reject missing policy");
  const disabled = doctor("rls_disabled_items", readerUrl, false);
  assert(JSON.stringify(disabled).includes("POSTGRES_RLS_DISABLED"), "doctor did not reject disabled RLS");

  const pool = new Pool({ connectionString: writerUrl, max: 1 });
  const client = await pool.connect();
  try {
    const report = await inspectPostgresRlsTarget(client, {
      schema: "public",
      table: "rls_items",
      scope: { tenantSetting: "synapsor.tenant_id", principalSetting: "synapsor.principal_id" },
      operations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    });
    assert(report.ok, "writer RLS policy did not cover all guarded operations", report);
  } finally {
    client.release();
    await pool.end();
  }
}

async function assertRejectsCode(fn, code, message) {
  try {
    await fn();
  } catch (error) {
    if (String(error?.code) === code) return;
    throw new Error(`${message}: received ${String(error?.code ?? error)}`);
  }
  throw new Error(message);
}

run("docker", ["compose", "-f", compose, "up", "-d", "postgres"]);
let admin;
try {
  await waitForPostgres();
  admin = new Pool({ connectionString: adminUrl, max: 2 });
  await setup(admin);
  await verifyDirectRlsAndPoolReset();
  await verifyRuntimeRead();
  await verifyWithCheck();
  await verifyDoctorAndInspector();
  await verifyGuardedWritePaths(admin);
  console.log("PostgreSQL database-scope verification passed: independent RLS, trusted principal/tenant binding, pool reset, guarded writes, compensation, and fail-closed doctor checks.");
} finally {
  await admin?.end();
  run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
  fs.rmSync(temp, { recursive: true, force: true });
}
