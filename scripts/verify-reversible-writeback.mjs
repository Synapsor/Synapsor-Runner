import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "../packages/postgres/node_modules/pg/lib/index.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import { main as runnerMain } from "../apps/runner/dist/runner.mjs";
import { applyPostgresJob } from "../packages/postgres/dist/index.js";
import { applyMysqlJob } from "../packages/mysql/dist/index.js";
import { ProposalStore } from "../packages/proposal-store/dist/index.js";
import { parseWritebackJob } from "../packages/protocol/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "examples", "runner-fleet", "docker-compose.yml");
const pgAdminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const mysqlAdminUrl = "mysql://root:root_password@127.0.0.1:53309/synapsor_fleet";
const { Pool } = pg;

const engines = {
  postgres: {
    schema: "public",
    sourceKind: "external_postgres",
    apply: applyPostgresJob,
    writerUrl: "postgresql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:55439/synapsor_fleet",
    receipts: { authority: "source_db", provisioning: "precreated", schema: "synapsor_precreated", table: "receipts" },
  },
  mysql: {
    schema: "synapsor_fleet",
    sourceKind: "external_mysql",
    apply: applyMysqlJob,
    writerUrl: "mysql://synapsor_crud_precreated:synapsor_crud_precreated_password@127.0.0.1:53309/synapsor_fleet",
    receipts: { authority: "source_db", provisioning: "precreated", schema: "synapsor_fleet", table: "synapsor_receipts_precreated" },
  },
};

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe" });
  if (!options.allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result;
}

async function waitForDatabases() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const pgReady = run("docker", ["compose", "-f", composeFile, "exec", "-T", "postgres", "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet"], { allowFailure: true });
    const mysqlReady = run("docker", ["compose", "-f", composeFile, "exec", "-T", "mysql", "mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password"], { allowFailure: true });
    if (pgReady.status === 0 && mysqlReady.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("reversible writeback databases did not become ready");
}

function sha(value) {
  return `sha256:${crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
}

async function query(engine, admin, sql, values = []) {
  if (engine === "postgres") return (await admin.query(sql, values)).rows;
  const [rows] = await admin.query(sql, values);
  return Array.isArray(rows) ? rows : [];
}

async function setupEngine(engine, admin) {
  const schema = engines[engine].schema;
  if (engine === "postgres") {
    await query(engine, admin, "DROP TABLE IF EXISTS public.reversible_items");
    await query(engine, admin, `CREATE TABLE public.reversible_items (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      status text NOT NULL,
      amount_cents integer NOT NULL,
      reason text,
      deleted_at text,
      version bigint NOT NULL DEFAULT 1,
      internal_note text NOT NULL DEFAULT 'kept-out'
    )`);
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON public.reversible_items TO synapsor_crud_precreated");
  } else {
    await query(engine, admin, "DROP TABLE IF EXISTS reversible_items");
    await query(engine, admin, `CREATE TABLE reversible_items (
      id varchar(128) PRIMARY KEY,
      tenant_id varchar(128) NOT NULL,
      status varchar(64) NOT NULL,
      amount_cents integer NOT NULL,
      reason varchar(500),
      deleted_at varchar(64),
      version bigint NOT NULL DEFAULT 1,
      internal_note varchar(500) NOT NULL DEFAULT 'kept-out'
    )`);
    await query(engine, admin, "GRANT SELECT, INSERT, UPDATE, DELETE ON synapsor_fleet.reversible_items TO 'synapsor_crud_precreated'@'%'");
    await query(engine, admin, "GRANT TRIGGER ON synapsor_fleet.reversible_items TO 'synapsor_crud_precreated'@'%'");
    await query(engine, admin, "GRANT PROCESS ON *.* TO 'synapsor_crud_precreated'@'%'");
  }
  for (const [id, amount] of [["update-1", 100], ["soft-delete-1", 200], ["stale-1", 300], ["hard-delete-1", 400], ["set-1", 501], ["set-2", 502], ["set-stale-1", 601], ["set-stale-2", 602]]) {
    const sql = engine === "postgres"
      ? `INSERT INTO ${schema}.reversible_items (id, tenant_id, status, amount_cents, version) VALUES ($1, $2, $3, $4, $5)`
      : "INSERT INTO reversible_items (id, tenant_id, status, amount_cents, version) VALUES (?, ?, ?, ?, ?)";
    await query(engine, admin, sql, [id, "acme", "active", amount, 1]);
  }
}

async function row(engine, admin, id) {
  const sql = engine === "postgres"
    ? "SELECT id, tenant_id, status, amount_cents, reason, deleted_at, version, internal_note FROM public.reversible_items WHERE id = $1"
    : "SELECT id, tenant_id, status, amount_cents, reason, deleted_at, version, internal_note FROM reversible_items WHERE id = ?";
  return (await query(engine, admin, sql, [id]))[0];
}

function capability(name, operation, allowedColumns) {
  const operationConfig = operation === "insert"
    ? { kind: "insert", deduplication: { components: [{ column: "tenant_id", source: "trusted_tenant" }, { column: "id", source: "proposal_id" }] } }
    : operation === "delete"
      ? { kind: "delete" }
      : { kind: "update", version_advance: { column: "version", strategy: "integer_increment" } };
  const writeArgs = name === "billing.adjust_credit"
    ? { amount_cents: { type: "number", required: true, minimum: 0, maximum: 2500 } }
    : name === "billing.soft_delete_credit"
      ? { deleted_at: { type: "string", required: true, max_length: 64 } }
      : name === "billing.create_credit"
        ? {
            amount_cents: { type: "number", required: true, minimum: 1, maximum: 2500 },
            reason: { type: "string", required: true, max_length: 500 },
          }
        : {};
  const patch = name === "billing.adjust_credit"
    ? { amount_cents: { from_arg: "amount_cents" } }
    : name === "billing.soft_delete_credit"
      ? { status: { fixed: "deleted" }, deleted_at: { from_arg: "deleted_at" } }
      : name === "billing.create_credit"
        ? { status: { fixed: "active" }, amount_cents: { from_arg: "amount_cents" }, reason: { from_arg: "reason" } }
        : {};
  return {
    name,
    kind: "proposal",
    source: "reversible_db",
    target: { schema: "__SCHEMA__", table: "reversible_items", primary_key: "id", tenant_key: "tenant_id" },
    args: { item_id: { type: "string", required: true, max_length: 128 }, ...writeArgs },
    lookup: { id_from_arg: "item_id" },
    visible_columns: ["id", "tenant_id", "status", "amount_cents", "reason", "deleted_at", "version"],
    evidence: "required",
    max_rows: 1,
    patch,
    allowed_columns: allowedColumns,
    ...(operation === "insert" ? {} : { conflict_guard: { column: "version" } }),
    operation: operationConfig,
    approval: { mode: "human", required_role: "billing_reviewer" },
    writeback: { mode: "direct_sql" },
    reversibility: { mode: "reviewed_inverse" },
  };
}

function configFor(engine, storePath) {
  const config = {
    version: 1,
    mode: "review",
    storage: { sqlite_path: storePath },
    sources: {
      reversible_db: {
        engine,
        read_url_env: "REVERSIBLE_DATABASE_URL",
        write_url_env: "REVERSIBLE_DATABASE_URL",
        statement_timeout_ms: 5000,
        receipts: engines[engine].receipts,
      },
    },
    trusted_context: { provider: "static_dev", values: { tenant_id: "acme", principal: "reversible_live_operator" } },
    capabilities: [
      capability("billing.adjust_credit", "update", ["amount_cents"]),
      capability("billing.soft_delete_credit", "update", ["status", "deleted_at"]),
      capability("billing.create_credit", "insert", ["status", "amount_cents", "reason"]),
      capability("billing.hard_delete_credit", "delete", []),
    ],
  };
  for (const item of config.capabilities) item.target.schema = engines[engine].schema;
  return config;
}

function forwardChangeSet(engine, input) {
  const insert = input.operation === "single_row_insert";
  const deleting = input.operation === "single_row_delete";
  const proposalId = `wrp_${engine}_${input.label}`;
  const version = Number(input.before.version ?? 1);
  const after = insert ? input.after : deleting ? {} : { ...input.before, ...input.patch, version: version + 1 };
  delete after.internal_note;
  const before = insert ? {} : { ...input.before };
  delete before.internal_note;
  return {
    schema_version: "synapsor.change-set.v2",
    proposal_id: proposalId,
    proposal_version: 1,
    action: input.action,
    operation: input.operation,
    mode: "review_required",
    principal: { id: "agent_live", source: "trusted_session" },
    scope: { tenant_id: "acme", business_object: "credit", object_id: input.id },
    source: {
      kind: engines[engine].sourceKind,
      source_id: "reversible_db",
      schema: engines[engine].schema,
      table: "reversible_items",
      primary_key: { column: "id", value: input.id },
    },
    before,
    patch: input.patch,
    after,
    guards: {
      tenant: { column: "tenant_id", value: "acme" },
      allowed_columns: input.allowedColumns,
      ...(insert ? {
        deduplication: { components: [
          { column: "tenant_id", value: "acme", source: "trusted_tenant" },
          { column: "id", value: input.id, source: "proposal_id" },
        ] },
      } : {
        expected_version: { column: "version", value: version },
        ...(deleting ? {} : { version_advance: { column: "version", strategy: "integer_increment" } }),
      }),
    },
    reversibility: {
      mode: "reviewed_inverse",
      lineage: { root_proposal_id: proposalId, parent_proposal_id: proposalId, reverts_proposal_id: proposalId, depth: 1 },
    },
    evidence: { bundle_id: `ev_${proposalId}`, query_fingerprint: sha({ engine, input }), items: [] },
    approval: { status: "pending", mode: "human", required_role: "billing_reviewer" },
    writeback: { status: "not_applied", mode: "trusted_worker_required", executor: "sql_update" },
    source_database_mutated: false,
    integrity: { proposal_hash: sha({ proposalId, input }) },
    created_at: "2026-07-13T00:00:00Z",
  };
}

function seedAndApprove(storePath, changeSet) {
  const store = new ProposalStore(storePath);
  store.createProposal(changeSet);
  store.approveProposal(changeSet.proposal_id, { approver: "billing_reviewer_1", proposal_hash: changeSet.integrity.proposal_hash, proposal_version: 1 });
  store.close();
}

async function applyProposal(configPath, storePath, proposalId) {
  return quietRunnerMain(["apply", proposalId, "--yes", "--config", configPath, "--store", storePath]);
}

async function quietRunnerMain(args) {
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await runnerMain(args);
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function createAndApplyRevert(configPath, storePath, forwardId) {
  const code = await quietRunnerMain(["revert", forwardId, "--actor", "billing_reviewer_1", "--config", configPath, "--store", storePath, "--json"]);
  assert(code === 0, "revert command failed to create a compensation proposal", { forwardId, code });
  const store = new ProposalStore(storePath);
  const compensation = store.listProposals().find((item) => item.change_set.schema_version === "synapsor.compensation-change-set.v1" && item.change_set.compensation.descriptor.lineage.reverts_proposal_id === forwardId);
  assert(compensation, "compensation proposal was not persisted", { forwardId });
  assert(compensation.state === "pending_review" && compensation.source_database_mutated === false, "revert mutated or approved without review", compensation);
  store.approveProposal(compensation.proposal_id, { approver: "billing_reviewer_2", proposal_hash: compensation.proposal_hash, proposal_version: compensation.proposal_version });
  store.close();
  const applyCode = await applyProposal(configPath, storePath, compensation.proposal_id);
  return { compensationId: compensation.proposal_id, applyCode };
}

function appliedInverse(storePath, proposalId) {
  const store = new ProposalStore(storePath);
  const receipt = store.receipts(proposalId).find((item) => item.status === "applied" || item.status === "already_applied");
  const replay = store.replay(proposalId);
  store.close();
  assert(receipt, "applied receipt missing", { proposalId });
  assert(replay.events.length > 0, "replay events missing", { proposalId });
  return receipt.receipt.inverse;
}

function adapterConfig(engine) {
  return {
    controlPlaneUrl: "http://127.0.0.1:1",
    runnerToken: "synthetic-local-token",
    runnerId: `reversible-${engine}`,
    sourceId: "reversible_db",
    databaseUrl: engines[engine].writerUrl,
    engine,
    pollIntervalMs: 1000,
    statementTimeoutMs: 5000,
    logLevel: "error",
    dryRun: false,
    stateDir: ".synapsor/test-state",
    receipts: engines[engine].receipts,
  };
}

function reviewedSetJob(engine, label, rows) {
  const members = rows.map((value) => {
    const id = String(value.id);
    const before = { id, tenant_id: String(value.tenant_id), status: String(value.status), amount_cents: Number(value.amount_cents), version: Number(value.version) };
    const after = { ...before, amount_cents: 777, version: before.version + 1 };
    return {
      primary_key: { column: "id", value: id },
      expected_version: { column: "version", value: before.version },
      before,
      after,
      before_digest: sha({ primary_key: id, before }),
      after_digest: sha({ primary_key: id, after }),
    };
  }).sort((left, right) => JSON.stringify(left.primary_key.value).localeCompare(JSON.stringify(right.primary_key.value)));
  const aggregateBounds = [{ column: "amount_cents", measure: "absolute_delta", maximum: 1000, actual: members.reduce((total, member) => total + Math.abs(Number(member.after.amount_cents) - Number(member.before.amount_cents)), 0) }];
  const inverse = {
    schema_version: "synapsor.inverse-descriptor.v1",
    availability: "available",
    reason_codes: [],
    operation: "restore_update",
    cardinality: "set",
    forward_proposal_id: `wrp_${engine}_${label}`,
    forward_writeback_job_id: `wbj_${engine}_${label}`,
    target: { source_id: "reversible_db", schema: engines[engine].schema, table: "reversible_items", primary_key_column: "id" },
    tenant_guard: { column: "tenant_id", value: "acme" },
    allowed_columns: ["amount_cents"],
    members: members.map((member) => ({ primary_key: member.primary_key, expected_state: { amount_cents: member.after.amount_cents, version: member.after.version }, restore_values: { amount_cents: member.before.amount_cents } })),
    max_rows: 2,
    aggregate_bounds: aggregateBounds,
    version_advance: { column: "version", strategy: "integer_increment" },
    lineage: { root_proposal_id: `wrp_${engine}_${label}`, parent_proposal_id: `wrp_${engine}_${label}`, reverts_proposal_id: `wrp_${engine}_${label}`, depth: 1 },
  };
  const job = parseWritebackJob({
    schema_version: "synapsor.writeback-job.v3",
    writeback_job_id: `wbj_${engine}_${label}`,
    proposal_id: `wrp_${engine}_${label}`,
    proposal_version: 1,
    proposal_hash: sha({ engine, label }),
    runner_scope: { project_id: "reversible-live", source_id: "reversible_db" },
    engine,
    operation: "set_update",
    target: { schema: engines[engine].schema, table: "reversible_items", primary_key: { column: "id" } },
    tenant_guard: { column: "tenant_id", value: "acme" },
    allowed_columns: ["amount_cents"],
    patch: { amount_cents: 777 },
    version_advance: { column: "version", strategy: "integer_increment" },
    frozen_set: { max_rows: 2, row_count: 2, aggregate_bounds: aggregateBounds, members, set_digest: sha({ operation: "set_update", members, aggregate_bounds: aggregateBounds }) },
    inverse_capture: inverse,
    idempotency_key: `idem_${engine}_${label}`,
    lease: { lease_id: `lease_${engine}_${label}`, attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
  return { job, inverse };
}

function compensationJob(engine, label, inverse, forwardHash) {
  return parseWritebackJob({
    schema_version: "synapsor.writeback-job.v4",
    writeback_job_id: `wbj_${engine}_${label}_revert`,
    proposal_id: `wrp_${engine}_${label}_revert`,
    proposal_version: 1,
    proposal_hash: sha({ engine, label, compensation: true }),
    runner_scope: { project_id: "reversible-live", source_id: "reversible_db" },
    engine,
    operation: inverse.operation,
    target: { schema: engines[engine].schema, table: "reversible_items", primary_key: { column: "id" } },
    tenant_guard: { column: "tenant_id", value: "acme" },
    allowed_columns: inverse.allowed_columns,
    patch: {},
    compensation: inverse,
    forward_receipt_hash: forwardHash,
    idempotency_key: `idem_${engine}_${label}_revert`,
    lease: { lease_id: `lease_${engine}_${label}_revert`, attempt: 1, expires_at: "2099-01-01T00:00:00Z" },
  });
}

async function verifyBoundedSetCompensation(engine, admin) {
  const original = [await row(engine, admin, "set-1"), await row(engine, admin, "set-2")];
  const { job } = reviewedSetJob(engine, "set", original);
  const forward = await engines[engine].apply(job, adapterConfig(engine));
  assert(forward.status === "applied" && forward.affected_rows === 2 && forward.inverse?.cardinality === "set", `${engine} reversible set forward apply failed`, forward);
  const compensation = compensationJob(engine, "set", forward.inverse, forward.result_hash);
  const reverted = await engines[engine].apply(compensation, adapterConfig(engine));
  assert(reverted.status === "applied" && reverted.affected_rows === 2 && reverted.inverse?.lineage.depth === 2, `${engine} reversible set compensation failed`, reverted);
  const restored = [await row(engine, admin, "set-1"), await row(engine, admin, "set-2")];
  assert(restored.every((value, index) => Number(value.amount_cents) === Number(original[index].amount_cents) && Number(value.version) === 3), `${engine} set compensation did not restore exact reviewed members`, restored);

  const staleOriginal = [await row(engine, admin, "set-stale-1"), await row(engine, admin, "set-stale-2")];
  const staleSet = reviewedSetJob(engine, "set-stale", staleOriginal);
  const staleForward = await engines[engine].apply(staleSet.job, adapterConfig(engine));
  assert(staleForward.status === "applied" && staleForward.inverse, `${engine} stale-set forward apply failed`, staleForward);
  const driftSql = engine === "postgres"
    ? "UPDATE public.reversible_items SET amount_cents = 778, version = version + 1 WHERE id = $1"
    : "UPDATE reversible_items SET amount_cents = 778, version = version + 1 WHERE id = ?";
  await query(engine, admin, driftSql, ["set-stale-2"]);
  const staleCompensation = compensationJob(engine, "set-stale", staleForward.inverse, staleForward.result_hash);
  const blocked = await engines[engine].apply(staleCompensation, adapterConfig(engine));
  assert(blocked.status === "conflict" && blocked.error_code === "ROW_CHANGED_AFTER_FORWARD_WRITE", `${engine} one stale set member did not block compensation`, blocked);
  const blockedRows = [await row(engine, admin, "set-stale-1"), await row(engine, admin, "set-stale-2")];
  assert(Number(blockedRows[0].amount_cents) === 777 && Number(blockedRows[0].version) === 2 && Number(blockedRows[1].amount_cents) === 778 && Number(blockedRows[1].version) === 3, `${engine} stale set compensation partially restored rows`, blockedRows);
}

function latestReceipt(storePath, proposalId) {
  const store = new ProposalStore(storePath);
  const receipts = store.receipts(proposalId);
  store.close();
  return receipts.at(-1);
}

async function verifyRoundTrip(engine, admin, configPath, storePath, input, expectedAfter, expectedRestored) {
  const before = input.operation === "single_row_insert" ? {} : await row(engine, admin, input.id);
  const changeSet = forwardChangeSet(engine, { ...input, before });
  seedAndApprove(storePath, changeSet);
  assert((await applyProposal(configPath, storePath, changeSet.proposal_id)) === 0, `${engine} forward apply failed`, input);
  const inverse = appliedInverse(storePath, changeSet.proposal_id);
  assert(inverse?.availability === "available", `${engine} forward receipt did not capture an available inverse`, inverse);
  assert(JSON.stringify(inverse).includes("internal_note") === false, `${engine} inverse captured kept-out data`, inverse);
  assert(await expectedAfter(), `${engine} forward state mismatch`, input);
  const reverted = await createAndApplyRevert(configPath, storePath, changeSet.proposal_id);
  assert(reverted.applyCode === 0, `${engine} compensation apply failed`, reverted);
  const inverseOfInverse = appliedInverse(storePath, reverted.compensationId);
  assert(inverseOfInverse?.availability === "available" && inverseOfInverse.lineage.depth === 2, `${engine} compensation receipt is not itself reversible`, inverseOfInverse);
  assert(await expectedRestored(), `${engine} compensation did not restore the reviewed state`, input);
}

async function verifyEngine(engine, admin) {
  await setupEngine(engine, admin);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `synapsor-reversible-${engine}-`));
  const storePath = path.join(tempDir, "local.db");
  const configPath = path.join(tempDir, "synapsor.runner.json");
  await fs.writeFile(configPath, JSON.stringify(configFor(engine, storePath), null, 2));
  process.env.REVERSIBLE_DATABASE_URL = engines[engine].writerUrl;
  try {
    await verifyRoundTrip(engine, admin, configPath, storePath, {
      label: "update", id: "update-1", action: "billing.adjust_credit", operation: "single_row_update", patch: { amount_cents: 2500 }, allowedColumns: ["amount_cents"],
    }, async () => Number((await row(engine, admin, "update-1"))?.amount_cents) === 2500, async () => {
      const value = await row(engine, admin, "update-1");
      return Number(value?.amount_cents) === 100 && Number(value?.version) === 3;
    });

    await verifyRoundTrip(engine, admin, configPath, storePath, {
      label: "insert", id: "insert-1", action: "billing.create_credit", operation: "single_row_insert",
      patch: { status: "active", amount_cents: 500, reason: "reviewed service recovery" },
      after: { id: "insert-1", tenant_id: "acme", status: "active", amount_cents: 500, reason: "reviewed service recovery" },
      allowedColumns: ["status", "amount_cents", "reason"],
    }, async () => Boolean(await row(engine, admin, "insert-1")), async () => !(await row(engine, admin, "insert-1")));

    await verifyRoundTrip(engine, admin, configPath, storePath, {
      label: "soft-delete", id: "soft-delete-1", action: "billing.soft_delete_credit", operation: "single_row_update",
      patch: { status: "deleted", deleted_at: "2026-07-13T00:00:00Z" }, allowedColumns: ["status", "deleted_at"],
    }, async () => (await row(engine, admin, "soft-delete-1"))?.status === "deleted", async () => {
      const value = await row(engine, admin, "soft-delete-1");
      return value?.status === "active" && value?.deleted_at == null && Number(value?.version) === 3;
    });

    const staleBefore = await row(engine, admin, "stale-1");
    const stale = forwardChangeSet(engine, { label: "stale", id: "stale-1", action: "billing.adjust_credit", operation: "single_row_update", before: staleBefore, patch: { amount_cents: 900 }, allowedColumns: ["amount_cents"] });
    seedAndApprove(storePath, stale);
    assert((await applyProposal(configPath, storePath, stale.proposal_id)) === 0, `${engine} stale fixture forward apply failed`);
    const driftSql = engine === "postgres"
      ? "UPDATE public.reversible_items SET amount_cents = 901, version = version + 1 WHERE id = $1"
      : "UPDATE reversible_items SET amount_cents = 901, version = version + 1 WHERE id = ?";
    await query(engine, admin, driftSql, ["stale-1"]);
    const staleRevert = await createAndApplyRevert(configPath, storePath, stale.proposal_id);
    const staleReceipt = latestReceipt(storePath, staleRevert.compensationId);
    assert(staleRevert.applyCode === 0 && staleReceipt?.status === "conflict" && staleReceipt.receipt.safe_error_code === "ROW_CHANGED_AFTER_FORWARD_WRITE", `${engine} stale compensation did not fail closed`, { staleRevert, staleReceipt });
    assert(Number((await row(engine, admin, "stale-1"))?.amount_cents) === 901, `${engine} stale compensation overwrote newer work`);

    const hardBefore = await row(engine, admin, "hard-delete-1");
    const hard = forwardChangeSet(engine, { label: "hard-delete", id: "hard-delete-1", action: "billing.hard_delete_credit", operation: "single_row_delete", before: hardBefore, patch: {}, allowedColumns: [] });
    seedAndApprove(storePath, hard);
    assert((await applyProposal(configPath, storePath, hard.proposal_id)) === 0, `${engine} hard delete forward apply failed`);
    const hardInverse = appliedInverse(storePath, hard.proposal_id);
    assert(hardInverse?.availability === "best_effort_unavailable" && hardInverse.reason_codes.length > 0, `${engine} hard delete overclaimed reversibility`, hardInverse);
    let hardError = "";
    try { await quietRunnerMain(["revert", hard.proposal_id, "--actor", "billing_reviewer_1", "--config", configPath, "--store", storePath]); }
    catch (error) { hardError = error instanceof Error ? error.message : String(error); }
    assert(/REVERSAL_UNAVAILABLE/.test(hardError), `${engine} hard delete did not surface a specific unavailable result`, { hardError });

    await verifyBoundedSetCompensation(engine, admin);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "mysql"], { inherit: true });
  await waitForDatabases();
  const pgAdmin = new Pool({ connectionString: pgAdminUrl, max: 8 });
  const mysqlAdmin = await mysql.createConnection(mysqlAdminUrl);
  try {
    for (const [engine, admin] of [["postgres", pgAdmin], ["mysql", mysqlAdmin]]) {
      console.log(`== ${engine}: reviewed reversible UPDATE, INSERT, soft delete, stale conflict, hard-delete honesty ==`);
      await verifyEngine(engine, admin);
    }
    console.log("Reversible writeback live verification passed: Postgres + MySQL, reviewed forward/apply/revert proposal/approval/compensation, exact bounded-set restore with atomic stale-member refusal, inverse-of-inverse, stale conflict, kept-out redaction, and hard-delete honesty.");
  } finally {
    delete process.env.REVERSIBLE_DATABASE_URL;
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
