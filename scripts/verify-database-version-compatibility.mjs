import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import { Pool } from "pg";
import {
  databaseServerCompatibility,
  inspectDatabase,
} from "../packages/schema-inspector/dist/index.js";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundary,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { createScopedExploreMcpServer } from "../apps/runner/dist/authoring-mcp.js";
import { startLocalUiServer } from "../apps/runner/dist/local-ui.js";
import { createScopedExploreRuntime } from "../apps/runner/dist/scoped-explore.js";
import {
  productionExploreRunnerInvocation,
  startProductionExploreCli,
  stopProductionExploreCli,
} from "./production-explore-http-e2e-helpers.mjs";
import {
  applyProductionExploreSoakBudgets,
  productionExploreSoakIdentities,
  runProductionExploreHttpSoak,
  runProductionExploreRecovery,
  waitForSourceConnectionQuiescence,
  verifyProductionExploreAuditSink,
  verifyProductionExploreOperatorLedger,
} from "./production-explore-http-soak.mjs";
import { verifyProductionExploreWorkbenchLedger } from "./verify-production-explore-workbench-ledger.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "examples/database-version-compatibility/docker-compose.yml");
const composeProject = `synapsor-database-compat-${process.pid}`;
const readerPassword = "compat_reader_password";
const controlUrl = "postgresql://compat_admin:compat_admin_password@127.0.0.1:55620/controldb";
const projectRoots = [];
const postgresLines = [
  { expected: "12", port: 55612, supported: false },
  { expected: "13", port: 55613, supported: true },
  { expected: "14", port: 55614, supported: true },
  { expected: "15", port: 55615, supported: true },
  { expected: "16", port: 55616, supported: true },
  { expected: "17", port: 55617, supported: true },
  { expected: "18", port: 55618, supported: true },
];
const mysqlLines = [
  { expected: "5.7", port: 55657, tier: "compatible_limited", automaticBands: false },
  { expected: "8.x", port: 55680, tier: "full", automaticBands: true },
  { expected: "8.x", port: 55684, tier: "full", automaticBands: true },
];
const mysql57SoakRequested = process.env.SYNAPSOR_MYSQL57_COMPAT_SOAK === "1";
const mysql57SoakOnly = process.env.SYNAPSOR_MYSQL57_COMPAT_SOAK_ONLY === "1";

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`}`);
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

function signedToken(privateKey, tenant, principal) {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "database-compatibility" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    tenant_id: tenant,
    sub: principal,
    scope: "synapsor.explore",
    iss: "https://identity.example",
    aud: "https://runner.example/mcp",
    iat: now,
    exp: now + 600,
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function httpClient(url, bearer) {
  return {
    client: new Client({ name: "database-version-http-verifier", version: "1.0.0" }),
    transport: new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    }),
  };
}

function projectSummary(projectRoot) {
  return {
    root: projectRoot,
    package_manager: "unknown",
    frameworks: [],
    schema_inputs: [],
    database_env_names: ["COMPAT_DATABASE_URL"],
  };
}

function reviewOverrides(resourceId, automaticBands = false) {
  const actor = "database-version-verifier";
  const decidedAt = "2026-08-12T20:00:00.000Z";
  const schema = resourceId.slice(0, resourceId.lastIndexOf("."));
  const childResourceId = `${schema}.event_items`;
  return {
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
    resources: {
      [resourceId]: {
        tenant_key: {
          value: "tenant_id",
          actor,
          reason: "The compatibility fixture uses tenant_id as its reviewed row boundary.",
          decided_at: decidedAt,
        },
        principal_key: {
          value: "principal_id",
          actor,
          reason: "The compatibility fixture uses principal_id as its second trusted row boundary.",
          decided_at: decidedAt,
        },
        numeric_bands: {
          duration_tier: {
            definition: {
              name: "duration_tier",
              label: "Duration tier",
              field: "duration_ms",
              edges: [350],
              bucket_labels: ["lower duration", "higher duration"],
            },
            actor,
            reason: "Exercise one fixed reviewer-authored numeric band.",
            decided_at: decidedAt,
          },
        },
        derived_measures: {
          duration_running_total: {
            definition: {
              name: "duration_running_total",
              label: "Duration running total",
              shape: "running_total",
              base_measure: { function: "sum", field: "duration_ms" },
            },
            actor,
            reason: "Exercise one reviewed post-suppression running metric.",
            decided_at: decidedAt,
          },
        },
        ...(automaticBands
          ? {
            auto_bands: {
              duration_ms: {
                definition: {
                  field: "duration_ms",
                  methods: ["quantile", "equal_width"],
                  min_buckets: 2,
                  max_buckets: 4,
                  min_bucket_width: 100,
                  label_style: "ordinal",
                },
                actor,
                reason: "Exercise capability-gated automatic numeric bands.",
                decided_at: decidedAt,
              },
            },
          }
          : {}),
      },
      [childResourceId]: {
        tenant_scope_path: {
          value: "event_items_event_id_fkey",
          actor,
          reason: "Every compatibility item derives tenant scope through its required event.",
          decided_at: decidedAt,
        },
        principal_scope_path: {
          value: "event_items_event_id_fkey",
          actor,
          reason: "Every compatibility item derives principal scope through its required event.",
          decided_at: decidedAt,
        },
      },
    },
  };
}

function fixtureRows() {
  const rows = [];
  let id = 1;
  for (const tenant of ["acme", "globex"]) {
    for (const month of ["06", "07"]) {
      for (const status of ["active", "paused"]) {
        for (let index = 0; index < 6; index += 1) {
          rows.push({
            id: id++,
            tenant,
            principal: tenant === "acme" ? "rep-1" : "rep-2",
            status,
            plainLabel: index % 2 === 0 ? "alpha" : "beta",
            caseLabel: index % 2 === 0 ? "Case" : "case",
            accentLabel: index % 2 === 0 ? "cafe" : "café",
            trailingLabel: index % 2 === 0 ? "trail" : "trail ",
            duration: 100 + (index * 100) + (status === "paused" ? 25 : 0),
            amountDecimal: ((status === "paused" ? 2_000 : 1_000) + (index * 25)) / 100,
            optionalScore: index === 5 ? null : 50 + index,
            occurredAt: month === "06"
              ? [
                "2026-06-01 00:00:00.000000",
                "2026-06-10 12:00:00.000000",
                "2026-06-20 12:00:00.000000",
                "2026-06-29 12:00:00.000000",
                "2026-06-30 23:59:59.000000",
                "2026-06-30 23:59:59.999999",
              ][index]
              : [
                "2026-07-01 00:00:00.000000",
                "2026-07-01 00:00:00.000001",
                "2026-07-10 12:00:00.000000",
                "2026-07-20 12:00:00.000000",
                "2026-07-31 23:59:59.000000",
                "2026-07-31 23:59:59.999999",
              ][index],
          });
        }
      }
    }
    rows.push({
      id: id++,
      tenant,
      principal: tenant === "acme" ? "rep-1" : "rep-2",
      status: "rare",
      plainLabel: "alpha",
      caseLabel: "Case",
      accentLabel: "cafe",
      trailingLabel: "trail",
      duration: 775,
      amountDecimal: 0,
      optionalScore: null,
      occurredAt: "2026-07-15 12:00:00.000000",
    }, {
      id: id++,
      tenant,
      principal: tenant === "acme" ? "rep-1" : "rep-2",
      status: "rare",
      plainLabel: "alpha",
      caseLabel: "Case",
      accentLabel: "cafe",
      trailingLabel: "trail",
      duration: 825,
      amountDecimal: 0,
      optionalScore: null,
      occurredAt: "2026-07-31 23:59:59.999999",
    });
  }
  return rows;
}

function fixtureItems(rows) {
  let id = 1;
  return rows.flatMap((row) => [1, 2].map((units) => ({
    id: id++,
    eventId: row.id,
    units,
  })));
}

function mysql57SoakFixture(identities) {
  const rows = [];
  const items = [];
  for (const identity of identities) {
    for (const status of ["active", "paused"]) {
      for (let index = 0; index < 5; index += 1) {
        const rowId = 1_000_000 + (identity.index * 100) + rows.length % 100;
        const duration = (status === "active" ? 100 : 125) + (index * 100) + identity.index;
        rows.push({
          id: rowId,
          tenant: identity.tenant,
          principal: identity.principal,
          status,
          plainLabel: index % 2 === 0 ? "alpha" : "beta",
          caseLabel: index % 2 === 0 ? "Case" : "case",
          accentLabel: index % 2 === 0 ? "cafe" : "caf\u00e9",
          trailingLabel: index % 2 === 0 ? "trail" : "trail ",
          duration,
          amountDecimal: duration / 100,
          optionalScore: index === 4 ? null : 50 + index,
          occurredAt: "2026-07-15 12:00:00.000000",
        });
        for (const units of [1, 2]) {
          items.push({
            id: 2_000_000 + (identity.index * 1_000) + (items.length % 1_000),
            eventId: rowId,
            units,
          });
        }
      }
    }
  }
  return { rows, items };
}

async function insertMysqlRows(connection, table, columns, rows) {
  const chunkSize = 500;
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    await connection.query(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
      chunk.flat(),
    );
  }
}

async function seedMysql57Soak(adminUrl, identities) {
  const connection = await mysql.createConnection(adminUrl);
  try {
    const fixture = mysql57SoakFixture(identities);
    await insertMysqlRows(
      connection,
      "compatdb.events",
      [
        "id", "tenant_id", "principal_id", "status", "plain_label", "case_label",
        "accent_label", "trailing_label", "duration_ms", "amount_decimal",
        "optional_score", "occurred_at",
      ],
      fixture.rows.map((row) => [
        row.id, row.tenant, row.principal, row.status, row.plainLabel, row.caseLabel,
        row.accentLabel, row.trailingLabel, row.duration, row.amountDecimal,
        row.optionalScore, row.occurredAt,
      ]),
    );
    await insertMysqlRows(
      connection,
      "compatdb.event_items",
      ["id", "event_id", "units"],
      fixture.items.map((item) => [item.id, item.eventId, item.units]),
    );
  } finally {
    await connection.end();
  }
}

async function seedPostgres(adminUrl) {
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await pool.query(`
      DROP SCHEMA IF EXISTS compat CASCADE;
      CREATE SCHEMA compat;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'compat_reader') THEN
          CREATE ROLE compat_reader LOGIN PASSWORD '${readerPassword}';
        END IF;
      END $$;
      ALTER ROLE compat_reader PASSWORD '${readerPassword}';
      ALTER ROLE compat_reader SET default_transaction_read_only = on;
      CREATE TABLE compat.events (
        id integer PRIMARY KEY,
        tenant_id text NOT NULL,
        principal_id text NOT NULL,
        status text NOT NULL CHECK (status IN ('active', 'paused', 'rare')),
        plain_label text NOT NULL,
        case_label text NOT NULL CHECK (case_label IN ('Case', 'case')),
        accent_label text NOT NULL CHECK (accent_label IN ('cafe', 'café')),
        trailing_label text NOT NULL CHECK (trailing_label IN ('trail', 'trail ')),
        duration_ms integer NOT NULL,
        amount_decimal numeric(12, 2) NOT NULL,
        optional_score numeric(12, 2),
        occurred_at timestamptz NOT NULL
      );
      CREATE TABLE compat.event_items (
        id integer PRIMARY KEY,
        event_id integer NOT NULL,
        units integer NOT NULL,
        CONSTRAINT event_items_event_id_fkey
          FOREIGN KEY (event_id) REFERENCES compat.events(id)
      );
      GRANT CONNECT ON DATABASE compatdb TO compat_reader;
      GRANT USAGE ON SCHEMA compat TO compat_reader;
      GRANT SELECT ON compat.events, compat.event_items TO compat_reader;
    `);
    const rows = fixtureRows();
    for (const row of rows) {
      await pool.query(
        `INSERT INTO compat.events
          (id, tenant_id, principal_id, status, plain_label, case_label, accent_label,
           trailing_label, duration_ms, amount_decimal, optional_score, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          row.id, row.tenant, row.principal, row.status, row.plainLabel,
          row.caseLabel, row.accentLabel, row.trailingLabel, row.duration,
          row.amountDecimal, row.optionalScore, `${row.occurredAt}+00`,
        ],
      );
    }
    for (const item of fixtureItems(rows)) {
      await pool.query(
        "INSERT INTO compat.event_items (id, event_id, units) VALUES ($1, $2, $3)",
        [item.id, item.eventId, item.units],
      );
    }
  } finally {
    await pool.end();
  }
}

async function seedMysql(adminUrl) {
  const connection = await mysql.createConnection(adminUrl);
  try {
    await connection.query("DROP DATABASE IF EXISTS compatdb");
    await connection.query("CREATE DATABASE compatdb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    await connection.query("DROP USER IF EXISTS 'compat_reader'@'%'");
    await connection.query(`CREATE USER 'compat_reader'@'%' IDENTIFIED BY '${readerPassword}'`);
    await connection.query(`
      CREATE TABLE compatdb.events (
        id integer PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        principal_id varchar(64) NOT NULL,
        status enum('active', 'paused', 'rare') NOT NULL,
        plain_label varchar(64) NOT NULL,
        case_label varchar(64) NOT NULL CHECK (case_label IN ('Case', 'case')),
        accent_label varchar(64) NOT NULL CHECK (accent_label IN ('cafe', 'café')),
        trailing_label varchar(64) NOT NULL CHECK (trailing_label IN ('trail', 'trail ')),
        duration_ms integer NOT NULL,
        amount_decimal decimal(12, 2) NOT NULL,
        optional_score decimal(12, 2),
        occurred_at datetime(6) NOT NULL
      )
    `);
    await connection.query(`
      CREATE TABLE compatdb.event_items (
        id integer PRIMARY KEY,
        event_id integer NOT NULL,
        units integer NOT NULL,
        CONSTRAINT event_items_event_id_fkey
          FOREIGN KEY (event_id) REFERENCES compatdb.events(id)
      )
    `);
    await connection.query("GRANT SELECT ON compatdb.* TO 'compat_reader'@'%'");
    const rows = fixtureRows();
    for (const row of rows) {
      await connection.query(
        `INSERT INTO compatdb.events
          (id, tenant_id, principal_id, status, plain_label, case_label, accent_label,
           trailing_label, duration_ms, amount_decimal, optional_score, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id, row.tenant, row.principal, row.status, row.plainLabel,
          row.caseLabel, row.accentLabel, row.trailingLabel, row.duration,
          row.amountDecimal, row.optionalScore, row.occurredAt,
        ],
      );
    }
    for (const item of fixtureItems(rows)) {
      await connection.query(
        "INSERT INTO compatdb.event_items (id, event_id, units) VALUES (?, ?, ?)",
        [item.id, item.eventId, item.units],
      );
    }
  } finally {
    await connection.end();
  }
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain structured content.");
  return JSON.parse(text);
}

function assertClose(actual, expected, context, tolerance = 1e-9) {
  const numeric = Number(actual);
  assert(Number.isFinite(numeric) && Math.abs(numeric - expected) <= tolerance,
    `${context} expected ${expected} but received ${String(actual)}.`, { actual, expected, tolerance });
}

function reviewedCandidate(build, resourceId, childResourceId, automaticBands) {
  const candidate = structuredClone(build.exploration_boundary);
  candidate.pack.name = "database_compatibility";
  candidate.pack.resources = candidate.pack.resources.filter((resource) =>
    resource.id === resourceId || resource.id === childResourceId);
  candidate.budgets.max_queries_per_session = 100;
  candidate.budgets.rate_limit_per_minute = 100;
  candidate.budgets.max_differencing_queries = 16;
  candidate.budgets.max_extracted_cells_per_session = 4_000;
  const resource = candidate.pack.resources.find((item) => item.id === resourceId);
  const childResource = candidate.pack.resources.find((item) => item.id === childResourceId);
  assert(resource, `Compatibility draft omitted ${resourceId}.`, candidate.pack.resources);
  assert(childResource?.tenant_scope?.path_id === "event_items_event_id_fkey"
    && childResource?.principal_scope?.path_id === "event_items_event_id_fkey",
  `Compatibility draft omitted reviewed derived scope for ${childResourceId}.`, childResource);
  assert(childResource.relationships.some((relationship) =>
    relationship.id === "event_items_event_id_fkey" && relationship.target_resource === resourceId),
  `Compatibility draft omitted the reviewed child-to-parent relationship for ${childResourceId}.`,
  childResource.relationships);
  assert(resource.numeric_bands?.some((band) => band.name === "duration_tier"),
    "Reviewed fixed numeric-band policy did not enter the candidate.", resource.numeric_bands);
  assert(resource.derived_measures?.some((measure) => measure.name === "duration_running_total"),
    "Reviewed running metric did not enter the candidate.", resource.derived_measures);
  assert(Boolean(resource.auto_bands?.length) === automaticBands,
    "Automatic-band policy did not match the server capability.", resource.auto_bands);
  return { candidate, resource, childResource };
}

async function assertRejects(operation, messagePart, failureMessage) {
  try {
    await operation();
  } catch (error) {
    assert(String(error?.message ?? error).toLowerCase().includes(messagePart.toLowerCase()),
      `${failureMessage} Refusal was not actionable.`, String(error?.message ?? error));
    return;
  }
  throw new Error(failureMessage);
}

async function verifyWorkbenchCompatibility(input) {
  const {
    projectRoot,
    boundaryRoot,
    inspection,
    expectedLine,
    expectedTier,
    automaticBands,
    resourceId,
    draft,
  } = input;
  const token = `compat-workbench-${process.pid}`;
  const csrfToken = `compat-workbench-csrf-${process.pid}`;
  const server = await startLocalUiServer({
    projectRoot,
    boundaryRoot,
    configPath: path.join(projectRoot, "synapsor.runner.json"),
    storePath: path.join(projectRoot, ".synapsor/workbench.db"),
    token,
    csrfToken,
    schemaInspector: async () => inspection,
  });
  const headers = {
    "x-synapsor-ui-token": token,
    "x-synapsor-csrf": csrfToken,
  };
  try {
    const response = await fetch(`http://${server.host}:${server.port}/api/boundary`, { headers });
    const responseBody = await response.text();
    assert(response.ok, `Workbench could not load ${inspection.engine} ${expectedLine} boundary state.`, {
      status: response.status,
      body: responseBody,
      resources: draft.pack.resources.map((resource) => ({
        id: resource.id,
        tenant_key: resource.tenant_key,
        principal_key: resource.principal_key,
        tenant_scope: resource.tenant_scope,
        principal_scope: resource.principal_scope,
      })),
      budgets: draft.budgets,
    });
    const state = JSON.parse(responseBody);
    assert(state.database_server_compatibility?.detected_version === inspection.server_version
      && state.database_server_compatibility?.tier === expectedTier
      && state.database_server_compatibility?.authority?.version_line === expectedLine,
    `Workbench displayed the wrong ${inspection.engine} ${expectedLine} compatibility authority.`,
    state.database_server_compatibility);
    const resource = state.candidate?.pack?.resources?.find((item) => item.id === resourceId);
    assert(Boolean(resource?.auto_bands?.length) === automaticBands,
      `Workbench exposed the wrong ${inspection.engine} ${expectedLine} automatic-band policy.`, resource);

    if (!automaticBands) {
      const mutation = await fetch(
        `http://${server.host}:${server.port}/api/boundary/regenerate`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            kind: "auto_band",
            resource_id: resourceId,
            field: "duration_ms",
            definition: {
              field: "duration_ms",
              methods: ["quantile"],
              min_buckets: 2,
              max_buckets: 4,
              label_style: "ordinal",
            },
            actor: "database-version-verifier",
            reason: "Prove Workbench refuses grammar unavailable on this server line.",
          }),
        },
      );
      const refusal = await mutation.text();
      assert(!mutation.ok && /automatic numeric bands.*unavailable.*5\.7/i.test(refusal),
        "Workbench did not explain the MySQL 5.7 automatic-band refusal.", {
          status: mutation.status,
          refusal,
        });
      const unchangedResponse = await fetch(
        `http://${server.host}:${server.port}/api/boundary`,
        { headers },
      );
      const unchanged = await unchangedResponse.json();
      const unchangedResource = unchanged.candidate?.pack?.resources?.find((item) => item.id === resourceId);
      assert(!unchangedResource?.auto_bands?.length,
        "A refused MySQL 5.7 Workbench edit changed disabled authority.", unchangedResource);
    }
  } finally {
    await server.close();
  }
}

function mysql57SoakOperations(resourceId, childResourceId) {
  const groupedPlan = {
    kind: "aggregate",
    resource: resourceId,
    measures: [{ function: "count" }, { function: "sum", field: "duration_ms" }],
    dimensions: [{ field: "status" }],
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
  };
  const assertScopedGroups = (payload, identity) => {
    const groups = new Map((payload.data ?? []).map((row) => [row.status, row]));
    assert(payload.ok === true
      && payload.source_database_changed === false
      && groups.size === 2
      && groups.get("active")?.count === 5
      && groups.get("active")?.sum_duration_ms === 1_500 + (identity.index * 5)
      && groups.get("paused")?.count === 5
      && groups.get("paused")?.sum_duration_ms === 1_625 + (identity.index * 5),
    "MySQL 5.7 soak escaped exact tenant/principal scope or changed aggregate semantics.", payload);
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
      validate: (payload) => {
        const parent = payload.resources?.find((resource) => resource.id === resourceId);
        assert(payload.ok === true
          && parent?.auto_bands?.length === 0
          && payload.resources?.some((resource) => resource.id === childResourceId),
        "MySQL 5.7 soak catalog lost its reduced-tier authority or reviewed resources.", payload);
      },
    },
    legal("grouped_count_sum", 30, groupedPlan, assertScopedGroups),
    legal("relative_time_window", 10, {
      ...groupedPlan,
      measures: [{ function: "count" }],
      time_window: { field: "occurred_at", window: "previous_month" },
    }, (payload) => assert((payload.data ?? []).length === 2
      && payload.data.every((row) => row.count === 5)
      && payload.operator_time_windows === undefined
      && payload.resolved_time_windows === undefined,
    "MySQL 5.7 relative window changed scope or exposed operator-only resolution metadata.", payload)),
    legal("fixed_numeric_band", 10, {
      kind: "aggregate",
      resource: resourceId,
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "duration_tier" }],
      top_n: 10,
    }, (payload) => assert(payload.data?.length === 1
      && payload.data[0]?.duration_tier === "lower duration"
      && payload.data[0]?.count === 6
      && payload.privacy?.suppressed_groups === 1,
    "MySQL 5.7 fixed numeric band changed suppression semantics.", payload)),
    legal("dispersion", 10, {
      ...groupedPlan,
      measures: [
        { function: "stddev_pop", field: "duration_ms" },
        { function: "var_pop", field: "duration_ms" },
      ],
    }, (payload) => assert(payload.data?.length === 2
      && payload.data.every((row) => Number.isFinite(row.stddev_pop_duration_ms)
        && Number.isFinite(row.var_pop_duration_ms)),
    "MySQL 5.7 contributor-safe dispersion failed during sustained use.", payload)),
    legal("derived_scope_relationship", 20, {
      kind: "aggregate",
      resource: childResourceId,
      measures: [{ function: "count" }, { function: "sum", field: "units" }],
      dimensions: [{ field: "status", relationship: "event_items_event_id_fkey" }],
      top_n: 10,
    }, (payload) => assert(payload.data?.length === 2
      && payload.data.every((row) => row.count === 10 && row.sum_units === 15),
    "MySQL 5.7 derived tenant/principal scope failed during sustained use.", payload)),
    legal("reviewed_running_total", 5, {
      kind: "aggregate",
      resource: resourceId,
      measures: [{ derived_measure: "duration_running_total" }],
      time_bucket: { field: "occurred_at", bucket: "month" },
      top_n: 10,
    }, (payload, identity) => assert(payload.data?.length === 1
      && payload.data[0]?.time_bucket === "2026-07-01"
      && payload.data[0]?.duration_running_total === 3_125 + (identity.index * 10),
    "MySQL 5.7 reviewed post-suppression metric changed during sustained use.", payload)),
    {
      name: "automatic_band_refusal",
      weight: 5,
      expected_refusal: true,
      request: () => ({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: resourceId,
            measures: [{ function: "count" }],
            dimensions: [{ numeric_band: { field: "duration_ms", method: "quantile", buckets: 2 } }],
            top_n: 10,
          },
        },
      }),
      validate_refusal: (result) => /not reviewed|automatic.*band|unsupported/i.test(JSON.stringify(result)),
    },
    {
      name: "unbounded_text_grouping_refusal",
      weight: 3,
      expected_refusal: true,
      request: () => ({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "aggregate",
            resource: resourceId,
            measures: [{ function: "count" }],
            dimensions: [{ field: "plain_label" }],
            top_n: 10,
          },
        },
      }),
      validate_refusal: (result) => /not reviewed|groupable|forbidden/i.test(JSON.stringify(result)),
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
          plan: groupedPlan,
        },
      }),
      validate_refusal: (result) => /unrecognized|unsupported|invalid/i.test(JSON.stringify(result)),
    },
  ];
}

async function verifyReviewedRuntime(input) {
  const { engine, databaseUrl, inspectedSchema, expectedLine, expectedTier, automaticBands } = input;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `synapsor-db-compat-${engine}-`));
  projectRoots.push(projectRoot);
  const env = {
    ...process.env,
    COMPAT_DATABASE_URL: databaseUrl,
    SYNAPSOR_TENANT_ID: "acme",
    SYNAPSOR_PRINCIPAL: "rep-1",
  };
  const inspection = await inspectDatabase({
    engine,
    databaseUrlEnv: "COMPAT_DATABASE_URL",
    schema: inspectedSchema,
    env,
  });
  const compatibility = databaseServerCompatibility(inspection);
  assert(compatibility.tier === expectedTier, `${engine} ${expectedLine} received the wrong support tier.`, compatibility);
  assert(compatibility.authority.version_line === expectedLine, `${engine} reported the wrong authority line.`, compatibility);
  assert(compatibility.authority.features.automatic_numeric_bands === automaticBands,
    `${engine} ${expectedLine} reported the wrong automatic-band capability.`, compatibility);
  assert(inspection.role_posture?.verified === true && inspection.role_posture?.read_only === true,
    `${engine} ${expectedLine} reader was not verified read-only.`, inspection.role_posture);

  const resourceId = `${inspectedSchema}.events`;
  const childResourceId = `${inspectedSchema}.event_items`;
  const build = buildAutoBoundary({
    inspection,
    project: projectSummary(projectRoot),
    sourceEnv: "COMPAT_DATABASE_URL",
    inspectedSchema,
    overrides: reviewOverrides(resourceId, automaticBands),
  });
  assert(build.lock.database_server_version === inspection.server_version,
    `${engine} ${expectedLine} lock omitted the exact server version.`, build.lock);
  assert(build.lock.database_server_tier === expectedTier,
    `${engine} ${expectedLine} lock omitted the resolved support tier.`, build.lock);
  assert(build.lock.database_server_authority?.version_line === expectedLine,
    `${engine} ${expectedLine} lock omitted the stable authority line.`, build.lock);
  assert(build.exploration_boundary.database_server_version === inspection.server_version
    && build.exploration_boundary.database_server_tier === expectedTier
    && build.exploration_boundary.database_server_authority?.version_line === expectedLine,
  `${engine} ${expectedLine} draft omitted its reviewed database capability authority.`,
  build.exploration_boundary);
  const { candidate, resource } = reviewedCandidate(build, resourceId, childResourceId, automaticBands);
  assert(resource.field_enums.status?.join(",") === "active,paused,rare",
    `${engine} ${expectedLine} did not preserve the bounded status vocabulary.`, resource.field_enums);
  if (expectedTier === "compatible_limited") {
    assert(!resource.groupable_fields.includes("plain_label")
      && resource.filterable_fields.plain_label === undefined,
    "MySQL 5.7 exposed an unbounded text field for grouping or filtering.", resource);
    assert(resource.selectable_fields.includes("plain_label"),
      "MySQL 5.7 removed selectable row authority while narrowing categorical operations.", resource);
    assert(resource.groupable_fields.includes("status") && resource.filterable_fields.status,
      "MySQL 5.7 failed to retain native ENUM grouping and filtering.", resource);
    for (const field of ["case_label", "accent_label", "trailing_label"]) {
      assert(!resource.groupable_fields.includes(field) && resource.filterable_fields[field] === undefined,
        `MySQL 5.7 trusted unenforced CHECK vocabulary for ${field}.`, resource);
    }
    assert(!resource.auto_bands?.length, "MySQL 5.7 boundary unexpectedly contains automatic bands.", resource.auto_bands);
  } else {
    for (const field of ["case_label", "accent_label", "trailing_label"]) {
      assert(resource.groupable_fields.includes(field) && resource.field_enums[field]?.length === 2,
        `${engine} ${expectedLine} did not expose bounded collation semantics for ${field}.`, resource);
    }
  }

  const written = await writeAutoBoundaryArtifacts({ projectRoot, build });
  await verifyWorkbenchCompatibility({
    projectRoot,
    boundaryRoot: written.root,
    inspection,
    expectedLine,
    expectedTier,
    automaticBands,
    resourceId,
    draft: build.exploration_boundary,
  });
  const digest = explorationBoundaryCandidateDigest(candidate);
  await activateExplorationBoundary({
    projectRoot,
    candidate,
    expectedDigest: digest,
    actor: "database-version-verifier",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  const activeBoundary = await loadActivatedExplorationBoundary(projectRoot);
  assert(activeBoundary.database_server_version === inspection.server_version
    && activeBoundary.database_server_tier === expectedTier
    && activeBoundary.database_server_authority?.version_line === expectedLine,
  `${engine} ${expectedLine} activated artifact omitted its reviewed database capability authority.`,
  activeBoundary);

  const fixedNow = Date.parse("2026-08-10T15:30:45.123Z");
  const runtime = await createScopedExploreRuntime({
    projectRoot,
    transport: "stdio",
    env,
    clock: () => fixedNow,
  });
  const server = createScopedExploreMcpServer(runtime);
  const client = new Client({ name: "database-version-verifier", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      `${engine} ${expectedLine} changed the locked two-tool surface.`, tools.tools);
    const exploreTool = tools.tools.find((tool) => tool.name === "app.explore_data");
    const advertised = `${exploreTool?.description ?? ""} ${JSON.stringify(exploreTool?.inputSchema ?? {})}`;
    assert(/quantile|equal_width/.test(advertised) === automaticBands,
      `${engine} ${expectedLine} advertised the wrong automatic-band grammar.`, advertised);

    const described = resultPayload(await client.callTool({
      name: "app.describe_data",
      arguments: { resource: resourceId },
    }));
    const describedResource = described.resources?.[0];
    assert(Boolean(describedResource?.auto_bands?.length) === automaticBands,
      `${engine} ${expectedLine} describe_data exposed the wrong automatic-band metadata.`, describedResource);

    const grouped = resultPayload(await client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          kind: "aggregate",
          resource: resourceId,
          measures: [
            { function: "count" },
            { function: "stddev_pop", field: "duration_ms" },
            { function: "var_pop", field: "duration_ms" },
          ],
          dimensions: [{ field: "status" }],
          time_bucket: { field: "occurred_at", bucket: "quarter" },
          time_window: { field: "occurred_at", window: "last_90_days" },
          top_n: 10,
        },
      },
    }));
    assert(grouped.ok === true && grouped.data?.length === 4,
      `${engine} ${expectedLine} failed its enum/dispersion/time aggregate.`, grouped);
    assert(grouped.data.every((row) => ["2026-Q2", "2026-Q3"].includes(row.time_bucket)
      && ["active", "paused"].includes(row.status) && row.count === 6)
      && grouped.privacy?.suppressed_groups === 1,
      `${engine} ${expectedLine} returned non-canonical or unscoped grouped data.`, grouped.data);

    const decimal = await runtime.explore({
      kind: "aggregate",
      resource: resourceId,
      measures: [
        { function: "count" },
        { function: "sum", field: "amount_decimal" },
        { function: "avg", field: "amount_decimal" },
      ],
      where: [{ field: "status", op: "in", value: ["active", "paused"] }],
      top_n: 1,
    });
    assert(decimal.data.length === 1 && decimal.data[0]?.count === 24,
      `${engine} ${expectedLine} failed exact decimal aggregate cardinality.`, decimal);
    assertClose(decimal.data[0]?.sum_amount_decimal, 375,
      `${engine} ${expectedLine} decimal sum`);
    assertClose(decimal.data[0]?.avg_amount_decimal, 15.625,
      `${engine} ${expectedLine} decimal average`);

    const missingData = await runtime.explore({
      kind: "aggregate",
      resource: resourceId,
      measures: [
        { function: "null_count", field: "optional_score" },
        { function: "non_null_count", field: "optional_score" },
        { function: "completion_rate", field: "optional_score" },
      ],
      where: [{ field: "status", op: "eq", value: "active" }],
      top_n: 1,
    });
    assert(missingData.data.length === 1
      && missingData.data[0]?.null_count_optional_score === 2
      && missingData.data[0]?.non_null_count_optional_score === 10,
    `${engine} ${expectedLine} changed NULL contributor semantics.`, missingData);
    assertClose(
      missingData.data[0]?.completion_rate_optional_score,
      engine === "mysql" ? 83.33333 : 1000 / 12,
      `${engine} ${expectedLine} completion rate`,
      1e-9,
    );

    const relativePlan = {
      kind: "aggregate",
      resource: resourceId,
      measures: [{ function: "count" }],
      dimensions: [{ field: "status" }],
      time_window: { field: "occurred_at", window: "previous_month" },
      top_n: 10,
    };
    const relative = await runtime.explore(relativePlan);
    const absolute = await runtime.explore({
      ...relativePlan,
      time_window: {
        field: "occurred_at",
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-08-01T00:00:00.000Z",
      },
    });
    assert(JSON.stringify(relative.data) === JSON.stringify(absolute.data)
      && relative.audit?.query_fingerprint === absolute.audit?.query_fingerprint
      && relative.data.length === 2
      && relative.data.every((row) => ["active", "paused"].includes(row.status) && row.count === 6)
      && relative.privacy?.suppressed_groups === 1,
    `${engine} ${expectedLine} relative and absolute half-open windows diverged.`, { relative, absolute });
    assert(relative.operator_time_windows?.[0]?.ranges?.[0]?.start_inclusive === "2026-07-01T00:00:00.000Z"
      && relative.operator_time_windows?.[0]?.ranges?.[0]?.end_exclusive === "2026-08-01T00:00:00.000Z",
    `${engine} ${expectedLine} did not resolve previous_month in reviewed UTC authority.`,
    relative.operator_time_windows);

    const derived = await runtime.explore({
      kind: "aggregate",
      resource: childResourceId,
      measures: [{ function: "count" }, { function: "sum", field: "units" }],
      dimensions: [{ field: "status", relationship: "event_items_event_id_fkey" }],
      top_n: 10,
    });
    assert(derived.data.length === 2
      && derived.data.every((row) => ["active", "paused"].includes(row.events_status)
        && row.count === 24 && row.sum_units === 36)
      && derived.privacy?.suppressed_groups === 1,
    `${engine} ${expectedLine} changed derived scope or relationship semantics.`, derived);

    for (const field of ["case_label", "accent_label", "trailing_label"]) {
      if (expectedTier === "compatible_limited") {
        await assertRejects(
          () => runtime.explore({
            kind: "aggregate",
            resource: resourceId,
            measures: [{ function: "count" }],
            dimensions: [{ field }],
            top_n: 10,
          }),
          "not reviewed",
          `MySQL 5.7 accepted ${field} grouping without trusted CHECK vocabulary.`,
        );
        continue;
      }
      const categorical = await runtime.explore({
        kind: "aggregate",
        resource: resourceId,
        measures: [{ function: "count" }],
        dimensions: [{ field }],
        top_n: 10,
      });
      const expectedGroups = engine === "postgres" ? 2 : 1;
      assert(categorical.data.length === expectedGroups
        && categorical.data.reduce((sum, row) => sum + Number(row.count), 0) === 26
        && (engine !== "postgres" || categorical.data.every((row) => [12, 14].includes(row.count)))
        && (engine !== "mysql" || categorical.data[0]?.count === 26),
      `${engine} ${expectedLine} changed ${field} collation/grouping semantics.`, categorical);
    }

    const fixedBand = await runtime.explore({
      kind: "aggregate",
      resource: resourceId,
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "duration_tier" }],
      top_n: 10,
    });
    assert(fixedBand.data.length === 2 && fixedBand.data.every((row) => row.count >= 5),
      `${engine} ${expectedLine} failed the reviewed fixed numeric band.`, fixedBand);

    const running = await runtime.explore({
      kind: "aggregate",
      resource: resourceId,
      measures: [{ derived_measure: "duration_running_total" }],
      time_bucket: { field: "occurred_at", bucket: "month" },
      top_n: 10,
    });
    assert(running.data.length === 2
      && running.data[0]?.time_bucket === "2026-06-01"
      && running.data[1]?.time_bucket === "2026-07-01"
      && Number(running.data[1]?.duration_running_total) > Number(running.data[0]?.duration_running_total),
    `${engine} ${expectedLine} failed its reviewed post-suppression running total.`, running);

    if (automaticBands) {
      const autoBand = await runtime.explore({
        kind: "aggregate",
        resource: resourceId,
        measures: [{ function: "count" }],
        dimensions: [{ numeric_band: { field: "duration_ms", method: "quantile", buckets: 2 } }],
        top_n: 10,
      });
      assert(autoBand.data.length === 2
        && autoBand.privacy?.auto_bands?.[0]?.raw_edges_returned === false,
      `${engine} ${expectedLine} failed reviewed automatic band execution.`, autoBand);
    } else {
      await assertRejects(
        () => runtime.explore({
          kind: "aggregate",
          resource: resourceId,
          measures: [{ function: "count" }],
          dimensions: [{ numeric_band: { field: "duration_ms", method: "quantile", buckets: 2 } }],
          top_n: 10,
        }),
        "not reviewed",
        "MySQL 5.7 accepted automatic bands despite the capability tier.",
      );
      await assertRejects(
        () => runtime.explore({
          kind: "aggregate",
          resource: resourceId,
          measures: [{ function: "count" }],
          dimensions: [{ field: "plain_label" }],
          top_n: 10,
        }),
        "not reviewed",
        "MySQL 5.7 accepted raw unbounded text grouping.",
      );
    }
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  }

  return {
    engine,
    exact_version: inspection.server_version,
    authority_line: expectedLine,
    tier: expectedTier,
    automatic_bands: automaticBands,
    semantic_checks: {
      decimal_precision: true,
      null_contributors: true,
      collation_grouping: true,
      relative_window_equivalence: true,
      derived_scope_relationship: true,
      suppression: true,
      workbench_compatibility: true,
    },
  };
}

async function verifyProductionHttp(input) {
  const {
    engine,
    databaseUrl,
    inspectedSchema,
    expectedLine,
    automaticBands,
    soakIdentities = [],
    sourceAdminUrl,
  } = input;
  const runMysql57Soak = engine === "mysql" && expectedLine === "5.7" && soakIdentities.length > 0;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `synapsor-db-compat-http-${engine}-`));
  projectRoots.push(projectRoot);
  const sourceName = engine === "postgres" ? "compat_postgres" : "compat_mysql";
  const sourceEnv = "COMPAT_HTTP_SOURCE_URL";
  const controlSchema = `synapsor_compat_${engine}_${process.pid}`;
  const env = {
    ...process.env,
    [sourceEnv]: databaseUrl,
    SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
    SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "database-compatibility-budget-hmac-key-material",
  };
  const inspection = await inspectDatabase({
    engine,
    databaseUrlEnv: sourceEnv,
    schema: inspectedSchema,
    env,
  });
  const serverCompatibility = databaseServerCompatibility(inspection);
  assert(serverCompatibility.authority?.version_line === expectedLine,
    `${engine} production HTTP inspection changed its authority line.`, inspection.server_version);
  const configuredTrustedContext = {
    schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
    provider: "http_claims",
    tenant_binding: "tenant_id",
    principal_binding: "principal_id",
    tenant_claim: "tenant_id",
    principal_claim: "sub",
  };
  const resourceId = `${inspectedSchema}.events`;
  const childResourceId = `${inspectedSchema}.event_items`;
  const build = buildAutoBoundary({
    inspection,
    project: projectSummary(projectRoot),
    sourceEnv,
    sourceName,
    inspectedSchema,
    deploymentProfile: "production",
    httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
    configuredTrustedContext,
    overrides: reviewOverrides(resourceId, automaticBands),
  });
  await writeAutoBoundaryArtifacts({ projectRoot, build });
  const { candidate } = reviewedCandidate(build, resourceId, childResourceId, automaticBands);
  candidate.pack.name = `database_compatibility_${engine}_production`;
  const digest = explorationBoundaryCandidateDigest(candidate);
  await activateExplorationBoundary({
    projectRoot,
    candidate,
    expectedDigest: digest,
    actor: "database-version-http-verifier",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  const activeBoundary = await loadActivatedExplorationBoundary(projectRoot);
  assert(activeBoundary.database_server_version === inspection.server_version
    && activeBoundary.database_server_tier === serverCompatibility.tier
    && activeBoundary.database_server_authority?.version_line === expectedLine,
  `${engine} production HTTP active artifact omitted its reviewed database capability authority.`,
  activeBoundary);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  env.SYNAPSOR_SESSION_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" });
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
        max_entries: runMysql57Soak ? 100_000 : 10_000,
      },
    },
    sources: {
      [sourceName]: {
        engine,
        read_url_env: sourceEnv,
        statement_timeout_ms: 5_000,
      },
    },
    trusted_context: {
      provider: "http_claims",
      tenant_binding: "tenant_id",
      principal_binding: "principal_id",
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
      accounting_namespace: `verify.database.compatibility.${engine}.${expectedLine}`,
      source_max_connections: 2,
      max_sessions_per_principal: 2,
      tenant_limits: {
        max_queries_per_rolling_24_hours: 1_000,
        max_extracted_cells_per_rolling_24_hours: 20_000,
        max_differencing_queries_per_rolling_24_hours: 100,
        requests_per_minute: 120,
        max_response_cells_per_response: 500,
      },
    },
  };
  if (runMysql57Soak) applyProductionExploreSoakBudgets(candidate, runtimeConfig);
  const configPath = path.join(projectRoot, "synapsor.runner.json");
  fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
  const migration = productionExploreRunnerInvocation(root, [
    "store", "shared-postgres", "apply-migration",
    "--schema", controlSchema,
    "--url-env", "SYNAPSOR_CONTROL_DATABASE_URL",
    "--yes",
  ]);
  run(migration.command, migration.args, { env });
  const doctorInvocation = productionExploreRunnerInvocation(root, [
    "doctor",
    "--config", configPath,
    "--json",
    "--transport", "streamable-http",
    "--host", "127.0.0.1",
    "--trusted-tls-proxy",
  ]);
  const doctorResult = run(doctorInvocation.command, doctorInvocation.args, { env });
  const doctor = JSON.parse(doctorResult.stdout);
  const versionCheck = doctor.checks?.find((check) => check.name === `source:${sourceName}:server-version`);
  assert(doctor.ok === true
    && versionCheck?.ok === true
    && versionCheck.message.includes(inspection.server_version),
  `${engine} ${expectedLine} Doctor did not report the detected support tier.`, versionCheck);
  assert(versionCheck.level === (automaticBands ? "pass" : "warn"),
    `${engine} ${expectedLine} Doctor reported the wrong compatibility severity.`, versionCheck);

  let server;
  const clients = [];
  const sourceAdmin = runMysql57Soak ? await mysql.createConnection(sourceAdminUrl) : undefined;
  const control = runMysql57Soak ? new Pool({ connectionString: controlUrl, max: 1 }) : undefined;
  const outputRoot = process.env.SYNAPSOR_SOAK_OUTPUT_DIR?.trim()
    || path.resolve(root, "..", "synapsor-1.7.0-version-qualification", "mysql57");
  let soakResult;
  let soakAudit;
  let soakRecovery;
  let operatorLedger;
  let operatorWorkbench;
  const sourceConnectionCount = async () => {
    const [rows] = await sourceAdmin.query(`
      SELECT COUNT(*) AS count
      FROM information_schema.PROCESSLIST
      WHERE DB = 'compatdb' AND USER = 'compat_reader'
    `);
    return Number(rows[0]?.count ?? 0);
  };
  try {
    server = await startProductionExploreCli({ root, configPath, env });

    if (runMysql57Soak) {
      const operations = mysql57SoakOperations(resourceId, childResourceId);
      const groupedOperation = operations.find((operation) => operation.name === "grouped_count_sum");
      const recoveryIdentity = soakIdentities.at(-1);
      soakResult = await runProductionExploreHttpSoak({
        engine: "mysql57",
        server_pid: server.child.pid,
        server_exit_state: server.exitState,
        source_connection_ceiling: runtimeConfig.production_explore.source_max_connections,
        source_connection_count: sourceConnectionCount,
        identities: soakIdentities.slice(0, -1),
        create_client: async (identity) => httpClient(
          server.url,
          signedToken(privateKey, identity.tenant, identity.principal),
        ),
        operations,
        result_path: path.join(outputRoot, "mysql57-http-soak.json"),
      });
      soakAudit = await verifyProductionExploreAuditSink({
        engine: "mysql57",
        control,
        schema: controlSchema,
        soak: soakResult,
        forbidden_values: ["soak-", readerPassword, "database-compatibility-budget-hmac-key-material"],
        result_path: path.join(outputRoot, "mysql57-http-audit.json"),
      });

      await stopProductionExploreCli(server);
      server = undefined;
      await waitForSourceConnectionQuiescence({
        engine: "mysql57",
        source_connection_count: sourceConnectionCount,
      });
      server = await startProductionExploreCli({ root, configPath, env });
      soakRecovery = await runProductionExploreRecovery({
        engine: "mysql57",
        server_pid: server.child.pid,
        source_connection_ceiling: runtimeConfig.production_explore.source_max_connections,
        source_connection_count: sourceConnectionCount,
        identity: recoveryIdentity,
        create_client: async (identity) => httpClient(
          server.url,
          signedToken(privateKey, identity.tenant, identity.principal),
        ),
        request: groupedOperation.request,
        validate: groupedOperation.validate,
        result_path: path.join(outputRoot, "mysql57-http-recovery.json"),
      });
    }

    const acme = httpClient(server.url, signedToken(privateKey, "acme", "rep-1"));
    clients.push(acme.client);
    await acme.client.connect(acme.transport);
    const tools = await acme.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      `${engine} ${expectedLine} production HTTP surface was not locked to two tools.`, tools.tools);
    const exploreTool = tools.tools.find((tool) => tool.name === "app.explore_data");
    const advertised = `${exploreTool?.description ?? ""} ${JSON.stringify(exploreTool?.inputSchema ?? {})}`;
    assert(/quantile|equal_width/.test(advertised) === automaticBands,
      `${engine} ${expectedLine} production HTTP advertised the wrong grammar tier.`, advertised);

    const grouped = resultPayload(await acme.client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          kind: "aggregate",
          resource: resourceId,
          measures: [{ function: "count" }, { function: "stddev_pop", field: "duration_ms" }],
          dimensions: [{ field: "status" }],
          time_bucket: { field: "occurred_at", bucket: "quarter" },
          top_n: 10,
        },
      },
    }));
    assert(grouped.ok === true && grouped.data?.length === 4
      && grouped.data.every((row) => row.count === 6 && ["2026-Q2", "2026-Q3"].includes(row.time_bucket)),
    `${engine} ${expectedLine} production HTTP did not apply claim-bound scope and portable SQL.`, grouped);

    const wrongPrincipal = httpClient(server.url, signedToken(privateKey, "acme", "rep-2"));
    clients.push(wrongPrincipal.client);
    await wrongPrincipal.client.connect(wrongPrincipal.transport);
    const isolated = resultPayload(await wrongPrincipal.client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          kind: "aggregate",
          resource: resourceId,
          measures: [{ function: "count" }],
          dimensions: [{ field: "status" }],
          top_n: 10,
        },
      },
    }));
    assert(isolated.ok === true && isolated.data?.length === 0,
      `${engine} ${expectedLine} production HTTP did not isolate the principal claim.`, isolated);

    const modelScopeAttempt = await acme.client.callTool({
      name: "app.explore_data",
      arguments: {
        tenant_id: "globex",
        plan: { kind: "rows", resource: resourceId, select: ["status"], limit: 1 },
      },
    });
    const refusalText = modelScopeAttempt.content?.find((item) => item.type === "text")?.text ?? "";
    assert(modelScopeAttempt.isError === true && /tenant_id|unrecognized|invalid/i.test(refusalText),
      `${engine} ${expectedLine} production HTTP accepted model-supplied trusted scope.`, modelScopeAttempt);

    if (runMysql57Soak) {
      operatorLedger = verifyProductionExploreOperatorLedger({
        schema: controlSchema,
        config_path: configPath,
        source_id: sourceName,
        forbidden_values: [databaseUrl, sourceAdminUrl, controlUrl, env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY],
        invoke: (args) => {
          const invocation = productionExploreRunnerInvocation(root, args);
          return run(invocation.command, invocation.args, { env, allowFailure: true });
        },
      });
      operatorWorkbench = await verifyProductionExploreWorkbenchLedger({
        engine: "mysql57",
        project_root: projectRoot,
        config_path: configPath,
        runtime_config: runtimeConfig,
        schema: controlSchema,
        url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
        control_url: controlUrl,
      });
    }
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await stopProductionExploreCli(server).catch(() => undefined);
    await sourceAdmin?.end().catch(() => undefined);
    await control?.end().catch(() => undefined);
  }
  return {
    engine,
    authority_line: expectedLine,
    transport: "streamable_http",
    jwt: "RS256",
    claim_scope: "tenant_and_principal",
    automatic_bands: automaticBands,
    ...(soakResult
      ? {
        soak: {
          requests: soakResult.requests,
          successes: soakResult.successes,
          expected_refusals: soakResult.expected_refusals,
          unexpected_errors: soakResult.unexpected_errors,
          audit: soakAudit,
          recovery: soakRecovery,
          operator_ledger: operatorLedger,
          operator_workbench: operatorWorkbench,
        },
      }
      : {}),
  };
}

async function verifyUnsupportedPostgres(line) {
  const adminUrl = `postgresql://compat_admin:compat_admin_password@127.0.0.1:${line.port}/compatdb`;
  await seedPostgres(adminUrl);
  const readerUrl = `postgresql://compat_reader:${readerPassword}@127.0.0.1:${line.port}/compatdb`;
  const env = { ...process.env, COMPAT_DATABASE_URL: readerUrl, SYNAPSOR_TENANT_ID: "acme" };
  const inspection = await inspectDatabase({
    engine: "postgres",
    databaseUrlEnv: "COMPAT_DATABASE_URL",
    schema: "compat",
    env,
  });
  const compatibility = databaseServerCompatibility(inspection);
  assert(compatibility.tier === "unsupported"
    && compatibility.authority === undefined
    && compatibility.normalized_version?.startsWith(`${line.expected}.`),
    "PostgreSQL below the supported floor did not produce an explicit unsupported tier.", compatibility);
  await assertRejects(
    async () => buildAutoBoundary({
      inspection,
      project: projectSummary("/tmp/synapsor-unsupported-postgres"),
      sourceEnv: "COMPAT_DATABASE_URL",
      inspectedSchema: "compat",
      overrides: reviewOverrides("compat.events"),
    }),
    "unsupported",
    "PostgreSQL below the supported floor reached boundary authoring.",
  );
  return {
    engine: "postgres",
    exact_version: inspection.server_version,
    authority_line: line.expected,
    tier: "unsupported",
    automatic_bands: false,
  };
}

async function main() {
  if (mysql57SoakOnly && !mysql57SoakRequested) {
    throw new Error("SYNAPSOR_MYSQL57_COMPAT_SOAK_ONLY requires SYNAPSOR_MYSQL57_COMPAT_SOAK=1.");
  }
  run("docker", [
    "compose", "-p", composeProject, "-f", compose, "up", "-d", "--wait",
    ...(mysql57SoakOnly ? ["control", "mysql57"] : []),
  ], { inherit: true });
  const results = [];
  const httpResults = [];
  const mysql57SoakIdentities = mysql57SoakRequested ? productionExploreSoakIdentities() : [];
  try {
    for (const line of mysql57SoakOnly ? [] : postgresLines) {
      const adminUrl = `postgresql://compat_admin:compat_admin_password@127.0.0.1:${line.port}/compatdb`;
      if (!line.supported) {
        results.push(await verifyUnsupportedPostgres(line));
        continue;
      }
      await seedPostgres(adminUrl);
      results.push(await verifyReviewedRuntime({
        engine: "postgres",
        databaseUrl: `postgresql://compat_reader:${readerPassword}@127.0.0.1:${line.port}/compatdb`,
        inspectedSchema: "compat",
        expectedLine: line.expected,
        expectedTier: "full",
        automaticBands: true,
      }));
    }
    for (const line of mysql57SoakOnly ? mysqlLines.slice(0, 1) : mysqlLines) {
      const adminUrl = `mysql://root:compat_admin_password@127.0.0.1:${line.port}`;
      await seedMysql(adminUrl);
      results.push(await verifyReviewedRuntime({
        engine: "mysql",
        databaseUrl: `mysql://compat_reader:${readerPassword}@127.0.0.1:${line.port}/compatdb`,
        inspectedSchema: "compatdb",
        expectedLine: line.expected,
        expectedTier: line.tier,
        automaticBands: line.automaticBands,
      }));
      if (line.expected === "5.7" && mysql57SoakRequested) {
        await seedMysql57Soak(adminUrl, mysql57SoakIdentities);
      }
    }
    if (!mysql57SoakOnly) {
      httpResults.push(await verifyProductionHttp({
        engine: "postgres",
        databaseUrl: `postgresql://compat_reader:${readerPassword}@127.0.0.1:55613/compatdb`,
        inspectedSchema: "compat",
        expectedLine: "13",
        automaticBands: true,
      }));
    }
    httpResults.push(await verifyProductionHttp({
      engine: "mysql",
      databaseUrl: `mysql://compat_reader:${readerPassword}@127.0.0.1:55657/compatdb`,
      inspectedSchema: "compatdb",
      expectedLine: "5.7",
      automaticBands: false,
      soakIdentities: mysql57SoakIdentities,
      sourceAdminUrl: "mysql://root:compat_admin_password@127.0.0.1:55657/compatdb",
    }));
    process.stdout.write(`${JSON.stringify({ ok: true, results, production_http: httpResults }, null, 2)}\n`);
  } finally {
    for (const projectRoot of projectRoots.splice(0)) {
      if (process.env.SYNAPSOR_KEEP_COMPAT_PROJECTS !== "1") {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      } else {
        process.stderr.write(`Kept compatibility project: ${projectRoot}\n`);
      }
    }
    if (process.env.SYNAPSOR_KEEP_COMPAT_CONTAINERS !== "1") {
      run("docker", ["compose", "-p", composeProject, "-f", compose, "down", "--volumes", "--remove-orphans"], {
        inherit: true,
        allowFailure: true,
      });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
