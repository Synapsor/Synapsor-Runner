import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import { Pool } from "pg";
import { ProposalStore } from "../packages/proposal-store/dist/index.js";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import {
  loadRuntimeConfigFromFile,
  startStreamableHttpMcpServer,
} from "../packages/mcp-server/dist/index.js";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundaries,
  loadGenerationLockSnapshot,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { createSavedBoundary } from "../apps/runner/dist/boundary-library.js";
import {
  commitBoundaryResourceReviewMutation,
  prepareBoundaryResourceReviewMutation,
} from "../apps/runner/dist/boundary-review-mutation.js";
import {
  assertProductionExploreStartup,
  productionExploreSessionFactory,
} from "../apps/runner/dist/mcp-runtime.js";
import { derivedScopeIndexDoctorChecks } from "../apps/runner/dist/derived-scope-index-doctor.js";
import { createScopedExploreRuntime } from "../apps/runner/dist/scoped-explore.js";
import {
  productionExploreRunnerInvocation,
  startProductionExploreCli,
  stopProductionExploreCli,
  verifyGeneratedProductionHttpClientConfigs,
  verifyJwtRejectionMatrix,
} from "./production-explore-http-e2e-helpers.mjs";
import {
  applyProductionExploreSoakBudgets,
  assertExactNumericBandResult,
  productionExploreSoakIdentities,
  productionExploreSoakRequested,
  runProductionExploreHttpSoak,
  runProductionExploreRecovery,
  waitForSourceConnectionQuiescence,
  verifyLocalExploreAuditRecords,
  verifyProductionExploreAuditSink,
  verifyProductionExploreOperatorLedger,
} from "./production-explore-http-soak.mjs";
import { verifyProductionExploreWorkbenchLedger } from "./verify-production-explore-workbench-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "examples/runner-fleet/docker-compose.yml");
const composeProject = `synapsor-production-explore-mysql-${process.pid}`;
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-mysql-http-"));
const authoringLifecycleProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-mysql-authoring-"));
const singleOrganizationProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-mysql-single-org-http-"));
const localParityProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-mysql-local-parity-"));
const mysqlAdminUrl = "mysql://root:root_password@127.0.0.1:53309";
const mysqlReadUrl = "mysql://synapsor_production_reader:synapsor_production_reader_password@127.0.0.1:53309/synapsor_production_explore";
const mysqlSingleOrganizationReadUrl = "mysql://synapsor_production_reader:synapsor_production_reader_password@127.0.0.1:53309/synapsor_single_org_explore";
const controlUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const controlSchema = `synapsor_production_mysql_${process.pid}`;
const sourceSchema = "synapsor_production_explore";
const sourceId = `${sourceSchema}.events`;
const scopedOrdersId = `${sourceSchema}.scoped_orders`;
const scopedOrderItemsId = `${sourceSchema}.scoped_order_items`;
const sharedProductCatalogId = `${sourceSchema}.shared_product_catalog`;
const singleOrganizationSchema = "synapsor_single_org_explore";
const singleOrganizationSourceId = `${singleOrganizationSchema}.activity`;

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function verifyMysqlProductionAuthoringLifecycle({ inspection, env }) {
  const configPath = path.join(authoringLifecycleProjectRoot, "synapsor.runner.json");
  const configInitInvocation = productionExploreRunnerInvocation(root, [
    "config", "init", "--production-explore",
    "--project-root", authoringLifecycleProjectRoot,
    "--output", configPath,
    "--engine", "mysql",
    "--source", "local_mysql",
    "--read-url-env", "MYSQL_DATABASE_URL",
    "--tenant-binding", "tenant_id",
    "--principal-binding", "owner_id",
    "--tenant-claim", "tenant_id",
    "--principal-claim", "sub",
    "--issuer", "https://identity.example",
    "--audience", "https://runner.example/mcp",
    "--accounting-namespace", "verify.production.mysql.authoring",
    "--json",
  ]);
  run(configInitInvocation.command, configInitInvocation.args, { env });
  const configuredTrustedContext = {
    schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
    provider: "http_claims",
    tenant_binding: "tenant_id",
    principal_binding: "owner_id",
    tenant_claim: "tenant_id",
    principal_claim: "sub",
  };
  const build = buildAutoBoundary({
    inspection,
    project: {
      root: authoringLifecycleProjectRoot,
      package_manager: "unknown",
      frameworks: [],
      schema_inputs: [],
      database_env_names: ["MYSQL_DATABASE_URL"],
    },
    sourceEnv: "MYSQL_DATABASE_URL",
    sourceName: "local_mysql",
    inspectedSchema: sourceSchema,
    deploymentProfile: "production",
    httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
    configuredTrustedContext,
  });
  await writeAutoBoundaryArtifacts({ projectRoot: authoringLifecycleProjectRoot, build });
  const reviewedMutation = await prepareBoundaryResourceReviewMutation(
    authoringLifecycleProjectRoot,
    {
      resource_id: sourceId,
      minimum_cohort_size: 4,
      actor: "production-owner@example.test",
      reason: "Exercise the live MySQL config-draft-review-activate lifecycle.",
    },
    async () => inspection,
  );
  await commitBoundaryResourceReviewMutation(authoringLifecycleProjectRoot, reviewedMutation);
  const reviewedBaseline = JSON.parse(fs.readFileSync(
    path.join(authoringLifecycleProjectRoot, ".synapsor/auto-boundary-policy-baseline.json"),
    "utf8",
  ));
  const reviewedLock = JSON.parse(fs.readFileSync(
    path.join(authoringLifecycleProjectRoot, ".synapsor/generation-lock.json"),
    "utf8",
  ));
  assert(reviewedBaseline.boundary.pack.resources.some((reviewedResource) =>
    reviewedResource.id === sourceId
    && reviewedResource.tenant_key === "tenant_id"
    && reviewedResource.principal_key === "owner_id"),
  "MySQL production review mutation discarded the configured authoring baseline.", reviewedBaseline);
  assert(reviewedLock.trusted_context_authority?.tenant_binding === "tenant_id"
    && reviewedLock.trusted_context_authority?.principal_binding === "owner_id",
  "MySQL production review mutation discarded configured binding authority.", reviewedLock);
  const candidateDigest = explorationBoundaryCandidateDigest(reviewedMutation.candidate);
  await activateExplorationBoundary({
    projectRoot: authoringLifecycleProjectRoot,
    candidate: reviewedMutation.candidate,
    expectedDigest: candidateDigest,
    actor: "production-owner@example.test",
    confirmation: `ACTIVATE ${candidateDigest}`,
    confirmedDecisions: reviewedMutation.candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  const active = await loadActivatedExplorationBoundaries(authoringLifecycleProjectRoot);
  const runtimeConfig = loadRuntimeConfigFromFile(configPath);
  const startup = await assertProductionExploreStartup(
    runtimeConfig,
    {
      ...env,
      SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
      SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "shared-production-mysql-authoring-hmac-key-material",
      SYNAPSOR_SESSION_JWKS_URL: "https://identity.example/.well-known/jwks.json",
    },
    async () => active,
    async () => ({ boundary: active[0], lock: reviewedLock }),
  );
  assert(startup.ok,
    "The reviewed MySQL binding authority did not pass production startup attestation.", startup);
  const second = await createSavedBoundary({
    projectRoot: authoringLifecycleProjectRoot,
    draft: reviewedMutation.build.exploration_boundary,
    currentCandidate: reviewedMutation.candidate,
    name: "mysql_events_secondary",
    resourceId: sourceId,
    actor: "secondary-production-owner@example.test",
  });
  assert(second.candidate.pack.resources[0]?.tenant_key === "tenant_id"
    && second.candidate.pack.resources[0]?.principal_key === "owner_id",
  "MySQL production review/activation did not leave a startable second-boundary baseline.", second);
  return {
    reviewed_bindings_preserved: true,
    startup_attestation_passed: true,
    second_boundary_startable: true,
  };
}

async function verifySchemaWidthScaling({ mysqlAdmin, client, env, plan, resources }) {
  assert(resources.length > 0, "The MySQL generation lock has no authority dependencies to inspect.");
  const expectedResourceIds = resources
    .map((resource) => `${resource.schema}.${resource.table}`)
    .sort();
  const inspect = async () => {
    const started = performance.now();
    const inspection = await inspectDatabase({
      engine: "mysql",
      databaseUrlEnv: "MYSQL_DATABASE_URL",
      schema: sourceSchema,
      resources,
      env,
    });
    const actualResourceIds = inspection.tables
      .map((table) => `${table.schema}.${table.name}`)
      .sort();
    assert(JSON.stringify(actualResourceIds) === JSON.stringify(expectedResourceIds),
      "Scoped MySQL inspection did not fetch exactly the generation-lock dependencies.",
      { expected: expectedResourceIds, actual: actualResourceIds });
    return performance.now() - started;
  };
  const before = [];
  for (let index = 0; index < 3; index += 1) before.push(await inspect());
  const decoys = Array.from({ length: 80 }, (_, index) =>
    `${sourceSchema}.synapsor_unreviewed_scale_${String(index).padStart(3, "0")}`);
  try {
    await mysqlAdmin.query(decoys.map((name) =>
      `CREATE TABLE ${name} (id bigint PRIMARY KEY, payload text, observed_at timestamp)`
    ).join(";\n"));
    const after = [];
    for (let index = 0; index < 3; index += 1) after.push(await inspect());
    const full = await inspectDatabase({
      engine: "mysql",
      databaseUrlEnv: "MYSQL_DATABASE_URL",
      schema: sourceSchema,
      env,
    });
    assert(full.tables.length >= resources.length + decoys.length,
      "Whole-schema MySQL discovery did not retain unrelated-table discovery.",
      { table_count: full.tables.length });
    await mysqlAdmin.query(
      `GRANT UPDATE ON ${decoys[0]} TO 'synapsor_production_reader'@'%'`,
    );
    try {
      const unsafeGrant = await client.callTool({
        name: "app.explore_data",
        arguments: { plan },
      });
      assert(unsafeGrant.isError === true
        && /EXPLORE_LOCK_STALE|EXPLORE_ROLE_UNSAFE|credential posture changed/i.test(
          JSON.stringify(unsafeGrant),
        ),
      "A write grant on an unrelated MySQL table bypassed the global read-only guard.",
      unsafeGrant);
    } finally {
      await mysqlAdmin.query(
        `REVOKE UPDATE ON ${decoys[0]} FROM 'synapsor_production_reader'@'%'`,
      );
    }
    const query = resultPayload(await client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    }));
    assert(query.ok === true,
      "Adding unrelated MySQL tables changed a live boundary query or triggered false drift.", query);
    const baselineMs = median(before);
    const widenedMs = median(after);
    assert(widenedMs <= Math.max(baselineMs * 4, baselineMs + 500),
      "Dependency-scoped MySQL inspection regressed materially as unrelated schema width grew.",
      { baseline_ms: baselineMs, widened_ms: widenedMs, unrelated_tables: decoys.length });
    return {
      unrelated_tables: decoys.length,
      dependency_tables_fetched: resources.length,
      unrelated_write_grant_refused: true,
      baseline_median_ms: Math.round(baselineMs * 100) / 100,
      widened_median_ms: Math.round(widenedMs * 100) / 100,
      whole_schema_tables_discovered: full.tables.length,
    };
  } finally {
    await mysqlAdmin.query(`DROP TABLE IF EXISTS ${decoys.join(", ")}`).catch(() => undefined);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function seedSource(connection) {
  await connection.query(`
    DROP DATABASE IF EXISTS ${sourceSchema};
    CREATE DATABASE ${sourceSchema};
    CREATE TABLE ${sourceSchema}.events (
      id varchar(64) PRIMARY KEY,
      tenant_id varchar(64) NOT NULL,
      owner_id varchar(64) NOT NULL DEFAULT 'alice',
      category enum('growth', 'retained', 'private-small', 'enterprise', 'partner') NOT NULL,
      amount_cents integer NOT NULL,
      occurred_at timestamp NOT NULL
    );
    CREATE TABLE ${sourceSchema}.scoped_orders (
      id varchar(64) PRIMARY KEY,
      tenant_id varchar(64) NOT NULL,
      owner_id varchar(64) NOT NULL,
      category enum('enterprise', 'trail') NOT NULL,
      occurred_at timestamp NOT NULL
    );
    CREATE INDEX scoped_orders_tenant_id_idx ON ${sourceSchema}.scoped_orders (tenant_id);
    CREATE INDEX scoped_orders_owner_id_idx ON ${sourceSchema}.scoped_orders (owner_id);
    CREATE TABLE ${sourceSchema}.scoped_order_items (
      id varchar(64) PRIMARY KEY,
      order_id varchar(64) NOT NULL,
      item_kind enum('standard') NOT NULL,
      quantity integer NOT NULL,
      occurred_at timestamp NOT NULL,
      CONSTRAINT scoped_order_items_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES ${sourceSchema}.scoped_orders(id) ON DELETE RESTRICT
    );
    CREATE TABLE ${sourceSchema}.shared_product_catalog (
      id varchar(64) PRIMARY KEY,
      category enum('hardware', 'software') NOT NULL,
      internal_notes text NOT NULL
    );
    INSERT INTO ${sourceSchema}.events (id, tenant_id, category, amount_cents, occurred_at) VALUES
      ('a-1', 'acme', 'growth', 100, '2026-07-01 00:00:00'),
      ('a-2', 'acme', 'growth', 110, '2026-07-02 00:00:00'),
      ('a-3', 'acme', 'growth', 120, '2026-07-03 00:00:00'),
      ('a-4', 'acme', 'growth', 130, '2026-07-04 00:00:00'),
      ('a-5', 'acme', 'growth', 140, '2026-07-05 00:00:00'),
      ('a-6', 'acme', 'retained', 200, '2026-07-06 00:00:00'),
      ('a-7', 'acme', 'retained', 210, '2026-07-07 00:00:00'),
      ('a-8', 'acme', 'retained', 220, '2026-07-08 00:00:00'),
      ('a-9', 'acme', 'retained', 230, '2026-07-09 00:00:00'),
      ('a-10', 'acme', 'retained', 240, '2026-07-10 00:00:00'),
      ('a-private-1', 'acme', 'private-small', 999, '2026-07-11 00:00:00'),
      ('a-private-2', 'acme', 'private-small', 999, '2026-07-12 00:00:00'),
      ('g-1', 'globex', 'enterprise', 500, '2026-07-01 00:00:00'),
      ('g-2', 'globex', 'enterprise', 510, '2026-07-02 00:00:00'),
      ('g-3', 'globex', 'enterprise', 520, '2026-07-03 00:00:00'),
      ('g-4', 'globex', 'enterprise', 530, '2026-07-04 00:00:00'),
      ('g-5', 'globex', 'enterprise', 540, '2026-07-05 00:00:00');
    UPDATE ${sourceSchema}.events SET owner_id = 'carol' WHERE tenant_id = 'globex';
    INSERT INTO ${sourceSchema}.events (id, tenant_id, owner_id, category, amount_cents, occurred_at) VALUES
      ('bob-1', 'acme', 'bob', 'partner', 301, '2026-07-01 00:00:00'),
      ('bob-2', 'acme', 'bob', 'partner', 302, '2026-07-02 00:00:00'),
      ('bob-3', 'acme', 'bob', 'partner', 303, '2026-07-03 00:00:00'),
      ('bob-4', 'acme', 'bob', 'partner', 304, '2026-07-04 00:00:00'),
      ('bob-5', 'acme', 'bob', 'partner', 305, '2026-07-05 00:00:00');
    INSERT INTO ${sourceSchema}.events (id, tenant_id, owner_id, category, amount_cents, occurred_at)
    SELECT CONCAT('band-', id), tenant_id, 'band', category, amount_cents, occurred_at
    FROM ${sourceSchema}.events WHERE tenant_id = 'acme' AND owner_id = 'alice';
    INSERT INTO ${sourceSchema}.events (id, tenant_id, owner_id, category, amount_cents, occurred_at)
    SELECT CONCAT('auto-', id), tenant_id, 'auto', category, amount_cents, occurred_at
    FROM ${sourceSchema}.events WHERE tenant_id = 'acme' AND owner_id = 'alice';
    INSERT INTO ${sourceSchema}.events (id, tenant_id, owner_id, category, amount_cents, occurred_at)
    SELECT CONCAT('auto-equal-', id), tenant_id, 'auto-equal', category, amount_cents, occurred_at
    FROM ${sourceSchema}.events WHERE tenant_id = 'acme' AND owner_id = 'alice';
    INSERT INTO ${sourceSchema}.events (id, tenant_id, owner_id, category, amount_cents, occurred_at)
    SELECT CONCAT('auto-ties-', id), tenant_id, 'auto-ties', category, amount_cents, occurred_at
    FROM ${sourceSchema}.events WHERE tenant_id = 'acme' AND owner_id = 'alice';
    UPDATE ${sourceSchema}.events AS event
    JOIN (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
      FROM ${sourceSchema}.events
      WHERE tenant_id = 'acme' AND owner_id = 'auto-ties'
    ) AS ranked ON ranked.id = event.id
    SET event.amount_cents = CASE WHEN ranked.rn <= 6 THEN 100 ELSE 200 END;
    INSERT INTO ${sourceSchema}.events (id, tenant_id, owner_id, category, amount_cents, occurred_at)
    SELECT CONCAT('running-', id), tenant_id, 'running', category, amount_cents, occurred_at
    FROM ${sourceSchema}.events WHERE tenant_id = 'acme' AND owner_id = 'alice';
    INSERT INTO ${sourceSchema}.events (id, tenant_id, owner_id, category, amount_cents, occurred_at)
    SELECT CONCAT('relative-', id), tenant_id, 'relative', category, amount_cents,
      UTC_TIMESTAMP() - INTERVAL 1 DAY
    FROM ${sourceSchema}.events WHERE tenant_id = 'acme' AND owner_id = 'alice';
    INSERT INTO ${sourceSchema}.scoped_orders (id, tenant_id, owner_id, category, occurred_at) VALUES
      ('derived-acme-order', 'acme', 'derived-acme', 'trail', '2026-07-01 00:00:00'),
      ('derived-globex-order', 'globex', 'derived-globex', 'enterprise', '2026-07-01 00:00:00'),
      ('fanout-acme-order-1', 'acme', 'fanout-acme', 'trail', '2026-07-01 00:00:00'),
      ('fanout-acme-order-2', 'acme', 'fanout-acme', 'trail', '2026-07-01 00:00:00'),
      ('fanout-acme-order-3', 'acme', 'fanout-acme', 'trail', '2026-07-01 00:00:00'),
      ('fanout-acme-order-4', 'acme', 'fanout-acme', 'trail', '2026-07-01 00:00:00'),
      ('fanout-acme-order-5', 'acme', 'fanout-acme', 'trail', '2026-07-01 00:00:00');
    INSERT INTO ${sourceSchema}.scoped_order_items (id, order_id, item_kind, quantity, occurred_at) VALUES
      ('derived-acme-item-1', 'derived-acme-order', 'standard', 1, '2026-07-01 00:00:00'),
      ('derived-acme-item-2', 'derived-acme-order', 'standard', 2, '2026-07-01 00:00:00'),
      ('derived-acme-item-3', 'derived-acme-order', 'standard', 3, '2026-07-01 00:00:00'),
      ('derived-acme-item-4', 'derived-acme-order', 'standard', 4, '2026-07-01 00:00:00'),
      ('derived-acme-item-5', 'derived-acme-order', 'standard', 5, '2026-07-01 00:00:00'),
      ('derived-globex-item-1', 'derived-globex-order', 'standard', 1, '2026-07-01 00:00:00'),
      ('derived-globex-item-2', 'derived-globex-order', 'standard', 2, '2026-07-01 00:00:00'),
      ('derived-globex-item-3', 'derived-globex-order', 'standard', 3, '2026-07-01 00:00:00'),
      ('derived-globex-item-4', 'derived-globex-order', 'standard', 4, '2026-07-01 00:00:00'),
      ('derived-globex-item-5', 'derived-globex-order', 'standard', 5, '2026-07-01 00:00:00'),
      ('derived-globex-item-6', 'derived-globex-order', 'standard', 6, '2026-07-01 00:00:00'),
      ('derived-globex-item-7', 'derived-globex-order', 'standard', 7, '2026-07-01 00:00:00'),
      ('fanout-acme-item-1', 'fanout-acme-order-1', 'standard', 1, '2026-07-01 00:00:00'),
      ('fanout-acme-item-2', 'fanout-acme-order-2', 'standard', 2, '2026-07-01 00:00:00'),
      ('fanout-acme-item-3', 'fanout-acme-order-3', 'standard', 3, '2026-07-01 00:00:00'),
      ('fanout-acme-item-4', 'fanout-acme-order-4', 'standard', 4, '2026-07-01 00:00:00'),
      ('fanout-acme-item-5', 'fanout-acme-order-5', 'standard', 5, '2026-07-01 00:00:00');
    INSERT INTO ${sourceSchema}.shared_product_catalog (id, category, internal_notes) VALUES
      ('hardware-1', 'hardware', 'operator-only hardware note 1'),
      ('hardware-2', 'hardware', 'operator-only hardware note 2'),
      ('hardware-3', 'hardware', 'operator-only hardware note 3'),
      ('hardware-4', 'hardware', 'operator-only hardware note 4'),
      ('hardware-5', 'hardware', 'operator-only hardware note 5'),
      ('hardware-6', 'hardware', 'operator-only hardware note 6'),
      ('software-1', 'software', 'operator-only software note 1'),
      ('software-2', 'software', 'operator-only software note 2'),
      ('software-3', 'software', 'operator-only software note 3'),
      ('software-4', 'software', 'operator-only software note 4'),
      ('software-5', 'software', 'operator-only software note 5'),
      ('software-6', 'software', 'operator-only software note 6');
    CREATE USER IF NOT EXISTS 'synapsor_production_reader'@'%' IDENTIFIED BY 'synapsor_production_reader_password';
    GRANT SELECT ON ${sourceSchema}.* TO 'synapsor_production_reader'@'%';
    DROP DATABASE IF EXISTS ${singleOrganizationSchema};
    CREATE DATABASE ${singleOrganizationSchema};
    CREATE TABLE ${singleOrganizationSchema}.activity (
      id varchar(64) PRIMARY KEY,
      category enum('open', 'paid') NOT NULL,
      amount_cents integer NOT NULL,
      occurred_at timestamp NOT NULL
    );
    INSERT INTO ${singleOrganizationSchema}.activity (id, category, amount_cents, occurred_at) VALUES
      ('open-1', 'open', 100, '2026-07-01 00:00:00'),
      ('open-2', 'open', 200, '2026-07-02 00:00:00'),
      ('open-3', 'open', 300, '2026-07-03 00:00:00'),
      ('open-4', 'open', 400, '2026-07-04 00:00:00'),
      ('open-5', 'open', 500, '2026-07-05 00:00:00'),
      ('open-6', 'open', 600, '2026-07-06 00:00:00'),
      ('paid-1', 'paid', 700, '2026-07-07 00:00:00'),
      ('paid-2', 'paid', 800, '2026-07-08 00:00:00'),
      ('paid-3', 'paid', 900, '2026-07-09 00:00:00'),
      ('paid-4', 'paid', 1000, '2026-07-10 00:00:00'),
      ('paid-5', 'paid', 1100, '2026-07-11 00:00:00'),
      ('paid-6', 'paid', 1200, '2026-07-12 00:00:00');
    GRANT SELECT ON ${singleOrganizationSchema}.* TO 'synapsor_production_reader'@'%';
    FLUSH PRIVILEGES;
  `);
}

async function singleOrganizationSourceSnapshot(connection) {
  const [rows] = await connection.query(`
    SELECT COUNT(*) AS row_count,
      SUM(amount_cents) AS total,
      MAX(occurred_at) AS latest
    FROM ${singleOrganizationSchema}.activity
  `);
  return {
    row_count: Number(rows[0].row_count),
    total: Number(rows[0].total),
    latest: new Date(rows[0].latest).toISOString(),
  };
}

async function sourceSnapshot(connection) {
  const [rows] = await connection.query(`
    SELECT COUNT(*) AS row_count,
      SUM(amount_cents) AS total,
      MAX(occurred_at) AS latest
    FROM ${sourceSchema}.events
  `);
  return {
    row_count: Number(rows[0].row_count),
    total: Number(rows[0].total),
    latest: new Date(rows[0].latest).toISOString(),
    derived: await derivedSourceSnapshot(connection),
    shared_reference: await sharedReferenceSourceSnapshot(connection),
  };
}

async function sharedReferenceSourceSnapshot(connection) {
  const [rows] = await connection.query(`
    SELECT COUNT(*) AS row_count,
      SUM(CASE WHEN category = 'hardware' THEN 1 ELSE 0 END) AS hardware_count,
      SUM(CASE WHEN category = 'software' THEN 1 ELSE 0 END) AS software_count
    FROM ${sourceSchema}.shared_product_catalog
  `);
  return {
    row_count: Number(rows[0].row_count),
    hardware_count: Number(rows[0].hardware_count),
    software_count: Number(rows[0].software_count),
  };
}

async function derivedSourceSnapshot(connection) {
  const [rows] = await connection.query(`
    SELECT
      (SELECT COUNT(*) FROM ${sourceSchema}.scoped_orders) AS order_count,
      (SELECT COUNT(*) FROM ${sourceSchema}.scoped_order_items) AS item_count,
      (SELECT SUM(quantity) FROM ${sourceSchema}.scoped_order_items) AS quantity_total
  `);
  return {
    order_count: Number(rows[0].order_count),
    item_count: Number(rows[0].item_count),
    quantity_total: Number(rows[0].quantity_total),
  };
}

function narrowDerivedResources(parent, child) {
  parent.selectable_fields = ["category", "occurred_at"];
  parent.filterable_fields = Object.fromEntries(Object.entries(parent.filterable_fields)
    .filter(([field]) => parent.selectable_fields.includes(field)));
  parent.sortable_fields = parent.sortable_fields.filter((field) => parent.selectable_fields.includes(field));
  parent.groupable_fields = parent.groupable_fields.filter((field) => field === "category");
  parent.aggregate_measures = [];
  parent.time_bucket_fields = Object.fromEntries(Object.entries(parent.time_bucket_fields)
    .filter(([field]) => field === "occurred_at"));

  child.selectable_fields = ["item_kind", "quantity", "occurred_at"];
  child.filterable_fields = Object.fromEntries(Object.entries(child.filterable_fields)
    .filter(([field]) => child.selectable_fields.includes(field)));
  child.sortable_fields = child.sortable_fields.filter((field) => child.selectable_fields.includes(field));
  child.groupable_fields = child.groupable_fields.filter((field) => field === "item_kind");
  child.aggregate_measures = child.aggregate_measures.filter((field) => field === "quantity");
  child.time_bucket_fields = Object.fromEntries(Object.entries(child.time_bucket_fields)
    .filter(([field]) => field === "occurred_at"));
  child.relationships = child.relationships.filter((relationship) =>
    relationship.id === "scoped_order_items_order_id_fkey");
}

function signedToken(privateKey, { tenant, principal }) {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    tenant_id: tenant,
    sub: principal,
    scope: "synapsor.explore",
    iss: "https://identity.example",
    aud: "https://runner.example/mcp",
    iat: now,
    exp: now + 600,
  })).toString("base64url");
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  return `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function mcpClient(url, bearer) {
  const client = new Client({ name: "production-explore-mysql-verifier", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  return { client, transport };
}

async function seedMysqlSoakPrincipals(connection, identities) {
  const capturedAt = Date.now();
  const recent = mysqlUtcTimestamp(capturedAt - 24 * 60 * 60 * 1_000);
  const priorWeek = mysqlUtcTimestamp(capturedAt - 8 * 24 * 60 * 60 * 1_000);
  const eventRows = [];
  const orderRows = [];
  const itemRows = [];
  for (const identity of identities) {
    const lowValue = 100 + identity.index;
    const highValue = 200 + identity.index;
    for (let item = 1; item <= 10; item += 1) {
      eventRows.push([
        `${identity.principal}-event-${item}`,
        identity.tenant,
        identity.principal,
        item <= 5 ? "growth" : "retained",
        (item <= 5 ? lowValue : highValue) + (item <= 5 ? item : item - 5),
        item <= 5 ? priorWeek : recent,
      ]);
    }
    const category = identity.index % 2 === 0 ? "trail" : "enterprise";
    orderRows.push([
      `${identity.principal}-order`,
      identity.tenant,
      identity.principal,
      category,
      priorWeek,
    ]);
    for (let item = 1; item <= 5; item += 1) {
      itemRows.push([
        `${identity.principal}-item-${item}`,
        `${identity.principal}-order`,
        "standard",
        item,
        priorWeek,
      ]);
    }
  }
  const insertRows = async (table, columns, rows) => {
    for (let start = 0; start < rows.length; start += 500) {
      const chunk = rows.slice(start, start + 500);
      const placeholders = chunk.map((row) => `(${row.map(() => "?").join(", ")})`).join(", ");
      await connection.query(
        `INSERT INTO ${sourceSchema}.${table} (${columns.join(", ")}) VALUES ${placeholders}`,
        chunk.flat(),
      );
    }
  };
  await insertRows("events", ["id", "tenant_id", "owner_id", "category", "amount_cents", "occurred_at"], eventRows);
  await insertRows("scoped_orders", ["id", "tenant_id", "owner_id", "category", "occurred_at"], orderRows);
  await insertRows("scoped_order_items", ["id", "order_id", "item_kind", "quantity", "occurred_at"], itemRows);
}

function mysqlUtcTimestamp(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 19).replace("T", " ");
}

function assertSoak(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

function mysqlSoakOperations() {
  const aggregatePlan = {
    kind: "aggregate",
    resource: sourceId,
    measures: [{ function: "count" }, { function: "sum", field: "amount_cents" }],
    dimensions: [{ field: "category" }],
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
  };
  const validateBase = (payload, identity) => {
    const byCategory = new Map((payload.data ?? []).map((row) => [row.category, row]));
    const lowValue = 100 + identity.index;
    const highValue = 200 + identity.index;
    assertSoak(payload.ok === true && payload.source_database_changed === false,
      "MySQL result was not verified against the locked source.", payload);
    assertSoak(byCategory.size === 2
      && byCategory.get("growth")?.count === 5
      && byCategory.get("growth")?.sum_amount_cents === lowValue * 5 + 15
      && byCategory.get("retained")?.count === 5
      && byCategory.get("retained")?.sum_amount_cents === highValue * 5 + 15,
    "MySQL exact tenant/principal scope isolation failed.", payload.data);
  };
  const legal = (name, weight, plan, validate) => ({
    name,
    weight,
    request: () => ({ name: "app.explore_data", arguments: { plan } }),
    validate,
  });
  return [
    {
      name: "catalog",
      weight: 5,
      request: () => ({ name: "app.describe_data", arguments: {} }),
      validate: (payload) => assertSoak(payload.ok === true
        && payload.resources?.length === 4
        && payload.resources.some((resource) => resource.id === scopedOrderItemsId)
        && payload.resources.some((resource) => resource.id === sharedProductCatalogId),
      "MySQL metadata catalog changed during soak.", payload),
    },
    legal("grouped_count_sum", 25, aggregatePlan, validateBase),
    legal("weekly_grouping", 10, {
      ...aggregatePlan,
      measures: [{ function: "count" }],
      time_bucket: { field: "occurred_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
    }, (payload) => assertSoak((payload.data ?? []).reduce((sum, row) => sum + row.count, 0) === 10,
      "MySQL weekly grouping escaped exact scope.", payload.data)),
    legal("relative_time_window", 10, {
      ...aggregatePlan,
      measures: [{ function: "count" }],
      time_window: { field: "occurred_at", window: "last_30_days" },
    }, (payload) => assertSoak(
      (payload.data ?? []).reduce((sum, row) => sum + row.count, 0) === 10
        && payload.operator_time_windows === undefined
        && payload.resolved_time_windows === undefined,
      "MySQL relative window escaped scope or exposed operator-only resolution metadata.",
      payload,
    )),
    legal("numeric_band", 10, {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "amount_band" }],
      top_n: 10,
    }, (payload, identity) => assertExactNumericBandResult(payload, {
      field: "amount_band",
      values: [
        ...Array.from({ length: 5 }, (_unused, index) => 100 + identity.index + index + 1),
        ...Array.from({ length: 5 }, (_unused, index) => 200 + identity.index + index + 1),
      ],
      edges: [150, 300],
      labels: ["under 150", "150 to 299", "300 or more"],
      minimum_count: 5,
      context: "MySQL numeric-band result did not match the exact scoped cohorts.",
    })),
    legal("auto_band", 10, {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ function: "count" }],
      dimensions: [{
        numeric_band: {
          field: "amount_cents",
          method: "quantile",
          buckets: 2,
        },
      }],
      top_n: 10,
    }, (payload) => assertSoak(payload.ok === true
      && payload.data?.length === 2
      && payload.data.every((row) => /^Q[12] of 2$/.test(row.amount_cents_quantile_band)
        && row.count === 5)
      && payload.privacy?.auto_bands?.[0]?.requested_buckets === 2
      && payload.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && !JSON.stringify(payload).includes("__auto_"),
    "MySQL automatic quantile bands leaked internals or escaped the reviewed scope.", payload)),
    legal("dispersion", 10, {
      kind: "aggregate",
      resource: sourceId,
      measures: [
        { function: "stddev_pop", field: "amount_cents" },
        { function: "var_pop", field: "amount_cents" },
      ],
      dimensions: [{ field: "category" }],
      top_n: 10,
    }, (payload) => assertSoak(payload.data?.length === 2
      && payload.data.every((row) => Number.isFinite(row.stddev_pop_amount_cents)
        && Number.isFinite(row.var_pop_amount_cents)),
    "MySQL contributor-safe dispersion did not return two reviewed cohorts.", payload.data)),
    legal("running_total", 10, {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ derived_measure: "amount_running_total" }],
      dimensions: [{ field: "category" }],
      time_bucket: { field: "occurred_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 25,
    }, (payload) => assertSoak(payload.data?.length === 2
      && payload.data.every((row) => Number.isFinite(row.amount_running_total)),
    "MySQL reviewed running total failed during soak.", payload.data)),
    legal("derived_relationship", 20, {
      kind: "aggregate",
      resource: scopedOrderItemsId,
      measures: [{ function: "count" }, { function: "sum", field: "quantity" }],
      dimensions: [{ field: "category", relationship: "scoped_order_items_order_id_fkey" }],
      top_n: 10,
    }, (payload, identity) => assertSoak(payload.data?.length === 1
      && payload.data[0].scoped_orders_category === (identity.index % 2 === 0 ? "trail" : "enterprise")
      && payload.data[0].count === 5
      && payload.data[0].sum_quantity === 15,
    "MySQL derived tenant/principal scope isolation failed.", payload.data)),
    legal("shared_reference", 5, {
      kind: "aggregate",
      resource: sharedProductCatalogId,
      measures: [{ function: "count" }],
      dimensions: [{ field: "category" }],
      top_n: 10,
    }, (payload) => assertSoak(payload.data?.length === 2
      && payload.data.every((row) => row.count === 6),
    "MySQL shared-reference result changed across tenants.", payload.data)),
    {
      name: "invalid_enum_refusal",
      weight: 3,
      expected_refusal: true,
      request: () => ({
        name: "app.explore_data",
        arguments: { plan: { ...aggregatePlan, where: [{ field: "category", op: "eq", value: "not-reviewed" }] } },
      }),
      validate_refusal: (result) => /not a reviewed value|EXPLORE_FIELD_ENUM_VALUE_FORBIDDEN/i.test(JSON.stringify(result)),
    },
    {
      name: "model_scope_refusal",
      weight: 2,
      expected_refusal: true,
      request: () => ({
        name: "app.explore_data",
        arguments: {
          tenant_id: "wrong-tenant",
          principal: "wrong-principal",
          plan: { ...aggregatePlan, tenant_id: "wrong-tenant", principal: "wrong-principal" },
        },
      }),
      validate_refusal: (result) => /unrecognized|unsupported|invalid/i.test(JSON.stringify(result)),
    },
  ];
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain structured content.");
  return JSON.parse(text);
}

async function productionControlCounts(control, schema) {
  const result = await control.query(`
    SELECT
      (SELECT COUNT(*)::int FROM "${schema}".production_explore_audit_events) AS audit_events,
      (SELECT COUNT(*)::int FROM "${schema}".production_explore_budget_reservations) AS budget_reservations
  `);
  return result.rows[0];
}

async function runLocalParityPlan(env, principal, plan, tenant = "acme") {
  const runtime = await createScopedExploreRuntime({
    projectRoot: localParityProjectRoot,
    transport: "stdio",
    env: {
      ...env,
      SYNAPSOR_TENANT_ID: tenant,
      SYNAPSOR_PRINCIPAL: principal,
    },
  });
  try {
    return await runtime.explore(plan);
  } finally {
    await runtime.close();
  }
}

async function verifyMysqlLocalExploreAudit(env, identity, operations, outputRoot) {
  const successful = operations.filter((operation) => [
    "grouped_count_sum",
    "numeric_band",
    "auto_band",
    "derived_relationship",
  ].includes(operation.name));
  for (const operation of successful) {
    const plan = operation.request(identity).arguments.plan;
    const result = await runLocalParityPlan(env, identity.principal, plan, identity.tenant);
    operation.validate(result, identity);
  }
  const refusal = operations.find((operation) => operation.name === "invalid_enum_refusal");
  let refused = false;
  try {
    await runLocalParityPlan(
      env,
      identity.principal,
      refusal.request(identity).arguments.plan,
      identity.tenant,
    );
  } catch (error) {
    refused = /not a reviewed value|EXPLORE_FIELD_ENUM_VALUE_FORBIDDEN/i.test(String(error));
  }
  assert(refused, "Local MySQL Explore did not refuse an unreviewed enum value before source execution.");
  const store = new ProposalStore(path.join(localParityProjectRoot, ".synapsor/local.db"));
  try {
    return verifyLocalExploreAuditRecords({
      engine: "mysql",
      evidence: store.listEvidenceBundles(),
      audits: store.listQueryAudit(),
      expected_successes: successful.length,
      expected_refusals: 1,
      forbidden_values: [identity.tenant, identity.principal, "not-reviewed", "operator-only"],
      result_path: path.join(outputRoot, "mysql-local-audit.json"),
    });
  } finally {
    store.close();
  }
}

function comparableAnalyticsResult(result) {
  return {
    ok: result.ok,
    status: result.outcome?.status ?? result.outcome?.result?.status,
    data: result.data,
    privacy: {
      minimum_cohort_size: result.privacy?.minimum_cohort_size,
      suppressed_groups: result.privacy?.suppressed_groups,
      enum_allowlist_excluded_rows: result.privacy?.enum_allowlist_excluded_rows,
    },
  };
}

function generatedAuthorityText(projectRoot, configPath) {
  const roots = [configPath, path.join(projectRoot, ".synapsor"), path.join(projectRoot, "synapsor/generated")];
  const files = [];
  const visit = (entry) => {
    if (!fs.existsSync(entry)) return;
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    if (/\.(?:json|md|sql|txt|ya?ml)$/i.test(entry)) files.push(entry);
  };
  for (const entry of roots) visit(entry);
  return files.map((file) => `${file}\n${fs.readFileSync(file, "utf8")}`).join("\n");
}

function assertConfigAndArtifactHygiene(input) {
  const text = generatedAuthorityText(input.projectRoot, input.configPath);
  for (const secret of input.forbiddenValues.filter(Boolean)) {
    assert(!text.includes(secret), "MySQL production Explore config or artifact persisted secret material.", secret);
  }
  assert(!/-----BEGIN (?:RSA )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./i.test(text),
    "MySQL production Explore config or artifact persisted a private JWT key or bearer token.");
}

async function verifySingleOrganizationProductionExplore(input) {
  const { controlSchema, controlUrl, mysqlAdmin, privateKey, publicKey } = input;
  const clients = [];
  let server;
  const before = await singleOrganizationSourceSnapshot(mysqlAdmin);
  const env = {
    ...process.env,
    MYSQL_SINGLE_ORG_DATABASE_URL: mysqlSingleOrganizationReadUrl,
    SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
    SYNAPSOR_SESSION_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }),
    SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "single-organization-mysql-budget-hmac-key-material-1234567890",
  };
  delete env.SYNAPSOR_TENANT_ID;
  try {
    const inspection = await inspectDatabase({
      engine: "mysql",
      databaseUrlEnv: "MYSQL_SINGLE_ORG_DATABASE_URL",
      schema: singleOrganizationSchema,
      env,
    });
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: singleOrganizationProjectRoot,
        package_manager: "unknown",
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["MYSQL_SINGLE_ORG_DATABASE_URL"],
      },
      sourceEnv: "MYSQL_SINGLE_ORG_DATABASE_URL",
      inspectedSchema: singleOrganizationSchema,
      deploymentProfile: "production",
      httpClaims: { principalClaim: "sub" },
      singleOrganization: { organizationId: "internal-finance" },
    });
    await writeAutoBoundaryArtifacts({ projectRoot: singleOrganizationProjectRoot, build });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "mysql_internal_finance_production";
    assert(candidate.pack.resources.length === 1
      && candidate.pack.resources[0].id === singleOrganizationSourceId
      && candidate.pack.resources[0].tenant_key === undefined
      && candidate.pack.resources[0].tenant_scope === undefined,
    "MySQL single-organization boundary did not retain one tenant-free reviewed resource.", candidate);
    candidate.budgets.max_queries_per_session = 1;
    candidate.budgets.rate_limit_per_minute = 10;
    candidate.budgets.max_extracted_cells_per_session = 100;
    candidate.budgets.max_differencing_queries = 10;
    const boundaryDigest = explorationBoundaryCandidateDigest(candidate);
    await activateExplorationBoundary({
      projectRoot: singleOrganizationProjectRoot,
      candidate,
      expectedDigest: boundaryDigest,
      actor: "production-owner@example.test",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });

    const runtimeConfig = {
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: path.join(singleOrganizationProjectRoot, ".synapsor/local.db"),
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
          schema: controlSchema,
          lock_timeout_ms: 5_000,
          max_entries: 100_000,
        },
      },
      sources: {
        [candidate.source]: {
          engine: "mysql",
          read_url_env: "MYSQL_SINGLE_ORG_DATABASE_URL",
          statement_timeout_ms: 3_000,
        },
      },
      trusted_context: { provider: "http_claims" },
      session_auth: {
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        public_key_env: "SYNAPSOR_SESSION_PUBLIC_KEY",
        issuer: "https://identity.example",
        audience: "https://runner.example/mcp",
        principal_claim: "sub",
      },
      http_security: {
        deployment: "shared",
        channel: "trusted_tls_proxy",
        allowed_hosts: ["127.0.0.1"],
        oauth_resource: {
          resource: "https://runner.example/mcp",
          authorization_servers: ["https://identity.example"],
          scopes_supported: ["synapsor.explore"],
          required_scopes: ["synapsor.explore"],
        },
      },
      production_explore: {
        enabled: true,
        project_root: singleOrganizationProjectRoot,
        required_oauth_scope: "synapsor.explore",
        budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
        accounting_namespace: "verify.production.mysql.single-organization",
        single_organization_id: "internal-finance",
        source_max_connections: 2,
        max_sessions_per_principal: 2,
        tenant_limits: {
          max_queries_per_rolling_24_hours: 100,
          max_extracted_cells_per_rolling_24_hours: 10_000,
          max_differencing_queries_per_rolling_24_hours: 100,
          requests_per_minute: 100,
          max_response_cells_per_response: 500,
        },
      },
    };
    const posture = await assertProductionExploreStartup(runtimeConfig, env);
    assert(posture.ok && posture.tools.join(",") === "app.describe_data,app.explore_data",
      "MySQL single-organization production posture did not pass startup attestation.", posture);
    server = await startStreamableHttpMcpServer({
      config: runtimeConfig,
      env,
      host: "127.0.0.1",
      port: 0,
      trustedTlsProxy: true,
      log: false,
      streamableSessionFactory: productionExploreSessionFactory(runtimeConfig, env),
    });

    const alice = mcpClient(server.url, signedToken(privateKey, { tenant: undefined, principal: "analyst-a" }));
    clients.push(alice.client);
    await alice.client.connect(alice.transport);
    const tools = await alice.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "MySQL single-organization MCP exposed an unexpected tool surface.", tools.tools);
    const described = resultPayload(await alice.client.callTool({ name: "app.describe_data", arguments: {} }));
    const describedText = JSON.stringify(described);
    assert(describedText.includes("single_organization") && !describedText.includes("internal-finance"),
      "MySQL model-facing catalog did not report the fixed posture safely.", described);
    assert(described.resources?.[0]?.id === singleOrganizationSourceId
      && !("label" in described.resources[0])
      && !("plan_resource" in described.resources[0]),
    "MySQL production describe_data did not publish one canonical resource id.", described);
    const plan = {
      kind: "aggregate",
      resource: "activity",
      measures: [{ function: "count" }, { function: "sum", field: "amount_cents" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const aliceResult = resultPayload(await alice.client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    }));
    assert(aliceResult.ok === true
      && aliceResult.source_database_changed === false
      && aliceResult.data.length === 2
      && aliceResult.data.reduce((sum, row) => sum + row.count, 0) === 12,
    "MySQL principal-only production Explore did not resolve an unambiguous table alias.", aliceResult);
    const exhausted = await alice.client.callTool({ name: "app.explore_data", arguments: { plan } });
    const exhaustedText = JSON.stringify(exhausted);
    assert(exhausted.isError === true
      && exhaustedText.includes("Authenticated-principal budget: query-volume allowance exhausted")
      && exhaustedText.includes("Used 1 of 1 queries")
      && exhaustedText.includes("expire no later than")
      && exhaustedText.includes("L Limits"),
      "The MySQL single-organization principal did not exhaust only its own reviewed budget.", exhausted);

    const bob = mcpClient(server.url, signedToken(privateKey, { tenant: undefined, principal: "analyst-b" }));
    clients.push(bob.client);
    await bob.client.connect(bob.transport);
    const bobResult = resultPayload(await bob.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(bobResult.ok === true && bobResult.data.length === 2,
      "A second MySQL principal was starved by the first principal in the fixed organization.", bobResult);

    const missingPrincipal = mcpClient(server.url, signedToken(privateKey, { tenant: undefined, principal: undefined }));
    clients.push(missingPrincipal.client);
    await missingPrincipal.client.connect(missingPrincipal.transport)
      .then(() => { throw new Error("JWT without a principal unexpectedly initialized MySQL single-organization Explore."); })
      .catch((error) => assert(/401|unauthorized/i.test(String(error)),
        "MySQL single-organization Explore did not require a verified principal.", String(error)));
    const after = await singleOrganizationSourceSnapshot(mysqlAdmin);
    assert(JSON.stringify(after) === JSON.stringify(before),
      "Single-organization production Explore mutated its MySQL source database.", { before, after });
    return {
      tools: tools.tools.map((tool) => tool.name),
      principal_only_jwt: true,
      fixed_organization: true,
      principal_budget_isolated: true,
      source_database_changed: false,
    };
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await server?.close().catch(() => undefined);
  }
}

async function main() {
  run("docker", ["compose", "-p", composeProject, "-f", compose, "up", "-d", "--wait", "postgres", "mysql"], { inherit: true });
  const mysqlAdmin = await mysql.createConnection({ uri: mysqlAdminUrl, multipleStatements: true });
  const control = new Pool({ connectionString: controlUrl, max: 1 });
  const soakRequested = productionExploreSoakRequested();
  const multiBoundaryOnly = process.env.SYNAPSOR_VERIFY_MYSQL_MULTI_BOUNDARY_ONLY === "1";
  const soakIdentities = soakRequested ? productionExploreSoakIdentities() : [];
  let server;
  let tenantBudgetServer;
  const clients = [];
  try {
    await seedSource(mysqlAdmin);
    if (soakRequested) await seedMysqlSoakPrincipals(mysqlAdmin, soakIdentities);
    const before = await sourceSnapshot(mysqlAdmin);
    const env = { ...process.env, MYSQL_DATABASE_URL: mysqlReadUrl };
    const inspection = await inspectDatabase({
      engine: "mysql",
      databaseUrlEnv: "MYSQL_DATABASE_URL",
      schema: sourceSchema,
      env,
    });
    assert(inspection.role_posture?.verified === true && inspection.role_posture.read_only === true,
      "MySQL production fixture reader is not demonstrably read-only.", inspection.role_posture);
    const mysqlAuthoringLifecycle = await verifyMysqlProductionAuthoringLifecycle({ inspection, env });
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: projectRoot,
        package_manager: "unknown",
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["MYSQL_DATABASE_URL"],
      },
      sourceEnv: "MYSQL_DATABASE_URL",
      inspectedSchema: sourceSchema,
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
      configuredTrustedContext: {
        schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
        provider: "http_claims",
        tenant_binding: "tenant_id",
        principal_binding: "owner_id",
        tenant_claim: "tenant_id",
        principal_claim: "sub",
      },
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          [sourceId]: {
            metadata: {
              label: "Customer events",
              description: "Reviewed customer events used for account analysis.",
              actor: "production-owner@example.test",
              reason: "Give operators and AI clients business context without changing resource authority.",
              decided_at: "2026-08-10T12:00:00.000Z",
            },
            field_metadata: {
              category: {
                label: "Event category",
                description: "Reviewed category used to group customer events.",
                actor: "production-owner@example.test",
                reason: "Clarify an existing reviewed grouping field.",
                decided_at: "2026-08-10T12:01:00.000Z",
              },
            },
            tenant_key: {
              value: "tenant_id",
              actor: "production-owner@example.test",
              reason: "The application owner confirms tenant_id is the row authorization boundary.",
              decided_at: "2026-08-04T00:00:00.000Z",
            },
            principal_key: {
              value: "owner_id",
              actor: "production-owner@example.test",
              reason: "The verified principal claim scopes each reviewed event.",
              decided_at: "2026-08-08T00:00:00.000Z",
            },
          },
          [scopedOrdersId]: {
            tenant_key: {
              value: "tenant_id",
              actor: "production-owner@example.test",
              reason: "The application owner confirms tenant_id is the order authorization boundary.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
            principal_key: {
              value: "owner_id",
              actor: "production-owner@example.test",
              reason: "The verified owner claim scopes each reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
          },
          [scopedOrderItemsId]: {
            tenant_scope_path: {
              value: "scoped_order_items_order_id_fkey",
              actor: "production-owner@example.test",
              reason: "Every item belongs to the tenant of its required reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
            principal_scope_path: {
              value: "scoped_order_items_order_id_fkey",
              actor: "production-owner@example.test",
              reason: "Every item belongs to the principal of its required reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
          },
          [sharedProductCatalogId]: {
            field_metadata: {
              internal_notes: {
                label: "Operator internal notes",
                description: "Human-only catalog context that must remain outside model metadata.",
                actor: "production-owner@example.test",
                reason: "Help the human reviewer recognize a field that remains kept out.",
                decided_at: "2026-08-10T12:02:00.000Z",
              },
            },
            fields: {
              internal_notes: {
                exposure: "keep_out",
                actor: "production-owner@example.test",
                reason: "Internal catalog notes are never part of reviewed model access.",
                decided_at: "2026-08-10T12:02:00.000Z",
              },
            },
            shared_reference_scope: {
              value: SHARED_REFERENCE_ACKNOWLEDGEMENT,
              actor: "production-owner@example.test",
              reason: "This centrally maintained catalog contains the same reviewed rows for every tenant.",
              decided_at: "2026-08-07T12:00:00.000Z",
            },
          },
        },
      },
    });
    await writeAutoBoundaryArtifacts({ projectRoot, build });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "mysql_events_production";
    candidate.pack.resources = candidate.pack.resources.filter((resource) => [
      sourceId,
      scopedOrdersId,
      scopedOrderItemsId,
      sharedProductCatalogId,
    ].includes(resource.id));
    assert(candidate.pack.resources.length === 4,
      "MySQL production fixture did not draft its direct, derived, and shared-reference resources.", candidate.pack.resources);
    const resource = candidate.pack.resources.find((candidateResource) => candidateResource.id === sourceId);
    const scopedOrders = candidate.pack.resources.find((candidateResource) => candidateResource.id === scopedOrdersId);
    const scopedOrderItems = candidate.pack.resources.find((candidateResource) => candidateResource.id === scopedOrderItemsId);
    const sharedProductCatalog = candidate.pack.resources.find((candidateResource) =>
      candidateResource.id === sharedProductCatalogId);
    assert(resource && scopedOrders && scopedOrderItems?.tenant_scope && scopedOrderItems?.principal_scope
      && sharedProductCatalog?.shared_reference_scope?.acknowledgement === SHARED_REFERENCE_ACKNOWLEDGEMENT,
    "MySQL production fixture did not preserve its derived scope and explicit shared-reference authority.", candidate.pack.resources);
    assert(resource.label === "Customer events"
      && resource.description === "Reviewed customer events used for account analysis."
      && resource.field_metadata?.category?.label === "Event category"
      && sharedProductCatalog.field_metadata?.internal_notes?.label === "Operator internal notes"
      && sharedProductCatalog.kept_out_fields.includes("internal_notes"),
    "MySQL production fixture did not bind reviewed metadata while keeping internal_notes out.", {
      resource,
      sharedProductCatalog,
    });
    assert(
      JSON.stringify(resource.field_enums.category)
        === JSON.stringify(["growth", "retained", "private-small", "enterprise", "partner"]),
      "MySQL ENUM values did not reach the reviewed boundary from live schema metadata.",
      resource.field_enums,
    );
    resource.selectable_fields = ["category", "amount_cents", "occurred_at"];
    resource.filterable_fields = Object.fromEntries(Object.entries(resource.filterable_fields)
      .filter(([field]) => resource.selectable_fields.includes(field)));
    resource.sortable_fields = resource.sortable_fields.filter((field) => resource.selectable_fields.includes(field));
    resource.groupable_fields = resource.groupable_fields.filter((field) => field === "category");
    resource.aggregate_measures = resource.aggregate_measures.filter((field) => field === "amount_cents");
    resource.count_distinct_fields = resource.count_distinct_fields.filter((field) => field === "id");
    resource.time_bucket_fields = Object.fromEntries(Object.entries(resource.time_bucket_fields)
      .filter(([field]) => field === "occurred_at"));
    resource.relationships = [];
    resource.numeric_bands = [{
      name: "amount_band",
      label: "Amount band",
      field: "amount_cents",
      edges: [150, 300],
      bucket_labels: ["under 150", "150 to 299", "300 or more"],
    }];
    resource.auto_bands = [{
      field: "amount_cents",
      methods: ["quantile", "equal_width"],
      min_buckets: 2,
      max_buckets: 8,
      min_bucket_width: 250,
      label_style: "ordinal",
    }];
    resource.derived_measures = [{
      name: "amount_running_total",
      label: "Amount running total",
      shape: "running_total",
      base_measure: { function: "sum", field: "amount_cents" },
    }];
    narrowDerivedResources(scopedOrders, scopedOrderItems);
    scopedOrders.derived_measures = [{
      name: "scoped_order_item_count",
      label: "Scoped order item count",
      shape: "child_count_total",
      child_resource: scopedOrderItemsId,
      relationship: "scoped_order_items_order_id_fkey",
    }];
    sharedProductCatalog.selectable_fields = ["category"];
    sharedProductCatalog.filterable_fields = Object.fromEntries(
      Object.entries(sharedProductCatalog.filterable_fields).filter(([field]) => field === "category"),
    );
    sharedProductCatalog.sortable_fields = sharedProductCatalog.sortable_fields
      .filter((field) => field === "category");
    sharedProductCatalog.groupable_fields = sharedProductCatalog.groupable_fields
      .filter((field) => field === "category");
    sharedProductCatalog.aggregate_measures = [];
    sharedProductCatalog.count_distinct_fields = [];
    sharedProductCatalog.time_bucket_fields = {};
    sharedProductCatalog.relationships = [];
    const indexChecks = derivedScopeIndexDoctorChecks({
      boundaries: [candidate],
      inspectionsBySource: new Map([[candidate.source, [inspection]]]),
    });
    assert(indexChecks.some((check) => check.name === "derived-scope-indexes:complete"
      && check.message.includes("2 reviewed derived-scope paths")),
    "MySQL information_schema.STATISTICS did not attest the live derived-scope indexes.", indexChecks);

    const localBuild = buildAutoBoundary({
      inspection,
      project: {
        root: localParityProjectRoot,
        package_manager: "unknown",
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["MYSQL_DATABASE_URL"],
      },
      sourceEnv: "MYSQL_DATABASE_URL",
      inspectedSchema: sourceSchema,
      deploymentProfile: "staging",
      overrides: build.overrides,
    });
    await writeAutoBoundaryArtifacts({ projectRoot: localParityProjectRoot, build: localBuild });
    const localCandidate = structuredClone(localBuild.exploration_boundary);
    localCandidate.pack.name = "mysql_events_local_parity";
    localCandidate.pack.resources = structuredClone(candidate.pack.resources);
    const localDigest = explorationBoundaryCandidateDigest(localCandidate);
    await activateExplorationBoundary({
      projectRoot: localParityProjectRoot,
      candidate: localCandidate,
      expectedDigest: localDigest,
      actor: "production-e2e-local-parity@example.test",
      confirmation: `ACTIVATE ${localDigest}`,
      confirmedDecisions: localCandidate.unresolved_decisions,
      currentInspection: inspection,
    });

    if (!soakRequested && !multiBoundaryOnly) {
      candidate.budgets.max_queries_per_session = 1;
      candidate.budgets.rate_limit_per_minute = 10;
      candidate.budgets.max_extracted_cells_per_session = 100;
      candidate.budgets.max_differencing_queries = 10;
    }
    const boundaryDigest = explorationBoundaryCandidateDigest(candidate);
    await activateExplorationBoundary({
      projectRoot,
      candidate,
      expectedDigest: boundaryDigest,
      actor: "production-owner@example.test",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });

    if (multiBoundaryOnly) {
      const second = await createSavedBoundary({
        projectRoot,
        draft: build.exploration_boundary,
        currentCandidate: candidate,
        name: "mysql_events_secondary",
        resourceId: sourceId,
        actor: "secondary-production-owner@example.test",
      });
      assert(second.candidate.pack.resources.length === 1
        && second.candidate.pack.resources[0]?.id === sourceId
        && second.candidate.pack.resources[0]?.tenant_key === "tenant_id"
        && second.candidate.pack.resources[0]?.principal_key === "owner_id",
      "MySQL second-boundary creation did not retain the explicitly configured reviewed scope.", second.candidate);
      const secondDigest = explorationBoundaryCandidateDigest(second.candidate);
      const secondLock = await loadGenerationLockSnapshot(
        projectRoot,
        second.candidate.generation_lock_fingerprint,
      );
      await activateExplorationBoundary({
        projectRoot,
        candidate: second.candidate,
        reviewDraft: second.candidate,
        generationLock: secondLock,
        expectedDigest: secondDigest,
        actor: "secondary-production-owner@example.test",
        confirmation: `ACTIVATE ${secondDigest}`,
        confirmedDecisions: second.candidate.unresolved_decisions,
        currentInspection: inspection,
        activeSetMode: "add",
      });
      const active = await loadActivatedExplorationBoundaries(projectRoot);
      assert(active.map((boundary) => boundary.pack.name).sort().join(",")
        === "mysql_events_production,mysql_events_secondary",
      "MySQL production active set did not retain both exact reviewed boundaries.", active);
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const runtimeConfig = {
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: path.join(projectRoot, ".synapsor/local.db"),
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
          schema: controlSchema,
          lock_timeout_ms: 5_000,
          max_entries: 100_000,
        },
      },
      sources: {
        [build.exploration_boundary.source]: {
          engine: "mysql",
          read_url_env: "MYSQL_DATABASE_URL",
          statement_timeout_ms: 3_000,
        },
      },
      trusted_context: {
        provider: "http_claims",
        tenant_binding: "tenant_id",
        principal_binding: "owner_id",
      },
      session_auth: {
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        public_key_env: "SYNAPSOR_SESSION_PUBLIC_KEY",
        issuer: "https://identity.example",
        audience: "https://runner.example/mcp",
        tenant_claim: "tenant_id",
        principal_claim: "sub",
      },
      http_security: {
        deployment: "shared",
        channel: "trusted_tls_proxy",
        allowed_hosts: ["127.0.0.1"],
        oauth_resource: {
          resource: "https://runner.example/mcp",
          authorization_servers: ["https://identity.example"],
          scopes_supported: ["synapsor.explore"],
          required_scopes: ["synapsor.explore"],
        },
      },
      production_explore: {
        enabled: true,
        project_root: projectRoot,
        required_oauth_scope: "synapsor.explore",
        budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
        accounting_namespace: "verify.production.mysql",
        source_max_connections: 2,
        max_sessions_per_principal: 2,
        tenant_limits: {
          max_queries_per_rolling_24_hours: 100,
          max_extracted_cells_per_rolling_24_hours: 10_000,
          max_differencing_queries_per_rolling_24_hours: 100,
          requests_per_minute: 100,
          max_response_cells_per_response: 500,
        },
      },
    };
    if (soakRequested) applyProductionExploreSoakBudgets(undefined, runtimeConfig);
    Object.assign(env, {
      SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
      SYNAPSOR_SESSION_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }),
      SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "shared-production-mysql-hmac-key-material-1234567890",
    });
    const posture = await assertProductionExploreStartup(runtimeConfig, env);
    assert(posture.ok, "MySQL production Explore posture did not pass startup attestation.", posture);
    const configPath = path.join(projectRoot, "synapsor.runner.json");
    fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
    assertConfigAndArtifactHygiene({
      projectRoot,
      configPath,
      forbiddenValues: [mysqlReadUrl, mysqlAdminUrl, controlUrl, env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY],
    });
    const migrationInvocation = productionExploreRunnerInvocation(root, [
      "store", "shared-postgres", "apply-migration",
      "--schema", controlSchema,
      "--url-env", "SYNAPSOR_CONTROL_DATABASE_URL",
      "--yes",
    ]);
    run(migrationInvocation.command, migrationInvocation.args, { env });
    for (const presentationArgs of [
      ["--result-format", "json"],
      ["--tool-name-style", "snake_case"],
    ]) {
      const rejectedInvocation = productionExploreRunnerInvocation(root, [
        "mcp", "serve",
        "--transport", "streamable-http",
        "--production-explore",
        "--config", configPath,
        "--host", "127.0.0.1",
        "--trusted-tls-proxy",
        ...presentationArgs,
      ]);
      const rejected = run(rejectedInvocation.command, rejectedInvocation.args, { env, allowFailure: true });
      assert(rejected.status !== 0
        && /fixed app\.describe_data\/app\.explore_data|not available on this surface/i.test(`${rejected.stdout}\n${rejected.stderr}`),
      `MySQL production Explore accepted presentation override ${presentationArgs[0]}.`, rejected);
    }
    server = await startProductionExploreCli({ root, configPath, env });
    if (multiBoundaryOnly) {
      const scoped = mcpClient(server.url, signedToken(privateKey, {
        tenant: "acme",
        principal: "alice",
      }));
      clients.push(scoped.client);
      await scoped.client.connect(scoped.transport);
      const tools = await scoped.client.listTools();
      assert(tools.tools.map((tool) => tool.name).join(",")
        === "app.describe_data,app.explore_data",
      "MySQL multi-boundary HTTP verification exposed an unexpected tool surface.", tools);
      const described = resultPayload(await scoped.client.callTool({
        name: "app.describe_data",
        arguments: {},
      }));
      assert(described.boundaries?.map((boundary) => boundary.name).sort().join(",")
        === "mysql_events_production,mysql_events_secondary",
      "MySQL HTTP catalog did not span both exact reviewed boundaries.", described);
      const plan = {
        kind: "aggregate",
        resource: sourceId,
        measures: [{ function: "count" }],
        dimensions: [{ field: "category" }],
        top_n: 10,
      };
      const ambiguous = await scoped.client.callTool({
        name: "app.explore_data",
        arguments: { plan },
      });
      assert(ambiguous.isError === true
        && /EXPLORE_BOUNDARY_REQUIRED/.test(JSON.stringify(ambiguous)),
      "MySQL overlapping resource did not fail closed without an exact boundary selector.", ambiguous);
      const primary = resultPayload(await scoped.client.callTool({
        name: "app.explore_data",
        arguments: { boundary: "mysql_events_production", plan },
      }));
      const secondary = resultPayload(await scoped.client.callTool({
        name: "app.explore_data",
        arguments: { boundary: "mysql_events_secondary", plan },
      }));
      assert(primary.ok === true && primary.boundary_name === "mysql_events_production",
        "MySQL query did not route through the primary boundary.", primary);
      assert(secondary.ok === true && secondary.boundary_name === "mysql_events_secondary",
        "MySQL query did not route through the secondary boundary.", secondary);
      assert(JSON.stringify(primary.rows) === JSON.stringify(secondary.rows),
        "Equivalent MySQL reviewed boundaries returned different scoped aggregates.", { primary, secondary });
      const after = await sourceSnapshot(mysqlAdmin);
      assert(JSON.stringify(after) === JSON.stringify(before),
        "MySQL multi-boundary verification mutated the source database.", { before, after });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        engine: "mysql",
        active_boundaries: described.boundaries.map((boundary) => boundary.name).sort(),
        tools: tools.tools.map((tool) => tool.name),
        ambiguity_refused: true,
        primary_boundary_query: primary.ok,
        secondary_boundary_query: secondary.ok,
        source_database_changed: false,
      }, null, 2)}\n`);
      return;
    }
    const generatedHttpClients = await verifyGeneratedProductionHttpClientConfigs({
      root,
      configPath,
      env,
      serverUrl: server.url,
      protectedResource: "https://runner.example/mcp",
      authorizationServer: "https://identity.example",
      tokenForPrincipal: (principal) => signedToken(privateKey, { tenant: "acme", principal }),
    });

    const authCountsBefore = await productionControlCounts(control, controlSchema);
    const wrongKeyPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const authRefusals = await verifyJwtRejectionMatrix({
      url: server.url,
      privateKey,
      wrongPrivateKey: wrongKeyPair.privateKey,
      tenant: "acme",
      principal: "alice",
    });
    const authCountsAfter = await productionControlCounts(control, controlSchema);
    assert(authRefusals.length === 11,
      "MySQL production Explore did not execute the complete JWT rejection matrix.", authRefusals);
    assert(JSON.stringify(authCountsAfter) === JSON.stringify(authCountsBefore),
      "A MySQL authentication failure reached query budget or evidence accounting.", {
        before: authCountsBefore,
        after: authCountsAfter,
      });

    if (soakRequested) {
      const outputRoot = process.env.SYNAPSOR_SOAK_OUTPUT_DIR?.trim()
        || path.resolve(root, "..", "synapsor-1.7.0-soak");
      const operations = mysqlSoakOperations();
      const groupedOperation = operations.find((operation) => operation.name === "grouped_count_sum");
      const recoveryIdentity = soakIdentities.at(-1);
      const loadIdentities = soakIdentities.slice(0, -1);
      const result = await runProductionExploreHttpSoak({
        engine: "mysql",
        server_pid: server.child.pid,
        server_exit_state: server.exitState,
        source_connection_ceiling: runtimeConfig.production_explore.source_max_connections,
        source_connection_count: async () => {
          const [rows] = await mysqlAdmin.query(`
            SELECT COUNT(*) AS count
            FROM information_schema.PROCESSLIST
            WHERE USER = 'synapsor_production_reader'
          `);
          return Number(rows[0]?.count ?? 0);
        },
        identities: loadIdentities,
        create_client: async (identity) => mcpClient(server.url, signedToken(privateKey, identity)),
        operations,
        result_path: path.join(outputRoot, "mysql-http-soak.json"),
      });
      const countsAfterSoak = await productionControlCounts(control, controlSchema);
      assert(Number(countsAfterSoak.audit_events) > Number(authCountsAfter.audit_events)
        && Number(countsAfterSoak.budget_reservations) > Number(authCountsAfter.budget_reservations),
      "MySQL soak traffic did not produce durable budget and metadata-only audit records.", {
        before: authCountsAfter,
        after: countsAfterSoak,
      });
      const audit = await verifyProductionExploreAuditSink({
        engine: "mysql",
        control,
        schema: controlSchema,
        soak: result,
        forbidden_values: [
          "soak-",
          "operator-only",
          "synthetic kept-out",
        ],
        result_path: path.join(outputRoot, "mysql-http-audit.json"),
      });

      await stopProductionExploreCli(server);
      await waitForSourceConnectionQuiescence({
        engine: "mysql",
        source_connection_count: async () => {
          const [rows] = await mysqlAdmin.query(`
            SELECT COUNT(*) AS count
            FROM information_schema.PROCESSLIST
            WHERE USER = 'synapsor_production_reader'
          `);
          return Number(rows[0]?.count ?? 0);
        },
      });
      server = await startProductionExploreCli({ root, configPath, env });
      const recovery = await runProductionExploreRecovery({
        engine: "mysql",
        server_pid: server.child.pid,
        source_connection_ceiling: runtimeConfig.production_explore.source_max_connections,
        source_connection_count: async () => {
          const [rows] = await mysqlAdmin.query(`
            SELECT COUNT(*) AS count
            FROM information_schema.PROCESSLIST
            WHERE USER = 'synapsor_production_reader'
          `);
          return Number(rows[0]?.count ?? 0);
        },
        identity: recoveryIdentity,
        create_client: async (identity) => mcpClient(server.url, signedToken(privateKey, identity)),
        request: groupedOperation.request,
        validate: groupedOperation.validate,
        result_path: path.join(outputRoot, "mysql-http-recovery.json"),
      });
      await stopProductionExploreCli(server);
      server = undefined;
      const localAudit = await verifyMysqlLocalExploreAudit(
        env,
        soakIdentities[0],
        operations,
        outputRoot,
      );
      const after = await sourceSnapshot(mysqlAdmin);
      assert(JSON.stringify(after) === JSON.stringify(before),
        "MySQL production HTTP soak mutated the source database.", { before, after });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        engine: "mysql",
        soak: result,
        local_audit: localAudit,
        audit,
        recovery,
        auth_rejections: authRefusals.length,
        source_database_changed: false,
      }, null, 2)}\n`);
      return;
    }

    const plan = {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ function: "count" }, { function: "sum", field: "amount_cents" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const alice = mcpClient(server.url, signedToken(privateKey, { tenant: "acme", principal: "alice" }));
    clients.push(alice.client);
    await alice.client.connect(alice.transport);
    const tools = await alice.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "MySQL production MCP exposed an unexpected tool surface.", tools.tools);

    const described = resultPayload(await alice.client.callTool({ name: "app.describe_data", arguments: {} }));
    const describedEvents = described.resources?.find((candidateResource) => candidateResource.id === sourceId);
    const focusedTimeDescription = resultPayload(await alice.client.callTool({
      name: "app.describe_data",
      arguments: { resource: sourceId },
    }));
    const describedItems = described.resources?.find((candidateResource) => candidateResource.id === scopedOrderItemsId);
    assert(described.ok === true
      && described.resources?.length === 4
      && JSON.stringify(describedEvents?.field_enums?.category)
        === JSON.stringify(["growth", "retained", "private-small", "enterprise", "partner"])
      && describedEvents?.label === "Customer events"
      && describedEvents?.description === "Reviewed customer events used for account analysis."
      && describedEvents?.fields?.some((field) => field.id === "category"
        && field.label === "Event category"
        && field.description === "Reviewed category used to group customer events.")
      && !described.resources?.some((candidateResource) => candidateResource.fields?.some((field) =>
        field.id === "internal_notes" || field.label === "Operator internal notes"))
      && describedEvents?.numeric_bands?.some((band) => band.name === "amount_band")
      && describedEvents?.auto_bands?.some((policy) => policy.field === "amount_cents"
        && JSON.stringify(policy.methods) === JSON.stringify(["quantile", "equal_width"])
        && policy.min_buckets === 2
        && policy.max_buckets === 8
        && policy.label_style === "ordinal"
        && policy.raw_edges_returned === false
        && !Object.hasOwn(policy, "min_bucket_width"))
      && describedEvents?.derived_measures?.some((measure) => measure.name === "amount_running_total")
      && !Object.hasOwn(described, "relative_time_windows")
      && focusedTimeDescription.relative_time_windows?.available === true
      && focusedTimeDescription.relative_time_windows?.reporting_timezone === "UTC"
      && focusedTimeDescription.relative_time_windows?.windows?.includes("last_7_days")
      && describedEvents?.relative_time_window_fields?.includes("occurred_at")
      && describedItems?.relationships?.some((relationship) =>
        relationship.id === "scoped_order_items_order_id_fkey" && relationship.activation === "active"),
    "MySQL production describe_data did not return the complete reviewed metadata catalog.", described);
    assert(!JSON.stringify(described).match(/a-private-|bob-[1-5]|operator-only hardware note|derived-acme-item/i),
      "MySQL production describe_data returned source-row data instead of metadata only.", described);

    const injectedScope = await alice.client.callTool({
      name: "app.explore_data",
      arguments: {
        tenant_id: "globex",
        principal: "carol",
        plan: { ...plan, tenant_id: "globex", principal: "carol" },
      },
    });
    assert(injectedScope.isError === true
      && /unrecognized|unsupported|invalid/i.test(JSON.stringify(injectedScope)),
    "MySQL production Explore accepted model-supplied tenant or principal authority.", injectedScope);

    const invalidEnum = await alice.client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          ...plan,
          where: [{ field: "category", op: "eq", value: "not-a-reviewed-category" }],
        },
      },
    });
    assert(invalidEnum.isError === true
      && /not a reviewed value|growth.*retained.*private-small.*enterprise.*partner/i.test(JSON.stringify(invalidEnum)),
    "MySQL production Explore did not enforce the reviewed enum allowlist before execution.", invalidEnum);

    const aliceResult = resultPayload(await alice.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(aliceResult.ok === true && aliceResult.privacy?.suppressed_groups === 1,
      "MySQL production Explore did not return the expected suppressed aggregate.", aliceResult);
    assert(!JSON.stringify(aliceResult).match(/globex|enterprise|partner|private-small|SELECT\s|`events`/i),
      "MySQL production result leaked another tenant, a suppressed label, or compiled SQL.", aliceResult);
    const localAliceResult = await runLocalParityPlan(env, "alice", plan);
    assert(JSON.stringify(comparableAnalyticsResult(localAliceResult))
      === JSON.stringify(comparableAnalyticsResult(aliceResult)),
    "MySQL suppression or reviewed enum grouping differed between local stdio and production HTTP.", {
      local: comparableAnalyticsResult(localAliceResult),
      http: comparableAnalyticsResult(aliceResult),
    });

    const evidenceRows = await control.query(`
      SELECT event_id, event_kind, payload_json
      FROM "${controlSchema}".production_explore_audit_events
      WHERE event_id = $1 OR payload_json::text LIKE $2 OR payload_json::text LIKE $3
      ORDER BY event_kind
    `, [
      aliceResult.evidence_bundle_id,
      `%${aliceResult.evidence_bundle_id}%`,
      `%${aliceResult.audit.query_fingerprint}%`,
    ]);
    const evidenceSerialized = JSON.stringify(evidenceRows.rows);
    const evidenceEvent = evidenceRows.rows.find((row) => row.event_kind === "evidence_bundle");
    assert(evidenceEvent
      && Array.isArray(evidenceEvent.payload_json?.evidence_bundle?.query_audit)
      && evidenceEvent.payload_json.evidence_bundle.query_audit.length === 1
      && /"tenant_id":"keyed:[a-f0-9]{64}"/i.test(evidenceSerialized)
      && /"result_fingerprint":"hmac-sha256:[a-f0-9]{64}"/i.test(evidenceSerialized)
      && /"result_values_persisted":false/i.test(evidenceSerialized)
      && !evidenceSerialized.includes("acme")
      && !evidenceSerialized.includes("alice")
      && !evidenceSerialized.includes("operator-only"),
    "MySQL production evidence did not preserve keyed scope, metadata-only audit, and fingerprint invariants.",
    evidenceRows.rows);

    const relativePlan = {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ function: "count" }],
      dimensions: [{ field: "category" }],
      time_window: { field: "occurred_at", window: "last_7_days" },
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const relativeClient = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "relative",
    }));
    clients.push(relativeClient.client);
    await relativeClient.client.connect(relativeClient.transport);
    const relativeResult = resultPayload(await relativeClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: relativePlan },
    }));
    const localRelativeResult = await runLocalParityPlan(env, "relative", relativePlan);
    assert(relativeResult.ok === true
      && relativeResult.data?.length > 0
      && JSON.stringify(comparableAnalyticsResult(localRelativeResult))
        === JSON.stringify(comparableAnalyticsResult(relativeResult))
      && localRelativeResult.operator_time_windows?.[0]?.window === "last_7_days"
      && !Object.hasOwn(relativeResult, "operator_time_windows")
      && !JSON.stringify(relativeResult).match(/resolved_time_windows|start_inclusive|end_exclusive/i),
    "MySQL reviewed relative time differed between local stdio and production HTTP or exposed operator timestamps to the model.", {
      local: comparableAnalyticsResult(localRelativeResult),
      http: comparableAnalyticsResult(relativeResult),
    });
    const relativeEvidenceRows = await control.query(`
      SELECT event_kind, payload_json
      FROM "${controlSchema}".production_explore_audit_events
      WHERE event_id = $1 OR payload_json::text LIKE $2
      ORDER BY event_kind
    `, [
      relativeResult.evidence_bundle_id,
      `%${relativeResult.evidence_bundle_id}%`,
    ]);
    const relativeEvidence = JSON.stringify(relativeEvidenceRows.rows);
    assert(relativeEvidenceRows.rows.some((row) => row.event_kind === "evidence_bundle")
      && relativeEvidence.includes('"resolved_time_windows"')
      && relativeEvidence.includes('"window":"last_7_days"')
      && relativeEvidence.includes('"reporting_timezone":"UTC"')
      && /"start_inclusive":"[^"]+Z"/.test(relativeEvidence)
      && /"end_exclusive":"[^"]+Z"/.test(relativeEvidence)
      && !relativeEvidence.includes('"principal":"relative"'),
    "MySQL relative-window evidence did not preserve the exact resolved UTC range without raw principal identity.",
    relativeEvidenceRows.rows);

    const numericBandPlan = {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "amount_band" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const bandClient = mcpClient(server.url, signedToken(privateKey, { tenant: "acme", principal: "band" }));
    clients.push(bandClient.client);
    await bandClient.client.connect(bandClient.transport);
    const bandResult = resultPayload(await bandClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: numericBandPlan },
    }));
    const localBandResult = await runLocalParityPlan(env, "band", numericBandPlan);
    assert(bandResult.ok === true
      && bandResult.privacy?.suppressed_groups === 1
      && bandResult.data?.some((row) => row.amount_band === "under 150" && row.count === 5)
      && bandResult.data?.some((row) => row.amount_band === "150 to 299" && row.count === 5)
      && JSON.stringify(comparableAnalyticsResult(localBandResult))
        === JSON.stringify(comparableAnalyticsResult(bandResult)),
    "MySQL reviewed numeric bands differed between local stdio and production HTTP.", {
      local: comparableAnalyticsResult(localBandResult),
      http: comparableAnalyticsResult(bandResult),
    });

    const autoBandPlan = {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ function: "count" }],
      dimensions: [{
        numeric_band: {
          field: "amount_cents",
          method: "quantile",
          buckets: 2,
        },
      }],
      top_n: 10,
    };
    const autoBandClient = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "auto",
    }));
    clients.push(autoBandClient.client);
    await autoBandClient.client.connect(autoBandClient.transport);
    const autoBandResult = resultPayload(await autoBandClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: autoBandPlan },
    }));
    const localAutoBandResult = await runLocalParityPlan(env, "auto", autoBandPlan);
    const autoBandSerialized = JSON.stringify(autoBandResult);
    assert(autoBandResult.ok === true
      && autoBandResult.data?.length === 2
      && autoBandResult.data.every((row) => /^Q[12] of 2$/.test(row.amount_cents_quantile_band)
        && row.count === 6)
      && autoBandResult.privacy?.minimum_cohort_size === 5
      && autoBandResult.privacy?.auto_bands?.[0]?.requested_buckets === 2
      && autoBandResult.privacy?.auto_bands?.[0]?.effective_buckets === 2
      && autoBandResult.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && !autoBandSerialized.includes("__auto_")
      && !autoBandSerialized.match(/SELECT\s|amount_cents\s*[<>]=?\s*\d/i)
      && JSON.stringify(comparableAnalyticsResult(localAutoBandResult))
        === JSON.stringify(comparableAnalyticsResult(autoBandResult)),
    "MySQL reviewed automatic bands differed between local stdio and production HTTP or exposed raw edges.", {
      local: comparableAnalyticsResult(localAutoBandResult),
      http: comparableAnalyticsResult(autoBandResult),
    });

    const tieBandPlan = {
      ...autoBandPlan,
      dimensions: [{
        numeric_band: {
          field: "amount_cents",
          method: "quantile",
          buckets: 8,
        },
      }],
    };
    const tieBandClient = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "auto-ties",
    }));
    clients.push(tieBandClient.client);
    await tieBandClient.client.connect(tieBandClient.transport);
    const tieBandResult = resultPayload(await tieBandClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: tieBandPlan },
    }));
    const localTieBandResult = await runLocalParityPlan(env, "auto-ties", tieBandPlan);
    const tieCounts = new Map(tieBandResult.data?.map((row) => [
      row.amount_cents_quantile_band,
      row.count,
    ]));
    assert(tieBandResult.ok === true
      && tieCounts.size === 2
      && tieCounts.get("Q4 of 8") === 6
      && tieCounts.get("Q8 of 8") === 6
      && tieBandResult.privacy?.auto_bands?.[0]?.requested_buckets === 8
      && tieBandResult.privacy?.auto_bands?.[0]?.effective_buckets === 2
      && tieBandResult.privacy?.auto_bands?.[0]?.reduced === true
      && tieBandResult.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && JSON.stringify(comparableAnalyticsResult(localTieBandResult))
        === JSON.stringify(comparableAnalyticsResult(tieBandResult)),
    "MySQL tie-heavy quantiles did not collapse without splitting equal values.", {
      local: comparableAnalyticsResult(localTieBandResult),
      http: comparableAnalyticsResult(tieBandResult),
    });

    const equalWidthPlan = {
      ...autoBandPlan,
      dimensions: [{
        numeric_band: {
          field: "amount_cents",
          method: "equal_width",
          buckets: 8,
        },
      }],
    };
    const equalWidthClient = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "auto-equal",
    }));
    clients.push(equalWidthClient.client);
    await equalWidthClient.client.connect(equalWidthClient.transport);
    const equalWidthResult = resultPayload(await equalWidthClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: equalWidthPlan },
    }));
    const localEqualWidthResult = await runLocalParityPlan(env, "auto-equal", equalWidthPlan);
    assert(equalWidthResult.ok === true
      && equalWidthResult.data?.length === 1
      && equalWidthResult.data[0].amount_cents_equal_width_band === "Band 1 of 3"
      && equalWidthResult.data[0].count === 10
      && equalWidthResult.privacy?.suppressed_groups === 1
      && equalWidthResult.privacy?.auto_bands?.[0]?.requested_buckets === 8
      && equalWidthResult.privacy?.auto_bands?.[0]?.effective_buckets === 3
      && equalWidthResult.privacy?.auto_bands?.[0]?.reduced === true
      && equalWidthResult.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && !JSON.stringify(equalWidthResult).includes("__auto_")
      && JSON.stringify(comparableAnalyticsResult(localEqualWidthResult))
        === JSON.stringify(comparableAnalyticsResult(equalWidthResult)),
    "MySQL equal-width auto bands did not honor the reviewed minimum width and suppression.", {
      local: comparableAnalyticsResult(localEqualWidthResult),
      http: comparableAnalyticsResult(equalWidthResult),
    });
    const autoBandEvidenceRows = await control.query(`
      SELECT event_kind, payload_json
      FROM "${controlSchema}".production_explore_audit_events
      WHERE event_id = $1 OR payload_json::text LIKE $2
      ORDER BY event_kind
    `, [
      tieBandResult.evidence_bundle_id,
      `%${tieBandResult.evidence_bundle_id}%`,
    ]);
    const autoBandEvidence = JSON.stringify(autoBandEvidenceRows.rows);
    assert(autoBandEvidenceRows.rows.some((row) => row.event_kind === "evidence_bundle")
      && /"result_values_persisted":false/i.test(autoBandEvidence)
      && !/__auto_|"edges"|"raw_edges"|"bucket_min"|"bucket_max"/i.test(autoBandEvidence)
      && !autoBandEvidence.includes("auto-ties"),
    "MySQL automatic-band evidence persisted raw edges, result values, or principal identity.",
    autoBandEvidenceRows.rows);

    const runningTotalPlan = {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ derived_measure: "amount_running_total" }],
      dimensions: [{ field: "category" }],
      time_bucket: { field: "occurred_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 25,
    };
    const runningClient = mcpClient(server.url, signedToken(privateKey, { tenant: "acme", principal: "running" }));
    clients.push(runningClient.client);
    await runningClient.client.connect(runningClient.transport);
    const runningResult = resultPayload(await runningClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: runningTotalPlan },
    }));
    const localRunningResult = await runLocalParityPlan(env, "running", runningTotalPlan);
    assert(runningResult.ok === true
      && runningResult.privacy?.suppressed_groups >= 1
      && runningResult.data?.every((row) => Number.isFinite(row.amount_running_total))
      && JSON.stringify(comparableAnalyticsResult(localRunningResult))
        === JSON.stringify(comparableAnalyticsResult(runningResult)),
    "MySQL named post-suppression metrics differed between local stdio and production HTTP.", {
      local: comparableAnalyticsResult(localRunningResult),
      http: comparableAnalyticsResult(runningResult),
    });

    const exhausted = await alice.client.callTool({ name: "app.explore_data", arguments: { plan } });
    assert(exhausted.isError === true, "MySQL production principal budget did not enforce its reviewed query ceiling.", exhausted);

    const secondPrincipal = mcpClient(server.url, signedToken(privateKey, { tenant: "acme", principal: "bob" }));
    clients.push(secondPrincipal.client);
    await secondPrincipal.client.connect(secondPrincipal.transport);
    const secondResult = resultPayload(await secondPrincipal.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(secondResult.ok === true
      && secondResult.data.length === 1
      && secondResult.data[0].category === "partner"
      && secondResult.data[0].count === 5,
      "A second MySQL principal was starved by the first principal's budget.", secondResult);

    const globex = mcpClient(server.url, signedToken(privateKey, { tenant: "globex", principal: "carol" }));
    clients.push(globex.client);
    await globex.client.connect(globex.transport);
    const globexResult = resultPayload(await globex.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(globexResult.ok === true
      && globexResult.data.length === 1
      && globexResult.data[0].category === "enterprise"
      && globexResult.data[0].count === 5,
    "MySQL production tenant predicate did not isolate the Globex result.", globexResult);

    const sharedReferencePlan = {
      kind: "aggregate",
      resource: sharedProductCatalogId,
      measures: [{ function: "count" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const sharedAcme = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "shared-reference-acme",
    }));
    clients.push(sharedAcme.client);
    await sharedAcme.client.connect(sharedAcme.transport);
    const sharedAcmeResult = resultPayload(await sharedAcme.client.callTool({
      name: "app.explore_data",
      arguments: { plan: sharedReferencePlan },
    }));
    const sharedGlobex = mcpClient(server.url, signedToken(privateKey, {
      tenant: "globex",
      principal: "shared-reference-globex",
    }));
    clients.push(sharedGlobex.client);
    await sharedGlobex.client.connect(sharedGlobex.transport);
    const sharedGlobexResult = resultPayload(await sharedGlobex.client.callTool({
      name: "app.explore_data",
      arguments: { plan: sharedReferencePlan },
    }));
    const expectedSharedData = [
      { category: "hardware", count: 6 },
      { category: "software", count: 6 },
    ];
    const sharedAcmeData = [...(sharedAcmeResult.data ?? [])]
      .sort((left, right) => left.category.localeCompare(right.category));
    const sharedGlobexData = [...(sharedGlobexResult.data ?? [])]
      .sort((left, right) => left.category.localeCompare(right.category));
    assert(sharedAcmeResult.ok === true
      && sharedGlobexResult.ok === true
      && JSON.stringify(sharedAcmeData) === JSON.stringify(expectedSharedData)
      && JSON.stringify(sharedGlobexData) === JSON.stringify(expectedSharedData)
      && sharedAcmeResult.source_database_changed === false
      && sharedGlobexResult.source_database_changed === false,
    "MySQL production HTTP Shared reference did not return the same reviewed global rows to two JWT tenants.", {
      sharedAcmeResult,
      sharedGlobexResult,
    });
    assert(!JSON.stringify([sharedAcmeResult, sharedGlobexResult]).match(/operator-only|internal_notes|SELECT\s|`shared_/i),
      "MySQL production HTTP Shared reference leaked a kept-out field or compiled SQL.", {
        sharedAcmeResult,
        sharedGlobexResult,
      });

    const derivedPlan = {
      kind: "aggregate",
      resource: scopedOrderItemsId,
      measures: [{ function: "count" }, { function: "sum", field: "quantity" }],
      dimensions: [{
        field: "category",
        relationship: "scoped_order_items_order_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const derivedAcme = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "derived-acme",
    }));
    clients.push(derivedAcme.client);
    await derivedAcme.client.connect(derivedAcme.transport);
    const derivedAcmeResult = resultPayload(await derivedAcme.client.callTool({
      name: "app.explore_data",
      arguments: { plan: derivedPlan },
    }));
    assert(derivedAcmeResult.ok === true
      && derivedAcmeResult.data.length === 1
      && derivedAcmeResult.data[0].scoped_orders_category === "trail"
      && derivedAcmeResult.data[0].count === 5,
    "MySQL production Explore did not isolate a normalized child through its mandatory scope path.", derivedAcmeResult);
    assert(!JSON.stringify(derivedAcmeResult).match(/globex|enterprise|derived-globex|SELECT\s|`scoped_/i),
      "MySQL derived-scope result leaked another scope or compiled SQL.", derivedAcmeResult);

    const derivedGlobex = mcpClient(server.url, signedToken(privateKey, {
      tenant: "globex",
      principal: "derived-globex",
    }));
    clients.push(derivedGlobex.client);
    await derivedGlobex.client.connect(derivedGlobex.transport);
    const derivedGlobexResult = resultPayload(await derivedGlobex.client.callTool({
      name: "app.explore_data",
      arguments: { plan: derivedPlan },
    }));
    assert(derivedGlobexResult.ok === true
      && derivedGlobexResult.data.length === 1
      && derivedGlobexResult.data[0].scoped_orders_category === "enterprise"
      && derivedGlobexResult.data[0].count === 7,
    "MySQL derived scope did not isolate the second tenant/principal.", derivedGlobexResult);

    const fanoutAcme = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "fanout-acme",
    }));
    clients.push(fanoutAcme.client);
    await fanoutAcme.client.connect(fanoutAcme.transport);
    const fanoutResult = resultPayload(await fanoutAcme.client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          kind: "aggregate",
          resource: scopedOrdersId,
          measures: [{ derived_measure: "scoped_order_item_count" }],
          dimensions: [{ field: "category" }],
          top_n: 10,
        },
      },
    }));
    assert(fanoutResult.ok === true
      && fanoutResult.data.length === 1
      && fanoutResult.data[0].category === "trail"
      && fanoutResult.data[0].scoped_order_item_count === 5
      && fanoutResult.privacy.minimum_cohort_size >= 5,
    "MySQL production HTTP Explore did not execute the reviewed scoped child count.", fanoutResult);
    assert(!JSON.stringify(fanoutResult).match(/globex|derived-acme|SELECT\s|`scoped_/i),
      "MySQL reviewed child count leaked another principal, tenant, or compiled SQL.", fanoutResult);

    const tenantBudgetConfig = structuredClone(runtimeConfig);
    tenantBudgetConfig.production_explore.accounting_namespace = "verify.production.mysql.tenant-budget";
    tenantBudgetConfig.production_explore.tenant_limits.max_queries_per_rolling_24_hours = 2;
    const tenantBudgetConfigPath = path.join(projectRoot, "synapsor.tenant-budget.runner.json");
    fs.writeFileSync(tenantBudgetConfigPath, `${JSON.stringify(tenantBudgetConfig, null, 2)}\n`, "utf8");
    assertConfigAndArtifactHygiene({
      projectRoot,
      configPath: tenantBudgetConfigPath,
      forbiddenValues: [mysqlReadUrl, mysqlAdminUrl, controlUrl, env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY],
    });
    tenantBudgetServer = await startProductionExploreCli({ root, configPath: tenantBudgetConfigPath, env });
    const tenantBudgetClients = [];
    try {
      const tenantResults = [];
      for (const principal of ["tenant-budget-1", "tenant-budget-2", "tenant-budget-3"]) {
        const handle = mcpClient(tenantBudgetServer.url, signedToken(privateKey, { tenant: "acme", principal }));
        tenantBudgetClients.push(handle.client);
        await handle.client.connect(handle.transport);
        tenantResults.push(await handle.client.callTool({
          name: "app.explore_data",
          arguments: { plan: sharedReferencePlan },
        }));
      }
      assert(resultPayload(tenantResults[0]).ok === true
        && resultPayload(tenantResults[1]).ok === true
        && tenantResults[2].isError === true
        && /tenant/i.test(JSON.stringify(tenantResults[2])),
      "The MySQL tenant query ceiling did not throttle only the exhausted tenant.", tenantResults);

      const otherTenant = mcpClient(tenantBudgetServer.url, signedToken(privateKey, {
        tenant: "globex",
        principal: "tenant-budget-other",
      }));
      tenantBudgetClients.push(otherTenant.client);
      await otherTenant.client.connect(otherTenant.transport);
      const otherTenantResult = resultPayload(await otherTenant.client.callTool({
        name: "app.explore_data",
        arguments: { plan: sharedReferencePlan },
      }));
      assert(otherTenantResult.ok === true && otherTenantResult.data.length === 2,
        "One MySQL tenant's exhausted budget starved another tenant on the same server.", otherTenantResult);
    } finally {
      await Promise.allSettled(tenantBudgetClients.map((client) => client.close()));
      await stopProductionExploreCli(tenantBudgetServer).catch(() => undefined);
      tenantBudgetServer = undefined;
    }

    const operatorLedgerCountsBefore = await control.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "${controlSchema}".production_explore_audit_events) AS dedicated_events,
        (SELECT COUNT(*)::int FROM "${controlSchema}".ledger_entries) AS ledger_entries
    `);
    const operatorLedger = verifyProductionExploreOperatorLedger({
      schema: controlSchema,
      config_path: configPath,
      source_id: candidate.source,
      forbidden_values: [mysqlReadUrl, mysqlAdminUrl, controlUrl, env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY],
      invoke: (args) => {
        const invocation = productionExploreRunnerInvocation(root, args);
        return run(invocation.command, invocation.args, { env, allowFailure: true });
      },
    });
    const operatorWorkbench = await verifyProductionExploreWorkbenchLedger({
      engine: "mysql",
      project_root: projectRoot,
      config_path: configPath,
      runtime_config: runtimeConfig,
      schema: controlSchema,
      url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
      control_url: controlUrl,
    });
    const operatorLedgerCountsAfter = await control.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "${controlSchema}".production_explore_audit_events) AS dedicated_events,
        (SELECT COUNT(*)::int FROM "${controlSchema}".ledger_entries) AS ledger_entries
    `);
    assert(JSON.stringify(operatorLedgerCountsAfter.rows[0]) === JSON.stringify(operatorLedgerCountsBefore.rows[0]),
      "MySQL-source production ledger operator reads wrote to the PostgreSQL control store.", {
        before: operatorLedgerCountsBefore.rows[0],
        after: operatorLedgerCountsAfter.rows[0],
      });

    const activeLock = await loadGenerationLockSnapshot(
      projectRoot,
      candidate.generation_lock_fingerprint,
    );
    const dependencyResources = Object.values(activeLock.authority_dependencies?.resources ?? {})
      .map((dependency) => ({ schema: dependency.schema, table: dependency.table }));
    const schemaWidthClient = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "schema-width",
    }));
    clients.push(schemaWidthClient.client);
    await schemaWidthClient.client.connect(schemaWidthClient.transport);
    const schemaWidthScaling = await verifySchemaWidthScaling({
      mysqlAdmin,
      client: schemaWidthClient.client,
      env,
      plan,
      resources: dependencyResources,
    });

    await mysqlAdmin.query(`ALTER TABLE ${sourceSchema}.events MODIFY amount_cents BIGINT NOT NULL`);
    try {
      const driftClient = mcpClient(server.url, signedToken(privateKey, {
        tenant: "acme",
        principal: "drift",
      }));
      clients.push(driftClient.client);
      await driftClient.client.connect(driftClient.transport);
      const driftRefusal = await driftClient.client.callTool({
        name: "app.explore_data",
        arguments: { plan },
      });
      assert(driftRefusal.isError === true
        && /EXPLORE_LOCK_STALE|generated authority is stale/i.test(JSON.stringify(driftRefusal)),
      "A reviewed MySQL column-type drift did not fail closed before source execution.", driftRefusal);
    } finally {
      await mysqlAdmin.query(`ALTER TABLE ${sourceSchema}.events MODIFY amount_cents INT NOT NULL`);
    }

    const singleOrganization = await verifySingleOrganizationProductionExplore({
      controlSchema,
      controlUrl,
      mysqlAdmin,
      privateKey,
      publicKey,
    });

    const after = await sourceSnapshot(mysqlAdmin);
    assert(JSON.stringify(after) === JSON.stringify(before),
      "Production HTTP Explore mutated the MySQL source database.", { before, after });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      engine: "mysql",
      boundary: candidate.pack.name,
      tools: tools.tools.map((tool) => tool.name),
      principal_budget_isolated: true,
      tenant_budget_isolated: true,
      tenant_rows_isolated: true,
      derived_tenant_and_principal_scope_isolated: true,
      reviewed_child_count_scope_isolated: true,
      shared_reference_same_across_tenants: true,
      source_connection_ceiling: 2,
      principal_session_ceiling: 2,
      derived_scope_indexes_attested: true,
      complete_jwt_rejection_matrix: authRefusals.map((item) => item.label),
      generated_http_client_configs: generatedHttpClients,
      mysql_authoring_lifecycle: mysqlAuthoringLifecycle,
      metadata_only_catalog: true,
      analytics_http_stdio_parity: true,
      production_operator_ledger: operatorLedger,
      production_operator_workbench: operatorWorkbench,
      schema_width_scaling: schemaWidthScaling,
      drift_refused_over_http: true,
      config_and_artifact_hygiene: true,
      single_organization: singleOrganization,
      source_database_changed: false,
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopProductionExploreCli(tenantBudgetServer).catch(() => undefined);
    await stopProductionExploreCli(server).catch(() => undefined);
    await control.query(`DROP SCHEMA IF EXISTS "${controlSchema}" CASCADE`).catch(() => undefined);
    await Promise.allSettled([control.end(), mysqlAdmin.end()]);
    run("docker", ["compose", "-p", composeProject, "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(authoringLifecycleProjectRoot, { recursive: true, force: true });
    fs.rmSync(singleOrganizationProjectRoot, { recursive: true, force: true });
    fs.rmSync(localParityProjectRoot, { recursive: true, force: true });
  }
}

await main();
