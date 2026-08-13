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
import { createScopedExploreRuntime } from "../apps/runner/dist/scoped-explore.js";
import {
  productionExploreRunnerInvocation,
  startProductionExploreCli,
  stopProductionExploreCli,
} from "./production-explore-http-e2e-helpers.mjs";

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
            duration: 100 + (index * 100) + (status === "paused" ? 25 : 0),
            occurredAt: `2026-${month}-${String(index + 1).padStart(2, "0")} 12:00:00`,
          });
        }
      }
    }
  }
  return rows;
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
        status text NOT NULL CHECK (status IN ('active', 'paused')),
        plain_label text NOT NULL,
        duration_ms integer NOT NULL,
        occurred_at timestamptz NOT NULL
      );
      GRANT CONNECT ON DATABASE compatdb TO compat_reader;
      GRANT USAGE ON SCHEMA compat TO compat_reader;
      GRANT SELECT ON compat.events TO compat_reader;
    `);
    for (const row of fixtureRows()) {
      await pool.query(
        "INSERT INTO compat.events (id, tenant_id, principal_id, status, plain_label, duration_ms, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [row.id, row.tenant, row.principal, row.status, row.plainLabel, row.duration, `${row.occurredAt}+00`],
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
    await connection.query("CREATE DATABASE compatdb");
    await connection.query("DROP USER IF EXISTS 'compat_reader'@'%'");
    await connection.query(`CREATE USER 'compat_reader'@'%' IDENTIFIED BY '${readerPassword}'`);
    await connection.query(`
      CREATE TABLE compatdb.events (
        id integer PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        principal_id varchar(64) NOT NULL,
        status enum('active', 'paused') NOT NULL,
        plain_label varchar(64) NOT NULL,
        duration_ms integer NOT NULL,
        occurred_at datetime NOT NULL
      )
    `);
    await connection.query("GRANT SELECT ON compatdb.* TO 'compat_reader'@'%'");
    for (const row of fixtureRows()) {
      await connection.query(
        "INSERT INTO compatdb.events (id, tenant_id, principal_id, status, plain_label, duration_ms, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [row.id, row.tenant, row.principal, row.status, row.plainLabel, row.duration, row.occurredAt],
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

function reviewedCandidate(build, resourceId, automaticBands) {
  const candidate = structuredClone(build.exploration_boundary);
  candidate.pack.name = "database_compatibility";
  candidate.pack.resources = candidate.pack.resources.filter((resource) => resource.id === resourceId);
  candidate.budgets.max_queries_per_session = 100;
  candidate.budgets.rate_limit_per_minute = 100;
  candidate.budgets.max_differencing_queries = 16;
  candidate.budgets.max_extracted_cells_per_session = 4_000;
  const resource = candidate.pack.resources[0];
  assert(resource, `Compatibility draft omitted ${resourceId}.`, candidate.pack.resources);
  assert(resource.numeric_bands?.some((band) => band.name === "duration_tier"),
    "Reviewed fixed numeric-band policy did not enter the candidate.", resource.numeric_bands);
  assert(resource.derived_measures?.some((measure) => measure.name === "duration_running_total"),
    "Reviewed running metric did not enter the candidate.", resource.derived_measures);
  assert(Boolean(resource.auto_bands?.length) === automaticBands,
    "Automatic-band policy did not match the server capability.", resource.auto_bands);
  return { candidate, resource };
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
  const { candidate, resource } = reviewedCandidate(build, resourceId, automaticBands);
  assert(resource.field_enums.status?.join(",") === "active,paused",
    `${engine} ${expectedLine} did not preserve the bounded status vocabulary.`, resource.field_enums);
  if (expectedTier === "compatible_limited") {
    assert(!resource.groupable_fields.includes("plain_label")
      && resource.filterable_fields.plain_label === undefined,
    "MySQL 5.7 exposed an unbounded text field for grouping or filtering.", resource);
    assert(resource.selectable_fields.includes("plain_label"),
      "MySQL 5.7 removed selectable row authority while narrowing categorical operations.", resource);
    assert(resource.groupable_fields.includes("status") && resource.filterable_fields.status,
      "MySQL 5.7 failed to retain native ENUM grouping and filtering.", resource);
    assert(!resource.auto_bands?.length, "MySQL 5.7 boundary unexpectedly contains automatic bands.", resource.auto_bands);
  }

  await writeAutoBoundaryArtifacts({ projectRoot, build });
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

  const runtime = await createScopedExploreRuntime({ projectRoot, transport: "stdio", env });
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
    assert(grouped.data.every((row) => ["2026-Q2", "2026-Q3"].includes(row.time_bucket) && row.count === 6),
      `${engine} ${expectedLine} returned non-canonical or unscoped grouped data.`, grouped.data);

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
  };
}

async function verifyProductionHttp(input) {
  const { engine, databaseUrl, inspectedSchema, expectedLine, automaticBands } = input;
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
  const { candidate } = reviewedCandidate(build, resourceId, automaticBands);
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
        max_entries: 10_000,
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
  try {
    server = await startProductionExploreCli({ root, configPath, env });
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
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    await stopProductionExploreCli(server).catch(() => undefined);
  }
  return {
    engine,
    authority_line: expectedLine,
    transport: "streamable_http",
    jwt: "RS256",
    claim_scope: "tenant_and_principal",
    automatic_bands: automaticBands,
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
  run("docker", ["compose", "-p", composeProject, "-f", compose, "up", "-d", "--wait"], { inherit: true });
  const results = [];
  const httpResults = [];
  try {
    for (const line of postgresLines) {
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
    for (const line of mysqlLines) {
      await seedMysql(`mysql://root:compat_admin_password@127.0.0.1:${line.port}`);
      results.push(await verifyReviewedRuntime({
        engine: "mysql",
        databaseUrl: `mysql://compat_reader:${readerPassword}@127.0.0.1:${line.port}/compatdb`,
        inspectedSchema: "compatdb",
        expectedLine: line.expected,
        expectedTier: line.tier,
        automaticBands: line.automaticBands,
      }));
    }
    httpResults.push(await verifyProductionHttp({
      engine: "postgres",
      databaseUrl: `postgresql://compat_reader:${readerPassword}@127.0.0.1:55613/compatdb`,
      inspectedSchema: "compat",
      expectedLine: "13",
      automaticBands: true,
    }));
    httpResults.push(await verifyProductionHttp({
      engine: "mysql",
      databaseUrl: `mysql://compat_reader:${readerPassword}@127.0.0.1:55657/compatdb`,
      inspectedSchema: "compatdb",
      expectedLine: "5.7",
      automaticBands: false,
    }));
    process.stdout.write(`${JSON.stringify({ ok: true, results, production_http: httpResults }, null, 2)}\n`);
  } finally {
    for (const projectRoot of projectRoots.splice(0)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
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
