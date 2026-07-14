import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
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
import { compileAgentDsl } from "../packages/dsl/dist/index.js";
import { createMcpRuntime, loadRuntimeConfigFromFile } from "../packages/mcp-server/dist/index.js";
import {
  PostgresWritebackIntentStore,
  ProposalStore,
} from "../packages/proposal-store/dist/index.js";
import { parseWritebackJob } from "../packages/protocol/dist/index.js";
import { normalizeContract } from "../packages/spec/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "examples", "runner-fleet", "docker-compose.yml");
const pgAdminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const mysqlAdminUrl = "mysql://root:root_password@127.0.0.1:53309/synapsor_fleet";
const intentLedgerUrl = pgAdminUrl;
const { Pool } = pg;

const engines = {
  postgres: {
    schema: "public",
    writerUrl: "postgresql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:55439/synapsor_fleet",
    ledgerWriterUrl: "postgresql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:55439/synapsor_fleet",
    apply: applyPostgresJob,
    inspect: inspectPostgresWritebackSource,
  },
  mysql: {
    schema: "synapsor_fleet",
    writerUrl: "mysql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:53309/synapsor_fleet",
    ledgerWriterUrl: "mysql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:53309/synapsor_fleet",
    apply: applyMysqlJob,
    inspect: inspectMysqlWritebackSource,
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
  throw new Error("bounded-set databases did not become ready");
}

function sha(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function scalarRow(row) {
  return {
    // Preserve the driver's native primary-key representation. PostgreSQL
    // intentionally returns bigint as text to avoid precision loss.
    id: row.id,
    tenant_id: String(row.tenant_id),
    request_id: String(row.request_id),
    status: String(row.status),
    note: String(row.note),
    value_cents: Number(row.value_cents),
    version: Number(row.version),
  };
}

function setMember(operation, row, patch = { status: "closed" }) {
  const before = scalarRow(row);
  const primaryKey = { column: "id", value: before.id };
  const expectedVersion = { column: "version", value: before.version };
  if (operation === "set_delete") {
    return {
      primary_key: primaryKey,
      expected_version: expectedVersion,
      before,
      after: {},
      before_digest: sha({ primary_key: before.id, before }),
      tombstone_digest: sha({ primary_key: before.id, expected_version: expectedVersion }),
    };
  }
  const after = { ...before, ...patch, version: before.version + 1 };
  return {
    primary_key: primaryKey,
    expected_version: expectedVersion,
    before,
    after,
    before_digest: sha({ primary_key: before.id, before }),
    after_digest: sha({ primary_key: before.id, after }),
  };
}

function setJob(engine, operation, label, rows, options = {}) {
  const patch = operation === "set_update" ? (options.patch ?? { status: "closed" }) : {};
  const members = rows
    .map((row) => setMember(operation, row, patch))
    .sort((left, right) => JSON.stringify(left.primary_key.value).localeCompare(JSON.stringify(right.primary_key.value)));
  const actual = members.reduce((total, member) => total + Math.abs(Number(member.before.value_cents)), 0);
  const aggregateBounds = [{
    column: "value_cents",
    measure: "before",
    maximum: options.aggregateMaximum ?? actual,
    actual,
  }];
  return parseWritebackJob({
    schema_version: "synapsor.writeback-job.v3",
    writeback_job_id: `wbj_${engine}_${label}`,
    proposal_id: `wrp_${engine}_${label}`,
    proposal_version: 1,
    proposal_hash: sha({ engine, label, operation }),
    runner_scope: { project_id: "bounded-set-live", source_id: `source_${engine}` },
    engine,
    operation,
    target: { schema: engines[engine].schema, table: "bounded_set_items", primary_key: { column: "id" } },
    tenant_guard: { column: "tenant_id", value: "acme" },
    allowed_columns: operation === "set_update" ? Object.keys(patch) : [],
    patch,
    ...(operation === "set_update" ? { version_advance: { column: "version", strategy: "integer_increment" } } : {}),
    frozen_set: {
      max_rows: options.maxRows ?? members.length,
      row_count: members.length,
      aggregate_bounds: aggregateBounds,
      members,
      set_digest: sha({ operation, members, aggregate_bounds: aggregateBounds }),
    },
    idempotency_key: `idem_${engine}_${label}`,
    lease: { lease_id: `lease_${engine}_${label}`, attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
}

function batchInsertJob(engine, label, items, options = {}) {
  const members = items.map((item) => {
    const after = {
      id: item.id,
      tenant_id: "acme",
      external_id: item.external_id,
      amount_cents: item.amount_cents,
      reason: item.reason ?? "reviewed",
    };
    return {
      primary_key: { column: "id", value: item.id },
      before: {},
      after,
      after_digest: sha({ primary_key: item.id, after }),
      deduplication: { components: [
        { column: "tenant_id", value: "acme", source: "trusted_tenant" },
        { column: "id", value: item.id, source: "fixed" },
        { column: "external_id", value: item.external_id, source: "fixed" },
      ] },
    };
  }).sort((left, right) => JSON.stringify(left.primary_key.value).localeCompare(JSON.stringify(right.primary_key.value)));
  const actual = members.reduce((total, member) => total + Math.abs(Number(member.after.amount_cents)), 0);
  const aggregateBounds = [{ column: "amount_cents", measure: "after", maximum: options.aggregateMaximum ?? actual, actual }];
  return parseWritebackJob({
    schema_version: "synapsor.writeback-job.v3",
    writeback_job_id: `wbj_${engine}_${label}`,
    proposal_id: `wrp_${engine}_${label}`,
    proposal_version: 1,
    proposal_hash: sha({ engine, label, operation: "batch_insert" }),
    runner_scope: { project_id: "bounded-set-live", source_id: `source_${engine}` },
    engine,
    operation: "batch_insert",
    target: { schema: engines[engine].schema, table: "bounded_set_credits", primary_key: { column: "id" } },
    tenant_guard: { column: "tenant_id", value: "acme" },
    allowed_columns: ["amount_cents", "reason"],
    patch: {},
    frozen_set: {
      max_rows: options.maxRows ?? members.length,
      row_count: members.length,
      aggregate_bounds: aggregateBounds,
      members,
      set_digest: sha({ operation: "batch_insert", members, aggregate_bounds: aggregateBounds }),
    },
    idempotency_key: `idem_${engine}_${label}`,
    lease: { lease_id: `lease_${engine}_${label}`, attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
}

function sourceConfig(engine, overrides = {}) {
  return {
    controlPlaneUrl: "http://127.0.0.1:1",
    runnerToken: "synthetic-local-token",
    runnerId: `bounded-set-${engine}`,
    sourceId: `source_${engine}`,
    databaseUrl: engines[engine].writerUrl,
    engine,
    pollIntervalMs: 1000,
    statementTimeoutMs: 5000,
    logLevel: "error",
    dryRun: false,
    stateDir: ".synapsor/test-state",
    receipts: engine === "postgres"
      ? { authority: "source_db", provisioning: "precreated", schema: "synapsor_precreated", table: "receipts" }
      : { authority: "source_db", provisioning: "precreated", schema: "synapsor_fleet", table: "synapsor_receipts_precreated" },
    ...overrides,
  };
}

async function intentStore(schema) {
  return new PostgresWritebackIntentStore({
    pool: new Pool({ connectionString: intentLedgerUrl, max: 4 }),
    schema,
    autoMigrate: true,
    closePool: true,
  });
}

async function query(engine, admin, sql, values = []) {
  if (engine === "postgres") return (await admin.query(sql, values)).rows;
  const [rows] = await admin.query(sql, values);
  return Array.isArray(rows) ? rows : [];
}

async function rowsByIds(engine, admin, ids) {
  if (engine === "postgres") {
    return await query(engine, admin, "SELECT id, tenant_id, request_id, status, note, value_cents, version FROM public.bounded_set_items WHERE id = ANY($1::bigint[]) ORDER BY id", [ids]);
  }
  return await query(engine, admin, `SELECT id, tenant_id, request_id, status, note, value_cents, version FROM bounded_set_items WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
}

async function setupEngine(engine, admin) {
  if (engine === "postgres") {
    await query(engine, admin, "DROP TABLE IF EXISTS public.bounded_set_dependents");
    await query(engine, admin, "DROP TABLE IF EXISTS public.bounded_set_credits");
    await query(engine, admin, "DROP TABLE IF EXISTS public.service_tickets");
    await query(engine, admin, "DROP TABLE IF EXISTS public.bounded_set_items");
    await query(engine, admin, `CREATE TABLE public.bounded_set_items (
      id bigint PRIMARY KEY,
      tenant_id text NOT NULL,
      request_id text NOT NULL,
      status text NOT NULL,
      note text NOT NULL,
      value_cents integer NOT NULL,
      version bigint NOT NULL,
      UNIQUE (tenant_id, request_id)
    )`);
    await query(engine, admin, `CREATE TABLE public.bounded_set_credits (
      id bigint PRIMARY KEY,
      tenant_id text NOT NULL,
      external_id text NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents <= 10000),
      reason text NOT NULL,
      UNIQUE (tenant_id, external_id)
    )`);
    await query(engine, admin, `CREATE TABLE public.service_tickets (
      id bigint PRIMARY KEY,
      tenant_id text NOT NULL,
      status text NOT NULL,
      cost_cents integer NOT NULL,
      version integer NOT NULL
    )`);
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON public.bounded_set_items, public.bounded_set_credits, public.service_tickets TO synapsor_crud_precreated, synapsor_crud_ledger");
  } else {
    await query(engine, admin, "SET FOREIGN_KEY_CHECKS = 0");
    await query(engine, admin, "DROP TABLE IF EXISTS bounded_set_dependents");
    await query(engine, admin, "DROP TABLE IF EXISTS bounded_set_credits");
    await query(engine, admin, "DROP TABLE IF EXISTS service_tickets");
    await query(engine, admin, "DROP TABLE IF EXISTS bounded_set_items");
    await query(engine, admin, "SET FOREIGN_KEY_CHECKS = 1");
    await query(engine, admin, `CREATE TABLE bounded_set_items (
      id bigint PRIMARY KEY,
      tenant_id varchar(128) NOT NULL,
      request_id varchar(128) NOT NULL,
      status varchar(64) NOT NULL,
      note varchar(256) NOT NULL,
      value_cents integer NOT NULL,
      version bigint NOT NULL,
      UNIQUE KEY bounded_set_items_tenant_request (tenant_id, request_id)
    )`);
    await query(engine, admin, `CREATE TABLE bounded_set_credits (
      id bigint PRIMARY KEY,
      tenant_id varchar(128) NOT NULL,
      external_id varchar(128) NOT NULL,
      amount_cents integer NOT NULL CHECK (amount_cents <= 10000),
      reason varchar(500) NOT NULL,
      UNIQUE KEY bounded_set_credits_tenant_external (tenant_id, external_id)
    )`);
    await query(engine, admin, `CREATE TABLE service_tickets (
      id bigint PRIMARY KEY,
      tenant_id varchar(128) NOT NULL,
      status varchar(64) NOT NULL,
      cost_cents integer NOT NULL,
      version integer NOT NULL
    )`);
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.bounded_set_items TO 'synapsor_crud_precreated'@'%'");
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.bounded_set_items TO 'synapsor_crud_ledger'@'%'");
    await query(engine, admin, "GRANT TRIGGER ON synapsor_fleet.bounded_set_items TO 'synapsor_crud_precreated'@'%'");
    await query(engine, admin, "GRANT TRIGGER ON synapsor_fleet.bounded_set_items TO 'synapsor_crud_ledger'@'%'");
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.bounded_set_credits TO 'synapsor_crud_precreated'@'%'");
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.bounded_set_credits TO 'synapsor_crud_ledger'@'%'");
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.service_tickets TO 'synapsor_crud_precreated'@'%'");
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.service_tickets TO 'synapsor_crud_ledger'@'%'");
  }

  const ids = [
    3001, 3002, 3011, 3012, 3021, 3022, 3031, 3032,
    3041, 3042, 3051, 3052, 3061, 3062, 3071, 3072,
    3081, 3082, 3091, 3092, 3101, 3102, 3111, 3112,
    3301, 3302, 3303, 3311, 3312,
    ...Array.from({ length: 111 }, (_, index) => 4001 + index),
  ];
  for (const id of ids) {
    const value = id === 3311 || id === 3312 ? 600 : (id % 100) + 1;
    const sql = engine === "postgres"
      ? "INSERT INTO public.bounded_set_items (id, tenant_id, request_id, status, note, value_cents, version) VALUES ($1, $2, $3, $4, $5, $6, $7)"
      : "INSERT INTO bounded_set_items (id, tenant_id, request_id, status, note, value_cents, version) VALUES (?, ?, ?, ?, ?, ?, ?)";
    await query(engine, admin, sql, [id, "acme", `req-${id}`, "open", "original", value, 1]);
  }
  const wrongTenantSql = engine === "postgres"
    ? "INSERT INTO public.bounded_set_items (id, tenant_id, request_id, status, note, value_cents, version) VALUES ($1, $2, $3, $4, $5, $6, $7)"
    : "INSERT INTO bounded_set_items (id, tenant_id, request_id, status, note, value_cents, version) VALUES (?, ?, ?, ?, ?, ?, ?)";
  await query(engine, admin, wrongTenantSql, [3999, "globex", "req-globex", "open", "original", 9999, 1]);
  const ticketInsert = engine === "postgres"
    ? "INSERT INTO public.service_tickets (id, tenant_id, status, cost_cents, version) VALUES ($1, $2, $3, $4, $5)"
    : "INSERT INTO service_tickets (id, tenant_id, status, cost_cents, version) VALUES (?, ?, ?, ?, ?)";
  for (const row of [
    [3, "acme", "closed", 8000, 1],
    [4, "acme", "closed", 15000, 1],
    [13, "acme", "closed", 8000, 1],
    [14, "acme", "closed", 15000, 1],
    [99, "globex", "overdue", 49000, 1],
  ]) await query(engine, admin, ticketInsert, row);
}

async function serviceTickets(engine, admin, ids) {
  if (engine === "postgres") return await query(engine, admin, "SELECT id, tenant_id, status, cost_cents, version FROM public.service_tickets WHERE id = ANY($1::bigint[]) ORDER BY id", [ids]);
  return await query(engine, admin, `SELECT id, tenant_id, status, cost_cents, version FROM service_tickets WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
}

async function verifyContractAuthoredHappyPath(engine, admin, authority) {
  const ids = authority === "source_db" ? [3, 4] : [13, 14];
  const resetSql = engine === "postgres"
    ? "UPDATE public.service_tickets SET status = CASE WHEN id = ANY($1::bigint[]) THEN 'overdue' ELSE 'closed' END, version = 1 WHERE tenant_id = 'acme'"
    : `UPDATE service_tickets SET status = CASE WHEN id IN (${ids.map(() => "?").join(",")}) THEN 'overdue' ELSE 'closed' END, version = 1 WHERE tenant_id = 'acme'`;
  await query(engine, admin, resetSql, engine === "postgres" ? [ids] : ids);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `synapsor-bug-016-${engine}-${authority}-`));
  const contractPath = path.join(tempDir, "synapsor.contract.json");
  const configPath = path.join(tempDir, "synapsor.runner.json");
  const schema = engines[engine].schema;
  const contract = normalizeContract(compileAgentDsl(`
CREATE AGENT CONTEXT local_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY tickets.close_overdue
  USING CONTEXT local_operator
  SOURCE local_db
  ON ${schema}.service_tickets
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD version
  LOOKUP reason BY id
  ARG reason STRING REQUIRED MAX LENGTH 100
  ALLOW READ id, tenant_id, status, cost_cents, version
  REQUIRE EVIDENCE
  PROPOSE ACTION close_overdue UPDATE SET
  SELECT WHERE status = 'overdue'
  MAX ROWS 10
  MAX TOTAL cost_cents BEFORE 50000
  ALLOW WRITE status
  PATCH status = 'closed'
  ADVANCE VERSION version USING INTEGER INCREMENT
  APPROVAL ROLE ops_manager
  WRITEBACK DIRECT SQL
END
`));
  const boundKeys = Object.keys(contract.capabilities[0].proposal.operation.aggregate_bounds[0]);
  assert(boundKeys.join(",") === "column,maximum,measure", `${engine} normalized contract did not reproduce the 1.4.0 aggregate-key order`, boundKeys);
  await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  await fs.writeFile(configPath, `${JSON.stringify({
    version: 1,
    mode: "review",
    storage: { sqlite_path: ":memory:" },
    sources: { local_db: { engine, read_url_env: "SET_READ_URL", write_url_env: "SET_WRITE_URL", statement_timeout_ms: 3000, receipts: authority === "source_db" ? { authority: "source_db", provisioning: "precreated", schema: engine === "postgres" ? "synapsor_precreated" : "synapsor_fleet", table: engine === "postgres" ? "receipts" : "synapsor_receipts_precreated" } : { authority: "runner_ledger" } } },
    contracts: ["./synapsor.contract.json"],
  }, null, 2)}\n`);

  const store = new ProposalStore();
  const runtime = createMcpRuntime(await loadRuntimeConfigFromFile(configPath), {
    env: {
      ...process.env,
      SET_READ_URL: authority === "source_db" ? engines[engine].writerUrl : engines[engine].ledgerWriterUrl,
      SET_WRITE_URL: authority === "source_db" ? engines[engine].writerUrl : engines[engine].ledgerWriterUrl,
      SYNAPSOR_TENANT_ID: "acme",
      SYNAPSOR_PRINCIPAL: "bounded_set_integrator",
    },
    store,
  });
  let intent;
  try {
    const proposed = await runtime.callTool("tickets.close_overdue", { reason: "clean-repro" });
    const proposal = store.getProposal(String(proposed.proposal_id));
    assert(proposal?.change_set?.schema_version === "synapsor.change-set.v3", `${engine} ${authority} did not create a v3 bounded-set proposal`, proposal);
    assert(proposal.change_set.frozen_set.row_count === 2, `${engine} ${authority} did not freeze exactly two tenant members`, proposal.change_set.frozen_set);
    const beforeApproval = await serviceTickets(engine, admin, ids);
    assert(beforeApproval.every((row) => row.status === "overdue" && Number(row.version) === 1), `${engine} ${authority} changed source before approval`, beforeApproval);
    store.approveProposal(proposal.proposal_id, { approver: "ops_manager", proposal_hash: proposal.proposal_hash, proposal_version: 1 });
    const publicJob = store.createWritebackJobFromProposal(proposal.proposal_id, { project_id: "bounded-set-integrator", runner_id: `runner-${engine}-${authority}` });
    const job = parseWritebackJob(publicJob);
    assert(job.protocol_version === "3.0", `${engine} ${authority} did not produce a normalized v3 job`, job);
    const applyConfig = sourceConfig(engine, {
      databaseUrl: authority === "source_db" ? engines[engine].writerUrl : engines[engine].ledgerWriterUrl,
      receipts: authority === "source_db"
        ? sourceConfig(engine).receipts
        : { authority: "runner_ledger" },
      ...(authority === "runner_ledger" ? { writebackIntentStore: await intentStore(`bounded_${engine}_contract_happy`) } : {}),
    });
    intent = applyConfig.writebackIntentStore;
    const applied = await engines[engine].apply(job, applyConfig);
    assert(applied.status === "applied" && applied.affected_rows === 2, `${engine} ${authority} contract-authored bounded set did not apply`, applied);
    const after = await serviceTickets(engine, admin, ids);
    assert(after.every((row) => row.status === "closed" && Number(row.version) === 2), `${engine} ${authority} contract-authored bounded set changed the wrong state`, after);
    const retry = await engines[engine].apply(job, applyConfig);
    assert(retry.status === "already_applied", `${engine} ${authority} contract-authored retry was not idempotent`, retry);
  } finally {
    await runtime.close();
    await store.close();
    await intent?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyProposalBounds(engine, admin) {
  const capRows = (await rowsByIds(engine, admin, [3301, 3302, 3303])).map(scalarRow);
  const aggregateRows = (await rowsByIds(engine, admin, [3311, 3312])).map(scalarRow);
  for (const [label, rows, maxRows, maximum, expectedCode] of [
    ["cap", capRows, 2, 10000, "SET_ROW_CAP_EXCEEDED"],
    ["aggregate", aggregateRows, 2, 1000, "SET_AGGREGATE_BOUND_EXCEEDED"],
  ]) {
    const store = new ProposalStore();
    const runtime = createMcpRuntime({
      version: 1,
      mode: "review",
      storage: { sqlite_path: ":memory:" },
      sources: { app_db: { engine, read_url_env: "SET_READ_URL", write_url_env: "SET_WRITE_URL", statement_timeout_ms: 3000 } },
      trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "bounded_set_test" } },
      capabilities: [{
        name: "billing.close_bounded_items",
        kind: "proposal",
        source: "app_db",
        target: { schema: engines[engine].schema, table: "bounded_set_items", primary_key: "id", tenant_key: "tenant_id" },
        args: { reason: { type: "string", required: true, max_length: 100 } },
        lookup: { id_from_arg: "reason" },
        visible_columns: ["id", "tenant_id", "request_id", "status", "value_cents", "version"],
        evidence: "required",
        patch: { status: { fixed: "closed" } },
        allowed_columns: ["status"],
        operation: {
          kind: "update",
          cardinality: "set",
          selection: { all: [{ column: "status", operator: "eq", value: "open" }] },
          max_rows: maxRows,
          aggregate_bounds: [{ column: "value_cents", measure: "before", maximum }],
          version_advance: { column: "version", strategy: "integer_increment" },
        },
        conflict_guard: { column: "version" },
        approval: { mode: "human", required_role: "billing_reviewer" },
        writeback: { mode: "direct_sql" },
      }],
    }, {
      env: { ...process.env, SET_READ_URL: engines[engine].writerUrl, SET_WRITE_URL: engines[engine].writerUrl },
      store,
      readRow: async () => ({ row: rows[0], rows, rowCount: rows.length }),
    });
    try {
      let code;
      try {
        await runtime.callTool("billing.close_bounded_items", { reason: label });
      } catch (error) {
        code = error?.code;
      }
      assert(code === expectedCode, `${engine} ${label} proposal did not reject with ${expectedCode}`, { code });
      assert(store.listProposals().length === 0, `${engine} ${label} overflow persisted a proposal`);
    } finally {
      await runtime.close();
      await store.close();
    }
  }
}

async function verifySetUpdate(engine, admin) {
  const before = await rowsByIds(engine, admin, [3001, 3002]);
  const job = setJob(engine, "set_update", "set_update", before);
  const result = await engines[engine].apply(job, sourceConfig(engine));
  assert(result.status === "applied" && result.affected_rows === 2, `${engine} bounded UPDATE did not apply`, result);
  assert(result.target_identities.length === 2 && result.member_effects.length === 2, `${engine} bounded UPDATE receipt omitted exact members`, result);
  assert(result.member_effects.every((effect) => effect.before_digest && effect.after_digest), `${engine} bounded UPDATE receipt omitted safe digests`, result);
  const after = await rowsByIds(engine, admin, [3001, 3002]);
  assert(after.every((row) => row.status === "closed" && Number(row.version) === 2), `${engine} bounded UPDATE changed the wrong state`, after);
  const retry = await engines[engine].apply(job, sourceConfig(engine));
  assert(retry.status === "already_applied" && retry.affected_rows === 0, `${engine} bounded UPDATE retry was not idempotent`, retry);
}

async function verifyStaleSetRollback(engine, admin) {
  const frozen = await rowsByIds(engine, admin, [3011, 3012]);
  const job = setJob(engine, "set_update", "stale_set", frozen);
  const driftSql = engine === "postgres"
    ? "UPDATE public.bounded_set_items SET version = 2 WHERE id = 3012"
    : "UPDATE bounded_set_items SET version = 2 WHERE id = 3012";
  await query(engine, admin, driftSql);
  const result = await engines[engine].apply(job, sourceConfig(engine));
  assert(result.status === "conflict" && result.error_code === "SET_DRIFT_CONFLICT", `${engine} stale member did not fail closed`, result);
  const after = await rowsByIds(engine, admin, [3011, 3012]);
  assert(after[0]?.status === "open" && Number(after[0]?.version) === 1, `${engine} stale-set conflict partially changed the first member`, after);
  assert(after[1]?.status === "open" && Number(after[1]?.version) === 2, `${engine} stale-set fixture was unexpectedly mutated`, after);
}

async function verifyReviewedStateDrift(engine, admin) {
  const table = engine === "postgres" ? "public.bounded_set_items" : "bounded_set_items";
  const scenarios = [
    {
      label: "predicate",
      ids: [3081, 3082],
      patch: { note: "reviewed" },
      mutate: `UPDATE ${table} SET status = 'paused' WHERE id = 3082`,
      assertDrift: (row) => row?.status === "paused" && row?.note === "original",
    },
    {
      label: "aggregate",
      ids: [3091, 3092],
      patch: { note: "reviewed" },
      mutate: `UPDATE ${table} SET value_cents = 999 WHERE id = 3092`,
      assertDrift: (row) => Number(row?.value_cents) === 999 && row?.note === "original",
    },
    {
      label: "writable-before",
      ids: [3101, 3102],
      patch: { note: "reviewed" },
      mutate: `UPDATE ${table} SET note = 'changed-externally' WHERE id = 3102`,
      assertDrift: (row) => row?.note === "changed-externally",
    },
    {
      label: "missing-member",
      ids: [3111, 3112],
      patch: { note: "reviewed" },
      mutate: `DELETE FROM ${table} WHERE id = 3112`,
      assertDrift: (row) => row === undefined,
    },
  ];

  for (const scenario of scenarios) {
    const frozen = await rowsByIds(engine, admin, scenario.ids);
    const job = setJob(engine, "set_update", `drift_${scenario.label}`, frozen, { patch: scenario.patch });
    await query(engine, admin, scenario.mutate);
    const result = await engines[engine].apply(job, sourceConfig(engine));
    assert(result.status === "conflict" && result.error_code === "SET_DRIFT_CONFLICT", `${engine} ${scenario.label} drift did not fail closed`, result);
    const after = await rowsByIds(engine, admin, scenario.ids);
    const untouched = after.find((row) => Number(row.id) === scenario.ids[0]);
    const drifted = after.find((row) => Number(row.id) === scenario.ids[1]);
    assert(untouched?.note === "original" && untouched?.status === "open" && Number(untouched?.version) === 1, `${engine} ${scenario.label} drift partially applied the reviewed patch`, after);
    assert(scenario.assertDrift(drifted), `${engine} ${scenario.label} drift was overwritten or misclassified`, after);
  }
}

async function verifyTenantDrift(engine, admin) {
  const ids = [3071, 3072];
  const frozen = await rowsByIds(engine, admin, ids);
  const job = setJob(engine, "set_update", "tenant_drift", frozen, { patch: { note: "reviewed" } });
  const table = engine === "postgres" ? "public.bounded_set_items" : "bounded_set_items";
  await query(engine, admin, `UPDATE ${table} SET tenant_id = 'globex' WHERE id = 3072`);
  const result = await engines[engine].apply(job, sourceConfig(engine));
  assert(result.status === "conflict" && result.error_code === "SET_DRIFT_CONFLICT", `${engine} tenant drift did not fail closed`, result);
  const after = await rowsByIds(engine, admin, ids);
  assert(after.every((row) => row.note === "original" && row.status === "open" && Number(row.version) === 1), `${engine} tenant drift partially applied the reviewed patch`, after);
  assert(after.find((row) => Number(row.id) === 3072)?.tenant_id === "globex", `${engine} tenant drift fixture was overwritten`, after);
}

async function verifyMidSetRollback(engine, admin) {
  if (engine === "postgres") {
    await query(engine, admin, "CREATE FUNCTION public.bounded_set_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 3022 THEN RAISE EXCEPTION 'synthetic bounded-set failure'; END IF; RETURN NEW; END $$");
    await query(engine, admin, "CREATE TRIGGER bounded_set_update_guard BEFORE UPDATE ON public.bounded_set_items FOR EACH ROW EXECUTE FUNCTION public.bounded_set_update_guard()")
  } else {
    await query(engine, admin, "CREATE TRIGGER bounded_set_update_guard BEFORE UPDATE ON bounded_set_items FOR EACH ROW BEGIN IF NEW.id = 3022 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic bounded-set failure'; END IF; END");
  }
  try {
    const before = await rowsByIds(engine, admin, [3021, 3022]);
    const result = await engines[engine].apply(setJob(engine, "set_update", "mid_set_failure", before), sourceConfig(engine));
    assert(result.status === "failed", `${engine} injected mid-set failure was not reported as failed`, result);
    const after = await rowsByIds(engine, admin, [3021, 3022]);
    assert(after.every((row) => row.status === "open" && Number(row.version) === 1), `${engine} mid-set failure did not roll back every row`, after);
  } finally {
    if (engine === "postgres") {
      await query(engine, admin, "DROP TRIGGER bounded_set_update_guard ON public.bounded_set_items");
      await query(engine, admin, "DROP FUNCTION public.bounded_set_update_guard()")
    } else {
      await query(engine, admin, "DROP TRIGGER bounded_set_update_guard");
    }
  }
}

async function verifySetDelete(engine, admin) {
  const before = await rowsByIds(engine, admin, [3031, 3032]);
  const job = setJob(engine, "set_delete", "set_delete", before);
  const result = await engines[engine].apply(job, sourceConfig(engine));
  assert(result.status === "applied" && result.affected_rows === 2, `${engine} bounded DELETE did not apply`, result);
  assert(result.member_effects.every((effect) => effect.before_digest && effect.tombstone_digest), `${engine} bounded DELETE receipt omitted tombstones`, result);
  assert((await rowsByIds(engine, admin, [3031, 3032])).length === 0, `${engine} bounded DELETE left target rows`);
  const retry = await engines[engine].apply(job, sourceConfig(engine));
  assert(retry.status === "already_applied", `${engine} bounded DELETE retry was not idempotent`, retry);
}

async function verifyDeleteHazards(engine, admin) {
  if (engine === "postgres") {
    await query(engine, admin, "CREATE FUNCTION public.bounded_set_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$");
    await query(engine, admin, "CREATE TRIGGER bounded_set_delete_guard BEFORE DELETE ON public.bounded_set_items FOR EACH ROW EXECUTE FUNCTION public.bounded_set_delete_guard()")
  } else {
    await query(engine, admin, "CREATE TRIGGER bounded_set_delete_guard BEFORE DELETE ON bounded_set_items FOR EACH ROW SET @bounded_set_delete_seen = OLD.id");
  }
  try {
    const rows = await rowsByIds(engine, admin, [3041, 3042]);
    const result = await engines[engine].apply(setJob(engine, "set_delete", "delete_trigger", rows), sourceConfig(engine));
    assert(result.status === "failed" && result.error_code === "DELETE_TRIGGER_BLOCKED", `${engine} bounded DELETE trigger was not rejected`, result);
    assert((await rowsByIds(engine, admin, [3041, 3042])).length === 2, `${engine} trigger-blocked DELETE changed source rows`);
  } finally {
    if (engine === "postgres") {
      await query(engine, admin, "DROP TRIGGER bounded_set_delete_guard ON public.bounded_set_items");
      await query(engine, admin, "DROP FUNCTION public.bounded_set_delete_guard()")
    } else {
      await query(engine, admin, "DROP TRIGGER bounded_set_delete_guard");
    }
  }

  if (engine === "postgres") {
    await query(engine, admin, "CREATE TABLE public.bounded_set_dependents (id bigint PRIMARY KEY, item_id bigint NOT NULL REFERENCES public.bounded_set_items(id) ON DELETE CASCADE)");
    await query(engine, admin, "INSERT INTO public.bounded_set_dependents (id, item_id) VALUES (1, 3051)");
  } else {
    await query(engine, admin, "CREATE TABLE bounded_set_dependents (id bigint PRIMARY KEY, item_id bigint NOT NULL, CONSTRAINT bounded_set_item_fk FOREIGN KEY (item_id) REFERENCES bounded_set_items(id) ON DELETE CASCADE)");
    await query(engine, admin, "INSERT INTO bounded_set_dependents (id, item_id) VALUES (1, 3051)");
  }
  const rows = await rowsByIds(engine, admin, [3051, 3052]);
  const result = await engines[engine].apply(setJob(engine, "set_delete", "delete_cascade", rows), sourceConfig(engine));
  assert(result.status === "failed" && result.error_code === "DELETE_CASCADE_BLOCKED", `${engine} bounded DELETE cascade was not rejected`, result);
  assert((await rowsByIds(engine, admin, [3051, 3052])).length === 2, `${engine} cascade-blocked DELETE changed source rows`);
}

async function creditRows(engine, admin, ids) {
  if (engine === "postgres") return await query(engine, admin, "SELECT id, tenant_id, external_id, amount_cents, reason FROM public.bounded_set_credits WHERE id = ANY($1::bigint[]) ORDER BY id", [ids]);
  return await query(engine, admin, `SELECT id, tenant_id, external_id, amount_cents, reason FROM bounded_set_credits WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id`, ids);
}

async function verifyBatchInsert(engine, admin) {
  const job = batchInsertJob(engine, "batch_insert", [
    { id: 6001, external_id: "ext-6001", amount_cents: 500 },
    { id: 6002, external_id: "ext-6002", amount_cents: 1500 },
  ]);
  const result = await engines[engine].apply(job, sourceConfig(engine));
  assert(result.status === "applied" && result.affected_rows === 2 && result.member_effects.length === 2, `${engine} batch INSERT did not apply exactly`, result);
  assert((await creditRows(engine, admin, [6001, 6002])).length === 2, `${engine} batch INSERT omitted source rows`);
  const retry = await engines[engine].apply(job, sourceConfig(engine));
  assert(retry.status === "already_applied", `${engine} batch INSERT retry was not idempotent`, retry);

  const preinsertSql = engine === "postgres"
    ? "INSERT INTO public.bounded_set_credits (id, tenant_id, external_id, amount_cents, reason) VALUES ($1, $2, $3, $4, $5)"
    : "INSERT INTO bounded_set_credits (id, tenant_id, external_id, amount_cents, reason) VALUES (?, ?, ?, ?, ?)";
  await query(engine, admin, preinsertSql, [6012, "acme", "ext-duplicate", 100, "existing"]);
  const duplicate = batchInsertJob(engine, "batch_duplicate", [
    { id: 6011, external_id: "ext-6011", amount_cents: 100 },
    { id: 6012, external_id: "ext-duplicate", amount_cents: 100 },
  ]);
  const duplicateResult = await engines[engine].apply(duplicate, sourceConfig(engine));
  assert(duplicateResult.status === "conflict" && duplicateResult.error_code === "INSERT_DEDUP_CONFLICT", `${engine} batch dedup conflict was not rejected`, duplicateResult);
  assert((await creditRows(engine, admin, [6011])).length === 0, `${engine} batch dedup preflight partially inserted a row`);

  const constraint = batchInsertJob(engine, "batch_atomicity", [
    { id: 6021, external_id: "ext-6021", amount_cents: 100 },
    { id: 6022, external_id: "ext-6022", amount_cents: 15000 },
  ], { aggregateMaximum: 20000 });
  const constraintResult = await engines[engine].apply(constraint, sourceConfig(engine));
  assert(constraintResult.status === "failed", `${engine} batch constraint failure was not reported`, constraintResult);
  assert((await creditRows(engine, admin, [6021, 6022])).length === 0, `${engine} batch constraint failure did not roll back every insert`);
}

async function verifyRunnerLedgerAmbiguity(engine, admin) {
  const store = await intentStore(`bounded_${engine}_ambiguity`);
  try {
    const rows = await rowsByIds(engine, admin, [3061, 3062]);
    const job = setJob(engine, "set_update", "ledger_ambiguity", rows);
    const config = sourceConfig(engine, {
      databaseUrl: engines[engine].ledgerWriterUrl,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: store,
      testFailpoint: (point) => {
        if (point === "after_source_commit") throw new Error("synthetic process loss after source COMMIT");
      },
    });
    const result = await engines[engine].apply(job, config);
    assert(result.status === "reconciliation_required" && result.error_code === "RECONCILIATION_REQUIRED", `${engine} post-COMMIT set ambiguity was not explicit`, result);
    const after = await rowsByIds(engine, admin, [3061, 3062]);
    assert(after.every((row) => row.status === "closed" && Number(row.version) === 2), `${engine} ambiguous set did not commit atomically`, after);
    const observation = await engines[engine].inspect(job, engines[engine].ledgerWriterUrl);
    assert(observation.classification === "matches_proposed" && observation.member_observations?.length === 2, `${engine} set reconciliation did not inspect every frozen member`, observation);
    const retry = await engines[engine].apply(job, sourceConfig(engine, {
      databaseUrl: engines[engine].ledgerWriterUrl,
      receipts: { authority: "runner_ledger" },
      writebackIntentStore: store,
    }));
    assert(retry.status === "reconciliation_required", `${engine} ambiguous set retry crossed the source boundary`, retry);
  } finally {
    await store.close();
  }
}

async function benchmark(engine, admin) {
  const results = [];
  let offset = 0;
  for (const count of [1, 10, 100]) {
    const ids = Array.from({ length: count }, (_, index) => 4001 + offset + index);
    offset += count;
    const rows = await rowsByIds(engine, admin, ids);
    const job = setJob(engine, "set_update", `benchmark_${count}`, rows, { maxRows: count });
    const started = performance.now();
    const result = await engines[engine].apply(job, sourceConfig(engine));
    const elapsedMs = performance.now() - started;
    assert(result.status === "applied" && result.affected_rows === count, `${engine} ${count}-row benchmark failed`, result);
    results.push({ rows: count, elapsed_ms: Number(elapsedMs.toFixed(2)) });
  }
  return results;
}

async function main() {
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "mysql"], { inherit: true });
  await waitForDatabases();
  const pgAdmin = new Pool({ connectionString: pgAdminUrl, max: 8 });
  const mysqlAdmin = await mysql.createConnection(mysqlAdminUrl);
  const benchmarkResults = {};
  try {
    for (const [engine, admin] of [["postgres", pgAdmin], ["mysql", mysqlAdmin]]) {
      console.log(`== ${engine}: setup and proposal-time bounds ==`);
      await setupEngine(engine, admin);
      console.log(`== ${engine}: contract-authored BUG-016 happy path ==`);
      await verifyContractAuthoredHappyPath(engine, admin, "source_db");
      await verifyContractAuthoredHappyPath(engine, admin, "runner_ledger");
      await verifyProposalBounds(engine, admin);
      console.log(`== ${engine}: exact set UPDATE, drift, and rollback ==`);
      await verifySetUpdate(engine, admin);
      await verifyStaleSetRollback(engine, admin);
      await verifyReviewedStateDrift(engine, admin);
      await verifyTenantDrift(engine, admin);
      await verifyMidSetRollback(engine, admin);
      console.log(`== ${engine}: exact set DELETE and side-effect preflight ==`);
      await verifySetDelete(engine, admin);
      await verifyDeleteHazards(engine, admin);
      console.log(`== ${engine}: exact batch INSERT and dedup/atomicity ==`);
      await verifyBatchInsert(engine, admin);
      console.log(`== ${engine}: runner-ledger ambiguity and reconciliation ==`);
      await verifyRunnerLedgerAmbiguity(engine, admin);
      console.log(`== ${engine}: local 1/10/100-row timings ==`);
      benchmarkResults[engine] = await benchmark(engine, admin);
    }
    console.log(JSON.stringify({ benchmark_environment: "local Docker; evidence only, not a throughput claim", results: benchmarkResults }, null, 2));
    console.log("Bounded-set live verification passed: contract-authored PostgreSQL + MySQL apply under source_db and runner_ledger authority, canonical/legacy digest compatibility, cap and aggregate rejection, independent version/predicate/aggregate/writable-value/missing-member/tenant drift, frozen UPDATE/DELETE, batch INSERT, atomic rollback, hazards, exact receipts, reconciliation, and 1/10/100-row bounds.");
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
