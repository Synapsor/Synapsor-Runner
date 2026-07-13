import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "../packages/postgres/node_modules/pg/lib/index.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import {
  applyPostgresJob,
  inspectPostgresWritebackSource,
} from "../packages/postgres/dist/index.js";
import {
  applyMysqlJob,
  inspectMysqlWritebackSource,
} from "../packages/mysql/dist/index.js";
import { PostgresWritebackIntentStore } from "../packages/proposal-store/dist/index.js";
import { parseWritebackJob } from "../packages/protocol/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "examples", "runner-fleet", "docker-compose.yml");
const pgAdminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const mysqlAdminUrl = "mysql://root:root_password@127.0.0.1:53309/synapsor_fleet";
const { Pool } = pg;

const engines = {
  postgres: {
    schema: "public",
    apply: applyPostgresJob,
    inspect: inspectPostgresWritebackSource,
    urls: {
      precreated: "postgresql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:55439/synapsor_fleet",
      auto: "postgresql://synapsor_crud_auto:synapsor_crud_auto_password@127.0.0.1:55439/synapsor_fleet",
      ledger: "postgresql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:55439/synapsor_fleet",
    },
    receipts: {
      precreated: { authority: "source_db", provisioning: "precreated", schema: "synapsor_precreated", table: "receipts" },
      auto: { authority: "source_db", provisioning: "auto_migrate", schema: "synapsor_auto", table: "receipts" },
      ledger: { authority: "runner_ledger" },
    },
  },
  mysql: {
    schema: "synapsor_fleet",
    apply: applyMysqlJob,
    inspect: inspectMysqlWritebackSource,
    urls: {
      precreated: "mysql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:53309/synapsor_fleet",
      auto: "mysql://synapsor_crud_auto:synapsor_crud_auto_password@127.0.0.1:53309/synapsor_fleet",
      ledger: "mysql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:53309/synapsor_fleet",
    },
    receipts: {
      precreated: { authority: "source_db", provisioning: "precreated", schema: "synapsor_fleet", table: "synapsor_receipts_precreated" },
      auto: { authority: "source_db", provisioning: "auto_migrate", schema: "synapsor_fleet", table: "synapsor_receipts_auto" },
      ledger: { authority: "runner_ledger" },
    },
  },
};

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function waitForDatabases() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const pgReady = run("docker", ["compose", "-f", composeFile, "exec", "-T", "postgres", "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet"], { allowFailure: true });
    const mysqlReady = run("docker", ["compose", "-f", composeFile, "exec", "-T", "mysql", "mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password"], { allowFailure: true });
    if (pgReady.status === 0 && mysqlReady.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("guarded CRUD databases did not become ready");
}

function hash(label) {
  return `sha256:${crypto.createHash("sha256").update(label).digest("hex")}`;
}

function job(engine, mode, operation, suffix, options = {}) {
  const proposalId = `wrp_${engine}_${mode}_${operation}_${suffix}`;
  const tenant = options.tenant ?? "acme";
  const mutation = operation === "insert"
    ? {
        kind: "single_row_insert",
        values: { value_cents: options.value ?? 500 },
        deduplication: { components: [
          { column: "tenant_id", value: tenant, source: "trusted_tenant" },
          { column: "request_id", value: proposalId, source: "proposal_id" },
        ] },
      }
    : operation === "delete"
      ? { kind: "single_row_delete", conflict_guard: { kind: "column", column: "version", expected_value: options.version ?? 1 } }
      : {
          kind: "single_row_update",
          values: { value_cents: options.value ?? 900 },
          conflict_guard: { kind: "column", column: "version", expected_value: options.version ?? 1 },
          version_advance: { column: "version", strategy: "integer_increment" },
        };
  return parseWritebackJob({
    schema_version: "synapsor.writeback-job.v2",
    writeback_job_id: `wbj_${engine}_${mode}_${operation}_${suffix}`,
    proposal_id: proposalId,
    proposal_version: 1,
    proposal_hash: hash(proposalId),
    runner_scope: { project_id: "guarded_crud", source_id: `source_${engine}` },
    engine,
    target: {
      schema: engines[engine].schema,
      table: "guard_crud_items",
      primary_key: { column: "id", ...(options.id === undefined ? {} : { value: options.id }) },
    },
    tenant_guard: { column: "tenant_id", value: tenant },
    allowed_columns: operation === "delete" ? [] : ["value_cents"],
    mutation,
    idempotency_key: `idem_${engine}_${mode}_${operation}_${suffix}`,
    lease: { lease_id: `lease_${engine}_${mode}_${operation}_${suffix}`, attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
}

function runnerConfig(engine, mode, intentStore, failpoint) {
  return {
    controlPlaneUrl: "http://127.0.0.1:1",
    runnerToken: "synthetic-local-token",
    runnerId: `guarded-crud-${engine}-${mode}`,
    sourceId: `source_${engine}`,
    databaseUrl: engines[engine].urls[mode],
    engine,
    pollIntervalMs: 1000,
    logLevel: "error",
    dryRun: false,
    stateDir: ".synapsor/test-state",
    receipts: engines[engine].receipts[mode],
    ...(intentStore ? { writebackIntentStore: intentStore } : {}),
    ...(failpoint ? { testFailpoint: failpoint } : {}),
  };
}

async function pgQuery(pool, sql, values = []) {
  const result = await pool.query(sql, values);
  return result.rows;
}

async function mysqlQuery(connection, sql, values = []) {
  const [rows] = await connection.query(sql, values);
  return Array.isArray(rows) ? rows : [];
}

async function rowFor(engine, admin, id) {
  const rows = engine === "postgres"
    ? await pgQuery(admin, "SELECT id, tenant_id, request_id, value_cents, version FROM public.guard_crud_items WHERE id = $1", [id])
    : await mysqlQuery(admin, "SELECT id, tenant_id, request_id, value_cents, version FROM guard_crud_items WHERE id = ?", [id]);
  return rows[0];
}

async function rowForRequest(engine, admin, requestId) {
  const rows = engine === "postgres"
    ? await pgQuery(admin, "SELECT id, tenant_id, request_id, value_cents, version FROM public.guard_crud_items WHERE tenant_id = 'acme' AND request_id = $1", [requestId])
    : await mysqlQuery(admin, "SELECT id, tenant_id, request_id, value_cents, version FROM guard_crud_items WHERE tenant_id = 'acme' AND request_id = ?", [requestId]);
  return rows[0];
}

async function intentStore(schema) {
  return new PostgresWritebackIntentStore({
    pool: new Pool({ connectionString: pgAdminUrl, max: 4 }),
    schema,
    autoMigrate: true,
    closePool: true,
  });
}

async function verifyModeMatrix(engine, admin) {
  const idByMode = {
    precreated: { update: 1001, delete: 1002 },
    auto: { update: 1011, delete: 1012 },
    ledger: { update: 1021, delete: 1022 },
  };
  for (const mode of ["precreated", "auto", "ledger"]) {
    const intents = mode === "ledger" ? await intentStore(`crud_${engine}_matrix`) : undefined;
    try {
      const update = job(engine, mode, "update", "matrix", { id: idByMode[mode].update, value: 1000 + idByMode[mode].update });
      const updateConfig = runnerConfig(engine, mode, intents);
      const updated = await engines[engine].apply(update, updateConfig);
      assert(updated.status === "applied" && updated.affected_rows === 1, `${engine}/${mode} UPDATE did not apply`, updated);
      const updateRow = await rowFor(engine, admin, idByMode[mode].update);
      assert(Number(updateRow?.value_cents) === 1000 + idByMode[mode].update && Number(updateRow?.version) === 2, `${engine}/${mode} UPDATE did not advance the exact row/version`, updateRow);
      const updateRetry = await engines[engine].apply(update, updateConfig);
      assert(updateRetry.status === "already_applied" && updateRetry.affected_rows === 0, `${engine}/${mode} UPDATE retry was not idempotent`, updateRetry);

      const insert = job(engine, mode, "insert", "matrix", { value: 700 + idByMode[mode].update });
      const inserted = await engines[engine].apply(insert, updateConfig);
      assert(inserted.status === "applied" && inserted.affected_rows === 1, `${engine}/${mode} INSERT did not apply`, inserted);
      const insertRow = await rowForRequest(engine, admin, insert.proposal_id);
      assert(insertRow?.tenant_id === "acme" && Number(insertRow?.value_cents) === 700 + idByMode[mode].update, `${engine}/${mode} INSERT did not force tenant/dedup identity`, insertRow);
      const insertRetry = await engines[engine].apply(insert, updateConfig);
      assert(insertRetry.status === "already_applied" && insertRetry.affected_rows === 0, `${engine}/${mode} INSERT retry was not idempotent`, insertRetry);

      const deletion = job(engine, mode, "delete", "matrix", { id: idByMode[mode].delete });
      const deleted = await engines[engine].apply(deletion, updateConfig);
      assert(deleted.status === "applied" && deleted.affected_rows === 1, `${engine}/${mode} DELETE did not apply`, deleted);
      assert(await rowFor(engine, admin, idByMode[mode].delete) === undefined, `${engine}/${mode} DELETE left the target row behind`);
      const deleteRetry = await engines[engine].apply(deletion, updateConfig);
      assert(deleteRetry.status === "already_applied" && deleteRetry.affected_rows === 0, `${engine}/${mode} DELETE retry was not idempotent`, deleteRetry);
    } finally {
      await intents?.close();
    }
  }
}

async function verifyGuards(engine, admin) {
  const wrongTenant = job(engine, "precreated", "update", "wrong_tenant", { id: 1031, tenant: "acme", value: 9999 });
  const wrongResult = await engines[engine].apply(wrongTenant, runnerConfig(engine, "precreated"));
  assert(wrongResult.status === "conflict" && wrongResult.error_code === "ROW_NOT_FOUND", `${engine} wrong-tenant UPDATE did not fail closed`, wrongResult);
  const wrongRow = await rowFor(engine, admin, 1031);
  assert(wrongRow?.tenant_id === "globex" && Number(wrongRow?.value_cents) === 230, `${engine} wrong-tenant UPDATE changed another tenant`, wrongRow);

  const stale = job(engine, "precreated", "update", "stale", { id: 1041, version: 1, value: 9998 });
  const staleResult = await engines[engine].apply(stale, runnerConfig(engine, "precreated"));
  assert(staleResult.status === "conflict" && staleResult.error_code === "VERSION_CONFLICT", `${engine} stale UPDATE did not fail closed`, staleResult);
  const staleRow = await rowFor(engine, admin, 1041);
  assert(Number(staleRow?.value_cents) === 240 && Number(staleRow?.version) === 2, `${engine} stale UPDATE changed the source`, staleRow);
}

async function verifyCrashWindows(engine, admin) {
  const afterStore = await intentStore(`crud_${engine}_crash_after`);
  try {
    const after = job(engine, "ledger", "update", "crash_after", { id: 1051, value: 5051 });
    const result = await engines[engine].apply(after, runnerConfig(engine, "ledger", afterStore, (point) => {
      if (point === "after_source_commit") throw new Error("synthetic process loss after COMMIT");
    }));
    assert(result.status === "reconciliation_required" && result.error_code === "RECONCILIATION_REQUIRED", `${engine} post-COMMIT crash was not made explicit`, result);
    const row = await rowFor(engine, admin, 1051);
    assert(Number(row?.value_cents) === 5051 && Number(row?.version) === 2, `${engine} post-COMMIT crash fixture did not commit exactly once`, row);
    const retry = await engines[engine].apply(after, runnerConfig(engine, "ledger", afterStore));
    assert(retry.status === "reconciliation_required", `${engine} ambiguous post-COMMIT retry was not stopped`, retry);
    const observation = await engines[engine].inspect(after, engines[engine].urls.ledger);
    assert(observation.classification === "matches_proposed", `${engine} reconciliation did not inspect the allowlisted proposed state`, observation);
  } finally {
    await afterStore.close();
  }

  const beforeStore = await intentStore(`crud_${engine}_crash_before`);
  try {
    const before = job(engine, "ledger", "update", "crash_before", { id: 1052, value: 5052 });
    const result = await engines[engine].apply(before, runnerConfig(engine, "ledger", beforeStore, (point) => {
      if (point === "before_source_commit") throw new Error("synthetic process loss before COMMIT");
    }));
    assert(result.status === "failed", `${engine} pre-COMMIT failure was not terminally classified`, result);
    const row = await rowFor(engine, admin, 1052);
    assert(Number(row?.value_cents) === 260 && Number(row?.version) === 1, `${engine} pre-COMMIT failure did not roll back`, row);
  } finally {
    await beforeStore.close();
  }
}

async function verifyConcurrentApply(engine, admin) {
  const schema = `crud_${engine}_race`;
  const [storeA, storeB] = await Promise.all([intentStore(schema), intentStore(schema)]);
  try {
    const update = job(engine, "ledger", "update", "race", { id: 1061, value: 6061 });
    const results = await Promise.all([
      engines[engine].apply(update, runnerConfig(engine, "ledger", storeA)),
      engines[engine].apply(update, runnerConfig(engine, "ledger", storeB)),
    ]);
    assert(results.filter((result) => result.status === "applied").length === 1, `${engine} concurrent apply did not produce one source mutation`, results);
    assert(results.every((result) => ["applied", "already_applied", "reconciliation_required"].includes(result.status)), `${engine} concurrent apply returned an unsafe outcome`, results);
    const row = await rowFor(engine, admin, 1061);
    assert(Number(row?.value_cents) === 6061 && Number(row?.version) === 2, `${engine} concurrent apply duplicated or lost the effect`, row);
    const final = await engines[engine].apply(update, runnerConfig(engine, "ledger", storeA));
    assert(final.status === "already_applied", `${engine} completed concurrent intent did not settle to already_applied`, final);
  } finally {
    await Promise.all([storeA.close(), storeB.close()]);
  }
}

async function verifyDeleteHazards(engine, admin) {
  if (engine === "postgres") {
    await pgQuery(admin, "CREATE FUNCTION public.guard_crud_delete_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$");
    await pgQuery(admin, "CREATE TRIGGER guard_crud_delete BEFORE DELETE ON public.guard_crud_items FOR EACH ROW EXECUTE FUNCTION public.guard_crud_delete_trigger()")
  } else {
    await mysqlQuery(admin, "CREATE TRIGGER guard_crud_delete BEFORE DELETE ON guard_crud_items FOR EACH ROW SET @guard_crud_delete_seen = OLD.id");
  }
  const triggerJob = job(engine, "precreated", "delete", "trigger", { id: 1031, tenant: "globex" });
  const triggerResult = await engines[engine].apply(triggerJob, runnerConfig(engine, "precreated"));
  assert(triggerResult.status === "failed" && triggerResult.error_code === "DELETE_TRIGGER_BLOCKED", `${engine} DELETE trigger was not rejected`, triggerResult);
  assert(await rowFor(engine, admin, 1031), `${engine} trigger-blocked DELETE changed the source`);
  if (engine === "postgres") await pgQuery(admin, "DROP TRIGGER guard_crud_delete ON public.guard_crud_items");
  else await mysqlQuery(admin, "DROP TRIGGER guard_crud_delete");

  if (engine === "postgres") {
    await pgQuery(admin, "CREATE TABLE public.guard_crud_dependents (id bigint PRIMARY KEY, item_id bigint NOT NULL REFERENCES public.guard_crud_items(id) ON DELETE CASCADE)");
    await pgQuery(admin, "INSERT INTO public.guard_crud_dependents (id, item_id) VALUES (1, 1031)");
  } else {
    await mysqlQuery(admin, "CREATE TABLE guard_crud_dependents (id bigint PRIMARY KEY, item_id bigint NOT NULL, CONSTRAINT guard_crud_item_fk FOREIGN KEY (item_id) REFERENCES guard_crud_items(id) ON DELETE CASCADE)");
    await mysqlQuery(admin, "INSERT INTO guard_crud_dependents (id, item_id) VALUES (1, 1031)");
  }
  const cascadeJob = job(engine, "precreated", "delete", "cascade", { id: 1031, tenant: "globex" });
  const cascadeResult = await engines[engine].apply(cascadeJob, runnerConfig(engine, "precreated"));
  assert(cascadeResult.status === "failed" && cascadeResult.error_code === "DELETE_CASCADE_BLOCKED", `${engine} cascading DELETE was not rejected`, cascadeResult);
  assert(await rowFor(engine, admin, 1031), `${engine} cascade-blocked DELETE changed the source`);
}

async function verifyReceiptBoundaries(pgAdmin, mysqlAdmin) {
  const pgLedgerTable = await pgQuery(pgAdmin, "SELECT to_regclass('public.synapsor_runner_ledger_receipts') AS table_name");
  assert(pgLedgerTable[0]?.table_name == null, "Postgres runner_ledger created a source receipt table", pgLedgerTable);
  const mysqlLedgerTable = await mysqlQuery(mysqlAdmin, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'synapsor_fleet' AND TABLE_NAME = 'synapsor_runner_ledger_receipts'");
  assert(mysqlLedgerTable.length === 0, "MySQL runner_ledger created a source receipt table", mysqlLedgerTable);

  const pgAuto = await pgQuery(pgAdmin, "SELECT to_regclass('synapsor_auto.receipts') AS table_name");
  assert(pgAuto[0]?.table_name === "synapsor_auto.receipts", "Postgres auto_migrate did not create the configured receipt table", pgAuto);
  const mysqlAuto = await mysqlQuery(mysqlAdmin, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'synapsor_fleet' AND TABLE_NAME = 'synapsor_receipts_auto'");
  assert(mysqlAuto.length === 1, "MySQL auto_migrate did not create the configured receipt table", mysqlAuto);

  const pgCanCreate = await pgQuery(pgAdmin, "SELECT has_schema_privilege('synapsor_crud_ledger', 'public', 'CREATE') AS can_create");
  assert(pgCanCreate[0]?.can_create === false, "Postgres ledger writer unexpectedly has CREATE", pgCanCreate);
  const mysqlGrants = await mysqlQuery(mysqlAdmin, "SHOW GRANTS FOR 'synapsor_crud_ledger'@'%'");
  assert(!JSON.stringify(mysqlGrants).match(/\bCREATE\b/i), "MySQL ledger writer unexpectedly has CREATE", mysqlGrants);
}

async function main() {
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "mysql"], { inherit: true });
  await waitForDatabases();
  const pgAdmin = new Pool({ connectionString: pgAdminUrl, max: 6 });
  const mysqlAdmin = await mysql.createConnection(mysqlAdminUrl);
  try {
    for (const [engine, admin] of [["postgres", pgAdmin], ["mysql", mysqlAdmin]]) {
      console.log(`== ${engine}: receipt modes and guarded CRUD ==`);
      await verifyModeMatrix(engine, admin);
      console.log(`== ${engine}: tenant/version/crash/concurrency guards ==`);
      await verifyGuards(engine, admin);
      await verifyCrashWindows(engine, admin);
      await verifyConcurrentApply(engine, admin);
      console.log(`== ${engine}: DELETE side-effect preflight ==`);
      await verifyDeleteHazards(engine, admin);
    }
    await verifyReceiptBoundaries(pgAdmin, mysqlAdmin);
    console.log("Guarded CRUD live verification passed: Postgres + MySQL, all receipt modes, retry, crash, concurrency, and DELETE hazards.");
  } finally {
    await mysqlAdmin.end().catch(() => undefined);
    await pgAdmin.end().catch(() => undefined);
    run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  process.exitCode = 1;
});
